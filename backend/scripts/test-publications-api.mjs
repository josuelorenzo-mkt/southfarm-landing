import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import express from 'express';
import { PublicationStore } from '../dist/publications-domain.js';
import { registerPublicationRoutes } from '../dist/publications-routes.js';

const port = 3321;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'southfarm-publications-api-'));
const dbPath = path.join(tempDir, 'southfarm.db');
const mediaRoot = path.join(tempDir, 'private-media');
const abortMarker = path.join(tempDir, 'after-rename.marker');
const backendNodePath = process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath;
const testProbe = process.env.SOUTHFARM_TEST_FFPROBE || 'C:\\Users\\josu_\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffprobe.exe';
let output = '';
let backend;
function startBackend() {
  backend = spawn(backendNodePath, [path.resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), SOUTHFARM_DB_PATH: dbPath, SOUTHFARM_PUBLICATION_MEDIA_ROOT: mediaRoot,
      SOUTHFARM_JWT_SECRET: 'test-only-southfarm-secret', SOUTHFARM_AUTO_PLANNER_ENABLED: 'false', SOUTHFARM_FFPROBE: testProbe,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => { output += chunk.toString(); });
  backend.stderr.on('data', (chunk) => { output += chunk.toString(); });
}

async function waitForPath(target) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${target}`);
}
async function stopBackend() {
  if (backend?.exitCode !== null) return;
  backend.kill('SIGTERM');
  await new Promise((resolve) => { const timeout = setTimeout(() => { backend.kill('SIGKILL'); resolve(); }, 5000); backend.once('exit', () => { clearTimeout(timeout); resolve(); }); });
}
startBackend();

const mp4Header = fs.readFileSync('C:\\Users\\josu_\\Downloads\\Videos to test\\MP-V-2.mp4');
const quicktimeHeader = Buffer.from('0000001466747970717420200000020071742020', 'hex');
const webmHeader = Buffer.from('1a45dfa3874282847765626d', 'hex');
const futureIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not become healthy.\n${output}`);
}

async function request(pathname, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function publicationForm({ deviceId, accountId, caption = 'A safe SouthFarm publishing test starts right now', platform = 'youtube', scheduledFor = futureIso, type = 'video/mp4', contents = mp4Header } = {}) {
  const body = new FormData();
  if (contents !== null) body.set('video', new Blob([contents], { type }), 'clip.mp4');
  body.set('platform', platform);
  body.set('device_id', String(deviceId));
  body.set('social_account_id', String(accountId));
  body.set('caption', caption);
  body.set('scheduled_for', scheduledFor);
  return body;
}

async function createUser(email) {
  const { response, body } = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test-password-123', name: email }),
  });
  assert.equal(response.status, 201);
  return body;
}

