import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const port = 3323;
const token = 'test-publisher-worker-token';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'southfarm-worker-api-'));
const dbPath = path.join(tempDir, 'southfarm.db');
const mediaRoot = path.join(tempDir, 'private-media');
let backend; let output = '';

function start() {
  backend = spawn(process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath, [path.resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), SOUTHFARM_DB_PATH: dbPath, SOUTHFARM_PUBLICATION_MEDIA_ROOT: mediaRoot, SOUTHFARM_JWT_SECRET: 'worker-api-test-secret', SOUTHFARM_PUBLISHER_WORKER_TOKEN: token, SOUTHFARM_AUTO_PLANNER_ENABLED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => { output += chunk; }); backend.stderr.on('data', (chunk) => { output += chunk; });
}
async function stop() { if (backend?.exitCode === null) { backend.kill('SIGTERM'); await new Promise((resolve) => backend.once('exit', resolve)); } }
async function waitForHealth() { for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`backend unavailable: ${output}`); }
async function request(pathname, init = {}) { const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init); const body = await response.json().catch(() => ({})); return { response, body }; }
async function createUser() { const { response, body } = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `worker-${Date.now()}@example.test`, password: 'test-password-123', name: 'Worker test' }) }); assert.equal(response.status, 201); return body; }
function form(deviceId, accountId, caption = 'Safe worker API media test') { const value = new FormData(); value.set('video', new Blob([Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex')], { type: 'video/mp4' }), 'clip.mp4'); value.set('platform', 'youtube'); value.set('device_id', String(deviceId)); value.set('social_account_id', String(accountId)); value.set('caption', caption); value.set('scheduled_for', new Date(Date.now() - 1_000).toISOString()); return value; }
const workerHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

start();
try {
  await waitForHealth();
  const owner = await createUser();
  const db = new Database(dbPath);
  const workspaceId = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active'").get(owner.user.id).workspace_id;
  const deviceId = Number(db.prepare("INSERT INTO devices (user_id, workspace_id, device_id, installation_id, device_name, lifecycle_status) VALUES (?, ?, 'worker-test-android', 'worker-test-android', 'Worker test phone', 'active')").run(owner.user.id, workspaceId).lastInsertRowid);
  const accountId = Number(db.prepare("INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, 'youtube', 'worker-test-channel')").run(owner.user.id, deviceId).lastInsertRowid);
  const deviceToken = `sfd-worker-device-${crypto.randomUUID()}`;
  db.prepare('UPDATE devices SET device_token_hash = ? WHERE id = ?').run(crypto.createHash('sha256').update(deviceToken).digest('hex'), deviceId);
  const ownerHeaders = { Authorization: `Bearer ${owner.token}` };
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId);
  const first = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: form(deviceId, accountId) }); assert.equal(first.response.status, 201, JSON.stringify(first.body));

  for (const headers of [{}, { Authorization: 'Bearer incorrect' }]) { const denied = await request('/api/publication-worker/claim', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_id: 'worker-a', device_id: deviceId }) }); assert.equal(denied.response.status, 401); }
  const [claimA, claimB] = await Promise.all(['worker-a', 'worker-b'].map((worker_id) => request('/api/publication-worker/claim', { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id, device_id: deviceId }) })));
  assert.equal([claimA, claimB].filter((item) => item.body.claimed).length, 1, 'two claims have exactly one winner');
  const claim = claimA.body.claimed ? claimA.body : claimB.body; const job = claim.job;
  assert.match(claim.claim_token, /^[0-9a-f-]{36}$/i); assert.notEqual(claim.claim_token, token);
  assert.deepEqual(Object.keys(job.media).sort(), ['file_extension', 'id', 'mime_type', 'sha256', 'size_bytes']);
  assert.equal(job.media.id, job.media_id);
  assert.equal(job.media.sha256, job.media.sha256.toLowerCase());
  assert.equal(typeof job.media.size_bytes, 'number');
  assert.equal(job.media.private_path, undefined);
  assert.equal(job.media.workspace_id, undefined);
  assert.equal(JSON.stringify(claim), JSON.stringify(claim).replaceAll(mediaRoot, '[private-root]'), 'claim never leaks its private media root');
  const taskClaim = await request('/api/tasks/claim', { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: 'worker-test-android', installation_id: 'worker-test-android' }) });
  assert.equal(taskClaim.response.status, 200); assert.equal(taskClaim.body.claimed, false); assert.equal(taskClaim.body.reason, 'device_busy_publication');
  const badHeartbeat = await request(`/api/publication-worker/jobs/${job.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: 'wrong' }) }); assert.equal(badHeartbeat.response.status, 409);
  const originalClaim = claim.claim_token;
  db.prepare("UPDATE publication_jobs SET claim_token = 'swapped-token' WHERE id = ?").run(job.id);
  const swapped = await request(`/api/publication-worker/jobs/${job.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: originalClaim }) }); assert.equal(swapped.response.status, 409, 'ownership changes after route parsing cannot mutate');
  db.prepare('UPDATE publication_jobs SET claim_token = ? WHERE id = ?').run(originalClaim, job.id);
  db.prepare('UPDATE publication_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1_000).toISOString(), job.id);
  const expired = await request(`/api/publication-worker/jobs/${job.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: originalClaim }) }); assert.equal(expired.response.status, 409, 'expired job lease is rejected');
  db.prepare('UPDATE publication_jobs SET lease_expires_at = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), job.id);
  const before = db.prepare('SELECT lease_expires_at FROM publication_jobs WHERE id = ?').get(job.id).lease_expires_at;
  const heartbeat = await request(`/api/publication-worker/jobs/${job.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token }) }); assert.equal(heartbeat.response.status, 200); assert.equal(heartbeat.body.cancel_requested, false);
  const after = db.prepare('SELECT lease_expires_at FROM publication_jobs WHERE id = ?').get(job.id).lease_expires_at; assert.ok(after > new Date().toISOString()); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_automation_locks WHERE device_id = ? AND expires_at > ?').get(deviceId, new Date().toISOString()).count, 1);
  db.prepare('UPDATE publication_jobs SET cancel_requested_at = ? WHERE id = ?').run(new Date().toISOString(), job.id);
  const cancelled = await request(`/api/publication-worker/jobs/${job.id}/heartbeat`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token }) }); assert.equal(cancelled.body.cancel_requested, true);
  const media = await request(`/api/publication-worker/media/${job.media_id}`, { headers: { Authorization: `Bearer ${token}`, 'X-SouthFarm-Worker-Id': claim.worker_id, 'X-SouthFarm-Claim-Token': claim.claim_token } }); assert.equal(media.response.status, 200); assert.match(media.response.headers.get('content-disposition'), /attachment/);
  const foreign = await request('/api/publication-worker/media/999999', { headers: { Authorization: `Bearer ${token}`, 'X-SouthFarm-Worker-Id': claim.worker_id, 'X-SouthFarm-Claim-Token': claim.claim_token } }); assert.equal(foreign.response.status, 404);
  const checkpoint = await request(`/api/publication-worker/jobs/${job.id}/checkpoint`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token, step: 'preparing', progress_percent: 10, evidence: { selector: 'prepare-button' } }) }); assert.equal(checkpoint.response.status, 200); assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM publication_events WHERE publication_job_id = ? ORDER BY id DESC LIMIT 1').get(job.id).payload).evidence, { selector: 'prepare-button' });
  const stableBeforeInvalid = db.prepare('SELECT status, current_step, progress_percent, final_action_at FROM publication_jobs WHERE id = ?').get(job.id); const eventBeforeInvalid = db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(job.id).count;
  for (const final_action of ['false', 'true', 0, 1, null]) { const invalid = await request(`/api/publication-worker/jobs/${job.id}/checkpoint`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token, step: 'preparing', progress_percent: 11, final_action }) }); assert.equal(invalid.response.status, 400); assert.deepEqual(db.prepare('SELECT status, current_step, progress_percent, final_action_at FROM publication_jobs WHERE id = ?').get(job.id), stableBeforeInvalid); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(job.id).count, eventBeforeInvalid); }
  const invalidFinal = await request(`/api/publication-worker/jobs/${job.id}/checkpoint`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token, step: 'publishing', progress_percent: 90 }) }); assert.equal(invalidFinal.response.status, 409, 'publishing requires final action');
  db.prepare("UPDATE publication_jobs SET status = 'cancellation_requested', current_step = 'cancellation_requested' WHERE id = ?").run(job.id);
  const eventCountBeforeFail = db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(job.id).count; db.exec(`CREATE TRIGGER worker_finish_failure BEFORE UPDATE ON publication_jobs WHEN OLD.id = ${job.id} BEGIN SELECT RAISE(ABORT, 'injected finish failure'); END;`);
  const failedAtomicFinish = await request(`/api/publication-worker/jobs/${job.id}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token, status: 'cancelled', error_code: 'TEST_CANCELLED' }) }); assert.equal(failedAtomicFinish.response.status, 409); assert.equal(db.prepare('SELECT status FROM publication_jobs WHERE id = ?').get(job.id).status, 'cancellation_requested'); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(job.id).count, eventCountBeforeFail); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_automation_locks WHERE publication_job_id = ?').get(job.id).count, 1); db.exec('DROP TRIGGER worker_finish_failure');
  const finish = await request(`/api/publication-worker/jobs/${job.id}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: claim.worker_id, claim_token: claim.claim_token, status: 'cancelled', result: { reason: 'operator' }, error_code: 'TEST_CANCELLED', error_message: 'cancelled safely', remote_post_identity: 'none' }) }); assert.equal(finish.response.status, 200); const finishedRow = db.prepare('SELECT result, error_code, error_message, remote_post_identity FROM publication_jobs WHERE id = ?').get(job.id); assert.equal(finishedRow.error_code, 'TEST_CANCELLED'); assert.equal(finishedRow.error_message, 'cancelled safely'); assert.equal(finishedRow.remote_post_identity, 'none'); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_automation_locks WHERE publication_job_id = ?').get(job.id).count, 0);
  const afterFinishMedia = await request(`/api/publication-worker/media/${job.media_id}`, { headers: { Authorization: `Bearer ${token}`, 'X-SouthFarm-Worker-Id': claim.worker_id, 'X-SouthFarm-Claim-Token': claim.claim_token } }); assert.equal(afterFinishMedia.response.status, 404, 'terminal jobs may not download media');
  const available = await request(`/api/publication-worker/devices/${deviceId}/availability`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(available.body.available, true);
  db.prepare("UPDATE devices SET lifecycle_status = 'revoked' WHERE id = ?").run(deviceId);
  const inactive = await request(`/api/publication-worker/devices/${deviceId}/availability`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(inactive.body.available, false); assert.ok(inactive.body.reasons.includes('device_offline'));
  db.prepare("UPDATE devices SET lifecycle_status = 'active', last_seen_at = ? WHERE id = ?").run(new Date(Date.now() - 120_000).toISOString(), deviceId);
  const stale = await request(`/api/publication-worker/devices/${deviceId}/availability`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(stale.body.available, false);
  db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId);
  const taskBlocked = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: form(deviceId, accountId, 'Task lock blocks publication claim') }); assert.equal(taskBlocked.response.status, 201);
  db.prepare("INSERT INTO task_runs (user_id, device_id, task_type, status, scheduled_for, expires_at) VALUES (?, ?, 'warmup_youtube', 'pending', ?, ?)").run(owner.user.id, deviceId, new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() + 120_000).toISOString());
  const futureTaskAvailable = await request(`/api/publication-worker/devices/${deviceId}/availability`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(futureTaskAvailable.body.available, true, 'future pending task is not busy');
  db.prepare("UPDATE task_runs SET scheduled_for = ? WHERE device_id = ? AND status = 'pending'").run(new Date(Date.now() - 1_000).toISOString(), deviceId);
  const dueTaskBusy = await request(`/api/publication-worker/devices/${deviceId}/availability`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal(dueTaskBusy.body.available, false); assert.ok(dueTaskBusy.body.reasons.includes('device_busy_task'));
  db.prepare("DELETE FROM task_runs WHERE device_id = ? AND status = 'pending'").run(deviceId);
  db.prepare("INSERT INTO task_runs (user_id, device_id, task_type, status, lease_expires_at) VALUES (?, ?, 'warmup_youtube', 'running', ?)").run(owner.user.id, deviceId, new Date(Date.now() + 60_000).toISOString());
  const blockedClaim = await request('/api/publication-worker/claim', { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker-c', device_id: deviceId }) }); assert.equal(blockedClaim.body.claimed, false, 'live task lease blocks a publication claim');
  db.prepare("DELETE FROM task_runs WHERE device_id = ? AND status = 'running'").run(deviceId);
  const finalClaimResponse = await request('/api/publication-worker/claim', { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker-c', device_id: deviceId }) }); assert.equal(finalClaimResponse.body.claimed, true);
  const finalClaim = finalClaimResponse.body; const finalJob = finalClaim.job;
  db.prepare("UPDATE publication_media SET private_path = '../outside.mp4' WHERE id = ?").run(finalJob.media_id);
  const traversal = await request(`/api/publication-worker/media/${finalJob.media_id}`, { headers: { Authorization: `Bearer ${token}`, 'X-SouthFarm-Worker-Id': finalClaim.worker_id, 'X-SouthFarm-Claim-Token': finalClaim.claim_token } }); assert.equal(traversal.response.status, 404, 'stored paths may not escape private root');
  db.prepare('UPDATE publication_media SET private_path = ? WHERE id = ?').run(`${finalJob.media_id}.mp4`, finalJob.media_id);
  for (const [step, progress_percent, final_action] of [['preparing', 10, false], ['transferring', 20, false], ['selecting_media', 30, false], ['editing', 50, false], ['captioning', 65, false], ['ready_to_publish', 80, false], ['publishing', 90, true]]) {
    const cp = await request(`/api/publication-worker/jobs/${finalJob.id}/checkpoint`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: finalClaim.worker_id, claim_token: finalClaim.claim_token, step, progress_percent, final_action }) }); assert.equal(cp.response.status, 200, `${step} checkpoint`);
  }
  const postFinalFailed = await request(`/api/publication-worker/jobs/${finalJob.id}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: finalClaim.worker_id, claim_token: finalClaim.claim_token, status: 'failed' }) }); assert.equal(postFinalFailed.response.status, 409);
  const postFinalReview = await request(`/api/publication-worker/jobs/${finalJob.id}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: finalClaim.worker_id, claim_token: finalClaim.claim_token, status: 'review_required' }) }); assert.equal(postFinalReview.response.status, 200);
  for (const [username, mutation] of [
    ['missing-media', (publicationId) => db.prepare('UPDATE publication_jobs SET media_id = NULL WHERE id = ?').run(publicationId)],
    ['staging-media', (publicationId) => db.prepare("UPDATE publication_media SET upload_status = 'staging' WHERE id = (SELECT media_id FROM publication_jobs WHERE id = ?)").run(publicationId)],
    ['mismatched-media', (publicationId) => {
      const foreignUser = Number(db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').run(`foreign-${crypto.randomUUID()}@example.test`, 'test-password-123', 'Foreign workspace').lastInsertRowid);
      const foreignWorkspace = Number(db.prepare('INSERT INTO workspaces (name, owner_user_id) VALUES (?, ?)').run('Foreign workspace', foreignUser).lastInsertRowid);
      db.prepare('UPDATE publication_jobs SET workspace_id = ? WHERE id = ?').run(foreignWorkspace, publicationId);
    }],
  ]) {
    const isolatedAccount = Number(db.prepare("INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, 'youtube', ?)").run(owner.user.id, deviceId, username).lastInsertRowid);
    const invalid = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: form(deviceId, isolatedAccount, `Safe ${username} claim`) });
    assert.equal(invalid.response.status, 201, JSON.stringify(invalid.body));
    mutation(invalid.body.publication.id);
    const invalidClaim = await request('/api/publication-worker/claim', { method: 'POST', headers: workerHeaders, body: JSON.stringify({ worker_id: 'worker-invalid', device_id: deviceId }) });
    assert.equal(invalidClaim.body.claimed, false, `${username} is never executable`);
    const invalidRow = db.prepare('SELECT status, error_code FROM publication_jobs WHERE id = ?').get(invalid.body.publication.id);
    assert.deepEqual(invalidRow, { status: 'review_required', error_code: 'MEDIA_UNAVAILABLE' });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM device_automation_locks WHERE publication_job_id = ?').get(invalid.body.publication.id).count, 0);
    const invalidEvent = db.prepare('SELECT payload FROM publication_events WHERE publication_job_id = ? ORDER BY id DESC LIMIT 1').get(invalid.body.publication.id);
    assert.equal(JSON.parse(invalidEvent.payload).reason, 'MEDIA_UNAVAILABLE');
  }
  console.log('publication-worker-api test passed: auth, atomic claim, shared lock, lease, media, cancellation, finish');
  db.close();
} finally { await stop(); try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
