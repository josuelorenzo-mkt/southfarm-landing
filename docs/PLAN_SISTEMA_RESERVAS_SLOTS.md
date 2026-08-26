# Plan: Sistema de Reservas de Slots por Teléfono ("Agenda de Flota")

> **Documento de arranque** para implementar el sistema de reservas de ventanas de tiempo
> por dispositivo sobre el stack existente de SouthFarm. Escrito para que cualquier agente o
> desarrollador pueda comenzar desde cero: contexto completo, qué existe, qué cambiar,
> decisiones de diseño ya tomadas, fases con criterios de aceptación y procedimiento de deploy.
>
> Última actualización: 2026-08-26. Estado: **Fases 1 y 2 implementadas** (backend en
> `feature/slot-reservations` de southfarm-landing, 29/29 checks; webapp en
> `feature/slot-reservations` de southfarm-webapp, lint + build + 38/38 tests). Nota: el
> endpoint de movimiento individual es el ya existente `PATCH /api/tasks/runs/:id/schedule`
> (no se creó `/reschedule`): ahora valida con `reserveSlot('reject')`, responde 409 con
> `conflicts` + `next_free_slot` y audita `rescheduled_manual {from, to, by_user_id}`.
> Pendiente: deploy al runtime + merge webapp → main, y Fases 3-4. Herramientas:
> `backend/scripts/test-slot-reservation.mjs` (suite) y
> `backend/scripts/audit-slot-overlaps.mjs` (auditoría post-deploy; correr con el node 22
> del runtime por el ABI del binario better-sqlite3).

---

## 1. Objetivo

Hoy las tareas (`task_runs`) se programan como **puntos en el tiempo** (`scheduled_for`) sin
noción de cuánto ocupa realmente la tarea ni de si el teléfono está libre. Esto produjo
duplicaciones, encimamientos y una cola impredecible. Se va a construir un **sistema de
reservas**: cada tarea reserva una *ventana* `[inicio, inicio + duración + margen]` sobre su
teléfono, y todo el sistema (rutinas, tareas manuales, movimientos) pasa por ese modelo.

Capacidades objetivo:

1. **Ocupación real rastreada**: inicio y fin confirmados por el teléfono; "ocupado hasta X"
   derivado del fin real cuando existe, o de expiración de lease cuando la tarea muere.
2. **Reserva con corrimiento**: si el horario pedido está ocupado, la tarea se ubica
   automáticamente en el próximo hueco libre (automáticas limitadas al mismo día).
3. **Movimiento individual**: cualquier tarea puede moverse de horario de forma independiente
   (aunque haya nacido en un lote de rutina), validada contra solapes.
4. **Conflicto al lanzar manual**: si hay tarea corriendo, la web ofrece *encolar después* o
   *interrumpir + re-encolar* (la interrumpida se ejecuta completa después).
5. **Margen de maniobra**: 5 minutos configurables entre fin estimado de una tarea e inicio
   válido de la siguiente.

---

## 2. Contexto del sistema (lo que hay que saber antes de tocar nada)

### 2.1 Repositorios y dónde vive cada cosa

| Pieza | Ubicación | Notas |
|---|---|---|
| Repo git único | `github.com/josuelorenzo-mkt/southfarm-landing` | Todas las branches viven acá |
| Worktree activo | `C:\SouthFarm\source\.worktrees\visualize-phone` (branch `feature/device-fleet-live-view`) | Sincronizada con origin; acá está el backend que corre |
| Checkout principal | `C:\SouthFarm\source` (branch `feature/ui-redesign-granja-tecnologica`) | Acá vive `ops/windows/southfarm-api-supervisor.ps1` que ejecuta la tarea productiva |
| Webapp | `visualize-phone/webapp` — **repo anidado con git propio** | Vercel deploya de su main; no tocar sin necesidad |
| Backend fuente | `<worktree>/backend/src/` | TypeScript, Express, better-sqlite3 |
| **Runtime productivo** | `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend` | Copia desacoplada del checkout. **Producción NO sale de git**: se compila, se copia `dist/`, se reinicia la tarea |
| Base de datos | `C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db` | SQLite (better-sqlite3), `PRAGMA foreign_keys = ON` |
| Logs productivos | `C:\ProgramData\SouthFarm\logs\southfarm-api.{out,error}.log` | UTF-16LE, rotan a 10MB |
| App mobile | `southfarm_app_v2/` (v1.2.0 fuente) y `dist-fixed/southfarm-1.1.8-release-arm64-vc22-FIXED.apk` (la instalada) | Flutter + servicio nativo Kotlin |

