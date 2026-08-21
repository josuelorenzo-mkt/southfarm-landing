#!/usr/bin/env node
// SouthFarm Activity Planner — integration test suite (FIX 1..8 + addenda).
//
// Runs against a LIVE server (default http://127.0.0.1:3103) started with
// SOUTHFARM_DB_PATH pointing at a COPY of the staging DB. Direct DB fixtures
// (viewer user, isolation cluster, QA cluster, task_runs with arbitrary
// statuses) are written through a second better-sqlite3 connection (WAL-safe)
// via the `sql()` helper below.
//
// Env:
//   TEST_API      base url (default http://127.0.0.1:3103)
//   TEST_DB_PATH  absolute path of the test DB (required for sql fixtures)
//   TEST_NODE     node binary for sql fixtures (default process.execPath)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.TEST_API || 'http://127.0.0.1:3103';
const DB_PATH = process.env.TEST_DB_PATH;
const NODE = process.env.TEST_NODE || process.execPath;
const WS_ID = 6; // workspace of staging@southfarm.local
const OWNER_ID = 22; // staging@southfarm.local
const BA_TZ = 'America/Argentina/Buenos_Aires';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── sql helper: run statements on the test DB from a second process ──
function sql(ops) {
  if (!DB_PATH) throw new Error('TEST_DB_PATH is required');
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1], { fileMustExist: true });
    const ops = JSON.parse(process.argv[2]);
    const out = [];
    for (const op of ops) {
      const st = db.prepare(op.sql);
      out.push(op.all ? st.all(...(op.params || [])) : op.run ? st.run(...(op.params || [])) : st.get(...(op.params || [])));
    }
    console.log(JSON.stringify(out));
  `;
  const res = spawnSync(NODE, ['-e', script, DB_PATH, JSON.stringify(ops)], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error('sql helper failed: ' + res.stderr);
  return JSON.parse(res.stdout);
}
const all = (sqlText, params) => sql([{ sql: sqlText, all: true, params: params || [] }])[0];
const get = (sqlText, params) => sql([{ sql: sqlText, params: params || [] }])[0];
const run = (sqlText, params) => sql([{ sql: sqlText, run: true, params: params || [] }])[0];

function nowIso() { return new Date().toISOString(); }
function addHours(iso, hours) { return new Date(Date.parse(iso) + hours * 3600e3).toISOString(); }
function baDateKey(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const v = (t) => parts.find((p) => p.type === t)?.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}
const DAY_OFFSETS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function baWeekdayIndex(iso) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: BA_TZ, weekday: 'short' })
    .formatToParts(new Date(iso)).find((p) => p.type === 'weekday')?.value;
  return DAY_OFFSETS[wd] ?? 0;
}
function baMondayOf(dateKey) {
  const instant = new Date(dateKey + 'T12:00:00Z').getTime();
  return baDateKey(new Date(instant - baWeekdayIndex(dateKey + 'T12:00:00Z') * 86400e3).toISOString());
}
function addDaysKey(dateKey, days) {
  return baDateKey(new Date(Date.parse(dateKey + 'T12:00:00Z') + days * 86400e3).toISOString());
}

function insertTask({
  userId = OWNER_ID, deviceId = null, taskType, platform = 'instagram', status = 'pending',
  scheduledFor, priority = 0, clusterId = null, routineId = null,
  accountKey = null, socialAccountId = null, params = {}, source = 'automatic',
}) {
  const overdueAt = addHours(scheduledFor, 2);
  const expiresAt = addHours(scheduledFor, 36);
  const now = nowIso();
  const row = {
    user_id: userId, device_id: deviceId, workspace_id: WS_ID, task_type: taskType,
    platform, source, params: JSON.stringify(params), status, scheduled_for: scheduledFor,
    overdue_at: overdueAt, expires_at: expiresAt,
    planned_duration_sec: params.duration_minutes ? params.duration_minutes * 60 : 1200,
    actual_duration_sec: 0, social_account_id: socialAccountId, account_key: accountKey,
    cluster_id: clusterId, routine_id: routineId, manual_override: 0, priority,
    attempt_count: 0, created_at: now, updated_at: now,
  };
  const cols = Object.keys(row);
  return run(`INSERT INTO task_runs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, Object.values(row));
}

// ── http helper ──
async function api(pathname, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + pathname, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, json, text };
}

async function login(email, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  return res.json.token;
}

