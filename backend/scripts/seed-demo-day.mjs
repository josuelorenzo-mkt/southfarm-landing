#!/usr/bin/env node
// Semilla de DEMO para la vista compacta "Día completo" — SOLO SANDBOX.
//
// Crea un día variado para visualizar/testear la vista:
//   - tareas completadas a la mañana,
//   - una tarea RUNNING AHORA (pulso verde en su carril),
//   - una hora con 4 teléfonos en simultáneo (apilado horizontal + scroll),
//   - futuras sueltas por la tarde/noche,
//   - una atrasada temprano.
//
// Uso: node scripts/seed-demo-day.mjs [--date YYYY-MM-DD]
// (corre contra el SANDBOX http://127.0.0.1:3002 con el usuario QA)

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(BACKEND_ROOT, 'data', 'sandbox', 'southfarm-sandbox.db');
const BASE = process.env.SANDBOX_URL || 'http://127.0.0.1:3002';
const EMAIL = 'qa-sandbox@test.local';
const PASSWORD = 'southfarm-qa-123';

const flagIdx = process.argv.indexOf('--date');
const DATE = flagIdx >= 0 ? process.argv[flagIdx + 1] : (() => {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
})();

const db = new Database(DB_PATH);
const clusters = db.prepare('SELECT id, name FROM account_clusters').all();
const clusterByName = new Map(clusters.map((c) => [c.name, Number(c.id)]));
// Cuenta activa por alias de teléfono (la primera que tenga device activo).
const accounts = db.prepare(`
  SELECT sa.id, sa.username, sa.platform, d.device_alias, d.id AS device_id, d.lifecycle_status
  FROM social_accounts sa JOIN devices d ON d.id = sa.device_id
  WHERE d.lifecycle_status = 'active'
  ORDER BY sa.id
`).all();
const byAlias = new Map();
for (const a of accounts) if (!byAlias.has(a.device_alias)) byAlias.set(a.device_alias, a);

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());
const token = login.token;
if (!token) throw new Error('login falló');

const toIso = (hhmm) => new Date(`${DATE}T${hhmm}:00-03:00`).toISOString();

// [hora BA, tipo, teléfono, duración min, ¿estado especial?]
const plan = [
  ['07:30', 'scan', '02', 10, 'done'],
  ['08:05', 'warmup', '02', 40, 'done'],
  ['08:30', 'warmup', '07', 40, 'late'],
  ['09:40', 'scan', '08', 10, 'done'],
  ['10:15', 'warmup', '02', 40],
  ['11:25', 'scan', '07', 10, 'done'],
  ['12:05', 'warmup', '07', 40, 'running'],
  ['11:40', 'warmup', '08', 40],
  ['12:10', 'warmup', '09', 40],
  ['15:00', 'warmup', '02', 40],
  ['15:00', 'warmup', '07', 40],
  ['15:00', 'scan', '08', 10],
  ['15:00', 'warmup', '09', 40],
  ['16:20', 'scan', '02', 10],
  ['17:45', 'warmup', '08', 40],
  ['19:30', 'warmup', '02', 40],
  ['21:00', 'scan', '09', 10],
];

const CLUSTER_FOR_DEVICE = { '02': clusterByName.get('Klein Thinking'), '07': clusterByName.get('Marczell Wisdom'), '08': clusterByName.get('Marczell Wisdom'), '09': clusterByName.get('ema nuevo') ?? 1 };

let created = 0;
const idsBySlot = [];
for (const [time, kind, alias, minutes, state] of plan) {
  const account = byAlias.get(alias);
  if (!account) { console.log(`  sin cuenta activa para ${alias}, salto`); continue; }
  const platform = String(account.platform);
  const taskType = kind === 'scan' ? `scan_${platform}` : (platform === 'tiktok' ? 'warmup_tiktok' : platform === 'youtube' ? 'warmup_youtube' : 'warmup_ig');
  const res = await fetch(`${BASE}/api/tasks/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      task_type: taskType, device_id: account.device_id, cluster_id: CLUSTER_FOR_DEVICE[alias] ?? 1,
      scheduled_for: toIso(time), social_account_id: Number(account.id),
      params: { account: account.username, platform, duration_minutes: minutes },
    }),
  }).then((r) => r.json());
  if (!res.task_run) { console.log(`  ERROR ${time} ${alias}: ${JSON.stringify(res)}`); continue; }
  idsBySlot.push({ id: Number(res.task_run.id), state, effective: res.scheduled_for_effective });
  created += 1;
}

// Estados especiales vía SQL (simulan lo que haría el teléfono).
const nowIso = new Date().toISOString();
const upd = db;
for (const { id, state, effective } of idsBySlot) {
  if (state === 'done') {
    upd.prepare("UPDATE task_runs SET status = 'completed', started_at = scheduled_for, completed_at = datetime(scheduled_for, '+' || planned_duration_sec || ' seconds') WHERE id = ?").run(id);
  } else if (state === 'running') {
    upd.prepare("UPDATE task_runs SET status = 'running', started_at = ?, lease_expires_at = datetime('now', '+25 minutes'), last_heartbeat_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 8 * 60e3).toISOString(), nowIso, id);
  }
}

console.log(`\nDemo listo: ${created} tareas para el ${DATE} (BA).`);
console.log(`- Running ahora: ${idsBySlot.filter((x) => x.state === 'running').length}`);
console.log(`- Hora con 4 teléfonos apilados: 15:00`);
console.log(`- Completadas: ${idsBySlot.filter((x) => x.state === 'done').length} · Atrasada: ${idsBySlot.filter((x) => x.state === 'late').length}`);
upd.close();
process.exit(0);