**Regla de entrega del dueño (AGENTS.md)**: cada versión funcional se commitea inmediatamente
antes de seguir iterando. Push a origin tras cada commit importante.

### 2.2 Cadena de producción

```
Web (Vercel, southfarm-webapp.vercel.app)
   │ HTTPS
   ▼
api.southfarm.tech  ── túnel cloudflared (servicio Windows "cloudflared") ──▶ 127.0.0.1:3001
   ▼
API Node (tarea programada "SouthFarm API", corre como SYSTEM vía
   powershell southfarm-api-supervisor.ps1 -BackendPath <runtime>)
   ▼
SQLite southfarm.db
   ▲
   │ polls cada 5s con device token (sfd_...)
Teléfonos Android (02, 07, 08, 09) — app 1.1.8 + SouthFarmAccessibilityService (Kotlin)
```

- Puerto local: **3001**. Health check: `GET http://127.0.0.1:3001/api/health`
  (respuesta rica: incluye `uptime_seconds`; si responde solo `{status,timestamp}` hay un
  proceso viejo/zombi atendiendo — ver §6 gotchas).
- Los teléfonos autentican con **device token** opaco (`sfd_...`, hash en
  `devices.device_token_hash`). El middleware `auth` lo acepta como `authType: 'device'`.
  **Desde el commit `e71f051`, `/api/devices/register` NUNCA rota el token** (rotación solo
  en `/devices/claim`, emparejamiento nuevo).

### 2.3 Estado de la flota (al momento de escribir esto)

- 4 teléfonos (alias **02, 07, 08, 09**) conectados por USB, todos en app **1.1.8**
  (APK: `southfarm_app/dist-fixed/southfarm-1.1.8-release-arm64-vc22-FIXED.apk`,
  versionCode 22).
- Workspace **6**, modo scheduler **`manual_only`** (desde el 19/08, decisión del dueño):
  los teléfonos solo reclaman tareas `source='manual'`. Las rutinas automáticas están
  **pausadas** por el dueño.
- Clústeres existentes: "Marczell Wisdom" (1), "app de plantas" (2), "ema nuevo" (3).
  **Comparten teléfonos** (el 08 tenía cuentas de los tres): es el origen histórico de las
  duplicaciones (§4).

---

## 3. Anatomía técnica actual (archivos, tablas, endpoints)

### 3.1 Tablas relevantes (SQLite)

**`task_runs`** — la tabla central. Columnas clave:
`id, user_id, device_id, workspace_id, task_type, platform, source ('manual'|'automatic'),
params (JSON), status, result, scheduled_for, overdue_at, expires_at, planned_duration_sec,
actual_duration_sec, social_account_id (FK→social_accounts), account_key, plan_item_id,
cluster_id, routine_id, manual_override, priority (manual=1000), attempt_count,
account_snapshot, created_at, started_at, completed_at, updated_at, claimed_at,
lease_expires_at, last_heartbeat_at, cancel_reason`.
Índices útiles existentes por status/scheduled_for.

Estados usados: `pending, running, completed, error, cancelled, expired` (y `overdue`
derivado/flag por tiempo). **Convención crítica**: `cancelled/expired/error` NO bloquean
regeneración del planner; `pending/running` sí.

**`task_events`** — bitácora append-only: `created, created_automatic, claimed, completed,
error, cancelled_manual, auto_cancelled_routine, updated...` con payload JSON. Toda operación
del scheduler debe dejar evento acá.

