#!/usr/bin/env node
// Seed gate (FIX 5) — verifies that demo seeding only runs when
// SOUTHFARM_PLANNER_SEED=1.
//
// The runner (scripts/run-planner-tests.sh) prepares a DEDICATED seed-test DB
// (copy of staging with ALL planner data wiped: clusters, members, routines,
// task_runs, sessions, events) and starts the server twice:
//   PHASE=nogate — server WITHOUT SOUTHFARM_PLANNER_SEED
//   PHASE=gate   — server WITH    SOUTHFARM_PLANNER_SEED=1 (fresh boot)
//
// seedDemoData picks the workspace with the most social accounts (ws6 in the
// copy) — with all clusters wiped it becomes empty, so the gate decides
// whether it gets seeded. This script only asserts the observable behavior:
//   nogate -> 0 clusters / 0 tasks in ws6
//   gate   -> >=1 cluster, tasks generated, posts plan in series
//
// Env: TEST_API, PHASE (nogate|gate), TEST_DB_PATH

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.TEST_API || 'http://127.0.0.1:3103';
const DB_PATH = process.env.TEST_DB_PATH;
const NODE = process.env.TEST_NODE || process.execPath;
const PHASE = process.env.PHASE || 'nogate';
const WS_ID = 6;

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

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
  const res = spawnSync(NODE, ['-e', script, DB_PATH, JSON.stringify(ops)], { cwd: BACKEND_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error('sql helper failed: ' + res.stderr);
  return JSON.parse(res.stdout);
}
const all = (s, p) => sql([{ sql: s, all: true, params: p || [] }])[0];
const get = (s, p) => sql([{ sql: s, params: p || [] }])[0];

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + pathname, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json, text };
}

async function login(email, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return res;
}

async function main() {
  // The seed (gate phase) creates demo@southfarm.local as an owner of ws6;
  // before that, staging@southfarm.local is the owner.
  const email = PHASE === 'gate' ? 'demo@southfarm.local' : 'staging@southfarm.local';
  const loginRes = await login(email, 'southfarm');
  if (loginRes.status !== 200) throw new Error(`seed ${PHASE}: login ${email} failed: ${loginRes.status} ${loginRes.text}`);
  const token = loginRes.json.token;

  const week = await api('/api/planner/week', { token });
  if (week.status !== 200) throw new Error(`seed ${PHASE}: week failed: ${week.status} ${week.text}`);

  // The seed runs ~800ms after boot inside a setTimeout; poll briefly so the
  // assertions run after it completes (not in a race with it).
  let clusterCount = get(`SELECT COUNT(*) AS c FROM account_clusters WHERE workspace_id = ${WS_ID}`).c;
  let taskCount = get(`SELECT COUNT(*) AS c FROM task_runs WHERE workspace_id = ${WS_ID}`).c;
  if (PHASE === 'gate') {
    for (let i = 0; i < 20 && Number(clusterCount) === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      clusterCount = get(`SELECT COUNT(*) AS c FROM account_clusters WHERE workspace_id = ${WS_ID}`).c;
      taskCount = get(`SELECT COUNT(*) AS c FROM task_runs WHERE workspace_id = ${WS_ID}`).c;
    }
  }
  // re-fetch the week AFTER the seed settled (the first fetch raced the seed)
  const weekRefetched = await api('/api/planner/week', { token });
  const weekFinal = weekRefetched.status === 200 ? weekRefetched : week;

  if (PHASE === 'nogate') {
    check('seed-gate A: ws6 has 0 clusters with seed OFF',
      Number(clusterCount) === 0 && weekFinal.json.clusters.length === 0,
      `clusters=${clusterCount} weekClusters=${weekFinal.json.clusters.length}`);
    check('seed-gate A: no tasks generated with seed OFF', Number(taskCount) === 0, `tasks=${taskCount}`);
  } else {
    check('seed-gate B: SOUTHFARM_PLANNER_SEED=1 seeded clusters',
      Number(clusterCount) >= 1 && weekFinal.json.clusters.length >= 1,
      `clusters=${clusterCount} weekClusters=${weekFinal.json.clusters.length}`);
    check('seed-gate B: generated tasks exist (history + plan)', Number(taskCount) >= 1, `tasks=${taskCount}`);
    // posts plan visible in the NEXT week series (current week has today's
    // tasks running/pending; next week is pure plan)
    const nextMonday = (() => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date());
      const v = (t) => parts.find((p) => p.type === t)?.value;
      const dateKey = `${v('year')}-${v('month')}-${v('day')}`;
      const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', weekday: 'short' })
        .formatToParts(new Date()).find((p) => p.type === 'weekday')?.value;
      const offsets = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
      const offset = offsets[wd] ?? 0;
      const monday = new Date(Date.parse(dateKey + 'T12:00:00Z') - offset * 86400e3).toISOString();
      const next = new Date(Date.parse(monday) + 7 * 86400e3).toISOString();
      const p2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(next));
      const v2 = (t) => p2.find((p) => p.type === t)?.value;
      return `${v2('year')}-${v2('month')}-${v2('day')}`;
    })();
    const weekNext = await api(`/api/planner/week?start=${nextMonday}`, { token });
    const postsSeries = (weekNext.json.clusters || []).some((c) => (c.metricSeries.posts || []).some((v) => v > 0));
    check('seed-gate B: posts plan visible in next-week series',
      postsSeries, JSON.stringify((weekNext.json.clusters || []).map((c) => c.metricSeries.posts)));
    const publishTasks = (weekNext.json.clusters || []).flatMap((c) => c.tasks || []).filter((t) => t.taskType === 'publish_reel');
    check('seed-gate B: no publish_reel placeholder tasks materialized',
      publishTasks.length === 0, `publishTasks=${publishTasks.length}`);
  }

  const fails = results.filter((r) => !r.pass);
  console.log('\n' + '='.repeat(60));
  console.log(`SEED GATE ${PHASE.toUpperCase()} — ${results.length} checks, ${fails.length} failed`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  process.exitCode = fails.length ? 1 : 0;
}

main().catch((error) => {
  console.error('SEED SUITE ERROR:', error);
  process.exitCode = 2;
});
