# Activity Planner — Contrato de API v1

> ## Extensiones v3 (2026-08-20) — BINDING para la iteración 3
>
> **1. Configs de rutina extendidas** (retrocompatibles: campos nuevos opcionales con defaults):
> - `warmup_daily`: `{ "minMinutes": 40, "sessionsPerDay": 2, "maxGapHours": 4 }` — `sessionsPerDay` = en cuántas sesiones se reparten los minutos (1–4); `maxGapHours` = máximo tiempo entre sesiones consecutivas. El motor distribuye `minMinutes` en `sessionsPerDay` sesiones dentro de 12:00–22:00 BA respetando el gap máximo (y mínimo 30 min entre sesiones).
> - `publishing`: `{ "postsPerWeek": 2, "days": [2, 4] }` — `days` = días de semana elegidos (1=lun … 7=dom, estilo ISO). El motor distribuye los posts en esos días; si hay menos días que posts, rota. Default `[2,4]` (mar/jue).
> - `scan_auto` sin cambios: `{ "timesPerDay": 2, "minGapHours": 9 }`.
>
> **2. Detalle de cluster — warmup POR CUENTA:**
> `GET /api/clusters/:id` → `history` gana `accountsWarmup: [{ "accountId": 11, "username": "marczell.clips", "platform": "instagram", "warmupByDay": [40, 40, ...14] }]` (una serie de 14 días por cuenta; el agregado `warmupByDay` se mantiene por compatibilidad).
>
> **3. Publicación de cluster con ARCHIVO (no URL):**
> `POST /api/clusters/:id/publish` acepta `multipart/form-data` con: `video` (archivo, requerido), `title` (string), `scheduledFor` (ISO opcional). El backend guarda el archivo en `backend/data/uploads/cluster-assets/` con nombre generado (`assetId`), crea un `publish_reel` por cuenta con `params: { title, assetId, assetName, cluster_id, cluster_name, duration_minutes }`, y responde `{ "created": k, "assetId": "…" }`. Se sirve el archivo para preview en `GET /assets/cluster/:assetId` (montaje estático local). El body JSON legacy con `videoUrl` sigue aceptándose por compatibilidad.

- **Fecha:** 2026-08-19
- **Propósito:** contrato binding entre backend y frontend para implementar el Activity Planner en paralelo.
- **Auth:** igual que el resto de la API: `Authorization: Bearer <JWT>` con los middlewares existentes (`requireAuth` + roles `owner|admin|operator` para mutaciones; `viewer` puede leer).
- **Timezone:** todas las fechas se devuelven ISO UTC; el frontend muestra en `America/Argentina/Buenos_Aires`. Los parámetros `start`/`date` son date keys (`YYYY-MM-DD`) interpretados en Buenos Aires.
- **Prefijo:** todo bajo `/api`.

## Modelo nuevo (migración v3, aditiva)

```sql
account_clusters (
  id INTEGER PK, workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',      -- 'confirmed' | 'suggested'
  detection_method TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
  created_at TEXT, updated_at TEXT
)
account_cluster_members (
  id INTEGER PK, cluster_id INTEGER NOT NULL, social_account_id INTEGER NOT NULL,
  UNIQUE(cluster_id, social_account_id)
)
cluster_routines (
  id INTEGER PK, cluster_id INTEGER NOT NULL,
  routine_type TEXT NOT NULL,   -- 'warmup_daily' | 'scan_auto' | 'publishing'
  config TEXT NOT NULL,         -- JSON según routine_type (abajo)
  status TEXT NOT NULL DEFAULT 'approved',  -- 'approved' | 'editing' | 'paused'
  created_at TEXT, updated_at TEXT,
  UNIQUE(cluster_id, routine_type)
)
```

`task_runs` gana columnas aditivas: `cluster_id INTEGER`, `routine_id INTEGER` (nullable, para tareas generadas por rutinas). Los `params` JSON de tareas generadas incluyen `cluster_id`, `routine_id`, `cluster_name`.

### Config por routine_type

```jsonc
warmup_daily: { "minMinutes": 40 }            // min de warmup POR CUENTA POR DÍA
scan_auto:    { "timesPerDay": 2, "minGapHours": 9 }
publishing:   { "postsPerWeek": 2 }           // videos POR CUENTA POR SEMANA
```

## Endpoints

### 1. `GET /api/planner/week?start=YYYY-MM-DD`

Vista principal. `start` = lunes de la semana (default: lunes de la semana actual en BA). Devuelve clusters confirmados + sugeridos con sus tareas de la semana y las series para los charts.