**`devices`** — `device_token_hash, lifecycle_status ('active'|'revoked'|'paused'),
device_alias ('02'...'09'), workspace_id, last_seen_at, last_auth_at`.

**`workspace_controls`** — `scheduler_mode ('normal'|'manual_only'|'paused')` por workspace;
workspace 6 hoy en `manual_only`.

**`social_accounts`** — cuentas detectadas por teléfono (FK desde task_runs; ver gotcha §6.3).

### 3.2 Código del backend (worktree `visualize-phone`)

| Archivo | Contenido |
|---|---|
| `backend/src/index.ts` (~4500 líneas) | Toda la API. Endpoints clave: `POST /api/tasks/run` (crea tarea, línea ~2950), `POST /api/tasks/claim` (~3393, filtra por scheduler_mode y `EXECUTABLE_TASK_TYPES`), `POST /api/tasks/runs/:id/heartbeat` (~3639), actualización de estado de tarea (~3859), `POST /api/social-accounts` (~3976), `/api/devices/*`, `/api/planner/tasks` (~3104) |
| `backend/src/activity-planner.ts` (~2390 líneas) | Generador de rutinas. Funciones clave: `generateWarmupDay` / `generateScanDay` (crean slots por día), `existingNonCancelledForDay` (dedupe intra-rutina), `hasActiveTaskForSlot` (**guard global agregado el 26/08, commit `97af908`**), `cancelRoutineFutureTasks` / `cancelClusterFutureTasks`, `insertRoutineTask` (~línea 337, INSERT en task_runs), ciclo de arranque "Startup plan" (~1765). Timezone: `BUENOS_AIRES_TIMEZONE`, helpers `localDateTimeToIso` / `dateKeyInTimezone` |
| `backend/src/db.ts` | Abre SQLite; **`PRAGMA foreign_keys = ON`** (¡cualquier violación FK tira excepción!) |
| `backend/src/jwt-config.ts` | JWT con secret del runtime config + fallback dev |
| `ops/windows/southfarm-api-supervisor.ps1` | Supervisor del runtime (ambas copias sincronizadas: principal y worktree) |

Tipos de tarea ejecutables por la app (`EXECUTABLE_TASK_TYPES`): `warmup_ig, warmup_tiktok,
warmup_youtube, scan_instagram, scan_tiktok, scan_youtube`. (`publish_reel` existe pero no lo
ejecuta la flota aún.)

### 3.3 La app móvil (lado teléfono)

- Servicio Kotlin `SouthFarmAccessibilityService.kt`: poll de tareas cada ~5s con device
  token, claim con lease, heartbeat durante ejecución, reporte de estado final
  (completed/error) vía `POST /api/tasks/runs/:id/...`.
- Canal remoto aparte: la app consulta cada 2-3s comandos de control
  (pausar/reanudar/detener) — **es el canal que se usará para interrumpir tareas** (Fase 3).
- Duraciones reales: warmups corren 40-80 min según config; scans ~10 min (50-90 s de
  detección + navegación).

### 3.4 Qué YA existe y hay que reutilizar (no reconstruir)

- `started_at`, `completed_at`, `actual_duration_sec`, `planned_duration_sec` en task_runs.
- Heartbeats con lease (`lease_expires_at`) — mecanismo de liberación ante muertes silenciosas.
- Campo `priority` (manual=1000 > automática) y `manual_override`.
- Bitácora `task_events` para auditoría de movimientos/corrimientos.
- Canal de control remoto de la app (para interrupciones).
- Guard global anti-duplicado puntual: `hasActiveTaskForSlot(deviceId, taskType, scheduledFor)`
  en activity-planner.ts (comparación por instante exacto — el sistema nuevo lo reemplaza por
  solape de ventanas, pero conviene mantenerlo como backstop).

---

## 4. Problema que motiva esto (historia reciente, agosto 2026)

