// Sistema de reservas de slots — ventanas [inicio, inicio + duración + margen]
// por dispositivo. Toda tarea viva (pending/overdue/running/paused) ocupa su
// ventana; 'cancelled'/'expired'/'error' no bloquean. La única fuente de
// verdad es task_runs: no hay tabla de slots.
//
// reserveSlot() es transaccional: el chequeo de conflicto y el INSERT del
// llamador corren dentro del mismo db.transaction() de better-sqlite3
// (single-writer), así dos generadores concurrentes no pueden colarse en el
// mismo hueco.
import { BUENOS_AIRES_TIMEZONE, localDateTimeToIso } from './scheduler.js';
export const DEFAULT_SLOT_BUFFER_SEC = 300; // margen entre fin estimado y próximo inicio válido
export const DEFAULT_PLANNED_DURATION_SEC = 600; // coincide con el default de la query de auditoría
const MAX_SHIFT_ITERATIONS = 500;
// Margen configurable por env (SOUTHFARM_SLOT_BUFFER_SEC), default 5 minutos.
export function slotBufferSec() {
    const raw = Number(process.env.SOUTHFARM_SLOT_BUFFER_SEC);
    if (!Number.isFinite(raw) || raw <= 0)
        return DEFAULT_SLOT_BUFFER_SEC;
    return Math.round(raw);
}
function dateKeyInTimezone(isoInstant, timezone = BUENOS_AIRES_TIMEZONE) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(isoInstant));
}
// Límite de corrimiento "hasta fin del día local" para automáticas: cuántos ms
// puede alejarse un inicio respecto del horario deseado sin pasar medianoche
// (America/Argentina/Buenos_Aires).
export function msUntilEndOfLocalDay(isoInstant) {
    const dateKey = dateKeyInTimezone(isoInstant);
    const noonIso = localDateTimeToIso(dateKey, '12:00', BUENOS_AIRES_TIMEZONE);
    const nextDayKey = dateKeyInTimezone(new Date(Date.parse(noonIso) + 12 * 3600 * 1000).toISOString());
    const endOfDayIso = localDateTimeToIso(nextDayKey, '00:00', BUENOS_AIRES_TIMEZONE);
    const delta = Date.parse(endOfDayIso) - Date.parse(isoInstant);
    return delta > 0 ? delta : 0;
}
// Una running/paused con lease vencido es una tarea muerta sin aviso: el
// mecanismo de leases existente la libera, así que no ocupa ventana.
function isLeaseAlive(row, nowMs) {
    if (row.status !== 'running' && row.status !== 'paused')
        return true;
    if (!row.lease_expires_at)
        return true;
    const leaseMs = Date.parse(String(row.lease_expires_at));
    return !(Number.isFinite(leaseMs) && leaseMs <= nowMs);
}
// Ventana real ocupada por una fila de task_runs, en ms epoch.
// - duración futura: planned_duration_sec (default 600 si es NULL)
// - tarea en ejecución: max(planned, ahora - started_at) — ocupa lo que de
//   verdad lleva, no solo lo planeado.
// El margen (buffer) se suma siempre al final.
function windowFor(row, nowMs, bufferSec) {
    const startMs = Date.parse(String(row.scheduled_for || ''));
    if (!Number.isFinite(startMs))
        return null;
    let durationSec = Number(row.planned_duration_sec);
    if (!Number.isFinite(durationSec) || durationSec <= 0)
        durationSec = DEFAULT_PLANNED_DURATION_SEC;
    if ((row.status === 'running' || row.status === 'paused') && row.started_at) {
        const startedMs = Date.parse(String(row.started_at));
        if (Number.isFinite(startedMs)) {
            durationSec = Math.max(durationSec, Math.ceil((nowMs - startedMs) / 1000));
        }
    }
    return { startMs, endMs: startMs + (durationSec + bufferSec) * 1000 };
}
// Tareas vivas del dispositivo cuya ventana solapa [startMs, endMs).
// El SQL pre-filtra por rango; la regla fina (extensión real de las running)
// se evalúa acá porque depende de started_at/now.
export function findOverlappingTasks(db, opts) {
    const bufferSec = opts.bufferSec ?? slotBufferSec();
    const nowMs = opts.nowMs ?? Date.now();
    // Upper bound: ninguna tarea que arranque después de nuestro fin puede
    // solaparnos (solape requiere su inicio < nuestro fin). Lower bound: una
    // running puede extenderse más allá de su ventana planeada, así que no
    // descartamos por fin estimado en SQL cuando está en ejecución. El fin de
    // ventana acá incluye el margen, igual que windowFor(): dos tareas pegadas
    // sin los minutos de aire NO son válidas.
    const rows = db.prepare(`
    SELECT id, task_type, status, scheduled_for, planned_duration_sec, started_at, lease_expires_at
    FROM task_runs
    WHERE device_id = ?
      AND status NOT IN ('cancelled', 'expired', 'error')
      AND scheduled_for IS NOT NULL
      AND datetime(scheduled_for) < datetime(?)
      AND (
        datetime(scheduled_for, '+' || CAST(COALESCE(planned_duration_sec, ${DEFAULT_PLANNED_DURATION_SEC}) + ${bufferSec} AS TEXT) || ' seconds') > datetime(?)
        OR ((status IN ('running', 'paused')) AND started_at IS NOT NULL)
      )
      ${opts.excludeTaskId != null ? 'AND id != ?' : ''}
    ORDER BY scheduled_for ASC
  `).all(opts.deviceId, new Date(opts.endMs).toISOString(), new Date(opts.startMs).toISOString(), ...(opts.excludeTaskId != null ? [opts.excludeTaskId] : []));
    const conflicts = [];
    for (const row of rows) {
        if (!isLeaseAlive(row, nowMs))
            continue;
        const window = windowFor(row, nowMs, bufferSec);
        if (!window)
            continue;
        if (window.startMs < opts.endMs && opts.startMs < window.endMs) {
            conflicts.push({
                task_id: Number(row.id),
                task_type: String(row.task_type),
                status: String(row.status),
                scheduled_for: row.scheduled_for ? String(row.scheduled_for) : null,
                window_end: new Date(window.endMs).toISOString(),
            });
        }
    }
    return conflicts;
}
// Reserva una ventana sobre el dispositivo. Con política 'shift', si el
// horario pedido está ocupado avanza al próximo hueco libre (cada avance salta
// al fin del último bloque que estorba, margen incluido). Con 'reject'
// devuelve los conflictos sin mover nada.
export function reserveSlot(input) {
    const { db } = input;
    const bufferSec = slotBufferSec();
    const nowMs = input.now?.getTime() ?? Date.now();
    const desiredMs = Date.parse(input.desiredStart);
    if (!Number.isFinite(desiredMs)) {
        throw new Error('reserveSlot: desiredStart must be a valid ISO date');
    }
    const limitMs = input.shiftLimitMs ?? null;
    const run = db.transaction
        ? db.transaction(() => attempt())
        : attempt;
    function attempt() {
        let candidateMs = desiredMs;
        let lastConflicts = [];
        for (let iteration = 0; iteration < MAX_SHIFT_ITERATIONS; iteration += 1) {
            const conflicts = findOverlappingTasks(db, {
                deviceId: input.deviceId,
                startMs: candidateMs,
                endMs: candidateMs + ((input.durationSec && input.durationSec > 0 ? input.durationSec : DEFAULT_PLANNED_DURATION_SEC) + bufferSec) * 1000,
                excludeTaskId: input.excludeTaskId,
                nowMs,
                bufferSec,
            });
            if (conflicts.length === 0)
                break;
            lastConflicts = conflicts;
            if (input.policy === 'reject') {
                return { ok: false, reason: 'conflict', conflicts };
            }
            // El próximo inicio válido es el fin del último bloque que estorba (el
            // fin ya incluye el margen, así que no hay que sumar buffer extra).
            candidateMs = Math.max(...conflicts.map((conflict) => Date.parse(conflict.window_end)));
            if (limitMs !== null && candidateMs - desiredMs > limitMs) {
                return { ok: false, reason: 'no_slot_within_limit', conflicts: lastConflicts };
            }
        }
        const shifted = candidateMs !== desiredMs;
        const scheduledFor = new Date(candidateMs).toISOString();
        const shiftedFrom = shifted ? input.desiredStart : null;
        if (input.insert) {
            return { ok: true, scheduledFor, shiftedFrom, result: input.insert(scheduledFor, shiftedFrom) };
        }
        return { ok: true, scheduledFor, shiftedFrom };
    }
    return run();
}
// Próximo hueco libre a partir de un instante (para sugerencias de UI).
// Devuelve el ISO del inicio libre o null si excede el límite.
export function nextFreeSlot(opts) {
    const result = reserveSlot({
        db: opts.db,
        deviceId: opts.deviceId,
        desiredStart: opts.from,
        durationSec: opts.durationSec,
        policy: 'shift',
        shiftLimitMs: opts.shiftLimitMs ?? null,
    });
    return result.ok ? result.scheduledFor : null;
}
const CASCADE_MANUAL_LIMIT_MS = 24 * 60 * 60 * 1000;
function esMovableParaCascade(row) {
    return (String(row.status) === 'pending' || String(row.status) === 'overdue') && !row.started_at;
}
// Límite de la cascada para una tarea recorrida: manuales hasta 24 h,
// automáticas solo dentro de su día local original (decisión del dueño §8).
function cascadeLimitMs(row) {
    if (String(row.source) === 'manual' || Number(row.manual_override) === 1) {
        return CASCADE_MANUAL_LIMIT_MS;
    }
    if (!row.scheduled_for)
        return null;
    return msUntilEndOfLocalDay(String(row.scheduled_for));
}
function simulWindow(startMs, plannedDurationSec, bufferSec) {
    let durationSec = Number(plannedDurationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0)
        durationSec = DEFAULT_PLANNED_DURATION_SEC;
    return { startMs, endMs: startMs + (durationSec + bufferSec) * 1000 };
}
// Calcula (SIN aplicar) qué tareas habría que recorrer si `primaryTaskId`
// pasara a insertarse en `targetStart`. Semántica de inserción: las tareas
// ANTERIORES al punto pedido quedan quietas; el destino se desliza al primer
// minuto válido tras ellas (sin saltar ninguna), y cada tarea POSTERIOR
// pisada avanza al próximo hueco continuo libre. Solo intervienen tareas
// pendientes/overdue no iniciadas del MISMO teléfono; running/completadas
// son bloqueos inmóviles. Devuelve el plan o el motivo por el que no hay
// arreglo posible dentro de los límites de corrimiento.
export function planCascadeMove(db, opts) {
    const bufferSec = opts.bufferSec ?? slotBufferSec();
    const nowMs = opts.now?.getTime() ?? Date.now();
    const targetMs = Date.parse(opts.targetStart);
    if (!Number.isFinite(targetMs)) {
        return { ok: false, reason: 'primary_not_movable', detail: 'targetStart inválido' };
    }
    const rows = db.prepare(`
    SELECT id, task_type, status, source, priority, manual_override,
           scheduled_for, planned_duration_sec, started_at, lease_expires_at
    FROM task_runs
    WHERE device_id = ? AND device_id IS NOT NULL
      AND status NOT IN ('cancelled', 'expired', 'error')
      AND scheduled_for IS NOT NULL
  `).all(opts.deviceId);
    const vivas = rows.filter((row) => isLeaseAlive(row, nowMs));
    const primary = vivas.find((row) => Number(row.id) === Number(opts.primaryTaskId));
    if (!primary || !esMovableParaCascade(primary)) {
        return {
            ok: false,
            reason: 'primary_not_movable',
            detail: 'La tarea debe existir y estar pendiente (no iniciada) para moverse en cascada',
        };
    }
    // Semántica "INSERTAR EN EL MEDIO" (fix 2026-08-27): las tareas con hora
    // original ANTERIOR al destino quedan CONGELADAS — jamás se recorren, aunque
    // el margen de la tarea insertada roce su ventana. Solo las POSTERIORES
    // (>= destino) participan de la cascada. Inmóviles (running/completed/
    // paused) siguen siendo bloqueos duros de cualquier hora.
    const frozen = vivas.filter((row) => Number(row.id) !== Number(primary.id)
        && (!esMovableParaCascade(row) || Date.parse(String(row.scheduled_for)) < targetMs));
    const movables = vivas
        .filter((row) => Number(row.id) !== Number(primary.id)
        && esMovableParaCascade(row)
        && Date.parse(String(row.scheduled_for)) >= targetMs)
        .sort((a, b) => Date.parse(String(a.scheduled_for)) - Date.parse(String(b.scheduled_for)));
    const durationOf = (row) => Number(row.planned_duration_sec) > 0
        ? Math.round(Number(row.planned_duration_sec))
        : DEFAULT_PLANNED_DURATION_SEC;
    // PASO A — el destino se desliza SOLO contra las congeladas: si el horario
    // pedido roza el margen de una tarea anterior (o de una inmóvil), la tarea
    // insertada avanza al primer minuto válido después de ese bloqueo. Así la
    // tarea entra lo más cerca posible del punto pedido SIN mover las previas.
    let effTargetMs = targetMs;
    for (let iteration = 0; iteration < MAX_SHIFT_ITERATIONS; iteration += 1) {
        const win = simulWindow(effTargetMs, durationOf(primary), bufferSec);
        let blockedBy = null;
        for (const other of frozen) {
            const otherWin = esMovableParaCascade(other)
                ? simulWindow(Date.parse(String(other.scheduled_for)), durationOf(other), bufferSec)
                : (windowFor(other, nowMs, bufferSec) ?? { startMs: 0, endMs: 0 });
            if (otherWin.endMs <= otherWin.startMs)
                continue;
            if (win.startMs < otherWin.endMs && otherWin.startMs < win.endMs) {
                blockedBy = blockedBy === null ? otherWin.endMs : Math.max(blockedBy, otherWin.endMs);
            }
        }
        if (blockedBy === null)
            break;
        effTargetMs = blockedBy;
    }
    const primaryOriginMs = Date.parse(String(primary.scheduled_for));
    const primaryLimitMs = cascadeLimitMs(primary);
    if (primaryLimitMs !== null && effTargetMs - primaryOriginMs > primaryLimitMs) {
        return {
            ok: false,
            reason: 'chain_overflow',
            detail: `El horario pedido queda tapado por tareas anteriores del teléfono y el `
                + `próximo hueco libre excede el límite de corrimiento de la tarea`,
        };
    }
    // Posiciones simuladas: congeladas en su horario actual, primaria en el
    // destino ya deslizado, posteriores por resolver.
    const positions = new Map();
    for (const row of vivas)
        positions.set(Number(row.id), Date.parse(String(row.scheduled_for)));
    positions.set(Number(primary.id), effTargetMs);
    for (const task of movables) {
        let candidate = positions.get(Number(task.id));
        const originMs = Date.parse(String(task.scheduled_for));
        const limitMs = cascadeLimitMs(task);
        for (let iteration = 0; iteration < MAX_SHIFT_ITERATIONS; iteration += 1) {
            const win = simulWindow(candidate, durationOf(task), bufferSec);
            let blockedBy = null;
            for (const other of vivas) {
                if (Number(other.id) === Number(task.id))
                    continue;
                const otherStart = positions.get(Number(other.id));
                if (otherStart === undefined)
                    continue;
                let otherWin;
                if (esMovableParaCascade(other)) {
                    otherWin = simulWindow(otherStart, durationOf(other), bufferSec);
                }
                else {
                    // Inmóvil (running/completed/paused): su ventana real incluye lo ya corrido.
                    const real = windowFor(other, nowMs, bufferSec);
                    if (!real)
                        continue;
                    otherWin = real;
                }
                if (win.startMs < otherWin.endMs && otherWin.startMs < win.endMs) {
                    blockedBy = blockedBy === null ? otherWin.endMs : Math.max(blockedBy, otherWin.endMs);
                }
            }
            if (blockedBy === null)
                break;
            candidate = blockedBy;
            if (limitMs !== null && candidate - originMs > limitMs) {
                return {
                    ok: false,
                    reason: 'chain_overflow',
                    detail: `La tarea #${task.id} (${String(task.task_type)}) no entra dentro de su `
                        + `límite de corrimiento${String(task.source) === 'manual' ? '' : ' (mismo día local)'}`,
                };
            }
        }
        positions.set(Number(task.id), candidate);
    }
    const moves = [];
    for (const row of vivas) {
        const finalMs = positions.get(Number(row.id));
        if (finalMs === undefined)
            continue;
        const origIso = String(row.scheduled_for);
        const finalIso = new Date(finalMs).toISOString();
        if (Date.parse(finalIso) !== Date.parse(origIso)) {
            moves.push({
                task_id: Number(row.id),
                ...(Number(row.id) !== Number(primary.id) ? { task_type: String(row.task_type) } : {}),
                from: origIso,
                to: finalIso,
            });
        }
    }
    return { ok: true, moves };
}
// "¿Está ocupado este teléfono ahora?" — fin de la ventana que cubre `now`
// (la de mayor fin si varias se enciman), o null si está libre. Es el dato que
// consume el cartel de conflicto de la web y el campo busy_until de deviceView.
export function busyUntilForDevice(db, deviceId, opts = {}) {
    const nowMs = opts.now?.getTime() ?? Date.now();
    const bufferSec = opts.bufferSec ?? slotBufferSec();
    const rows = db.prepare(`
    SELECT id, task_type, status, scheduled_for, planned_duration_sec, started_at, lease_expires_at
    FROM task_runs
    WHERE device_id = ?
      AND status NOT IN ('cancelled', 'expired', 'error')
      AND scheduled_for IS NOT NULL
      AND datetime(scheduled_for) < datetime(?, '+2 hours')
      AND (
        datetime(scheduled_for, '+' || CAST(COALESCE(planned_duration_sec, ${DEFAULT_PLANNED_DURATION_SEC}) + ${bufferSec} AS TEXT) || ' seconds') > datetime(?)
        OR ((status IN ('running', 'paused')) AND started_at IS NOT NULL)
      )
  `).all(deviceId, new Date(nowMs).toISOString(), new Date(nowMs - 48 * 3600 * 1000).toISOString());
    let latestEndMs = null;
    for (const row of rows) {
        if (!isLeaseAlive(row, nowMs))
            continue;
        const window = windowFor(row, nowMs, bufferSec);
        if (!window)
            continue;
        if (window.startMs <= nowMs && nowMs < window.endMs) {
            latestEndMs = latestEndMs === null ? window.endMs : Math.max(latestEndMs, window.endMs);
        }
    }
    return latestEndMs === null ? null : new Date(latestEndMs).toISOString();
}
