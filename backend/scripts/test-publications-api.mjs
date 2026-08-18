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
// A local copy of the real fixture: its ffprobe metadata is fixed at creation
// time by the seeded upload, so each fixture below exercises one rule outcome.
function seededMediaFixture(overrides = {}) {
  const file = path.join(tempDir, `seeded-${++seededMediaFixture.sequence}.mp4`);
  fs.writeFileSync(file, mp4Header);
  return { file, metadata: { duration_seconds: 14, width: 1080, height: 1920, video_codec: 'hevc', audio_codec: 'aac', ...overrides } };
}
seededMediaFixture.sequence = 0;

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

  // Fail-closed platform media rules run at creation, before any phone minutes
  // are spent on the job. The uploaded bytes are the same real MP4 every time;
  // only the seeded ffprobe metadata changes, which is what the route validates.
  const rulesFixtures = [
    seededMediaFixture({ video_codec: 'hevc', width: 2160, height: 3840 }),
    seededMediaFixture({ video_codec: 'hevc', width: 1080, height: 1920 }),
    seededMediaFixture({ video_codec: 'vp9', width: 1080, height: 1920 }),
    seededMediaFixture({ video_codec: null, width: null, height: null }),
  ];
  // Multer stores the upload under a random name, so the injected inspector
  // keys on the uploaded byte size; pad each fixture to a unique size.
  for (let index = 0; index < rulesFixtures.length; index += 1) {
    fs.appendFileSync(rulesFixtures[index].file, Buffer.alloc((index + 1) * 137));
    rulesFixtures[index].size = fs.statSync(rulesFixtures[index].file).size;
  }
  const instagramAccountId = Number(db.prepare("INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, 'instagram', 'test-reels')").run(owner.user.id, deviceId).lastInsertRowid);
  const rulesApp = express();
  rulesApp.use(express.json());
  registerPublicationRoutes({
    app: rulesApp, db, store: new PublicationStore(db), mediaRoot: path.join(tempDir, 'rules-media'),
    auth: (req, _res, next) => { req.user = { userId: owner.user.id, workspaceId: ownerWorkspace, role: 'owner', authType: 'user' }; next(); },
    requireRole: () => (_req, _res, next) => next(),
    inspectVideo: async (file) => {
      const fixture = rulesFixtures.find((item) => item.size === fs.statSync(file).size);
      return fixture ? fixture.metadata : { duration_seconds: 14, width: 1080, height: 1920, video_codec: 'hevc', audio_codec: 'aac' };
    },
  });
  const rulesServer = await new Promise((resolve) => { const server = rulesApp.listen(port + 3, () => resolve(server)); });
  const rulesRequest = async (formData) => {
    const response = await fetch(`http://127.0.0.1:${port + 3}/api/publications`, { method: 'POST', headers: { Authorization: `Bearer ${owner.token}` }, body: formData });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  };
  const makeRulesForm = (file) => {
    const value = new FormData();
    value.set('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), 'clip.mp4');
    value.set('platform', 'instagram');
    value.set('device_id', String(deviceId));
    value.set('social_account_id', String(instagramAccountId));
    value.set('caption', 'Platform media rules reject this early');
    value.set('scheduled_for', futureIso);
    return value;
  };
  const unsupported4k = await rulesRequest(makeRulesForm(rulesFixtures[0].file));
  assert.equal(unsupported4k.response.status, 400, JSON.stringify(unsupported4k.body));
  assert.equal(unsupported4k.body.error_code, 'MEDIA_UNSUPPORTED');
  assert.match(unsupported4k.body.error, /Video is hevc 2160x3840 but platform allows max 1080x1920 with h264\/hevc/);
  const supportedHevc = await rulesRequest(makeRulesForm(rulesFixtures[1].file));
  assert.equal(supportedHevc.response.status, 201, JSON.stringify(supportedHevc.body));
  const unsupportedCodec = await rulesRequest(makeRulesForm(rulesFixtures[2].file));
  assert.equal(unsupportedCodec.response.status, 400, JSON.stringify(unsupportedCodec.body));
  assert.equal(unsupportedCodec.body.error_code, 'MEDIA_UNSUPPORTED');
  assert.match(unsupportedCodec.body.error, /Video codec vp9 is not supported: platform allows max 1080x1920 with h264\/hevc/);
  const unsupportedNoMetadata = await rulesRequest(makeRulesForm(rulesFixtures[3].file));
  assert.equal(unsupportedNoMetadata.response.status, 400, JSON.stringify(unsupportedNoMetadata.body));
  assert.equal(unsupportedNoMetadata.body.error_code, 'MEDIA_UNSUPPORTED');
  assert.match(unsupportedNoMetadata.body.error, /Video metadata is missing \(codec or dimensions not inspected\) but platform allows max 1080x1920 with h264\/hevc/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE platform = 'instagram' AND status = 'queued'").get().count, 1, 'only the rule-compliant media may enqueue a job');
  assert.equal(fs.readdirSync(path.join(tempDir, 'rules-media')).filter((name) => name !== '.tmp').length, 1, 'rejected media must not remain in the media root');
  await new Promise((resolve) => rulesServer.close(resolve));

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

  // `result` carries worker evidence (phone accessibility dumps) and must only
  // reach managing roles. Seed it on a job, then confirm list and detail expose
  // it to owner/operator but strip it for viewer.
  db.prepare(`INSERT INTO publication_jobs
    (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, current_step, result, created_at, updated_at)
    VALUES (?, ?, ?, 'youtube', 'Evidence gating', 2, ?, 'completed', 'completed', ?, ?, ?)`)
    .run(ownerWorkspace, deviceId, accountId, futureIso, JSON.stringify({ worker_dump: 'evidence-dump.txt' }), futureIso, futureIso);
  const evidenceJobId = Number(db.prepare("SELECT id FROM publication_jobs WHERE social_account_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1").get(accountId).id);
  const operatorEmail = `publication-operator-${Date.now()}@example.test`;
  const operator = await createUser(operatorEmail);
  const operatorId = Number(operator.user.id);
  // register() created a private workspace for the operator; drop it so the
  // operator resolves to the single owner-workspace membership like every
  // other user under test (workspaceMembership orders by membership id).
  db.prepare('DELETE FROM workspace_members WHERE user_id = ? AND workspace_id != ?').run(operatorId, ownerWorkspace);
  db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'operator', 'active', ?, ?)`).run(ownerWorkspace, operatorId, futureIso, futureIso);
  const operatorHeaders = { Authorization: `Bearer ${operator.token}` };
  const operatorList = await request('/api/publications', { headers: operatorHeaders });
  assert.equal(operatorList.response.status, 200);
  const operatorEvidence = operatorList.body.publications.find((item) => item.id === evidenceJobId);
  assert.ok(operatorEvidence, 'operator must see the evidence job in the list');
  assert.equal(String(operatorEvidence.result), String(JSON.stringify({ worker_dump: 'evidence-dump.txt' })), 'operator list exposes worker evidence');
  const operatorDetail = await request(`/api/publications/${evidenceJobId}`, { headers: operatorHeaders });
  assert.equal(operatorDetail.response.status, 200);
  assert.equal(String(operatorDetail.body.publication.result), String(JSON.stringify({ worker_dump: 'evidence-dump.txt' })), 'operator detail exposes worker evidence');
  const ownerEvidence = await request(`/api/publications/${evidenceJobId}`, { headers: ownerHeaders });
  assert.equal(ownerEvidence.response.status, 200);
  assert.equal(String(ownerEvidence.body.publication.result), String(JSON.stringify({ worker_dump: 'evidence-dump.txt' })), 'owner detail exposes worker evidence');
  db.prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?").run(ownerWorkspace, operatorId);
  const viewerList = await request('/api/publications', { headers: operatorHeaders });
  assert.equal(viewerList.response.status, 200);
  assert.equal('result' in viewerList.body.publications.find((item) => item.id === evidenceJobId), false, 'viewer list must not expose worker evidence');
  assert.equal(viewerList.body.publications.some((item) => Object.prototype.hasOwnProperty.call(item, 'result')), false, 'viewer list must not expose result on any publication');
  const viewerDetail = await request(`/api/publications/${evidenceJobId}`, { headers: operatorHeaders });
  assert.equal(viewerDetail.response.status, 200);
  assert.equal('result' in viewerDetail.body.publication, false, 'viewer detail must not expose worker evidence');

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

  const reviewJobId = Number(db.prepare("SELECT id FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required' ORDER BY id DESC LIMIT 1").get(accountId).id);
  db.prepare('UPDATE publication_jobs SET result = ?, final_action_at = ? WHERE id = ?').run(JSON.stringify({ worker_dump: 'screen-capture.txt' }), futureIso, reviewJobId);
  const deviceReview = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...deviceHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(deviceReview.response.status, 403, 'device tokens cannot resolve reviews');
  db.prepare("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?").run(ownerWorkspace, owner.user.id);
  const viewerReview = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(viewerReview.response.status, 403, 'viewers cannot resolve reviews');
  db.prepare("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = ? AND user_id = ?").run(ownerWorkspace, owner.user.id);
  const invalidAction = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'maybe' }) });
  assert.equal(invalidAction.response.status, 400);
  assert.equal(invalidAction.body.error_code, 'VALIDATION_ERROR');
  const badNote = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss', note: 42 }) });
  assert.equal(badNote.response.status, 400);
  const wrongState = await request(`/api/publications/${valid.body.publication.id}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(wrongState.response.status, 409, 'jobs outside review_required are rejected');
  assert.equal(wrongState.body.error_code, 'UNSAFE_TRANSITION');
  const confirmed = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.publication.status, 'completed');
  assert.equal(confirmed.body.publication.current_step, 'completed');
  assert.ok(confirmed.body.publication.completed_at, 'confirm sets completed_at');
  assert.equal(confirmed.body.publication.verified_at, confirmed.body.publication.completed_at, 'confirm sets verified_at');
  assert.equal(confirmed.body.publication.error_code, null);
  assert.equal(confirmed.body.publication.error_message, null);
  assert.ok(String(confirmed.body.publication.result).startsWith(`${JSON.stringify({ worker_dump: 'screen-capture.txt' })}\n`), 'worker evidence is preserved');
  assert.ok(String(confirmed.body.publication.result).includes('"action":"completed"'), 'manual evidence is appended to result');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").get(accountId).count, 0);
  const confirmedDetail = await request(`/api/publications/${reviewJobId}`, { headers: ownerHeaders });
  const confirmEvent = confirmedDetail.body.publication.events.at(-1);
  assert.equal(confirmEvent.from_status, 'review_required');
  assert.equal(confirmEvent.to_status, 'completed');
  assert.equal(confirmEvent.actor_type, 'user');
  assert.equal(confirmEvent.payload.action, 'completed');
  const unblockedAfterConfirm = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(unblockedAfterConfirm.response.status, 201, `account can publish again after confirm: ${JSON.stringify(unblockedAfterConfirm.body)}`);
  const confirmAgain = await request(`/api/publications/${reviewJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }) });
  assert.equal(confirmAgain.response.status, 409, 'resolved jobs cannot be resolved twice');

  db.prepare(`INSERT INTO publication_jobs
    (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, current_step, result, error_code, error_message, created_at, updated_at)
    VALUES (?, ?, ?, 'youtube', 'Dismiss me', 2, ?, 'review_required', 'review_required', ?, 'VERIFICATION_PENDING', 'Publication completed but could not be verified', ?, ?)`)
    .run(ownerWorkspace, deviceId, accountId, futureIso, JSON.stringify({ worker_dump: 'last-dump.txt' }), futureIso, futureIso);
  const dismissJobId = Number(db.prepare("SELECT id FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required' ORDER BY id DESC LIMIT 1").get(accountId).id);
  const dismissed = await request(`/api/publications/${dismissJobId}/review`, { method: 'POST', headers: { ...ownerHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'dismiss', note: 'El video nunca apareció en la cuenta' }) });
  assert.equal(dismissed.response.status, 200, JSON.stringify(dismissed.body));
  assert.equal(dismissed.body.publication.status, 'failed');
  assert.equal(dismissed.body.publication.current_step, 'failed');
  assert.equal(dismissed.body.publication.error_code, 'REVIEW_DISMISSED');
  assert.equal(dismissed.body.publication.error_message, 'El video nunca apareció en la cuenta');
  assert.equal(dismissed.body.publication.verified_at, null, 'dismiss does not set verified_at');
  assert.ok(String(dismissed.body.publication.result).startsWith(`${JSON.stringify({ worker_dump: 'last-dump.txt' })}\n`), 'worker evidence is preserved on dismiss');
  assert.ok(String(dismissed.body.publication.result).includes('"action":"failed"'), 'manual evidence is appended on dismiss');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").get(accountId).count, 0);
  const dismissedDetail = await request(`/api/publications/${dismissJobId}`, { headers: ownerHeaders });
  const dismissEvent = dismissedDetail.body.publication.events.at(-1);
  assert.equal(dismissEvent.from_status, 'review_required');
  assert.equal(dismissEvent.to_status, 'failed');
  assert.equal(dismissEvent.payload.action, 'failed');
  assert.equal(dismissEvent.payload.error_code, 'REVIEW_DISMISSED');
  const unblockedAfterDismiss = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId }) });
  assert.equal(unblockedAfterDismiss.response.status, 201, `account can publish again after dismiss: ${JSON.stringify(unblockedAfterDismiss.body)}`);

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
  assert.equal(fs.readdirSync(mediaRoot).filter((name) => name !== '.tmp').length, 6, 'failed uploads must not leave media files');
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