1. **Duplicación masiva de tareas**: tres clústeres compartían teléfonos y cada rutina
   generaba sus propios slots; el dedupe era solo intra-rutina. Acumularon ~150 tareas
   automáticas repetidas (hasta 3 copias por slot). Fix puntual: `hasActiveTaskForSlot`
   (commit `97af908`). Pero es comparación de instantes exactos: no detecta encimamientos de
   ventanas ni reubica tareas.
2. **Scans que perdían cuentas y quedaban trabados**: `/devices/register` rotaba el device
   token en cada llamada y el token capturado al reclamar moría a mitad del scan → 401 al
   reportar resultados. Fix: commit `e71f051` (nunca rota en register).
3. **Crash-loop de la API**: violación de FK al borrar `social_accounts` referenciadas +
   handler async sin catch mataban el proceso entero cada ~40s. Fix: detach previo + try/catch
   + guard global de rechazos (`51869c4`).
4. **Supervisor frágil + zombis**: PowerShell 5.1 convertía stderr del backend en error
   terminal del supervisor (`5050118`/`879afcf`); una copia vieja del backend bajo WSL/PM2
   llegó a atender el puerto productivo (eliminada). Lección: verificar SIEMPRE el formato
   rico del health check, no solo HTTP 200.

Consecuencia de diseño: **la cola debe volverse predecible y legible** — reservas explícitas,
duraciones reales, un lugar único donde consultar "¿está libre este teléfono?".

---

## 5. Diseño técnico del sistema de reservas

### 5.1 Modelo de ventanas

Cada tarea ocupa `[scheduled_for, scheduled_for + duración + margen]`:

- `duración` = `planned_duration_sec` si la tarea es futura; para chequeos contra tareas en
  ejecución usar `max(planned, ahora - started_at)`; para estimar huecos preferir
  `actual_duration_sec` promedio del mismo task_type+device si existe historial.
- `margen` = constante configurable `SCHED_SLOT_BUFFER_SEC` (default **300** = 5 min),
  leída de env var en el supervisor/runtime config.
- Solape entre dos ventanas A y B: `A.start < B.end && B.start < A.end`.

### 5.2 Función central de reserva (transaccional)

```
reservarSlot(db, {deviceId, taskType, deseadoStart, duracionSec, politica}):
  BEGIN TRANSACTION (better-sqlite3: db.transaction)
    loop:
      conflicto = SELECT tarea viva de ese device cuyo intervalo solapa
                 (status NOT IN cancelled/expired/error, usando ventana propia)
      si no hay conflicto -> break
      si politica == 'reject' -> ROLLBACK, devolver {ok:false}
      si politica == 'shift':
         si (nuevoInicio - deseadoStart) > limiteCorrimiento -> descartar/registrar
         deseadoStart = fin del último bloque que estorba + margen
    INSERT task_runs con scheduled_for = deseadoStart
    recordTaskEvent('created' | 'created_automatic', {shifted_from: ...})
  COMMIT
```

- **Atómico**: el SELECT de conflicto y el INSERT dentro de `db.transaction()` de
  better-sqlite3 (single-writer: suficiente; no hace falta más concurrencia).
- `politica`: `'shift'` para automáticas del planner (con límite = resto del día local del
  teléfono; si no hay hueco ese día, se omite y queda registrado), `'shift'` también para
  manuales pero con límite mayor (24 h), `'reject'` disponible para validaciones de UI.
- Índice recomendado: `CREATE INDEX IF NOT EXISTS idx_task_runs_device_sched ON
  task_runs(device_id, scheduled_for)` si no existe uno cubiciente.

### 5.3 Estado "teléfono ocupado hasta"

Endpoint existente de devices (o campo calculado en `deviceView`) expondrá:

```
busy_until:  max(lease_expires_at|completed_at+buffer) de la tarea activa, o null si libre
current_task: {...} (ya existe en deviceView)
```

Reglas:
- Tarea `running` → ocupado hasta `min(now + restante_estimado, lease_expires_at)`;
  al completarse, el handler de estado final recalcula `libre_desde = completed_at + buffer`.
