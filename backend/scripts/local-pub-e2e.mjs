// Local end-to-end harness for the publication pipeline (web -> backend -> worker -> phone).
// Usage:
//   node scripts/local-pub-e2e.mjs --video <ruta.mp4> [--caption "..."] [--platform instagram|tiktok|youtube]
//                                  [--port 3325] [--keep] [--monitor]
//
// 1. Prepares a temp DB + media root (reused with --keep).
// 2. Boots backend/dist/index.js with worker-friendly env and waits for /api/health.
// 3. Seeds owner + workspace + real-phone device (android_id aaa9c7a1f6cdb7a1) +
//    instagram/tiktok/youtube social accounts directly in SQLite (same pattern as
//    scripts/test-publication-worker-api.mjs). Keeps last_seen_at fresh every 20s.
// 4. Uploads the video and creates a queued publication job via the HTTP API (201).
// 5. Prints a copy-paste env block (cmd `set` + bash `export`) for the Python worker.
// 6. --monitor polls the job until a terminal status (10 min timeout).
// 7. Ctrl+C kills the backend and removes temporaries (unless --keep).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'review_required', 'cancelled']);
const DEFAULT_VIDEOS_DIR = 'C:\\Users\\josu_\\Downloads\\Videos to test';
const REAL = {
  adb: 'C:/SouthFarm/toolchain/android-sdk/platform-tools/adb.exe',
  serial: '863d00583048313238510ca492874c',
  androidId: 'aaa9c7a1f6cdb7a1',
  instagram: { username: 'marczell.vibes', display: 'Marczellvibes' },
  tiktok: { username: 'marczell.vibes', display: 'marczell.vibes1' },
  // social_accounts UNIQUE(user_id, device_id, platform, username): a stable handle
  // distinct from ig/tiktok is used for youtube; display keeps the channel name.
  youtube: { username: 'MarczellWisdom', display: 'Marczell Wisdom' },
};

function parseArgs(argv) {
  const options = { caption: 'Stay present, tomorrow is not promised', platform: 'instagram', port: 3325, keep: false, monitor: false, video: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--video') options.video = argv[++i];
    else if (arg === '--caption') options.caption = argv[++i];
    else if (arg === '--platform') options.platform = argv[++i];
    else if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--monitor') options.monitor = true;
    else if (arg === '--help' || arg === '-h') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 15).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['instagram', 'tiktok', 'youtube'].includes(options.platform)) throw new Error(`--platform must be instagram, tiktok, or youtube (got ${options.platform})`);
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error('--port must be a positive integer');
  return options;
}

function resolveFfprobe() {
  const candidates = [process.env.SOUTHFARM_TEST_FFPROBE, process.env.SOUTHFARM_FFPROBE,
    'C:\\Users\\josu_\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffprobe.exe', 'ffprobe'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === 'ffprobe') { if (spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0) return candidate; continue; }
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('ffprobe not found: set SOUTHFARM_FFPROBE to a valid ffprobe.exe');
}

function probeDurationSeconds(ffprobe, file) {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
  const duration = result.status === 0 ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(duration) ? duration : Infinity;
}

function pickDefaultVideo(ffprobe) {
  if (!fs.existsSync(DEFAULT_VIDEOS_DIR)) throw new Error(`no --video given and default directory missing: ${DEFAULT_VIDEOS_DIR}`);
  const entries = fs.readdirSync(DEFAULT_VIDEOS_DIR).filter((name) => /\.mp4$/i.test(name)).map((name) => path.join(DEFAULT_VIDEOS_DIR, name));
  if (!entries.length) throw new Error(`no .mp4 files in ${DEFAULT_VIDEOS_DIR}`);
  const probed = entries.map((file) => ({ file, duration: probeDurationSeconds(ffprobe, file), size: fs.statSync(file).size }));
  const short = probed.filter((item) => item.duration <= 60).sort((a, b) => a.duration - b.duration);
  const chosen = short[0] || probed.sort((a, b) => a.size - b.size)[0];
  if (chosen.duration > 60) console.warn(`warning: shortest video is ${chosen.duration.toFixed(1)}s (>60s)`);
  return chosen.file;
}

const options = parseArgs(process.argv.slice(2));

