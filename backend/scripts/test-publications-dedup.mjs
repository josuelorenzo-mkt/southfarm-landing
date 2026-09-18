// Content-based dedup test for POST /api/publications.
//
// Scenario under test (review observation, media idempotency): the client
// uploads the full video, the backend creates the job and answers 201, but the
// response is lost on the wire; the client retries and the backend would
// otherwise enqueue a second identical publication.
//
// Same pattern as test-publications-api.mjs: spawns the real backend
// (dist/index.js) against a throwaway DB and media root, drives it with fetch.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const port = 3322;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'southfarm-publications-dedup-'));
const dbPath = path.join(tempDir, 'southfarm.db');
const mediaRoot = path.join(tempDir, 'private-media');
const backendNodePath = process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath;
const ffmpegDir = 'C:\\Users\\josu_\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin';
const ffprobePath = process.env.SOUTHFARM_TEST_FFPROBE || path.join(ffmpegDir, 'ffprobe.exe');
const ffmpegPath = path.join(ffmpegDir, 'ffmpeg.exe');
let output = '';
let backend;
function startBackend() {
  backend = spawn(backendNodePath, [path.resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env, PORT: String(port), SOUTHFARM_DB_PATH: dbPath, SOUTHFARM_PUBLICATION_MEDIA_ROOT: mediaRoot,
      SOUTHFARM_JWT_SECRET: 'test-only-southfarm-secret', SOUTHFARM_AUTO_PLANNER_ENABLED: 'false', SOUTHFARM_FFPROBE: ffprobePath,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => { output += chunk.toString(); });
  backend.stderr.on('data', (chunk) => { output += chunk.toString(); });
}
async function stopBackend() {
  if (backend?.exitCode !== null) return;
  backend.kill('SIGTERM');
  await new Promise((resolve) => { const timeout = setTimeout(() => { backend.kill('SIGKILL'); resolve(); }, 5000); backend.once('exit', () => { clearTimeout(timeout); resolve(); }); });
}
startBackend();

// Two distinct small real MP4s (h264 320x240, within every platform rule).
// Different source patterns -> different bytes -> different sha256.
function makeVideo(name, source) {
  const file = path.join(tempDir, name);
  execFileSync(ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', source, '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', file]);
  return file;
}
const videoA = makeVideo('video-a.mp4', 'testsrc=duration=2:size=320x240:rate=24');
const videoB = makeVideo('video-b.mp4', 'testsrc2=duration=2:size=320x240:rate=24');
const shaA = crypto.createHash('sha256').update(fs.readFileSync(videoA)).digest('hex');

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

function publicationForm({ deviceId, accountId, file, caption = 'Dedup test publication', platform = 'youtube', scheduledFor }) {
  const body = new FormData();
  body.set('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), path.basename(file));
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
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

try {
  await waitForHealth();
  const owner = await createUser(`publication-dedup-${Date.now()}@example.test`);
  const db = new Database(dbPath);
  const ownerWorkspace = db.prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = ?').get(owner.user.id, 'active').workspace_id;
  const deviceId = Number(db.prepare('INSERT INTO devices (user_id, workspace_id, device_id, device_name, lifecycle_status) VALUES (?, ?, ?, ?, ?)').run(owner.user.id, ownerWorkspace, 'dedup-android-id', 'Dedup Phone', 'active').lastInsertRowid);
  const accountId = Number(db.prepare('INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, ?, ?)').run(owner.user.id, deviceId, 'youtube', 'dedup-channel').lastInsertRowid);
  const ownerHeaders = { Authorization: `Bearer ${owner.token}` };
  const futureIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const jobCount = () => db.prepare('SELECT COUNT(*) AS count FROM publication_jobs').get().count;
  const mediaCount = () => db.prepare('SELECT COUNT(*) AS count FROM publication_media').get().count;

  // 1. First upload creates the job normally.
  const first = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, file: videoA, scheduledFor: futureIso }) });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.duplicate, undefined, 'a fresh upload must not be flagged as duplicate');
  const firstId = first.body.publication.id;
  assert.equal(jobCount(), 1);
  assert.equal(mediaCount(), 1);

  // 2. Same file, same account, right away: retry of a lost 201 must NOT create
  // a second job. Same publication id, 200 + duplicate:true, no leftovers.
  const retry = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, file: videoA, scheduledFor: futureIso }) });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.duplicate, true, 'retry must be flagged duplicate');
  assert.equal(retry.body.publication.id, firstId, 'retry must return the existing publication');
  assert.equal(jobCount(), 1, 'retry must not enqueue a second job');
  assert.equal(mediaCount(), 1, 'retry must not insert a second media row');
  assert.equal(fs.readdirSync(path.join(mediaRoot, '.tmp')).length, 0, 'dedup hit must compensate the freshly uploaded temp file');
  assert.ok(output.includes(`[API] publication dedup hit sha256=${shaA.slice(0, 12)} existing_job=${firstId}`), 'dedup hit must be logged with sha prefix and existing job id');

  // 3. The window covers already-completed jobs (201 lost after the worker
  // finished): force the job to a final state and retry the same bytes.
  db.prepare("UPDATE publication_jobs SET status = 'completed', current_step = 'completed', final_action_at = ?, completed_at = ? WHERE id = ?").run(futureIso, futureIso, firstId);
  const retryCompleted = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, file: videoA, scheduledFor: futureIso }) });
  assert.equal(retryCompleted.response.status, 200, JSON.stringify(retryCompleted.body));
  assert.equal(retryCompleted.body.duplicate, true);
  assert.equal(retryCompleted.body.publication.id, firstId, 'dedup must hit jobs in final state');
  assert.equal(jobCount(), 1);
  assert.equal(mediaCount(), 1);

  // 4. A different file to the same account is a different publication.
  const other = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, file: videoB, scheduledFor: futureIso }) });
  assert.equal(other.response.status, 201, JSON.stringify(other.body));
  assert.equal(other.body.duplicate, undefined);
  assert.notEqual(other.body.publication.id, firstId, 'different content must create a new publication');
  assert.equal(jobCount(), 2, 'different content must create a second job');
  assert.equal(mediaCount(), 2);

  // 5. Dedup is per account: the same bytes on a different account are new.
  const otherAccountId = Number(db.prepare('INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, ?, ?)').run(owner.user.id, deviceId, 'youtube', 'dedup-channel-2').lastInsertRowid);
  const otherAccount = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId: otherAccountId, file: videoA, scheduledFor: futureIso }) });
  assert.equal(otherAccount.response.status, 201, JSON.stringify(otherAccount.body));
  assert.equal(otherAccount.body.duplicate, undefined);
  assert.equal(jobCount(), 3, 'same bytes on a different account must create a new job');
  assert.equal(mediaCount(), 3);

  // 6. Same bytes + same account but a DIFFERENT caption is a new publication:
  // re-publishing a video with new copy is a legitimate operation, not a retry.
  const newCaption = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: publicationForm({ deviceId, accountId, file: videoA, caption: 'Dedup test different caption', scheduledFor: futureIso }) });
  assert.equal(newCaption.response.status, 201, JSON.stringify(newCaption.body));
  assert.equal(newCaption.body.duplicate, undefined);
  assert.notEqual(newCaption.body.publication.id, firstId, 'different caption must create a new publication');
  assert.equal(jobCount(), 4, 'different caption must create a new job');
  assert.equal(mediaCount(), 4);

  db.close();
  console.log('publications dedup test passed: retry of lost 201 returns existing publication (200 + duplicate:true), distinct content/captions/accounts create new jobs');
} finally {
  await stopBackend();
  try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch {}
}