- Tarea muerta sin aviso → su lease vence y desaparece del cálculo (mecanismo existente).
- Este dato es lo que consume la Fase 3 (cartel de conflicto) y la web futura (agenda).

### 5.4 Movimiento individual de tareas

`PATCH /api/tasks/runs/:id/reschedule {scheduled_for}`:
- Auth usuario (owner/admin/operator) del workspace de la tarea; solo tareas `pending`
  (no running/completed).
- Validación con `reservarSlot(politica:'reject')` contra el resto de la agenda del teléfono
  (excluyéndose a sí misma).
- Si ok: UPDATE + `task_events` tipo `rescheduled` con `{from, to, by_user_id}`.

### 5.5 Conflicto al lanzar manual (Fase 3)

`POST /api/tasks/run` gana parámetro opcional `conflict_policy`:
- Default actual: crear igual (compatibilidad).
- `conflict_policy: 'report'`: si el teléfono tiene `busy_until` vigente o una ventana
  planeada que solapa, responde `409` con detalle del bloqueo y alternativas → la web muestra
  el cartel: *"Hay una tarea corriendo / en cola: ¿Encolar después? / ¿Interrumpir?"*.
- Interrumpir = `POST .../interrupt`: cancela la tarea en ejecución vía canal de control
  remoto existente, marca `cancelled` con motivo `interrupted_by_manual`, recrea la tarea
  original completa encolada después de la nueva (**reinicio completo, sin resume** — el
  resume verdadero queda como mejora futura porque exige checkpoints de sesión en la app).

### 5.6 Corrimiento correctivo (Fase 4)

Job periódico (el scheduler tick ya existe, `SOUTHFARM_SCHEDULER_TICK_SECONDS=30`): tareas
`pending` cuya `scheduled_for` pasó y cuyo teléfono sigue ocupado → recorrer `scheduled_for`
al próximo hueco libre (misma función de reserva), dejando evento `auto_shifted`. Evita la
rafaga de tareas atrasadas ejecutándose encimadas cuando el teléfono se libera.

---

## 6. Gotchas operativos (lecciones caras de la intervención del 25-26/08)