// better-sqlite3 is a native module: it only loads under the Node.js version it was
// compiled for (NODE_MODULE_VERSION). Preflight it in the backend cwd so a version
// mismatch fails fast with instructions instead of a crashed backend child.
{ const probe = spawnSync(process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath, ['-e', "new (require('better-sqlite3'))(':memory:')"], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) {
    console.error('[harness] better-sqlite3 cannot load under the current Node (native module version mismatch).');
    console.error('[harness] run this script with the Node version used for `npm install` (e.g. Node 22), or set SOUTHFARM_TEST_NODE_PATH to that node.exe.');
    process.exit(1);
  }
}

const ffprobe = resolveFfprobe();
const video = options.video ? path.resolve(options.video) : pickDefaultVideo(ffprobe);
if (!fs.existsSync(video)) throw new Error(`video not found: ${video}`);
const duration = probeDurationSeconds(ffprobe, video);
const backendUrl = `http://127.0.0.1:${options.port}`;

const tempDir = path.join(os.tmpdir(), 'southfarm-local-pub-e2e');
const dbPath = path.join(tempDir, 'southfarm.db');
const mediaRoot = path.join(tempDir, 'private-media');
if (options.keep && fs.existsSync(dbPath)) {
  console.log(`[harness] reusing --keep state at ${tempDir}`);
} else {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(mediaRoot, { recursive: true });
  console.log(`[harness] fresh temp state at ${tempDir}`);
}

