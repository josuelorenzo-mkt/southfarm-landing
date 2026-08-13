import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const port = 3321;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'southfarm-publications-api-'));
const dbPath = path.join(tempDir, 'southfarm.db');
const mediaRoot = path.join(tempDir, 'private-media');
const backendNodePath = process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath;
const backend = spawn(backendNodePath, [path.resolve('dist/index.js')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    SOUTHFARM_DB_PATH: dbPath,
    SOUTHFARM_PUBLICATION_MEDIA_ROOT: mediaRoot,
    SOUTHFARM_JWT_SECRET: 'test-only-southfarm-secret',
    SOUTHFARM_AUTO_PLANNER_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
backend.stdout.on('data', (chunk) => { output += chunk.toString(); });
backend.stderr.on('data', (chunk) => { output += chunk.toString(); });

const mp4Header = Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex');
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
    { contents: null },
    { type: 'text/plain' },
    { contents: Buffer.from('not an MP4') },
  ]) {
    const result = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, ...options }) });
    assert.equal(result.response.status, 400, `${JSON.stringify(options)} ${JSON.stringify(result.body)}`);
  }
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 1, 'validation failures must remove temporary/final media');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'validation failures must remove temporary media');

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
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 1, 'review gate must clean the uploaded temp file');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'review gate must remove temporary media');
  db.prepare("DELETE FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").run(accountId);

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
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 1, 'failed uploads must not leave media files');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'oversized uploads must remove temporary media');
  db.close();

  console.log('publications-api test passed: upload, ownership, RBAC, validation, privacy, and cleanup');
} finally {
  if (backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => { const timeout = setTimeout(() => { backend.kill('SIGKILL'); resolve(); }, 5000); backend.once('exit', () => { clearTimeout(timeout); resolve(); }); });
  }
  // Windows may release SQLite/WAL handles just after the child exits. Cleanup
  // is best-effort so it cannot hide the route assertion that failed above.
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {}
}