1. **Deploy de backend** = `cd backend && npm install --ignore-scripts` (primera vez; el build
   nativo de better-sqlite3 falla sin VS Build Tools, el runtime ya trae el binario) →
   `npm run build` (o `npx tsc`) → copiar `backend/dist/*.js` a
   `%LOCALAPPDATA%\SouthFarm\runtime\backend\dist\` → reiniciar tarea
   (`schtasks /end + /run "SouthFarm API"`). **Verificar health formato rico**
   (`uptime_seconds` presente) tras reiniciar: si responde `{status,timestamp}` corto, hay un
   proceso viejo en el puerto.
2. **Procesos huérfanos SYSTEM**: `schtasks /end` a veces deja el node vivo dueño del puerto
   y es imposible de matar sin admin. Síntoma: uptime viejo en health tras reiniciar. Solución:
   pedirle al dueño `taskkill /F /PID <pid>` en consola administrador y relanzar.
3. **FK estrictas**: `PRAGMA foreign_keys=ON`. Antes de borrar filas con hijos referenciados
   (ej. social_accounts ← task_runs.social_account_id) desvincular primero. Handler async sin
   catch = muerte del proceso (mitigado con guard global, pero no abusar).
4. **WSL**: existe un Ubuntu con PM2 (`pm2-josue.service`) que históricamente corría una copia
   vieja del backend en el puerto 3001 vía localhost-forwarding. La entrada fue eliminada
   (`pm2 delete southfarm-api` + save). Si el puerto "responde código viejo" revisar WSL:
   `wsl -d Ubuntu -- ss -tlnp | grep 3001`.
5. **El planner corre en cada arranque** ("Startup plan"): cualquier reinicio de la API
   dispara regeneración. Todo cambio al generador debe ser idempotente.
6. **PowerShell 5.1**: en el supervisor, stderr del hijo + `$ErrorActionPreference='Stop'` +
   redirección `*>>` = muerte del supervisor (ya mitigado; no revertir).
7. **Timezone**: todo se guarda UTC ISO; la agenda del usuario es America/Argentina/Buenos_Aires
   (`BUENOS_AIRES_TIMEZONE`, helpers `dateKeyInTimezone`/`localDateTimeToIso`). Los límites
   "mismo día" para corrimientos deben calcularse con esos helpers, nunca con `substr`.

---

## 7. Fases de implementación

> Cada fase termina en: compilación limpia, deploy al runtime, verificación de estabilidad
> (health rico ≥ 10 min), commit + push, y prueba funcional específica.

### Fase 1 — Fundación: ventanas + reserva con corrimiento + ocupación real

**Cambios:**

1. `activity-planner.ts`:
   - Nueva función `findOverlappingTask(deps, deviceId, startISO, endISO, excludeId?)`.
   - Nueva `reserveSlot(...)` transaccional con políticas `'shift'`/`'reject'` y límite de
     corrimiento por política (automática = hasta fin del día local; manual = 24 h).
   - `generateWarmupDay` / `generateScanDay`: reemplazar el guard puntual
     `hasActiveTaskForSlot` por `reserveSlot(politica:'shift')` (mantener el guard viejo como
     backstop de coincidencias exactas).
2. `index.ts`:
   - Constante `SLOT_BUFFER_SEC` (env `SOUTHFARM_SLOT_BUFFER_SEC`, default 300).
   - `POST /api/tasks/run`: crear vía `reserveSlot(politica:'shift', limite 24h)` en
     transacción; responder el horario efectivo asignado (`scheduled_for` final) para que la
     web muestre "se agendó para las HH:MM".
   - `deviceView`: agregar `busy_until` calculado según §5.3.
3. Tests manuales scripted (no hay suite formal de planner):
   - Con dos rutinas aprobadas sobre el mismo teléfono, verificar que el segundo clúster cae
     en el hueco siguiente y no encima (contar task_runs por slot).
   - Crear manual que pisa una automática futura → verificar corrimiento y evento
     `created` con `shifted_from`.
   - Verificar `busy_until` con tarea running real y con tarea muerta (lease vencido).

**Criterio de aceptación:** cero solapes de ventana en task_runs para un mismo teléfono
(query de auditoría incluida abajo); horarios efectivos devueltos al creador; API estable.

Query de auditoría (usar post-deploy):

```sql
-- solapes de ventana por teléfono (debe devolver 0 filas)
SELECT a.id, b.id, a.device_id, a.scheduled_for, a.task_type, b.task_type
FROM task_runs a JOIN task_runs b
  ON a.device_id = b.device_id AND a.id < b.id
 AND a.status NOT IN ('cancelled','expired','error')
 AND b.status NOT IN ('cancelled','expired','error')
 AND datetime(a.scheduled_for,'+'||COALESCE(a.planned_duration_sec,600)||' seconds') > b.scheduled_for
 AND datetime(b.scheduled_for,'+'||COALESCE(b.planned_duration_sec,600)||' seconds') > a.scheduled_for;
