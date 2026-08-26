// Auditoría de solapes de ventana por teléfono (Fase 1 — sistema de reservas).
//
// Debe devolver 0 solapes tras cada deploy del planner. Usa las mismas reglas
// que slot-reservation.ts: ventana = [scheduled_for, scheduled_for + duración
// + margen], con duración = max(planned, ahora - started_at) para tareas en
// ejecución y default 600 s cuando planned_duration_sec es NULL.
//
// Uso: node scripts/audit-slot-overlaps.mjs [ruta-a-southfarm.db]

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'southfarm.db');
const dbPath = process.argv[2] || process.env.SOUTHFARM_DB_PATH || DEFAULT_DB;
const bufferSec = (() => {
  const raw = Number(process.env.SOUTHFARM_SLOT_BUFFER_SEC);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 300;
})();
const nowMs = Date.now();

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`
  SELECT id, device_id, task_type, status, scheduled_for, planned_duration_sec, started_at, lease_expires_at
  FROM task_runs
  WHERE device_id IS NOT NULL
    AND scheduled_for IS NOT NULL
    AND status NOT IN ('cancelled', 'expired', 'error')
  ORDER BY device_id, scheduled_for
`).all();
db.close();

function windowFor(row) {
  const startMs = Date.parse(String(row.scheduled_for));
  if (!Number.isFinite(startMs)) return null;
  let durationSec = Number(row.planned_duration_sec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) durationSec = 600;
  if ((row.status === 'running' || row.status === 'paused') && row.started_at) {
    const startedMs = Date.parse(String(row.started_at));
    if (Number.isFinite(startedMs)) {
      durationSec = Math.max(durationSec, Math.ceil((nowMs - startedMs) / 1000));
    }
  }
  return { startMs, endMs: startMs + (durationSec + bufferSec) * 1000 };
}

let overlaps = 0;
let lastByDevice = new Map();
for (const row of rows) {
  const win = windowFor(row);
  if (!win) continue;
  // Una tarea muerta sin aviso (lease vencido) no ocupa ventana.
  if ((row.status === 'running' || row.status === 'paused') && row.lease_expires_at) {
    const leaseMs = Date.parse(String(row.lease_expires_at));
    if (Number.isFinite(leaseMs) && leaseMs <= nowMs) continue;
  }
  const prev = lastByDevice.get(Number(row.device_id));
  if (prev && prev.win.endMs > win.startMs) {
    overlaps += 1;
    console.log(
      `SOLAPE device=${row.device_id}\n`
      + `  A: #${prev.row.id} ${prev.row.task_type} ${prev.row.status} `
      + `${prev.row.scheduled_for} -> ${new Date(prev.win.endMs).toISOString()}\n`
      + `  B: #${row.id} ${row.task_type} ${row.status} `
      + `${row.scheduled_for} -> ${new Date(win.endMs).toISOString()}`,
    );
  }
  if (!prev || win.endMs > prev.win.endMs) lastByDevice.set(Number(row.device_id), { row, win });
}

console.log(`\nRevisadas ${rows.length} tareas vivas (margen ${bufferSec}s). Solapes: ${overlaps}`);
process.exit(overlaps === 0 ? 0 : 1);