async function pairDevice(token, { deviceId, installationId }) {
  const p = await api('/api/devices/pairing-codes', { method: 'POST', token });
  if (p.status !== 201) throw new Error('pairing-codes failed: ' + p.status + ' ' + p.text);
  const claim = await api('/api/devices/claim', {
    method: 'POST', token,
    body: { code: p.json.pairing.code, access_key: p.json.pairing.access_key, device_id: deviceId, installation_id: installationId },
  });
  if (claim.status !== 201) throw new Error('device claim failed: ' + claim.status + ' ' + claim.text);
  return { deviceToken: claim.json.device_token, device: claim.json.device };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ─────────────────────────────────────────────────────────────────────
const started = Date.now();
let token = null;
let ownerToken = null;
const summary = {};

async function main() {
  const health = await api('/api/health');
  if (health.status !== 200) throw new Error('server not reachable on ' + BASE);

  // ============ TEST 1 — AUTH / RBAC ============
  ownerToken = await login('staging@southfarm.local', 'southfarm');
  token = ownerToken;
  check('1a. login owner ws6', true);

  const bad = await api('/api/planner/week', { token: 'not-a-token' });
  check('1b. invalid token -> 401', bad.status === 401, `status=${bad.status}`);

  // viewer: direct INSERT user (copying the staging password hash) + membership
  const viewerEmail = 'viewer-planner@southfarm.local';
  const viewerRow = get(`SELECT id FROM users WHERE email = ?`, [viewerEmail]);
  if (!viewerRow) {
    run(`INSERT INTO users (email, password, name) SELECT ?, password, 'Planner Viewer' FROM users WHERE id = 22`, [viewerEmail]);
  }
  const viewerUser = get(`SELECT id FROM users WHERE email = ?`, [viewerEmail]);
  const viewerMember = get(`SELECT id FROM workspace_members WHERE workspace_id = ${WS_ID} AND user_id = ?`, [viewerUser.id]);
  if (!viewerMember) {
    run(`INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
         VALUES (${WS_ID}, ?, 'viewer', 'active', ?, ?)`, [viewerUser.id, nowIso(), nowIso()]);
  }
  const viewerToken = await login(viewerEmail, 'southfarm');
  const viewerPost = await api('/api/clusters', { method: 'POST', token: viewerToken, body: { name: 'No permitido' } });
  check('1c. viewer POST /api/clusters -> 403', viewerPost.status === 403, `status=${viewerPost.status}`);
  const viewerWeek = await api('/api/planner/week', { token: viewerToken });
  check('1d. viewer GET /api/planner/week -> 200', viewerWeek.status === 200, `status=${viewerWeek.status}`);

  // ============ TEST 9 — ISOLATION ============
  run(`INSERT INTO account_clusters (workspace_id, name, status, detection_method, created_at, updated_at)
       VALUES (1, 'Isolated WS1 Cluster', 'confirmed', 'manual', ?, ?)`, [nowIso(), nowIso()]);
  const isoClusters = await api('/api/clusters', { token });
  const isoIds = (isoClusters.json.clusters || []).map((c) => c.name);
  check('9a. cluster of other workspace invisible in GET /api/clusters',
    !isoIds.includes('Isolated WS1 Cluster'), JSON.stringify(isoIds));
  const isoWeek = await api('/api/planner/week', { token });
  const isoWeekNames = (isoWeek.json.clusters || []).map((c) => c.name);
  check('9b. cluster of other workspace invisible in GET /api/planner/week',
    !isoWeekNames.includes('Isolated WS1 Cluster'), JSON.stringify(isoWeekNames));

  // ============ QA CLUSTER FIXTURE ============
  const created = await api('/api/clusters', { method: 'POST', token, body: { name: 'QA Test Cluster' } });
  if (created.status !== 201) throw new Error('cluster creation failed: ' + created.status + ' ' + created.text);
  const clusterId = created.json.id;
  summary.clusterId = clusterId;
  const routines = all(`SELECT id, routine_type, status FROM cluster_routines WHERE cluster_id = ${clusterId}`);
  const warmupRoutine = routines.find((r) => r.routine_type === 'warmup_daily');
  const scanRoutine = routines.find((r) => r.routine_type === 'scan_auto');
  const publishRoutine = routines.find((r) => r.routine_type === 'publishing');

  const memberAdd = await api(`/api/clusters/${clusterId}/members`, {
    method: 'POST', token, body: { accountIds: [474] },
  });
  check('fixture: member 474 added (active device 24)', memberAdd.status === 200 && memberAdd.json.added === 1, JSON.stringify(memberAdd.json));

  const todayKey = baDateKey(nowIso());
  const tomorrowKey = addDaysKey(todayKey, 1);
  const currentMonday = baMondayOf(todayKey);
  const nextMonday = addDaysKey(currentMonday, 7);
  const account474 = get(`SELECT id, user_id, device_id, platform, username, account_key
                          FROM social_accounts WHERE id = 474`);
  const warmupBase = {
    taskType: 'warmup_ig', platform: 'instagram', clusterId, routineId: warmupRoutine.id,
    accountKey: account474.account_key, socialAccountId: 474, deviceId: 24,
    params: { account: account474.username, platform: 'instagram', duration_minutes: 20, cluster_id: clusterId, routine_id: warmupRoutine.id, cluster_name: 'QA Test Cluster', social_account_id: 474, account_key: account474.account_key },
  };

  // ============ TEST 4 (FIX 3 + FIX 6) — REGENERATION ============
  // clear today's live warmup tasks for the QA cluster so the day is free
  run(`UPDATE task_runs SET status = 'cancelled', cancel_reason = 'fixture_clear'
       WHERE cluster_id = ? AND routine_id = ?
         AND status IN ('pending', 'overdue') AND scheduled_for >= ? AND scheduled_for < ?`,
    [clusterId, warmupRoutine.id, todayKey + 'T00:00:00.000Z', addHours(todayKey + 'T00:00:00.000Z', 24)]);
  // FIX 6: overdue task for TODAY (direct DB insert, status overdue)
  const overdueId = insertTask({ ...warmupBase, status: 'overdue', scheduledFor: todayKey + 'T15:00:00.000Z', priority: 0 }).lastInsertRowid;
  const genFix6 = await api('/api/planner/week/generate', { method: 'POST', token, body: {} });
  const overdueAfter = get(`SELECT status, cancel_reason FROM task_runs WHERE id = ${overdueId}`);
  check('4a. (FIX 6) overdue task cancelled + day regenerated',
    overdueAfter.status === 'cancelled' && overdueAfter.cancel_reason === 'routine_overdue_replanned'
    && genFix6.json.created >= 1,
    `created=${genFix6.json.created} status=${overdueAfter.status} reason=${overdueAfter.cancel_reason}`);
  const genFix6b = await api('/api/planner/week/generate', { method: 'POST', token, body: {} });
  check('4b. (FIX 6) second generate -> created 0 (idempotent)', genFix6b.json.created === 0, `created=${genFix6b.json.created}`);

  // FIX 3: EXPIRED task on tomorrow -> day regenerates (expired no longer blocks)
  const fix3Start = baMondayOf(tomorrowKey);
  run(`UPDATE task_runs SET status = 'cancelled', cancel_reason = 'fixture_clear'
       WHERE cluster_id = ? AND routine_id = ?
         AND status IN ('pending', 'overdue') AND scheduled_for >= ? AND scheduled_for < ?`,
    [clusterId, warmupRoutine.id, tomorrowKey + 'T00:00:00.000Z', addHours(tomorrowKey + 'T00:00:00.000Z', 24)]);
  const expiredId = insertTask({ ...warmupBase, status: 'expired', scheduledFor: tomorrowKey + 'T16:00:00.000Z' }).lastInsertRowid;
  const genFix3 = await api('/api/planner/week/generate', { method: 'POST', token, body: { start: fix3Start } });
  const tomorrowLive = get(`SELECT COUNT(*) AS c FROM task_runs WHERE cluster_id = ${clusterId}
    AND routine_id = ${warmupRoutine.id} AND status = 'pending'
    AND scheduled_for >= ? AND scheduled_for < ?`,
    [tomorrowKey + 'T00:00:00.000Z', addHours(tomorrowKey + 'T00:00:00.000Z', 24)]);
  check('4c. (FIX 3) expired does not block; day regenerated',
    genFix3.json.created >= 1 && Number(tomorrowLive.c) >= 1, `created=${genFix3.json.created} live=${tomorrowLive.c}`);
  const expiredAfter = get(`SELECT status FROM task_runs WHERE id = ${expiredId}`);
  check('4d. (FIX 3) expired row left untouched (history preserved)', expiredAfter.status === 'expired', `status=${expiredAfter.status}`);
  const genFix3b = await api('/api/planner/week/generate', { method: 'POST', token, body: { start: fix3Start } });
  check('4e. (FIX 3) second generate -> created 0', genFix3b.json.created === 0, `created=${genFix3b.json.created}`);

  // ============ TEST 8 (FIX 7) — REVOKED DEVICE ============
  const revokedId = insertTask({
    ...warmupBase, deviceId: 16, status: 'pending', scheduledFor: addHours(nowIso(), -1),
  }).lastInsertRowid;
  const genFix7 = await api('/api/planner/week/generate', { method: 'POST', token, body: {} });
  const revokedAfter = get(`SELECT status, cancel_reason FROM task_runs WHERE id = ${revokedId}`);
  check('8a. (FIX 7) pending task on revoked device cancelled',
    revokedAfter.status === 'cancelled' && revokedAfter.cancel_reason === 'device_revoked',
    `status=${revokedAfter.status} reason=${revokedAfter.cancel_reason}`);
  const revokedNew = get(`SELECT COUNT(*) AS c FROM task_runs WHERE cluster_id = ${clusterId} AND device_id = 16 AND status = 'pending'`).c;
  check('8b. (FIX 7) nothing regenerated for revoked device', Number(revokedNew) === 0, `pending=${revokedNew}`);
  const revokedOrphans = get(`SELECT COUNT(*) AS c FROM task_runs tr JOIN devices d ON d.id = tr.device_id
    WHERE tr.workspace_id = ${WS_ID} AND tr.status IN ('pending', 'overdue') AND d.lifecycle_status != 'active'`).c;
  check('8c. (FIX 7) self-heal: no pending/overdue tasks left on revoked devices in ws6',
    Number(revokedOrphans) === 0, `after=${revokedOrphans}`);

  // ============ TEST 3 (FIX 2) — NO PLACEHOLDER MATERIALIZATION ============
  // snapshot: publish_reel created AFTER the generate run must not grow
  // (FIX 7 cleanup may cancel legacy placeholders, so count pending/overdue only)
  const publishPendingBefore = get(`SELECT COUNT(*) AS c FROM task_runs WHERE workspace_id = ${WS_ID} AND task_type = 'publish_reel' AND status IN ('pending','overdue')`).c;
  const genFix2 = await api('/api/planner/week/generate', { method: 'POST', token, body: {} });
  const publishPendingAfter = get(`SELECT COUNT(*) AS c FROM task_runs WHERE workspace_id = ${WS_ID} AND task_type = 'publish_reel' AND status IN ('pending','overdue')`).c;
  check('3a. (FIX 2) generate did not materialize publish_reel tasks',
    Number(publishPendingAfter) <= Number(publishPendingBefore), `before=${publishPendingBefore} after=${publishPendingAfter}`);

  const weekNow = await api(`/api/planner/week?start=${currentMonday}`, { token });
  const clusterNow = weekNow.json.clusters.find((c) => c.id === clusterId);
  const placeholderTasks = (weekNow.json.clusters || []).flatMap((c) => c.tasks || [])
    .filter((t) => t.taskType === 'publish_reel' && !(t.params && (t.params.assetId || t.params.asset_id || t.params.video_url)));
  check('3b. (FIX 2) no placeholder publish_reel in week tasks[]', placeholderTasks.length === 0,
    `placeholders=${placeholderTasks.length}`);

  const weekNext = await api(`/api/planner/week?start=${nextMonday}`, { token });
  const clusterNext = weekNext.json.clusters.find((c) => c.id === clusterId);
  check('3c. (FIX 2) posts series planned from routine (next week Tue/Thu)',
    Array.isArray(clusterNext.metricSeries.posts)
    && clusterNext.metricSeries.posts[1] === 1 && clusterNext.metricSeries.posts[3] === 1,
    `posts=${JSON.stringify(clusterNext.metricSeries.posts)}`);
  const publishTasksNext = (clusterNext.tasks || []).filter((t) => t.taskType === 'publish_reel');
  check('3d. (FIX 2) next week has plan but no materialized publish tasks',
    publishTasksNext.length === 0, `publishTasks=${publishTasksNext.length}`);
  check('3e. (FIX 2) summary.publishTotal >= 2 (routine plan next week)',
    Number(weekNext.json.summary.publishTotal) >= 2, `publishTotal=${weekNext.json.summary.publishTotal}`);

  // ============ TEST 2 (FIX 1) — CLAIM FILTER ============
  const dev = await pairDevice(token, { deviceId: 'test-device-3103', installationId: 'sf-install-test-3103' });
  summary.testDevice = { id: dev.device.id, key: dev.device.device_id, installationId: 'sf-install-test-3103' };
  const testDeviceId = dev.device.id;
  const warmupClaimId = insertTask({
    userId: OWNER_ID, deviceId: testDeviceId, taskType: 'warmup_ig', platform: 'instagram',
    scheduledFor: addHours(nowIso(), -5 / 60), priority: 0,
    params: { account: 'testaccount', platform: 'instagram', duration_minutes: 20 },
  }).lastInsertRowid;
  const publishClaimId = insertTask({
    userId: OWNER_ID, deviceId: testDeviceId, taskType: 'publish_reel', platform: 'instagram',
    scheduledFor: addHours(nowIso(), -1), priority: 200, // would win by priority if claimable
    params: { account: 'testaccount', platform: 'instagram', duration_minutes: 1, title: 'x', video_url: '' },
  }).lastInsertRowid;
  const claimBody = { device_id: dev.device.device_id, installation_id: 'sf-install-test-3103' };
  const claim1 = await api('/api/tasks/claim', { method: 'POST', token: dev.deviceToken, body: claimBody });
  check('2a. (FIX 1) claim returns the executable warmup (never publish_reel)',
    claim1.json.claimed === true && claim1.json.task.task_type === 'warmup_ig'
    && Number(claim1.json.task.id) === Number(warmupClaimId),
    `claimed=${claim1.json.claimed} type=${claim1.json.task && claim1.json.task.task_type} id=${claim1.json.task && claim1.json.task.id}`);
  const publishAfterClaim = get(`SELECT status, claim_token FROM task_runs WHERE id = ${publishClaimId}`);
  check('2b. (FIX 1) publish_reel untouched (no lease/claim)',
    ['pending', 'overdue'].includes(publishAfterClaim.status) && publishAfterClaim.claim_token === null,
    `status=${publishAfterClaim.status}`);
  const claim2 = await api('/api/tasks/claim', { method: 'POST', token: dev.deviceToken, body: claimBody });
  check('2c. (FIX 1) second claim reuses the running warmup, publish still excluded',
    claim2.json.claimed === true && claim2.json.reused === true
    && Number(claim2.json.task.id) === Number(warmupClaimId),
    `reused=${claim2.json.reused} id=${claim2.json.task && claim2.json.task.id}`);

  // ============ TEST 10 — FULL DEVICE FLOW (claim -> heartbeat -> complete) ============
  // Device 24 (a66078d5b320725d) belongs to user 12 (staging device of account 474);
  // re-pairing with the owner token keeps user_id=12 (touchDevice never rewrites it),
  // so the claim scope is user 12. Clean the claimable backlog first so the flow is
  // deterministic (the staging DB has past overdue warmup rows on device 24).
  run(`UPDATE task_runs SET status = 'cancelled', cancel_reason = 'fixture_clear'
       WHERE device_id = 24 AND status IN ('pending', 'overdue')
         AND (scheduled_for IS NULL OR scheduled_for <= ?)`, [nowIso()]);
  const dev24 = await pairDevice(token, { deviceId: 'a66078d5b320725d', installationId: 'sf-install-655660d60c026cc06b493dd8' });
  const flowTaskId = insertTask({
    ...warmupBase, userId: 12, deviceId: 24, status: 'pending',
    scheduledFor: addHours(nowIso(), -30 / 3600), priority: 1000,
  }).lastInsertRowid;
  const flowClaim = await api('/api/tasks/claim', {
    method: 'POST', token: dev24.deviceToken,
    body: { device_id: 'a66078d5b320725d', installation_id: 'sf-install-655660d60c026cc06b493dd8' },
  });
  check('10a. device flow: claim returns our high-priority warmup',
    flowClaim.json.claimed === true && Number(flowClaim.json.task.id) === Number(flowTaskId),
    `claimed=${flowClaim.json.claimed} id=${flowClaim.json.task && flowClaim.json.task.id}`);
  const flowToken = flowClaim.json.claim_token;
  const hb = await api(`/api/tasks/runs/${flowTaskId}/heartbeat`, {
    method: 'POST', token: dev24.deviceToken,
    body: { device_id: 'a66078d5b320725d', claim_token: flowToken },
  });
  check('10b. device flow: heartbeat ok', hb.status === 200 && hb.json.ok === true, `status=${hb.status}`);
  const done = await api(`/api/tasks/runs/${flowTaskId}`, {
    method: 'PATCH', token: dev24.deviceToken,
    body: {
      status: 'completed', device_id: 'a66078d5b320725d', claim_token: flowToken,
      result: { elapsed_sec: 1500, timestamp: nowIso(), account: account474.username, platform: 'instagram' },
    },
  });
  check('10c. device flow: PATCH completed ok', done.status === 200 && done.json.ok === true, `status=${done.status}`);
  const session = get(`SELECT id, elapsed_sec, account_key FROM warmup_sessions WHERE task_run_id = ${flowTaskId}`);
  check('10d. device flow: warmup_sessions row created',
    Boolean(session) && Number(session.elapsed_sec) === 1500, JSON.stringify(session));
  const flowTask = get(`SELECT status FROM task_runs WHERE id = ${flowTaskId}`);
  check('10e. device flow: task completed', flowTask.status === 'completed', `status=${flowTask.status}`);
  const weekAfterFlow = await api(`/api/planner/week?start=${currentMonday}`, { token });
  const clusterFlow = weekAfterFlow.json.clusters.find((c) => c.id === clusterId);
  const todayIndex = baWeekdayIndex(nowIso());
  const warmupSeries = clusterFlow.metricSeries.warmup;
  check('10f. device flow: week warmup series reflects executed minutes today',
    todayIndex >= 0 && Number(warmupSeries[todayIndex]) >= 25, `series=${JSON.stringify(warmupSeries)} todayIdx=${todayIndex}`);

  // ============ TEST 6 (FIX 8) — REAL PUBLISH + ASSET + PUBLICATIONS ============
  // Single queue (2026-08-21): the planner publish creates publication_jobs
  // (executed by the PC publisher workers), not publish_reel task_runs. The
  // uploaded video must be a real MP4 because the bridge inspects it with
  // ffprobe before creating jobs.
  const videoBytes = fs.readFileSync(path.join(BACKEND_ROOT, 'scripts', 'fixtures', 'test-reel.mp4'));
  const form = new FormData();
  form.append('video', new Blob([videoBytes], { type: 'video/mp4' }), 'test-reel.mp4');
  form.append('title', 'Reel de integración');
  const pub = await api(`/api/clusters/${clusterId}/publish`, { method: 'POST', token, form });
  check('6a. publish multipart -> created 1 job + assetId',
    pub.status === 201 && pub.json.created === 1 && typeof pub.json.assetId === 'string'
      && Array.isArray(pub.json.publicationIds) && pub.json.publicationIds.length === 1,
    `status=${pub.status} ${JSON.stringify(pub.json)}`);
  const assetId = pub.json.assetId;
  const assetRes = await fetch(BASE + `/assets/cluster/${assetId}`, { headers: { authorization: `Bearer ${token}` } });
  const assetBytes = Buffer.from(await assetRes.arrayBuffer());
  check('6b. GET /assets/cluster/:assetId returns video bytes',
    assetRes.status === 200 && assetBytes.length === videoBytes.length, `status=${assetRes.status} bytes=${assetBytes.length}`);
  const jobRow = get(`SELECT * FROM publication_jobs WHERE id = ${pub.json.publicationIds[0]}`);
  check('6a2. publication job queued in the single queue',
    Boolean(jobRow) && jobRow.status === 'queued' && jobRow.cluster_id === clusterId
      && jobRow.caption === 'Reel de integración' && Number(jobRow.device_id) === 24,
    JSON.stringify(jobRow ? { id: jobRow.id, status: jobRow.status, cluster_id: jobRow.cluster_id } : null));
  const noTaskRuns = get(`SELECT COUNT(*) AS c FROM task_runs WHERE task_type = 'publish_reel' AND cluster_id = ${clusterId}`).c;
  check('6a3. no publish_reel task_runs created (single queue)',
    Number(noTaskRuns) === 0, `task_runs=${noTaskRuns}`);

  const pubs = await api('/api/planner/publications', { token });
  const pubJob = (pubs.json.publications || []).find((p) => p.assetUrl === `/assets/cluster/${assetId}`);
  check('6c. (FIX 8) GET /api/planner/publications lists the job with assetUrl',
    pubs.status === 200 && Boolean(pubJob)
      && pubJob.clusterId === clusterId && pubJob.title === 'Reel de integración'
      && pubJob.platform === 'instagram' && pubJob.account === account474.username
      && pubJob.source === 'publication_jobs' && pubJob.job_status === 'queued',
    JSON.stringify(pubJob || pubs.json));

  const weekWithPublish = await api(`/api/planner/week?start=${currentMonday}`, { token });
  const clusterPub = weekWithPublish.json.clusters.find((c) => c.id === clusterId);
  const stalePublishTask = (clusterPub.tasks || []).find((t) => t.taskType === 'publish_reel' && t.params && t.params.assetId === assetId);
  check('6d. week tasks[] carries no real publish task (jobs live in the publication queue)',
    !stalePublishTask, JSON.stringify(stalePublishTask || null));
  const history = await api(`/api/clusters/${clusterId}`, { token });
  const historyPub = (history.json.history.publications || []).find((p) => p.assetUrl === `/assets/cluster/${assetId}`);
  check('6e. cluster history lists the queued job with assetUrl',
    Boolean(historyPub) && historyPub.status === 'queued' && historyPub.job_status === 'queued', JSON.stringify(historyPub));

  // Week/day views must expose the queued job (single queue) so the owner
  // sees newly created publications in the planner.
  const weekPub = (clusterPub.publications || []).find((p) => p.assetUrl === `/assets/cluster/${assetId}`);
  check('6f. (single queue) week view lists the job in cluster.publications',
    Boolean(weekPub) && weekPub.clusterId === clusterId && weekPub.title === 'Reel de integración'
      && weekPub.status === 'queued' && weekPub.job_status === 'queued'
      && weekPub.account === account474.username && weekPub.platform === 'instagram',
    JSON.stringify(weekPub || null));
  const todayBA = baDateKey(nowIso());
  const dayWithPublish = await api(`/api/planner/day?date=${todayBA}`, { token });
  const dayPub = (dayWithPublish.json.publications || []).find((p) => p.assetUrl === `/assets/cluster/${assetId}`);
  check('6g. (single queue) day view lists the job in publications[]',
    dayWithPublish.status === 200 && Boolean(dayPub)
      && dayPub.clusterId === clusterId && dayPub.platform === 'instagram'
      && dayPub.status === 'queued' && dayPub.account === account474.username,
    JSON.stringify(dayPub || dayWithPublish.json));

  // ============ TEST 7 (FIX 4) — PUBLISH WITHOUT VIDEO ============
  const invalid = await api(`/api/clusters/${clusterId}/publish`, {
    method: 'POST', token,
    body: { title: 'Sin video', video_url: '', videoUrl: '' },
  });
  check('7a. (FIX 4) publish without file and empty video_url -> 400',
    invalid.status === 400, `status=${invalid.status} ${invalid.text}`);
  const invalid2 = await api(`/api/clusters/${clusterId}/publish`, { method: 'POST', token, body: {} });
  check('7b. (FIX 4) publish with no body -> 400', invalid2.status === 400, `status=${invalid2.status}`);
  const invalidCount = get(`SELECT COUNT(*) AS c FROM task_runs WHERE task_type = 'publish_reel' AND cluster_id = ${clusterId}`).c;
  check('7c. (FIX 4) no publish task created by invalid publishes (queue stays empty)',
    Number(invalidCount) === 0, `task_runs=${invalidCount}`);

  // ============ TEST 5 — ROUTINES ============
  const warmupRoutineId = warmupRoutine.id;
  const cfgPut = await api(`/api/clusters/${clusterId}/routines/${warmupRoutineId}`, {
    method: 'PUT', token,
    body: { config: { minMinutes: 60, sessionsPerDay: 2 }, status: 'approved' },
  });
  check('5a. routine config + approved -> regenerated', cfgPut.status === 200 && cfgPut.json.regenerated === true,
    `status=${cfgPut.status} regenerated=${cfgPut.json.regenerated}`);
  const afterApprove = get(`SELECT COUNT(*) AS c FROM task_runs WHERE cluster_id = ${clusterId} AND routine_id = ${warmupRoutineId} AND status = 'pending'`).c;
  check('5b. routine approve regenerated pending tasks', Number(afterApprove) >= 4, `pending=${afterApprove}`);

  const paused = await api(`/api/clusters/${clusterId}/routines/${warmupRoutineId}`, {
    method: 'PUT', token, body: { status: 'paused' },
  });
  const pendingAfterPause = get(`SELECT COUNT(*) AS c FROM task_runs WHERE cluster_id = ${clusterId} AND routine_id = ${warmupRoutineId} AND status = 'pending'`).c;
  const cancelledPause = get(`SELECT COUNT(*) AS c FROM task_runs WHERE cluster_id = ${clusterId} AND routine_id = ${warmupRoutineId} AND status = 'cancelled' AND cancel_reason = 'routine_paused'`).c;
  check('5c. paused -> future tasks cancelled',
    paused.status === 200 && Number(pendingAfterPause) === 0 && Number(cancelledPause) > 0,
    `pending=${pendingAfterPause} cancelled=${cancelledPause}`);

  const reapprove = await api(`/api/clusters/${clusterId}/routines/${warmupRoutineId}`, {
    method: 'PUT', token, body: { config: { minMinutes: 60, sessionsPerDay: 2 }, status: 'approved' },
  });
  // sessionsPerDay=2 and 1 member account -> exactly 2 pending per slot, never more
  const dupCheck = get(`SELECT scheduled_for, COUNT(*) AS c FROM task_runs
    WHERE cluster_id = ${clusterId} AND routine_id = ${warmupRoutineId} AND status = 'pending'
    GROUP BY scheduled_for HAVING c > 2 LIMIT 1`);
  check('5d. re-approve regenerates without duplicates (<=2 per slot)',
    reapprove.status === 200 && !dupCheck, JSON.stringify(dupCheck));

  const editing = await api(`/api/clusters/${clusterId}/routines/${warmupRoutineId}`, {
    method: 'PUT', token, body: { config: { minMinutes: 30 } },
  });
  check('5e. config-only edit -> status editing, no regen',
    editing.status === 200 && editing.json.routine.status === 'editing' && editing.json.regenerated === false,
    JSON.stringify(editing.json.routine));
  await api(`/api/clusters/${clusterId}/routines/${warmupRoutineId}`, {
    method: 'PUT', token, body: { status: 'approved' },
  });

  // ============ FIX 2 — WEEK RESPONSE SHAPE (webapp compatibility) ============
  const shapeWeek = await api(`/api/planner/week?start=${currentMonday}`, { token });
  const shapeCluster = shapeWeek.json.clusters[0];
  const shape = {
    topLevel: Object.keys(shapeWeek.json).sort(),
    clusterKeys: shapeCluster ? Object.keys(shapeCluster).sort() : [],
    metricKeys: shapeCluster ? Object.keys(shapeCluster.metricSeries).sort() : [],
    summaryKeys: Object.keys(shapeWeek.json.summary).sort(),
    taskKeys: shapeCluster && shapeCluster.tasks[0] ? Object.keys(shapeCluster.tasks[0]).sort() : [],
  };
  check('shape: week top-level {weekStart,weekEnd,now,summary,clusters}',
    JSON.stringify(shape.topLevel) === JSON.stringify(['clusters', 'now', 'summary', 'weekEnd', 'weekStart']),
    JSON.stringify(shape.topLevel));
  check('shape: cluster {id,name,status,health,accounts,routines,metricSeries,tasks,publications}',
    JSON.stringify(shape.clusterKeys) === JSON.stringify(['accounts', 'health', 'id', 'metricSeries', 'name', 'publications', 'routines', 'status', 'tasks']),
    JSON.stringify(shape.clusterKeys));
  check('shape: metricSeries {warmup,posts,views}',
    JSON.stringify(shape.metricKeys) === JSON.stringify(['posts', 'views', 'warmup']), JSON.stringify(shape.metricKeys));
  check('shape: summary {tasksTotal,tasksRunning,tasksQueued,publishTotal,warmupMinutesPlanned}',
    JSON.stringify(shape.summaryKeys) === JSON.stringify(['publishTotal', 'tasksQueued', 'tasksRunning', 'tasksTotal', 'warmupMinutesPlanned']),
    JSON.stringify(shape.summaryKeys));
  check('shape: task view keeps webapp fields (params additive)',
    ['id', 'taskType', 'status', 'scheduledFor', 'durationMin', 'username', 'platform', 'deviceAlias', 'source'].every((k) => shape.taskKeys.includes(k)),
    JSON.stringify(shape.taskKeys));
  const shapePubCluster = shapeWeek.json.clusters.find((c) => (c.publications || []).length > 0) || null;
  const shapePubKeys = shapePubCluster ? Object.keys(shapePubCluster.publications[0]).sort() : [];
  check('shape: publication view keeps queue fields (additive)',
    ['id', 'clusterId', 'clusterName', 'title', 'status', 'job_status', 'scheduledFor', 'platform', 'account', 'assetUrl', 'source'].every((k) => shapePubKeys.includes(k)),
    JSON.stringify(shapePubKeys));

  // ============ REPORT ============
  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '='.repeat(72));
  console.log(`TEST MATRIX (${results.length} checks, ${fails.length} failed, ${Math.round((Date.now() - started) / 1000)}s)`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log('='.repeat(72));
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((error) => {
  console.error('SUITE ERROR:', error);
  process.exitCode = 2;
});