```jsonc
{
  "weekStart": "2026-08-17", "weekEnd": "2026-08-23",
  "now": "2026-08-19T18:42:00.000Z",
  "summary": { "tasksTotal": 84, "tasksRunning": 2, "tasksQueued": 30, "publishTotal": 18, "warmupMinutesPlanned": 2520 },
  "clusters": [
    {
      "id": 1, "name": "Marczell Clips",
      "status": "confirmed",            // 'confirmed' | 'suggested'
      "health": "ok",                   // 'ok' | 'deficit' | 'paused'
      "accounts": [
        { "id": 11, "platform": "instagram", "username": "marczell.clips", "deviceAlias": "n9", "policyStatus": "warming" }
      ],
      "routines": [
        { "id": 1, "routineType": "warmup_daily", "status": "approved", "config": { "minMinutes": 40 } }
      ],
      "metricSeries": {                  // 7 valores (lun..dom) por métrica
        "warmup": [40, 40, 40, 0, 0, 0, 0],   // minutos EJECUTADOS+planificados por día (para 'hoy': solo ejecutado)
        "posts":  [0, 1, 0, 0, 0, 0, 0],
        "views":  [0, 0, 0, 0, 0, 0, 0]        // siempre 0 por ahora (próximamente)
      },
      "tasks": [                          // tareas de la semana de este cluster
        { "id": 501, "taskType": "warmup_ig", "status": "pending",
          "scheduledFor": "2026-08-19T16:00:00.000Z", "durationMin": 20,
          "username": "marczell.clips", "platform": "instagram", "deviceAlias": "n9", "source": "automatic" }
      ]
    }
  ]
}
```

- `taskType` ∈ `warmup_ig|warmup_tiktok|warmup_youtube|scan_instagram|scan_tiktok|scan_youtube|publish_reel`.
- `status` ∈ `pending|overdue|expired|running|paused|cancelled|completed|error`.
- `health`: `paused` si todas las rutinas del cluster están `paused`; `deficit` si algún día pasado de la semana tiene menos actividad ejecutada que lo que exige la rutina aprobada; `ok` en el resto.

### 2. `GET /api/planner/day?date=YYYY-MM-DD`

Timeline del día (default: hoy).

```jsonc
{
  "date": "2026-08-19",
  "tasks": [
    { "id": 501, "taskType": "warmup_ig", "status": "running",
      "scheduledFor": "2026-08-19T16:00:00.000Z", "durationMin": 20,
      "clusterId": 1, "clusterName": "Marczell Clips",
      "username": "marczell.clips", "platform": "instagram", "deviceAlias": "n9", "source": "automatic" }
  ],
  "hourly": [ { "hour": 12, "count": 3 }, { "hour": 13, "count": 0 } ]   // 12..22
}
```

### 3. Clusters

- `GET /api/clusters` → `{ "clusters": [ {id, name, status, detectionMethod, accountCount, memberAccountIds: [11,12]} ] }` (incluye sugeridos).
- `POST /api/clusters` body `{ "name": "…", "accountIds": [11,12] }` → crea cluster `confirmed` con rutinas default (warmup_daily 40 approved, scan_auto 2/9 approved, publishing 2 approved) → devuelve el objeto completo del punto 1 (mismo shape que item de `clusters[]`).
- `PATCH /api/clusters/:id` body `{ "name": "…" }` → renombra.
- `POST /api/clusters/:id/confirm` → `suggested` → `confirmed` (+ crea rutinas default si no existen).
- `DELETE /api/clusters/:id?mode=reject|delete` → `reject` descarta un sugerido (soft: status `rejected`), `delete` elimina cluster confirmado (NO borra cuentas; cancela sus tareas automáticas futuras no iniciadas).
- `POST /api/clusters/:id/members` body `{ "accountIds": [13] }` → agrega.
- `DELETE /api/clusters/:id/members/:accountId` → quita.
- `GET /api/clusters/suggestions/scan` → re-ejecuta auto-detección y devuelve nuevos sugeridos (`{ "created": [cluster…] }`). Heurística: agrupar `social_accounts` del workspace cuyo username normalizado (sin @, lowercase, sin puntos/guiones) coincide entre plataformas.

### 4. `GET /api/clusters/:id` — detalle

```jsonc
{
  "cluster": { /* ídem item de clusters[] del week */ },
  "history": {
    "publications": [ { "id": 502, "taskType": "publish_reel", "status": "completed",
      "scheduledFor": "…", "username": "…", "platform": "tiktok", "title": "Como editar en 30s" } ],  // últimas 10
    "warmupByDay": [40, 40, 20, 40, 0, 0, 0, 40, 40, 40, 40, 0, 0, 0],  // 14 días, minutos ejecutados
    "postsByDay": [0,1,0,0,0,0,0, 0,1,0,0,0,0,0],                        // 14 días
    "stats": { "warmupMinutes30d": 2400, "posts30d": 8, "views": null }  // views null = próximamente
  },
  "nav": { "prevClusterId": 5, "nextClusterId": 2 }   // por orden del listado; null si no hay
}
```

### 5. Rutinas — `GET/PUT`