let backend; let backendOutput = ''; let heartbeat; let db;
function startBackend() {
  backend = spawn(process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath, [path.resolve('dist/index.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(options.port),
      SOUTHFARM_DB_PATH: dbPath,
      SOUTHFARM_PUBLICATION_MEDIA_ROOT: mediaRoot,
      SOUTHFARM_PUBLISHER_WORKER_TOKEN: 'token-test-local',
      SOUTHFARM_PUBLISHER_WORKER_ENABLED: 'true',
      SOUTHFARM_JWT_SECRET: 'secret-test-local',
      SOUTHFARM_FFPROBE: ffprobe,
      SOUTHFARM_DEVICE_ONLINE_WINDOW_SECONDS: '90',
      SOUTHFARM_AUTO_PLANNER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.on('data', (chunk) => { backendOutput += chunk; });
  backend.stderr.on('data', (chunk) => { backendOutput += chunk; });
}
async function stopBackend() {
  clearInterval(heartbeat);
  try { db?.close(); } catch {}
  if (backend?.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => { backend.once('exit', resolve); setTimeout(resolve, 5000).unref?.(); });
  }
  if (!options.keep) fs.rmSync(tempDir, { recursive: true, force: true });
}
process.on('SIGINT', () => { console.log('\n[harness] shutting down'); stopBackend().then(() => process.exit(0)); });
process.on('SIGTERM', () => stopBackend().then(() => process.exit(0)));

async function waitForHealth() {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${backendUrl}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`backend unhealthy at ${backendUrl}: ${backendOutput.slice(-2000)}`);
}
async function request(pathname, init = {}) {
  const response = await fetch(`${backendUrl}${pathname}`, init);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

startBackend();
try {
  await waitForHealth();
  console.log(`[harness] backend healthy at ${backendUrl} (media root ${mediaRoot})`);

  const owner = await request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `local-e2e-${Date.now()}@example.test`, password: 'test-password-123', name: 'Local E2E Owner' }) });
  if (owner.response.status !== 201 || !owner.body?.user?.id) throw new Error(`register failed ${owner.response.status}: ${JSON.stringify(owner.body).slice(0, 400)}`);
  const ownerUserId = owner.body.user.id;
  const ownerHeaders = { Authorization: `Bearer ${owner.body.token}` };

  db = new Database(dbPath);
  const workspaceId = db.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND status = 'active'").get(ownerUserId).workspace_id;
  const now = () => new Date().toISOString();
  const deviceId = Number(db.prepare("INSERT INTO devices (user_id, workspace_id, device_id, installation_id, device_name, lifecycle_status, last_seen_at, paired_at) VALUES (?, ?, ?, ?, 'Marczell phone', 'active', ?, ?)").run(ownerUserId, workspaceId, REAL.androidId, REAL.androidId, now(), now()).lastInsertRowid);
  const accounts = {};
  for (const platform of ['instagram', 'tiktok', 'youtube']) {
    const spec = REAL[platform];
    accounts[platform] = Number(db.prepare('INSERT INTO social_accounts (user_id, device_id, platform, username, display_name) VALUES (?, ?, ?, ?, ?)').run(ownerUserId, deviceId, platform, spec.username, spec.display).lastInsertRowid);
  }
  const refresh = () => db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), deviceId);
  heartbeat = setInterval(refresh, 20_000);
  console.log(`[harness] seeded device row ${deviceId} (device_id=${REAL.androidId}) + accounts ${JSON.stringify(accounts)}`);

  const form = new FormData();
  form.set('video', new Blob([fs.readFileSync(video)], { type: 'video/mp4' }), path.basename(video));
  form.set('platform', options.platform);
  form.set('device_id', String(deviceId));
  form.set('social_account_id', String(accounts[options.platform]));
  form.set('caption', options.caption);
  // The API has no null schedule: scheduled_for is a required RFC3339 field. A
  // near-past timestamp keeps the job immediately due (claimable) like the reference test.
  form.set('scheduled_for', new Date(Date.now() - 1_000).toISOString());
  const created = await request('/api/publications', { method: 'POST', headers: ownerHeaders, body: form });
  if (created.response.status !== 201) throw new Error(`publication create failed ${created.response.status}: ${JSON.stringify(created.body)}`);
  const publication = created.body.publication;
  console.log(`[harness] publication job ${publication.id} created: status=${publication.status} step=${publication.current_step} platform=${publication.platform} caption="${publication.caption}"`);

  const workerEnv = {
    SOUTHFARM_API_URL: backendUrl,
    SOUTHFARM_PUBLISHER_WORKER_TOKEN: 'token-test-local',
    SOUTHFARM_PUBLISHER_WORKER_ID: 'local-e2e-worker',
    SOUTHFARM_PUBLISHER_DEVICE_ID: String(deviceId),
    SOUTHFARM_ADB: REAL.adb,
    SOUTHFARM_ADB_SERIAL: REAL.serial,
    SOUTHFARM_EXPECTED_ANDROID_ID: REAL.androidId,
    SOUTHFARM_BACKEND_DEVICE_ID: REAL.androidId,
    SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS: '',
  };
  const separator = '='.repeat(78);
  console.log('\n' + separator);
  console.log(`JOB ${publication.id} | device row ${deviceId} | video ${path.basename(video)} (${Number.isFinite(duration) ? duration.toFixed(1) : '?'}s)`);
  console.log(`owner token (for webapp/API queries): ${owner.body.token}`);
  console.log(separator + '\n--- Windows cmd ---');
  for (const [key, value] of Object.entries(workerEnv)) console.log(`set ${key}=${value}`);
  console.log('\n--- git bash ---');
  for (const [key, value] of Object.entries(workerEnv)) console.log(`export ${key}="${value}"`);
  console.log(`\nthen run the worker from the repo root: python -m southfarm_publisher.runner (cwd publisher_worker/)`);
  console.log(separator);

  if (options.monitor) {
    console.log('\n[harness] monitoring job (poll 2s, timeout 10 min)...');
    const deadline = Date.now() + 10 * 60_000;
    let last = '';
    while (Date.now() < deadline) {
      const state = await request(`/api/publications/${publication.id}`, { headers: ownerHeaders });
      if (state.response.status !== 200) throw new Error(`monitor query failed ${state.response.status}: ${JSON.stringify(state.body)}`);
      const job = state.body.publication;
      const line = `${new Date().toISOString()} status=${job.status} step=${job.current_step} progress=${job.progress_percent}%`;
      if (line !== last) { console.log(line); last = line; }
      if (TERMINAL_STATUSES.has(job.status)) { console.log(`[harness] terminal status reached: ${job.status}`); break; }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (Date.now() >= deadline) console.warn('[harness] monitor timed out after 10 min');
  } else {
    console.log(`\n[harness] no --monitor: check the job with`);
    console.log(`  curl -H "Authorization: Bearer <owner token>" ${backendUrl}/api/publications/${publication.id}`);
    console.log('[harness] waiting for Ctrl+C (backend stays up for the worker)...');
  }
  await new Promise(() => {});
} catch (error) {
  console.error(`[harness] failed: ${error.stack || error.message}`);
  if (backendOutput) console.error(backendOutput.slice(-2000));
  await stopBackend();
  process.exit(1);
}