```

### Fase 2 — Movimiento individual de tareas

1. `PATCH /api/tasks/runs/:id/reschedule` (solo `pending`; valida con
   `reserveSlot(politica:'reject')` excluyéndose a sí misma; audita `rescheduled`).
2. Web (`webapp`, repo anidado): acción ⋮ en cada tarjeta de tarea → "Mover" con selector de
   hora; feedback si el horario choca (mostrar próximo hueco sugerido llamando con
   `conflict_policy:'report'`).
3. Probar: mover 1 warmup de un lote de 4 sin afectar los demás; intentar mover encima de otra
   → rechazo limpio con mensaje.

**Criterio:** movimiento atómico, auditado, sin posibilidad de solape; UI refleja el cambio
sin recargar.

### Fase 3 — Conflicto al lanzar manual + interrupción

1. `POST /api/tasks/run` soporta `conflict_policy:'report'` → `409` con
   `{blocking_task, busy_until, alternatives:{next_free_slot}}`.
2. Endpoint `POST /api/tasks/runs/:id/interrupt` (owner/admin): usa el canal de control remoto
   existente (stop), marca `cancelled` motivo `interrupted_by_manual`, recrea la tarea
   completa vía `reserveSlot` encolada después de la nueva, deja eventos de ambos pasos.
3. Web: cartel en el lanzamiento manual cuando `report` devuelve 409: botones
   *"Encolar después"* (usa next_free_slot) y *"Interrumpir y correr esta"* (llama interrupt +
   crea). Texto honesto: la interrumpida se ejecuta completa luego (no resume).
4. Probar con warmup largo corriendo + intento de scan manual.

**Criterio:** nunca quedan dos tareas marcadas running en el mismo teléfono; la interrumpida
queda encolada visible; auditoría completa de la secuencia.

### Fase 4 — Pulido

1. Corrimiento correctivo: en el tick del scheduler, pendings atrasadas con teléfono ocupado
   se recorren al próximo hueco (`auto_shifted`).
2. Vista "Agenda del teléfono" en la web (timeline del día con ventanas y huecos).
3. Franjas operativas por dispositivo (config: horas permitidas) aplicadas en `reserveSlot`.
4. Resume verdadero de tareas interrumpidas (requiere checkpoint de sesión en la app Kotlin/
   Flutter — evaluar costo antes de prometer).
5. Métricas: duración media real por task_type+device para afinar estimaciones.

---

## 8. Decisiones de diseño ya tomadas (no re-discutir sin el dueño)

- Margen entre tareas: **5 minutos**, configurable (`SOUTHFARM_SLOT_BUFFER_SEC`).
- Automáticas: corrimiento limitado al **mismo día local** del teléfono; sin hueco → se omite
  con registro. Manuales: hasta 24 h.
- Interrumpir = **cancelar + re-ejecutar completa** después; resume verdadero pospuesto.
- Sin tabla nueva de slots: `task_runs` es la única fuente de verdad; ventanas derivadas de
  `scheduled_for` + `planned_duration_sec` + buffer.
- Modo scheduler del workspace 6 hoy: **manual_only** (decisión del dueño, 19/08). Rutinas
  pausadas. El sistema debe respetar ambos filtros existentes en claim.
- Prioridad: manual (1000) siempre puede agendar aunque haya automáticas cerca; las
  automáticas se recorren.

---

## 9. Checklist de entorno para la sesión nueva

1. `adb devices` → 4 teléfonos USB (seriales en `C:\ProgramData\SouthFarm\screen-bridge\devices.json`,
   alias 02/07/08/09).
2. API viva: `curl http://127.0.0.1:3001/api/health` → formato rico, uptime creciente.
3. Tarea "SouthFarm API": `schtasks /query /tn "SouthFarm API"` → Running.
4. Trabajar en `C:\SouthFarm\source\.worktrees\visualize-phone` (branch
   `feature/device-fleet-live-view`, pusheada y al día).
5. Para probar el planner con rutinas: están **pausadas**; reactivar una sola rutina de un
   solo clúster para pruebas y volver a pausar al terminar (o crear clúster de prueba con un
   solo teléfono).
6. Usuario de pruebas: **NO existe** (QA user borrado el 26/08). Crear uno nuevo vía
   `POST /api/auth/register` + membership SQL al workspace 6 (recordar: borrar la membresía
   del workspace propio automático para que `workspaceIdForUser` resuelva el 6 — ver
   conversación del 25/08).

## 10. Orden de trabajo sugerido para la primera sesión

1. Leer este doc + `ESTRATEGIA_VISTA_EN_VIVO_FLOTA.md` (contexto de infraestructura).
2. Fase 1 completa (código + deploy + auditoría de solapes en 0).
3. Dejar la query de auditoría documentada y correrla tras cada deploy del planner.
4. No tocar la app mobile en esta etapa: todo lo de las Fases 1-2 es backend+web.