- `GET /api/clusters/:id/routines` → `{ "routines": [ {id, routineType, config, status} ] }` (3, una por tipo; se crean con defaults al confirmar/crear el cluster).
- `PUT /api/clusters/:id/routines/:routineId` body `{ "config"?: {...}, "status"?: "approved"|"editing"|"paused" }`:
  - Si llega **solo `config`** (o config con status distinto de `approved`): guarda config y fuerza `status='editing'`. **NO toca el plan.** (El toggle del frontend pasa solo a Editando.)
  - Si llega `status='approved'`: aplica config+rutina como nueva realidad → cancela tareas automáticas **futuras no iniciadas** de esa rutina en ese cluster y **regenera** el plan (semana en curso desde ahora + próxima semana).
  - Si llega `status='paused'`: cancela tareas automáticas futuras no iniciadas de esa rutina; la generación la saltea.
  - Si llega `status='editing'` sin config: no-op de plan (solo estado).
  - Respuesta: `{ "routine": {…}, "regenerated": true|false }`.

### 6. `POST /api/planner/week/generate` body `{ "start": "YYYY-MM-DD" (opcional) }`

Materializa/regenera la semana (default: semana actual) desde las rutinas `approved` de todos los clusters confirmados. Idempotente por (cluster, rutina, día): no duplica tareas existentes no canceladas. Respuesta: `{ "created": n, "cancelled": m, "weekStart": "…" }`.

### 7. `POST /api/clusters/:id/publish` body `{ "videoUrl": "…", "title": "…", "scheduledFor": "ISO opcional" }`

Publicación de cluster: crea un `publish_reel` task_run **por cada cuenta** del cluster (mismo video y título), `source:'automatic'` (o manual si viene del composer). Respuesta `{ "created": k }`. (Ejecución real fuera de alcance local: quedan pending.)

### 8. Tareas — reuso de endpoints existentes

- Manual: `POST /api/tasks/run` (ya existe; aceptar `clusterId` opcional en params para que aparezca asociada).
- Reagendar: `PATCH /api/tasks/runs/:id/schedule` (existe).
- Cancelar: `PATCH /api/tasks/runs/:id/stop` (existe) — debe cancelar también si la tarea tiene `cluster_id` (verificar que el filtro por workspace lo permita).
- Live: los `status` de week/day reflejan ejecución real vía el protocolo existente (claim/lease, polling de la app).

## Motor de generación (reglas)

- **warmup_daily:** por cuenta del cluster, por día de la semana (lun..dom, solo días ≥ hoy para regeneraciones): total de `minMinutes` repartido en 2-3 sesiones dentro de la ventana 12:00–22:00 BA con ~2h de separación (reusar `splitWarmupDurationSeconds` y el espaciado existente de `generatePlannerPlan`). Cada sesión = 1 `task_runs` con `task_type` según plataforma de la cuenta.
- **scan_auto:** por día, `timesPerDay` scans del cluster con `minGapHours` de separación (default horas 11:00 y 21:00 aprox.), `task_type = scan_<platform>` por cada cuenta? — NO: 1 scan por cuenta por turno (mismo dispositivo elige la cuenta; simple: crear 1 scan task por cuenta por turno).
- **publishing:** `postsPerWeek` `publish_reel` por cuenta, distribuidos en días fijos (mar y jue 16:00 BA por default, offset por cluster), título placeholder "— definir contenido —" si no hay contenido asignado.
- Semanas cubiertas: la semana en curso (solo desde ahora hacia adelante si se regenera a mitad de semana) y la próxima.
- El backend genera al arrancar (si no existe plan) y al aprobar rutinas. Botón "Regenerar semana" del frontend llama al endpoint 6.

## Seed / demo (idempotente, solo si no hay clusters en el workspace)

Al arrancar el backend (ticker de arranque, detrás de `SOUTHFARM_SEED_DEMO` default **true** en dev):

1. Tomar el primer workspace con owner. Si no hay `social_accounts`, crear 8-10 sample accounts (usernames tipo `marczell.clips`, `nova.gaming`, `cocina.sur`, `fitzone.ok`, `urbanstyle` en ig/tt/yt) asociadas a los dispositivos existentes.
2. Auto-detectar sugeridos por username normalizado; **confirmar 4** (con rutinas default approved), dejar 1 como `suggested`.
3. Crear usuario demo si no existe: `demo@southfarm.local` / `southfarm` (role owner del mismo workspace) — solo create-if-missing, jamás resetear passwords existentes.
4. Generar semana actual + próxima.
5. Marcar algunos estados realistas: 1-2 tareas completed con `result` (para que los charts de warmup/posts tengan histórico), 1 running si hay dispositivos online.

## Errores

Formate igual al resto de la API: `{ "error": "mensaje" }` con 400/401/403/404/409. 409 si el workspace está pausado y se quiere generar (regla existente).
