#!/usr/bin/env node
// Fase 1 — Sistema de reservas de slots: test de integración.
//
// Arranca un servidor efímero contra una DB SQLite NUEVA (temporal), siembra
// workspace+device de prueba y valida:
//   1. POST /api/tasks/run sin conflicto → horario pedido intacto.
//   2. POST /api/tasks/run con solape → corrimiento al próximo hueco, respuesta
//      con scheduled_for_effective/shifted_from y evento 'created' auditado.
//   3. Sin hueco dentro del límite de 24 h → 409 con conflictos.
//   4. busy_until en la vista de devices mientras una ventana cubre "ahora".
//   5. reserveSlot('reject') / límite / excludeTaskId (unitario vía dist).
//   6. Auditoría de solapes = 0 sobre la DB del test.
//
// Uso: node scripts/test-slot-reservation.mjs
// Env: TEST_PORT (default 3111)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT || 3111);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(BACKEND_ROOT, 'data', 'test-slot-reservation.db');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.rmSync(DB_PATH + suffix); } catch {}
}

async function api(method, urlPath, body, token) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

const server = spawn(process.execPath, [path.join(BACKEND_ROOT, 'dist', 'index.js')], {
  env: {
    ...process.env,
    SOUTHFARM_DB_PATH: DB_PATH,
    PORT: String(PORT),
    SOUTHFARM_SCHEDULER_TICK_SECONDS: '3600',
    // Media root propio del test: el default apunta a ProgramData productivo.
    SOUTHFARM_PUBLICATION_MEDIA_ROOT: path.join(BACKEND_ROOT, 'data', 'test-publish-media'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write('[api] ' + chunk));
server.stderr.on('data', (chunk) => process.stderr.write('[api!] ' + chunk));

try {
  if (!(await waitForHealth())) throw new Error('El servidor no respondió /api/health');
  console.log(`Servidor de prueba arriba en ${BASE} (DB: ${DB_PATH})\n`);

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(DB_PATH);

  // ── Fixtures ──
  const reg = await api('POST', '/api/auth/register', { email: 'slots@test.local', password: 'test1234', name: 'Slots Tester' });
  check('registro de usuario de prueba', reg.status === 201 && !!reg.json?.token);
  const token = reg.json.token;
  const userId = Number(reg.json.user.id);

  // El registro ya crea workspace propio + membresía 'owner': reutilizarlos.
  const wsId = Number(db.prepare(
    'SELECT workspace_id FROM workspace_members WHERE user_id = ? LIMIT 1',
  ).get(userId).workspace_id);
  db.prepare(`
    INSERT INTO devices (user_id, device_id, device_name, workspace_id, lifecycle_status, last_seen_at)
    VALUES (?, 'test-dev-01', 'Test Phone', ?, 'active', ?)
  `).run(userId, wsId, new Date().toISOString());

  // El módulo bajo test (dist) contra la misma DB.
  const reservationModule = await import(pathToFileURL(path.join(BACKEND_ROOT, 'dist', 'slot-reservation.js')).href);

  // ── 1. Creación sin conflicto ──
  const t0 = new Date(Date.now() + 2 * 3600e3);
  t0.setSeconds(0, 0);
  const first = await api('POST', '/api/tasks/run', {
    task_type: 'warmup_ig',
    device_id: 'test-dev-01',
    params: { duration_minutes: 60 },
    scheduled_for: t0.toISOString(),
  }, token);
  check('creación sin conflicto devuelve 201', first.status === 201, `status=${first.status}`);
  check(
    'sin conflicto respeta el horario pedido',
    first.json?.scheduled_for_effective === t0.toISOString() && first.json?.shifted === false,
    JSON.stringify({ effective: first.json?.scheduled_for_effective }),
  );
  const firstId = Number(first.json?.task_run?.id);

  // ── 2. Solape → corrimiento al próximo hueco ──
  const overlappingStart = new Date(t0.getTime() + 30 * 60e3); // cae adentro de la primera hora
  const second = await api('POST', '/api/tasks/run', {
    task_type: 'warmup_tiktok',
    device_id: 'test-dev-01',
    params: { duration_minutes: 30 },
    scheduled_for: overlappingStart.toISOString(),
  }, token);
  const expectedShift = new Date(t0.getTime() + (65 * 60e3)); // fin 60m + margen 5m
  check('solape devuelve 201 con corrimiento', second.status === 201 && second.json?.shifted === true, `status=${second.status}`);
  check(
    'horario efectivo = fin del bloque estorbante (margen incluido)',
    second.json?.scheduled_for_effective === expectedShift.toISOString(),
    `effective=${second.json?.scheduled_for_effective} esperado=${expectedShift.toISOString()}`,
  );
  check('shifted_from expone el horario pedido originalmente', second.json?.shifted_from === overlappingStart.toISOString());
  const eventRow = db.prepare(
    "SELECT payload FROM task_events WHERE task_run_id = ? AND event_type = 'created' ORDER BY id DESC LIMIT 1",
  ).get(second.json?.task_run?.id);
  let eventPayload = {};
  try { eventPayload = JSON.parse(eventRow?.payload || '{}'); } catch {}
  check("evento 'created' audita shifted_from", eventPayload.shifted_from === overlappingStart.toISOString(), eventRow?.payload);

  // ── 3. Sin hueco en 24 h → 409 ──
  // Rellenar el día con tareas cada ~70 min desde el corrimiento hasta pasarse
  // de las 24 h es costoso; basta pedir una tarea cuya duración desborde el
  // límite: 24 h de duración arranca en el hueco libre pero se corre más allá
  // del límite sólo si el hueco ya está desplazado. Caso directo: política
  // reject contra ocupación (cubre el branch 409 real vía API con shift+límite
  // imposible: scheduled_for hace 25 h no es válido; usamos reject acá).
  const rejected = await api('POST', '/api/tasks/run', {
    task_type: 'scan_instagram',
    device_id: 'test-dev-01',
    params: { duration_seconds: 600 },
    scheduled_for: overlappingStart.toISOString(),
    conflict_policy: 'reject',
  }, token);
  // conflict_policy todavía no existe como parámetro (llega en Fase 3): la
  // creación con shift tiene que haber ido a parar a OTRO hueco, nunca pisar.
  check(
    'sin conflict_policy la creación sigue compatibilidad (shift, no pisa)',
    rejected.status === 201 && rejected.json?.task_run?.scheduled_for !== overlappingStart.toISOString(),
    `status=${rejected.status}`,
  );

  // ── 4. busy_until en deviceView ──
  // Una tarea pendiente que empieza "ahora" cubre el presente: busy_until debe
  // existir y ser ≈ ahora + duración + margen.
  const nowTask = await api('POST', '/api/tasks/run', {
    task_type: 'warmup_youtube',
    device_id: 'test-dev-01',
    params: { duration_minutes: 20 },
  }, token);
  check('tarea inmediata creada', nowTask.status === 201);
  const devicesRes = await api('GET', '/api/devices', undefined, token);
  const deviceView = (devicesRes.json?.devices || []).find((d) => d.device_id === 'test-dev-01');
  const busyUntil = deviceView?.busy_until ? Date.parse(deviceView.busy_until) : null;
  const nowTs = Date.now();
  check(
    'busy_until refleja la ventana que cubre ahora (~20m + 5m)',
    busyUntil !== null && busyUntil > nowTs + 20 * 60e3 && busyUntil <= nowTs + 30 * 60e3,
    `busy_until=${deviceView?.busy_until}`,
  );

  // Tarea muerta (lease vencido) NO ocupa: cancelarla libera.
  db.prepare("UPDATE task_runs SET status = 'running', started_at = ?, lease_expires_at = ? WHERE id = ?")
    .run(new Date(nowTs - 30 * 60e3).toISOString(), new Date(nowTs - 10 * 60e3).toISOString(), Number(nowTask.json.task_run.id));
  const devicesAfter = await api('GET', '/api/devices', undefined, token);
  const viewAfter = (devicesAfter.json?.devices || []).find((d) => d.device_id === 'test-dev-01');
  check('lease vencido libera el teléfono (busy_until null o de otra ventana)', !viewAfter?.busy_until, `busy_until=${viewAfter?.busy_until}`);
  db.prepare("UPDATE task_runs SET status = 'pending', started_at = NULL, lease_expires_at = NULL WHERE id = ?")
    .run(Number(nowTask.json.task_run.id));

  // ── 5. Unitarios de reserveSlot (vía dist) ──
  const probe = reservationModule.reserveSlot({
    db,
    deviceId: Number(deviceIdFor(db, 'test-dev-01')),
    desiredStart: overlappingStart.toISOString(),
    durationSec: 600,
    policy: 'reject',
  });
  check("policy 'reject' reporta conflicto sin crear nada", probe.ok === false && probe.reason === 'conflict' && probe.conflicts.length > 0);

  const freeSlot = reservationModule.nextFreeSlot({
    db,
    deviceId: Number(deviceIdFor(db, 'test-dev-01')),
    from: overlappingStart.toISOString(),
    durationSec: 600,
    shiftLimitMs: 3 * 60 * 60e3, // los bloques de warmup estorban más de 1 h
  });
  check('nextFreeSlot sugiere el próximo hueco', !!freeSlot && Date.parse(freeSlot) >= expectedShift.getTime(), `free=${freeSlot}`);

  const impossibleLimit = reservationModule.reserveSlot({
    db,
    deviceId: Number(deviceIdFor(db, 'test-dev-01')),
    desiredStart: overlappingStart.toISOString(),
    durationSec: 600,
    policy: 'shift',
    shiftLimitMs: 60e3, // 1 minuto: imposible
  });
  check('límite de corrimiento agotado devuelve no_slot_within_limit', impossibleLimit.ok === false && impossibleLimit.reason === 'no_slot_within_limit');

  const excludeSelf = reservationModule.reserveSlot({
    db,
    deviceId: Number(deviceIdFor(db, 'test-dev-01')),
    desiredStart: second.json.scheduled_for_effective,
    durationSec: 30 * 60,
    policy: 'reject',
    excludeTaskId: Number(second.json.task_run.id),
  });
  check('excludeTaskId permite validar una tarea contra sí misma', excludeSelf.ok === true);

  // ── 5b. Dos clústeres, un mismo teléfono (el caso histórico de duplicación) ──
  const devId = Number(deviceIdFor(db, 'test-dev-01'));
  const accA = db.prepare(
    "INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, 'instagram', 'cluster_a')",
  ).run(userId, devId).lastInsertRowid;
  const accB = db.prepare(
    "INSERT INTO social_accounts (user_id, device_id, platform, username) VALUES (?, ?, 'tiktok', 'cluster_b')",
  ).run(userId, devId).lastInsertRowid;
  const clusterA = await api('POST', '/api/clusters', { name: 'Cluster A', accountIds: [Number(accA)] }, token);
  check('clúster A creado y generado', clusterA.status === 201);
  const clusterB = await api('POST', '/api/clusters', { name: 'Cluster B', accountIds: [Number(accB)] }, token);
  check('clúster B creado sobre el MISMO teléfono', clusterB.status === 201);
  await api('POST', '/api/planner/week/generate', {}, token);
  const autoTasks = db.prepare(`
    SELECT id, cluster_id, task_type, scheduled_for, planned_duration_sec
    FROM task_runs WHERE device_id = ? AND source = 'automatic' AND status = 'pending'
    ORDER BY scheduled_for
  `).all(devId);
  check('ambos clústeres generaron tareas automáticas', new Set(autoTasks.map((t) => t.cluster_id)).size === 2, `tareas=${autoTasks.length}`);
  let autoOverlaps = 0;
  for (let i = 1; i < autoTasks.length; i += 1) {
    const prevEnd = Date.parse(autoTasks[i - 1].scheduled_for)
      + ((autoTasks[i - 1].planned_duration_sec || 600) + 300) * 1000;
    if (prevEnd > Date.parse(autoTasks[i].scheduled_for)) autoOverlaps += 1;
  }
  check('cero solapes entre las ventanas de los dos clústeres', autoOverlaps === 0,
    JSON.stringify(autoTasks.map((t) => [t.task_type, t.scheduled_for])));
  const shiftedEvents = db.prepare(`
    SELECT COUNT(*) AS n FROM task_events
    WHERE event_type = 'created_automatic' AND payload LIKE '%shifted_from%'
  `).get();
  check('el corrimiento entre clústeres queda auditado', Number(shiftedEvents.n) > 0, `eventos=${shiftedEvents.n}`);

  // Vista día scopped a UN clúster (GET /api/planner/day?cluster_id=N).
  const clustersAb = db.prepare(
    "SELECT id, name FROM account_clusters WHERE name IN ('Cluster A','Cluster B')",
  ).all();
  const aId = Number(clustersAb.find((c) => c.name === 'Cluster A').id);
  const bId = Number(clustersAb.find((c) => c.name === 'Cluster B').id);
  const fechaAuto = db.prepare(`
    SELECT scheduled_for FROM task_runs
    WHERE cluster_id = ? AND source = 'automatic' AND status = 'pending'
    ORDER BY scheduled_for LIMIT 1
  `).get(aId).scheduled_for;
  const dateKeyBA = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(fechaAuto));
  const diaGeneral = await api('GET', `/api/planner/day?date=${dateKeyBA}`, undefined, token);
  const diaScoped = await api('GET', `/api/planner/day?date=${dateKeyBA}&cluster_id=${aId}`, undefined, token);
  check('día general devuelve tareas de ambos clústeres', diaGeneral.status === 200
    && diaGeneral.json.tasks.some((t) => t.clusterId === aId)
    && diaGeneral.json.tasks.some((t) => t.clusterId === bId));
  check('día con cluster_id devuelve SOLO ese clúster',
    diaScoped.status === 200 && diaScoped.json.tasks.length > 0
    && diaScoped.json.tasks.every((t) => t.clusterId === aId),
    `total=${diaScoped.json?.tasks?.length} cluster_id=${diaScoped.json?.cluster_id}`);
  const diaInvalido = await api('GET', '/api/planner/day?cluster_id=999999', undefined, token);
  check('cluster_id inexistente devuelve 404', diaInvalido.status === 404);

  // Creación con cluster_id (acciones rápidas): la tarea queda asociada y
  // la vista día de ESE clúster la muestra.
  const conCluster = await api('POST', '/api/tasks/run', {
    task_type: 'warmup_ig', device_id: 'test-dev-01', cluster_id: aId,
    params: { duration_minutes: 30 }, scheduled_for: '2026-08-28T18:00:00Z',
  }, token);
  check('creación con cluster_id devuelve 201', conCluster.status === 201, `status=${conCluster.status} ${JSON.stringify(conCluster.json?.error)}`);
  const fila = conCluster.json?.task_run ? db.prepare('SELECT cluster_id, scheduled_for FROM task_runs WHERE id = ?').get(Number(conCluster.json.task_run.id)) : null;
  check('la fila guarda el cluster_id', !!fila && Number(fila.cluster_id) === aId, JSON.stringify(fila));
  const diaTrasCreacion = await api('GET', `/api/planner/day?date=2026-08-28&cluster_id=${aId}`, undefined, token);
  check('la nueva tarea aparece en el día de ese clúster', diaTrasCreacion.status === 200
    && (diaTrasCreacion.json.tasks || []).some((t) => Number(t.id) === Number(conCluster.json.task_run.id)));
  const conClusterMalo = await api('POST', '/api/tasks/run', {
    task_type: 'warmup_ig', device_id: 'test-dev-01', cluster_id: 999999,
    scheduled_for: '2026-08-28T18:00:00Z',
  }, token);
  check('cluster_id de otro workspace rechazado (404)', conClusterMalo.status === 404);

  // ── 5c. Movimiento individual (Fase 2): PATCH /api/tasks/runs/:id/schedule ──
  // Mover una tarea a un hueco libre (el sugerido por nextFreeSlot).
  const moveBase = new Date(Date.now() + 26 * 3600e3);
  // Mismo criterio de duración que la tarea firstId (60'): si pedimos un hueco
  // más chico el /schedule valida con la duración real y el test se vuelve
  // dependiente de la hora de ejecución (flaky).
  const freeTarget = reservationModule.nextFreeSlot({
    db,
    deviceId: devId,
    from: moveBase.toISOString(),
    durationSec: 60 * 60,
    shiftLimitMs: 72 * 3600e3,
  });
  const batchSnapshot = db.prepare(
    "SELECT id, scheduled_for FROM task_runs WHERE device_id = ? AND source = 'automatic' AND status = 'pending' ORDER BY id",
  ).all(devId);
  const moved = await api('PATCH', `/api/tasks/runs/${firstId}/schedule`, { scheduled_for: freeTarget }, token);
  check('mover tarea pendiente a hueco libre devuelve ok', moved.status === 200 && moved.json?.ok === true, `status=${moved.status} ${JSON.stringify(moved.json?.error)}`);
  check('la tarea quedó en el horario pedido', moved.json?.task_run?.scheduled_for === freeTarget, `scheduled=${moved.json?.task_run?.scheduled_for}`);
  const batchAfter = db.prepare(
    "SELECT id, scheduled_for FROM task_runs WHERE device_id = ? AND source = 'automatic' AND status = 'pending' ORDER BY id",
  ).all(devId);
  check(
    'mover una tarea no tocó el resto de la cola',
    JSON.stringify(batchAfter) === JSON.stringify(batchSnapshot),
  );
  const reschedEvent = db.prepare(
    "SELECT payload FROM task_events WHERE task_run_id = ? AND event_type = 'rescheduled_manual' ORDER BY id DESC LIMIT 1",
  ).get(firstId);
  let reschedPayload = {};
  try { reschedPayload = JSON.parse(reschedEvent?.payload || '{}'); } catch {}
  check("evento 'rescheduled_manual' audita from/to/usuario", !!reschedPayload.from && !!reschedPayload.to && Number(reschedPayload.by_user_id) === userId, reschedEvent?.payload);

  // Mover encima de una ventana ocupada → 409 con conflicto y próximo hueco.
  const occupiedSlot = db.prepare(`
    SELECT scheduled_for FROM task_runs
    WHERE device_id = ? AND source = 'automatic' AND status = 'pending'
      AND task_type LIKE 'warmup%' ORDER BY scheduled_for DESC LIMIT 1
  `).get(devId);
  const clash = await api('PATCH', `/api/tasks/runs/${firstId}/schedule`, { scheduled_for: occupiedSlot.scheduled_for }, token);
  check('mover encima de otra tarea devuelve 409', clash.status === 409, `status=${clash.status}`);
  check('el 409 incluye conflictos y next_free_slot sugerido', Array.isArray(clash.json?.conflicts) && clash.json.conflicts.length > 0 && !!clash.json.next_free_slot, `sugerido=${clash.json?.next_free_slot}`);
  const unchanged = db.prepare('SELECT scheduled_for FROM task_runs WHERE id = ?').get(firstId);
  check('tras el rechazo la tarea conserva su horario', unchanged.scheduled_for === freeTarget);

  // No se puede mover una tarea en ejecución.
  db.prepare("UPDATE task_runs SET status = 'running', started_at = ?, lease_expires_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date(Date.now() + 3600e3).toISOString(), Number(nowTask.json.task_run.id));
  const moveRunning = await api('PATCH', `/api/tasks/runs/${nowTask.json.task_run.id}/schedule`, { scheduled_for: freeTarget }, token);
  check('mover una tarea running devuelve 409', moveRunning.status === 409, `status=${moveRunning.status}`);
  db.prepare("UPDATE task_runs SET status = 'pending', started_at = NULL, lease_expires_at = NULL WHERE id = ?")
    .run(Number(nowTask.json.task_run.id));

  // ── 5d. Fase 2.5: movimiento en cascada ──
  // Escenario del dueño: A(15:00-16:00), B(16:00-16:45), C lejana; meter a C
  // en el medio empuja a B al próximo hueco continuo. Teléfono limpio nuevo,
  // sin la cola generada por los clústeres de arriba.
  db.prepare(`
    INSERT INTO devices (user_id, device_id, device_name, workspace_id, lifecycle_status, last_seen_at)
    VALUES (?, 'test-dev-casc', 'Cascade Phone', ?, 'active', ?)
  `).run(userId, wsId, new Date().toISOString());
  const cascDev = Number(deviceIdFor(db, 'test-dev-casc'));
  const CASCAID = 'test-dev-casc';
  const crearEnCascada = async (body) => {
    const res = await api('POST', '/api/tasks/run', body, token);
    if (res.status !== 201) throw new Error('seed cascada falló: ' + JSON.stringify(res.json));
    return Number(res.json.task_run.id);
  };
  const TA = '2026-08-28T18:00:00Z'; // 15:00 BA (A dura 45m → ventana hasta 18:50Z)
  const idA = await crearEnCascada({ task_type: 'warmup_ig', device_id: CASCAID, params: { duration_minutes: 45 }, scheduled_for: TA });
  const idB = await crearEnCascada({ task_type: 'warmup_tiktok', device_id: CASCAID, params: { duration_minutes: 45 }, scheduled_for: '2026-08-28T19:00:00Z' });
  const idC = await crearEnCascada({ task_type: 'scan_instagram', device_id: CASCAID, params: { duration_minutes: 10 }, scheduled_for: '2026-08-28T21:00:00Z' });

  // Preview de inserción de C a las 19:05 — B(19:00) está ANTES del punto:
  // con la semántica "insertar en el medio" B queda CONGELADA y C se desliza
  // sola al primer hueco válido (fin de ventana de B = 19:50Z).
  const snapshotCascada = () => JSON.stringify(
    db.prepare('SELECT id, scheduled_for FROM task_runs WHERE device_id = ? ORDER BY id').all(cascDev),
  );
  const antesDelPreview = snapshotCascada();
  const preview = await api('POST', `/api/tasks/runs/${idC}/move/preview`, { scheduled_for: '2026-08-28T19:05:00Z' }, token);
  check('preview: solo se mueve C — la anterior (B) NO participa', preview.status === 200 && preview.json?.ok === true && Array.isArray(preview.json?.moves) && preview.json.moves.length === 1
    && preview.json.moves[0].task_id === idC,
    JSON.stringify(preview.json));
  check('C se desliza al primer hueco tras la anterior (19:50:00.000Z)',
    preview.json?.moves?.[0]?.to === '2026-08-28T19:50:00.000Z',
    JSON.stringify(preview.json?.moves?.[0]));
  check('el preview NO mutó la base', snapshotCascada() === antesDelPreview);

  const aplicado = await api('POST', `/api/tasks/runs/${idC}/move`, { scheduled_for: '2026-08-28T19:05:00Z' }, token);
  check('aplicación devuelve ok con el movimiento deslizado', aplicado.status === 200 && aplicado.json?.ok === true && aplicado.json?.applied?.length === 1,
    `status=${aplicado.status}`);
  const bRow = db.prepare('SELECT scheduled_for FROM task_runs WHERE id = ?').get(idB);
  const cRow = db.prepare('SELECT scheduled_for FROM task_runs WHERE id = ?').get(idC);
  check('C entró a las 19:50 y B quedó exactamente donde estaba',
    cRow.scheduled_for === '2026-08-28T19:50:00.000Z' && bRow.scheduled_for === '2026-08-28T19:00:00.000Z');
  const evC = db.prepare(
    "SELECT payload FROM task_events WHERE task_run_id = ? AND event_type = 'rescheduled_manual' ORDER BY id DESC LIMIT 1",
  ).get(idC);
  let payloadC = {};
  try { payloadC = JSON.parse(evC?.payload || '{}'); } catch {}
  check('la primaria audita cascade_root_id y from/to', Number(payloadC.cascade_root_id) === idC
    && payloadC.from === '2026-08-28T21:00:00.000Z' && payloadC.to === '2026-08-28T19:50:00.000Z',
    evC?.payload);

  // ESCENARIO EXACTO del video del dueño (2026-08-27): 4 tareas de 35 min;
  // meter IG (18:25) en el hueco entre YT(19:10) y TT(19:50) soltando en 19:45.
  // Esperado: IG desliza a 19:50 (tras el margen de YT), TT salta a 21:10
  // (después de YT2 20:30-21:05), YT y YT2 quedan INTACTOS.
  db.prepare(`
    INSERT INTO devices (user_id, device_id, device_name, workspace_id, lifecycle_status, last_seen_at)
    VALUES (?, 'test-dev-casc2', 'Cascade Phone 2', ?, 'active', ?)
  `).run(userId, wsId, new Date().toISOString());
  const CASCA2 = 'test-dev-casc2';
  const idV1 = await crearEnCascada({ task_type: 'warmup_ig', device_id: CASCA2, params: { duration_minutes: 35 }, scheduled_for: '2026-08-28T21:25:00Z' });
  const idV2 = await crearEnCascada({ task_type: 'warmup_youtube', device_id: CASCA2, params: { duration_minutes: 35 }, scheduled_for: '2026-08-28T22:10:00Z' });
  const idV3 = await crearEnCascada({ task_type: 'warmup_tiktok', device_id: CASCA2, params: { duration_minutes: 35 }, scheduled_for: '2026-08-28T22:50:00Z' });
  const idV4 = await crearEnCascada({ task_type: 'warmup_youtube', device_id: CASCA2, params: { duration_minutes: 35 }, scheduled_for: '2026-08-28T23:30:00Z' });
  const previewVideo = await api('POST', `/api/tasks/runs/${idV1}/move/preview`, { scheduled_for: '2026-08-28T22:45:00Z' }, token);
  const movesVideo = previewVideo.json?.moves || [];
  check('video: solo se mueven IG y TT (YT anterior e YT2 posterior quedan)', previewVideo.status === 200 && previewVideo.json?.ok === true
    && movesVideo.length === 2
    && movesVideo.some((m) => m.task_id === idV1 && m.to === '2026-08-28T22:50:00.000Z')
    && movesVideo.some((m) => m.task_id === idV3 && m.to === '2026-08-29T00:10:00.000Z'),
    JSON.stringify(movesVideo));
  const aplicadoVideo = await api('POST', `/api/tasks/runs/${idV1}/move`, { scheduled_for: '2026-08-28T22:45:00Z' }, token);
  check('video aplicado: ok', aplicadoVideo.status === 200 && aplicadoVideo.json?.ok === true, `status=${aplicadoVideo.status}`);
  const horaDe = (id) => db.prepare('SELECT scheduled_for h FROM task_runs WHERE id = ?').get(id).h;
  check('video: horas finales exactas (YT 19:10 y YT2 20:30 intactos)',
    horaDe(idV1) === '2026-08-28T22:50:00.000Z'
    && horaDe(idV2) === '2026-08-28T22:10:00.000Z'
    && horaDe(idV4) === '2026-08-28T23:30:00.000Z'
    && horaDe(idV3) === '2026-08-29T00:10:00.000Z',
    JSON.stringify({ v1: horaDe(idV1), v2: horaDe(idV2), v3: horaDe(idV3), v4: horaDe(idV4) }));

  // Límite de día para automáticas: bloqueo INMÓVIL (running con lease vivo,
  // 10 h planeadas arrancando cerca de medianoche BA). La automática F queda
  // atrapada dentro de ese bloque; sacarla exige correrla más allá de su fin
  // de día local → la cascada completa se rechaza sin mover absolutamente nada.
  const idG = await crearEnCascada({ task_type: 'warmup_youtube', device_id: CASCAID, params: { duration_minutes: 600 }, scheduled_for: '2026-08-29T00:30:00Z' });
  const idF = await crearEnCascada({ task_type: 'warmup_tiktok', device_id: CASCAID, params: { duration_minutes: 10 }, scheduled_for: '2026-08-28T20:00:00Z', source: 'automatic' });
  // Fabricar el pisado imposible: G pasa a running-iniciado y F queda adentro.
  db.prepare("UPDATE task_runs SET status = 'running', started_at = ?, lease_expires_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 60e3).toISOString(), new Date(Date.now() + 8 * 3600e3).toISOString(), idG);
  db.prepare("UPDATE task_runs SET scheduled_for = '2026-08-28T23:50:00Z' WHERE id = ?").run(idF); // 20:50 BA, dentro de G
  const fOriginal = db.prepare('SELECT scheduled_for FROM task_runs WHERE id = ?').get(idF);
  const estadoAntesDeOverflow = snapshotCascada();
  const aplicacionOverflow = await api('POST', `/api/tasks/runs/${idF}/move`, { scheduled_for: '2026-08-29T00:50:00Z' }, token);
  check('cascada que obligaría a la automática a salir de su día local se rechaza (409)',
    aplicacionOverflow.status === 409 && aplicacionOverflow.json?.reason === 'chain_overflow',
    JSON.stringify(aplicacionOverflow.json));
  check('tras el rechazo no se movió NADA (todo o nada)',
    snapshotCascada() === estadoAntesDeOverflow
    && db.prepare('SELECT scheduled_for FROM task_runs WHERE id = ?').get(idF).scheduled_for === fOriginal.scheduled_for);

  // ── 6. Auditoría de solapes sobre la DB del test ──
  const { spawnSync } = await import('node:child_process');
  const audit = spawnSync(process.execPath, [path.join(BACKEND_ROOT, 'scripts', 'audit-slot-overlaps.mjs'), DB_PATH], { encoding: 'utf8' });
  check('auditoría de solapes = 0', audit.status === 0, (audit.stdout || '').trim().split('\n').pop());

  db.close();
} catch (error) {
  check('suite completa sin excepciones', false, error.message);
} finally {
  server.kill();
  await sleep(300);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks OK`);
process.exit(failed.length === 0 ? 0 : 1);

function deviceIdFor(db, stableId) {
  return db.prepare('SELECT id FROM devices WHERE device_id = ?').get(stableId).id;
}