try {
  await waitForHealth();
  const owner = await createUser(`publication-owner-${Date.now()}@example.test`);
  const db = new Database(dbPath);
  const ownerWorkspace = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = ?').get(owner.user.id, 'active').workspace_id;
  const deviceId = Number(db.prepare('INSERT INTO devices (user_id, workspace_id, device_id, device_name, lifecycle_status) VALUES (?, ?, ?, ?, ?)').run(owner.user.id, ownerWorkspace, 'test-android-id', 'Test Phone', 'active').lastInsertRowid);
  const accountId = Number(db.prepare('INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, ?, ?)').run(owner.user.id, deviceId, 'youtube', 'test-channel').lastInsertRowid);
  const foreign = await createUser(`publication-foreign-${Date.now()}@example.test`);
  const foreignWorkspace = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = ?').get(foreign.user.id, 'active').workspace_id;
  const foreignDeviceId = Number(db.prepare('INSERT INTO devices (user_id, workspace_id, device_id, lifecycle_status) VALUES (?, ?, ?, ?)').run(foreign.user.id, foreignWorkspace, 'foreign-android-id', 'active').lastInsertRowid);
  const foreignAccountId = Number(db.prepare('INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, ?, ?)').run(foreign.user.id, foreignDeviceId, 'youtube', 'foreign-channel').lastInsertRowid);

  const ownerHeaders = { Authorization: `Bearer ${owner.token}` };
  const deviceToken = `sfd-test-device-${crypto.randomUUID()}`;
  db.prepare('UPDATE devices SET device_token_hash = ? WHERE id = ?').run(crypto.createHash('sha256').update(deviceToken).digest('hex'), deviceId);
  const deviceHeaders = { Authorization: `Bearer ${deviceToken}` };
  const valid = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(valid.response.status, 201, JSON.stringify(valid.body));
  assert.equal(valid.body.publication.status, 'queued');
  assert.match(valid.body.publication.media.media_key, /^\d+\.(mp4|mov|webm)$/);
  assert.deepEqual(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp'), [valid.body.publication.media.media_key]);
  assert.equal(fs.existsSync(path.join(tempDir, 'public', valid.body.publication.media.media_key)), false);

  const list = await request('/api/publications', { headers: ownerHeaders });
  assert.equal(list.response.status, 200);
  const detail = await request(`/api/publications/${valid.body.publication.id}`, { headers: ownerHeaders });
  assert.equal(detail.response.status, 200);
  assert.equal(JSON.stringify({ list: list.body, detail: detail.body }).includes(mediaRoot), false);
  assert.equal(JSON.stringify({ list: list.body, detail: detail.body }).includes(tempDir), false);
  db.prepare(`INSERT INTO publication_events (publication_job_id, actor_type, actor_id, payload, created_at)
    VALUES (?, 'test', 'corrupt-payload', '{not-json', ?)`).run(valid.body.publication.id, futureIso);
  const corruptEventDetail = await request(`/api/publications/${valid.body.publication.id}`, { headers: ownerHeaders });
  assert.equal(corruptEventDetail.response.status, 200);
  assert.equal(corruptEventDetail.body.publication.events.at(-1).payload, null);

  const deviceCreate = await request('/api/publications', { method: 'POST', headers: deviceHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(deviceCreate.response.status, 403);
  const deviceList = await request('/api/publications', { headers: deviceHeaders });
  assert.equal(deviceList.response.status, 403);
  const deviceDetail = await request(`/api/publications/${valid.body.publication.id}`, { headers: deviceHeaders });
  assert.equal(deviceDetail.response.status, 403);
  const deviceSchedule = await request(`/api/publications/${valid.body.publication.id}/schedule`, { method: 'PATCH', headers: { ...deviceHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_for: futureIso }) });
  assert.equal(deviceSchedule.response.status, 403);
  const deviceCancel = await request(`/api/publications/${valid.body.publication.id}/cancel`, { method: 'POST', headers: deviceHeaders });
  assert.equal(deviceCancel.response.status, 403);

  const unexpectedBody = new FormData();
  unexpectedBody.set('not_video', new Blob([mp4Header], { type: 'video/mp4' }), 'wrong.mp4');
  const unexpected = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: unexpectedBody });
  assert.equal(unexpected.response.status, 400);
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'unexpected file fields must not leave temp media');

  const rescheduledFor = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  const rescheduled = await request(`/api/publications/${valid.body.publication.id}/schedule`, {
    method: 'PATCH', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_for: rescheduledFor }),
  });
  assert.equal(rescheduled.response.status, 200, JSON.stringify(rescheduled.body));
  assert.equal(rescheduled.body.publication.scheduled_for, rescheduledFor);
  const cancelled = await request(`/api/publications/${valid.body.publication.id}/cancel`, { method: 'POST', headers: ownerHeaders });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.publication.status, 'cancelled');
  const unsafeReschedule = await request(`/api/publications/${valid.body.publication.id}/schedule`, {
    method: 'PATCH', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_for: futureIso }),
  });
  assert.equal(unsafeReschedule.response.status, 409);

  for (const options of [
    { caption: 'one two three four five six seven eight nine ten eleven' },
    { caption: 'x'.repeat(101) },
    { scheduledFor: 'not-an-iso-date' },
    { scheduledFor: '2026-08-13' },
    { scheduledFor: '08/13/2026 12:00' },
    { scheduledFor: '2026-08-13T12:00:00' },
    { scheduledFor: '2026-08-13T12:00:00+25:00' },
    { contents: null },
    { type: 'text/plain' },
    { contents: Buffer.from('not an MP4') },
    { contents: Buffer.from('0000001866747970617669660000020061766966', 'hex') },
    { contents: Buffer.from('0000001866747970617669660000020069736f6d', 'hex') },
    { contents: Buffer.from('000000086674797069736f6d', 'hex') },
    { type: 'video/mp4', contents: quicktimeHeader },
    { type: 'video/webm', contents: mp4Header },
    { type: 'video/webm', contents: Buffer.from('1a45dfa39f4282846d6174726f736b61', 'hex') },
    { type: 'video/webm', contents: Buffer.from('1a45dfa39f4282846e6f747765626d', 'hex') },
    { type: 'video/webm', contents: Buffer.from('1a45dfa38aec884282847765626d', 'hex') },
    { type: 'video/webm', contents: Buffer.from('1a45dfa3ff4282847765626d', 'hex') },
  ]) {
    const result = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, ...options }) });
    assert.equal(result.response.status, 400, `${JSON.stringify(options)} ${JSON.stringify(result.body)}`);
  }
  const quicktime = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, type: 'video/quicktime', contents: quicktimeHeader }) });
  assert.equal(quicktime.response.status, 400, 'a recognised container without inspectable video metadata is rejected');
  assert.equal(quicktime.body.error_code, 'MEDIA_METADATA_INVALID');
  const webm = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, type: 'video/webm', contents: webmHeader }) });
  assert.equal(webm.response.status, 400, 'a recognised container without inspectable video metadata is rejected');
  assert.equal(webm.body.error_code, 'MEDIA_METADATA_INVALID');
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 1, 'validation failures must remove temporary/final media');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'validation failures must remove temporary media');

  const jobsBeforeAbort = db.prepare('SELECT COUNT(*) AS count FROM publication_jobs').get().count;
  const mediaBeforeAbort = db.prepare('SELECT COUNT(*) AS count FROM publication_media').get().count;
  const abortRoot = path.join(tempDir, 'abort-media');
  const abortPort = port + 1;
  const abortApp = express();
  abortApp.use(express.json());
  registerPublicationRoutes({
    app: abortApp, db, store: new PublicationStore(db), mediaRoot: abortRoot,
    inspectVideo: async () => ({ duration_seconds: 25, width: 1080, height: 1920, video_codec: 'hevc', audio_codec: 'aac' }),
    auth: (req, _res, next) => { req.user = { userId: owner.user.id, workspaceId: ownerWorkspace, role: 'owner', authType: 'user' }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    testHooks: { afterRename: (req, res) => {
      fs.writeFileSync(abortMarker, 'renamed');
      return new Promise((resolve) => { const done = () => resolve(); req.once('aborted', done); res.once('close', done); });
    } },
  });
  const abortServer = await new Promise((resolve) => { const server = abortApp.listen(abortPort, () => resolve(server)); });
  const abortBoundary = `abort-${crypto.randomUUID()}`;
  const abortBody = Buffer.concat([
    Buffer.from(`--${abortBoundary}\r\nContent-Disposition: form-data; name="video"; filename="abort.mp4"\r\nContent-Type: video/mp4\r\n\r\n`), mp4Header,
    Buffer.from(`\r\n--${abortBoundary}\r\nContent-Disposition: form-data; name="platform"\r\n\r\nyoutube\r\n--${abortBoundary}\r\nContent-Disposition: form-data; name="device_id"\r\n\r\n${deviceId}\r\n--${abortBoundary}\r\nContent-Disposition: form-data; name="social_account_id"\r\n\r\n${accountId}\r\n--${abortBoundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nAbort cleanup proves no publication survives\r\n--${abortBoundary}\r\nContent-Disposition: form-data; name="scheduled_for"\r\n\r\n${futureIso}\r\n--${abortBoundary}--\r\n`),
  ]);
  const abortRequest = http.request({ hostname: '127.0.0.1', port: abortPort, path: '/api/publications', method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': `multipart/form-data; boundary=${abortBoundary}`, 'Content-Length': abortBody.length } });
  abortRequest.on('error', () => {});
  abortRequest.end(abortBody);
  await waitForPath(abortMarker);
  abortRequest.destroy();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publication_jobs').get().count, jobsBeforeAbort, 'aborted upload after rename must not enqueue a job');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM publication_media').get().count, mediaBeforeAbort, 'aborted upload after rename must not retain media metadata');
  assert.equal(fs.readdirSync(abortRoot).filter((name) => name !== '.tmp').length, 0, 'aborted upload after rename must remove final media');
  assert.equal(fs.readdirSync(path.join(abortRoot, '.tmp')).length, 0, 'aborted upload after rename must remove temp media');
  await new Promise((resolve) => abortServer.close(resolve));

  const racePort = port + 2;
  const raceScheduleJob = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(raceScheduleJob.response.status, 201, JSON.stringify(raceScheduleJob.body));
  const raceCancelJob = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(raceCancelJob.response.status, 201, JSON.stringify(raceCancelJob.body));
  const raceApp = express();
  raceApp.use(express.json());
  registerPublicationRoutes({
    app: raceApp, db, store: new PublicationStore(db), mediaRoot: path.join(tempDir, 'race-media'),
    auth: (req, _res, next) => { req.user = { userId: owner.user.id, workspaceId: ownerWorkspace, role: 'owner', authType: 'user' }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    testHooks: {
      beforeReschedule: () => db.prepare("UPDATE publication_jobs SET status = 'claimed' WHERE id = ?").run(raceScheduleJob.body.publication.id),
      beforeCancel: () => db.prepare("UPDATE publication_jobs SET final_action_at = ? WHERE id = ?").run(futureIso, raceCancelJob.body.publication.id),
    },
  });
  const raceServer = await new Promise((resolve) => { const server = raceApp.listen(racePort, () => resolve(server)); });
  const raceScheduleResponse = await fetch(`http://127.0.0.1:${racePort}/api/publications/${raceScheduleJob.body.publication.id}/schedule`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_for: futureIso }) });
  assert.equal(raceScheduleResponse.status, 409, 'store transition race must remain a 409');
  const raceCancelResponse = await fetch(`http://127.0.0.1:${racePort}/api/publications/${raceCancelJob.body.publication.id}/cancel`, { method: 'POST' });
  assert.equal(raceCancelResponse.status, 409, 'store cancellation race must remain a 409');
  await new Promise((resolve) => raceServer.close(resolve));

  const errorJobId = Number(db.prepare(`INSERT INTO publication_jobs
    (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, current_step, created_at, updated_at)
    VALUES (?, ?, ?, 'youtube', 'Database error mapping test', 4, ?, 'queued', 'queued', ?, ?)`).run(ownerWorkspace, deviceId, accountId, futureIso, futureIso, futureIso).lastInsertRowid);
  db.exec(`CREATE TRIGGER publication_test_failure BEFORE UPDATE ON publication_jobs
    WHEN OLD.id = ${errorJobId} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  const internalSchedule = await request(`/api/publications/${errorJobId}/schedule`, {
    method: 'PATCH', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduled_for: futureIso }),
  });
  assert.equal(internalSchedule.response.status, 500);
  assert.equal(internalSchedule.body.error_code, 'INTERNAL_ERROR');
  const internalCancel = await request(`/api/publications/${errorJobId}/cancel`, { method: 'POST', headers: ownerHeaders });
  assert.equal(internalCancel.response.status, 500);
  assert.equal(internalCancel.body.error_code, 'INTERNAL_ERROR');
  db.exec('DROP TRIGGER publication_test_failure');

  const foreignDevice = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId: foreignDeviceId, accountId: foreignAccountId }) });
  assert.equal(foreignDevice.response.status, 404);
  const foreignAccount = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId: foreignAccountId }) });
  assert.equal(foreignAccount.response.status, 404);

  db.prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?").run(ownerWorkspace, owner.user.id);
  const viewer = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(viewer.response.status, 403);
  db.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").run(ownerWorkspace, owner.user.id);

  db.prepare(`INSERT INTO publication_jobs
    (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, current_step, created_at, updated_at)
    VALUES (?, ?, ?, 'youtube', 'Needs manual review', 3, ?, 'review_required', 'review_required', ?, ?)`)
    .run(ownerWorkspace, deviceId, accountId, futureIso, futureIso, futureIso);
  const blockedByReview = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(blockedByReview.response.status, 409);
  assert.equal(blockedByReview.body.error_code, 'REVIEW_REQUIRED');
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 3, 'review gate must clean the uploaded temp file');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'review gate must remove temporary media');
  db.prepare("DELETE FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").run(accountId);

  const orphanTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const orphanId = Number(db.prepare(`INSERT INTO publication_media
    (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, upload_status, created_at, updated_at)
    VALUES (?, ?, 'orphan.mp4', '999.mp4', 'video/mp4', 'mp4', ?, 'orphan', 'staging', ?, ?)`).run(ownerWorkspace, owner.user.id, mp4Header.length, orphanTime, orphanTime).lastInsertRowid);
  fs.writeFileSync(path.join(mediaRoot, '999.mp4'), mp4Header);
  fs.writeFileSync(path.join(mediaRoot, '.tmp', 'orphan.upload'), mp4Header);
  fs.utimesSync(path.join(mediaRoot, '.tmp', 'orphan.upload'), new Date(orphanTime), new Date(orphanTime));
  const outsidePath = path.join(tempDir, 'must-not-delete.mp4');
  fs.writeFileSync(outsidePath, mp4Header);
  const unsafeOrphanId = Number(db.prepare(`INSERT INTO publication_media
    (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, upload_status, created_at, updated_at)
    VALUES (?, ?, 'unsafe.mp4', '../must-not-delete.mp4', 'video/mp4', 'mp4', ?, 'unsafe', 'staging', ?, ?)`).run(ownerWorkspace, owner.user.id, mp4Header.length, orphanTime, orphanTime).lastInsertRowid);
  const linkedStagingId = Number(db.prepare(`INSERT INTO publication_media
    (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, upload_status, created_at, updated_at)
    VALUES (?, ?, 'linked.mp4', 'linked.mp4', 'video/mp4', 'mp4', ?, 'linked', 'staging', ?, ?)`).run(ownerWorkspace, owner.user.id, mp4Header.length, orphanTime, orphanTime).lastInsertRowid);
  fs.writeFileSync(path.join(mediaRoot, 'linked.mp4'), mp4Header);
  db.prepare(`INSERT INTO publication_jobs
    (workspace_id, device_id, social_account_id, media_id, platform, caption, word_count, scheduled_for, status, current_step, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'youtube', 'linked staging media', 3, ?, 'queued', 'queued', ?, ?)`).run(ownerWorkspace, deviceId, accountId, linkedStagingId, futureIso, futureIso, futureIso);
  assert.ok(db.prepare('SELECT id FROM publication_media WHERE id = ?').get(orphanId));
  db.close();
  await stopBackend();
  startBackend();
  await waitForHealth();
  const recoveredDb = new Database(dbPath);
  assert.equal(recoveredDb.prepare('SELECT id FROM publication_media WHERE id = ?').get(orphanId), undefined);
  assert.equal(recoveredDb.prepare('SELECT id FROM publication_media WHERE id = ?').get(unsafeOrphanId), undefined);
  assert.ok(recoveredDb.prepare('SELECT id FROM publication_media WHERE id = ?').get(linkedStagingId), 'linked staging media must survive recovery');
  assert.equal(fs.existsSync(path.join(mediaRoot, '999.mp4')), false);
  assert.equal(fs.existsSync(outsidePath), true, 'recovery must never delete outside the media root');
  assert.equal(fs.existsSync(path.join(mediaRoot, 'linked.mp4')), true, 'recovery must never delete linked media');
  assert.equal(fs.existsSync(path.join(mediaRoot, '.tmp', 'orphan.upload')), false);
  recoveredDb.close();

  // Stream the file body instead of allocating a 200 MiB fixture. Multer must
  // stop the request at its exact 200 MiB file limit and remove its temp file.
  const boundary = `southfarm-${crypto.randomUUID()}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="platform"\r\n\r\nyoutube\r\n--${boundary}\r\nContent-Disposition: form-data; name="device_id"\r\n\r\n${deviceId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="social_account_id"\r\n\r\n${accountId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nA safe SouthFarm publishing test starts right now\r\n--${boundary}\r\nContent-Disposition: form-data; name="scheduled_for"\r\n\r\n${futureIso}\r\n--${boundary}--\r\n`);
  let remaining = 200 * 1024 * 1024 + 1;
  const largeBody = new ReadableStream({
    start(controller) { controller.enqueue(prefix); },
    pull(controller) {
      if (remaining <= 0) { controller.enqueue(suffix); controller.close(); return; }
      const size = Math.min(1024 * 1024, remaining);
      const chunk = Buffer.alloc(size);
      if (remaining === 200 * 1024 * 1024 + 1) mp4Header.copy(chunk);
      remaining -= size;
      controller.enqueue(chunk);
    },
  });
  const large = await request('/api/publications', { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: largeBody, duplex: 'half' });
  assert.equal(large.response.status, 413, JSON.stringify(large.body));
  assert.equal(large.body.error_code, 'VIDEO_TOO_LARGE');
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 4, 'failed uploads must not leave media files');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'oversized uploads must remove temporary media');
  // The initial DB handle was closed before restart recovery.

  console.log('publications-api test passed: upload, ownership, RBAC, validation, privacy, and cleanup');
} finally {
  await stopBackend();
  // Windows may release SQLite/WAL handles just after the child exits. Cleanup
  // is best-effort so it cannot hide the route assertion that failed above.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {}
}
