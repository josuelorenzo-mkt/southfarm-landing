# HANDOFF — SouthFarm: warmup, posting y scan

> **Documento de entrada para un agente nuevo.** Objetivo asignado: arreglar detalles de las
> funcionalidades de **warmup**, **posting** y **scan** de la herramienta.
> Este documento explica qué es SouthFarm, dónde vive cada pieza (con rutas absolutas), cómo
> funciona cada una de las tres funcionalidades de punta a punta, el estado y versiones
> actuales, los fixes recientes y los gotchas operativos aprendidos a nivel producción.
> Complementar con: `docs/ESTRATEGIA_VISTA_EN_VIVO_FLOTA.md` (infra de streaming),
> `docs/PLAN_SISTEMA_RESERVAS_SLOTS.md` (gotchas operativos §6 + scheduler futuro).
> Escrito: 2026-08-27.

---

## 1. Qué es SouthFarm

SouthFarm es una herramienta de **operación de granjas de teléfonos Android** para agencias:
los teléfonos ejecutan cuentas de Instagram/TikTok/YouTube (warmups para "calentarlas",
escaneos para detectar cuentas activas en cada teléfono, y publicaciones programadas). El
dueño opera todo desde una web (command center) que habla con un backend API, que a su vez se
comunica con una app instalada en cada teléfono. La web está en
`https://southfarm-webapp.vercel.app`, la API en `https://api.southfarm.tech` (túnel
Cloudflare hacia la PC de la oficina, donde corre todo el backend en SQLite).

Workspace activo real: **workspace 6**. Flota: **4 teléfonos Xiaomi "POCO C71" (Android 15)**
con alias **02, 07, 08, 09**, conectados por **USB** a la PC, todos con la app **v1.1.8**.

---

## 2. Arquitectura general y dónde vive cada cosa

```
Web (Next.js en Vercel)  ──►  API backend (Node/Express en la PC, puerto 3001)
                                      │
                    SQLite: C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        ▼                             ▼                              ▼
Publisher Worker (Python en PC)  App mobile (Flutter+Kotlin)    Screen-bridge (streaming)
  automatiza publicaciones        en cada teléfono               C:\ProgramData\...\screen-bridge
  via ADB a los teléfonos         (accesibilidad = el "worker")
```

### Repos y rutas absolutas (CRÍTICO — hay tres checkouts)

| Qué | Dónde | Branch |
|---|---|---|
| **Worktree activo (backend + webapp + docs)** | `C:\SouthFarm\source\.worktrees\visualize-phone` | `feature/device-fleet-live-view` (pusheada, al día) |
| Checkout principal (ops + fuentes de app) | `C:\SouthFarm\source` | `feature/ui-redesign-granja-tecnologica` |
| Repo remoto único | `github.com/josuelorenzo-mkt/southfarm-landing` | Todas las branches viven acá |
| **Webapp** (repo anidado con git PROPIO) | `<worktree>/webapp` | `feature/device-fleet-live-view` |
| Fuentes app mobile | `C:\SouthFarm\source\southfarm_app` (v1.2.0+20) y `C:\SouthFarm\source\southfarm_app_v2` (**v1.2.0+120, la más nueva**) | |
| APK instalado en la flota | `C:\SouthFarm\source\southfarm_app\dist-fixed\southfarm-1.1.8-release-arm64-vc22-FIXED.apk` (versionCode **22**) | |
| Runtime productivo del backend | `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend` | Copia desacoplada; producción NO sale de git |
| DB SQLite | `C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db` | `PRAGMA foreign_keys = ON` |
| Media de publicaciones | `C:\ProgramData\SouthFarm\publish-media\` | ACL protegida |
| Config runtime (tokens/secrets) | `C:\ProgramData\SouthFarm\config\*.json` | ACL protegida, ilegible sin admin |
| Logs | `C:\ProgramData\SouthFarm\logs\` | `southfarm-api.*`, `publisher-*\`, `screen-bridge.*` |

**Módulos backend** (`<worktree>/backend/src/`): `index.ts` (toda la API REST, ~4500 líneas),
`activity-planner.ts` (rutinas automáticas, ~2400 líneas), `publications-domain.ts` (máquina
de estados de publicación), `publications-routes.ts` + `publication-worker-routes.ts` (API de
posting), `planner-publication-bridge.ts` (une planner↔cola de publicación),
`scheduler.ts`, `auth.ts`/`auth-migrations.ts`, `db.ts`.

**App mobile**: monolito Flutter `lib/main.dart` (~3500-3700 líneas según copia) + servicio
nativo `android/app/src/main/kotlin/com/example/southfarm_app/SouthFarmAccessibilityService.kt`
(EL motor de automatización: naviga Instagram/TikTok/YouTube por accesibilidad, ejecuta
warmups, scans y reporta). El Flutter maneja UI, sesión, persistencia local y sync.

**Web** (`<worktree>/webapp/src/app/`): `page.tsx` (command center + Device Fleet con vista
en vivo), `scheduler-panel.tsx`, `publication-panel.tsx` (+ `publication-upload/validation/review/types`),
`activity-planner/` (planner-page, planner-week, day-view, cluster-detail, routine-editor,
api.ts, types.ts).

---

## 3. Funcionalidad: WARMUP (calentamiento de cuentas)

### Flujo de punta a punta

1. El planner automático (o una tarea manual desde la web) crea `task_runs` con
   `task_type` ∈ {`warmup_ig`, `warmup_tiktok`, `warmup_youtube`} y
   `planned_duration_sec` (40-80 min típicos).
2. La app del teléfono reclama la tarea (`POST /api/tasks/claim`, device token), el servicio
   Kotlin ejecuta `startWarmup(...)`: abre la app social, navega feeds/reels/shorts, likea,
   guarda, con **overlay** que muestra el progreso y bloquea el uso del teléfono.
3. La app reporta métricas (`warmupMetrics` en el servicio Kotlin → Flutter) y al terminar
   hace `POST /api/warmup-sessions` (registro canónico por cuenta/dispositivo) y actualiza el
   `task_run` a completed/error con heartbeats durante la ejecución.

### Dónde tocar

| Pieza | Ubicación |
|---|---|
| Ejecución on-device (navegación, pausas, métricas) | `SouthFarmAccessibilityService.kt` → buscar `startWarmup`, `pauseWarmup`, `warmupMetrics` |
| UI/config de warmup en la app, historial local y sync | `southfarm_app_v2/lib/main.dart` → buscar `WarmupApi`, `_loadAccounts`, overlay de tareas |
| Creación/claim de tareas remotas | `backend/src/index.ts` → `POST /api/tasks/run` (~línea 2950), `POST /api/tasks/claim` (~3393), heartbeat (~3639), update de estado (~3859) |
| Sesiones canónicas | `POST/GET /api/warmup-sessions` (index.ts ~4160); tablas `warmup_sessions`, `warmup_policies` |
| Rutinas automáticas de warmup | `activity-planner.ts` → `generateWarmupDay`, `warmupSlotsForDay`, config JSON `{minMinutes, sessionsPerDay, maxGapHours}` en `cluster_routines.config` |
| Web: ver/lanzar warmups, planner | `webapp/src/app/scheduler-panel.tsx`, `activity-planner/*` (day-view, planner-week, routine-editor) |

### Tablas: `task_runs` (ver §6), `warmup_sessions` (canónica), `cluster_routines`.

---

## 4. Funcionalidad: SCAN (detección de cuentas en cada teléfono)

### Flujo

1. Tarea `scan_instagram` / `scan_tiktok` / `scan_youtube` (manual desde la web o rutina
   `scan_auto`).
2. El teléfono reclama → Kotlin `executeRemoteScanTask` (~línea 690 del .kt): abre la app
   social, va al perfil, abre el **selector de cuentas** ("switcher") y enumera las cuentas
   logueadas por accesibilidad.
3. Al terminar hace `POST /api/social-accounts` con el array de cuentas — **OJO: el endpoint
   REEMPLAZA el set completo** de ese teléfono+plataforma (borra y reinserta). Fue causa de un
   crash en producción: ver §7 gotcha #3.
4. El backend crea `scan_sessions` y guarda en `social_accounts` (visible en web + app).

También existe scan **local desde la app** (botón en el teléfono): `_loadAccounts` en
main.dart → `detectAccounts` (mismo motor Kotlin vía MethodChannel) → `syncAccountsToBackend`
(same endpoint, con JWT de usuario).

### Dónde tocar

| Pieza | Ubicación |
|---|---|
| Detección on-device (switcher, nodos de accesibilidad) | `SouthFarmAccessibilityService.kt` → `executeRemoteScanTask`, `detectInstagramAccounts`, `detectTikTokAccounts`, `detectYouTubeChannels` |
| Guardado en backend (borrado+insert, FK) | `backend/src/index.ts` → `POST /api/social-accounts` (~3976). Lleva detach de `task_runs.social_account_id` + try/catch agregados el 26/08 |
| Sesiones de scan | `scan_sessions` (tabla) + `POST/GET /api/scan-sessions` (~4126) |
| Web: lanzar scan por teléfono, ver cuentas | `webapp/src/app/page.tsx` (Device Fleet) |
| Estado: el teléfono **07 detecta 0 cuentas** porque el switcher de Instagram no aparece como nodo accesible en ese dispositivo ("switcher could not be opened" en logcat) — bug abierto a investigar |

---

## 5. Funcionalidad: POSTING (publicaciones programadas)

### Arquitectura (¡diferente a warmup/scan!)

El posting tiene **dos actores**: una **cola única** en el backend (`publication_jobs` con
máquina de estados) y un **worker Python en la PC** que automatiza la publicación en los
teléfonos vía ADB (no usa la app — usa UI automation directa sobre las apps sociales).

```
Web (sube media, crea jobs) ──► API (publications-routes.ts)
                                     │ publications-domain.ts (estados: pending→claiming→
                                     │   downloading→publishing→published/failed/skipped…)
ActivityPlanner ──(rutina publishing:─┘  claimDueJob vía planner-publication-bridge)
                                     ▼
             Publisher Worker Python (PC) — tarea programada "SouthFarm Publisher Worker 26/27/30"
               adb_device.py (controla el teléfono por ADB)
               platforms/instagram.py | tiktok.py | youtube.py  (UI automation del post)
               api_client.py (reporta al backend con publisher_worker_token)
```

### Dónde tocar

| Pieza | Ubicación |
|---|---|
| Máquina de estados y lógica de dominio | `backend/src/publications-domain.ts`, `publications-migrations.ts` |
| API de publicación (crear jobs, media, etc.) | `backend/src/publications-routes.ts` |
| Endpoints del worker (claim, reportes) | `backend/src/publication-worker-routes.ts`; token `publisher_worker_token` en runtime config |
| Puente planner→cola | `backend/src/planner-publication-bridge.ts`; rutina `publishing` (`postsPerWeek`, `days`) |
| Worker PC (automatización real) | `<worktree>/publisher_worker/southfarm_publisher/`: `runner.py`, `adb_device.py`, `api_client.py`, `models.py`, `platforms/{instagram,tiktok,youtube}.py` + `common.py` |
| Inspección de media (ffprobe) | `backend/src/publication-media-inspector.ts`; media en `C:\ProgramData\SouthFarm\publish-media\` |
| Web: subir/validar/revisar publicaciones | `webapp/src/app/publication-panel.tsx` + `publication-upload.ts`, `publication-validation.ts`, `publication-review.ts` |
| Instalador/supervisor del worker | `ops/windows/install-southfarm-publisher-worker.ps1`, `southfarm-publisher-supervisor.ps1`; logs `logs/publisher-{26,27,30}/` |

**Fixes recientes de posting** (del agente anterior, ya pusheados en el repo principal):
`8bc3c45` (descarta drafts previos, desvío a Edits tras Next), `bf5cba8` (baseline del perfil
espera render de grilla), `b836c83`/`d8f6cce`/`394937f` (**switch de cuenta automático** en
YouTube/TikTok/Instagram publishers), `e77fdbe`/`1734343`/`6d1784f` (claimDueJob y availability
respetan filtro de cola del workspace).

---

## 6. `task_runs` — la tabla que las tres funcionalidades comparten

```
task_runs(id, user_id, device_id, workspace_id, task_type, platform,
  source 'manual'|'automatic', params JSON, status, result, scheduled_for,
  overdue_at, expires_at, planned_duration_sec, actual_duration_sec,
  social_account_id FK→social_accounts, account_key, plan_item_id,
  cluster_id, routine_id, manual_override, priority (manual=1000),
  attempt_count, created_at, started_at, completed_at, claimed_at,
  lease_expires_at, last_heartbeat_at, cancel_reason, ...)
```

- `task_type` ejecutables por la app: `warmup_ig|warmup_tiktok|warmup_youtube|
  scan_instagram|scan_tiktok|scan_youtube` (`publish_reel` existe pero aún no lo ejecuta la
  app; el posting real va por el worker Python).
- Ciclo: `pending → claimed → running → completed | error | cancelled | expired`.
- **Crear tareas**: `POST /api/tasks/run` con `{task_type, device_id, source:'manual',
  params:{platform:'instagram'}}` — **params SIEMPRE objeto**: si llega null, el Kotlin
  crashea con JSONException (gotcha §7.6).
- Bitácora: `task_events` (created/claimed/completed/error/auto_cancelled_routine/...).

---

## 7. Gotchas operativos de producción (aprendidos a nivel real, 25-27/08)

1. **Producción no sale de git**: backend = compilar → copiar `backend/dist/` a
   `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend\dist\` → `schtasks /end` +
   `/run "SouthFarm API"` → verificar `http://127.0.0.1:3001/api/health` con formato RICO
   (incluye `uptime_seconds`; si responde `{status,timestamp}` corto hay un proceso zombi
   viejo en el puerto — matarlo con admin `taskkill /F /PID <pid>`).
2. **Primera compilación del backend** en un checkout nuevo: `npm install --ignore-scripts`
   (el build nativo de better-sqlite3 falla sin VS Build Tools; el runtime ya trae binario).
3. **FK estrictas**: `PRAGMA foreign_keys=ON`. Borrar filas referenciadas tira
   `SQLITE_CONSTRAINT` — desvincular primero (patrón ya aplicado en /social-accounts).
   Handlers async sin catch mataban el proceso entero: existe guard global
   (`unhandledRejection`/`uncaughtException`) desde `2f3a4e4`, pero no abusar.
4. **Auth de la flota**: teléfonos usan device token opaco (`sfd_...`,
   `devices.device_token_hash`). `/api/devices/register` NUNCA rota el token (fix `e71f051`);
   rotación solo en `/devices/claim` (emparejamiento nuevo). Si una app muestra pantalla de
   login sin motivo, revisar familias revocadas en `refresh_sessions` (fix anti-carrera
   `2f3a4e4`: gracia 60s + access JWT 12h vía supervisor).
5. **ADB-USB "desconectado" con cable puesto**: el teléfono quedó en modo tcpip residual →
   diagnosticar por WiFi (`adb connect IP:5555`, `getprop ro.serialno`) y restaurar con
   `adb -s <ip>:5555 usb`; sin WiFi alcanzable, desenchufar/reconectar. El keepalive
   (`%LOCALAPPDATA%\SouthFarm\ops\adb-wifi-keepalive.ps1`) solo hace `connect`.
6. **Mapeo serial→alias del bridge**: `C:\ProgramData\SouthFarm\screen-bridge\devices.json`
   (espejado en el repo, commit `d3cca6f`); incluye respaldos `-wifi`.
7. **`params` de tareas siempre objeto JSON** (no null) — el Kotlin hace
   `JSONObject(task.optString("params","{}"))` pero null crashea.
8. **El planner corre en cada arranque de la API** ("Startup plan") — cualquier cambio debe
   ser idempotente; dedupe global por dispositivo+tipo+horario en `hasActiveTaskForSlot` +
   reservas (ver PLAN_SISTEMA_RESERVAS_SLOTS.md).
9. **WSL**: hay un Ubuntu con PM2 (`pm2-josue.service`) que históricamente sirvió una copia
   vieja del backend en el puerto 3001. La entrada fue eliminada; si el puerto "responde
   código viejo": `wsl -d Ubuntu -- ss -tlnp | grep 3001`.
10. **PowerShell 5.1**: en supervisores, stderr del hijo + `$ErrorActionPreference='Stop'` +
    `*>>` = muerte del supervisor (ya mitigado; no revertir).
11. **Crear usuario de pruebas** (no existe QA user, fue borrado): `POST /api/auth/register`
    → luego `sqlite3`: borrar su membresía del workspace automático propio e insertar
    membership activa al workspace 6 (el backend usa la PRIMERA membresía del usuario:
    `workspaceMembership` ORDER BY id ASC).

---

## 8. Procedimientos de deploy

| Pieza | Procedimiento |
|---|---|
| **Backend** | `cd backend && npm install --ignore-scripts` (solo primera vez) → `npx tsc` → copiar `dist/` al runtime → `schtasks /end` + `/run "SouthFarm API"` → health rico + uptime creciente |
| **Webapp** | Dev servers ya corriendo: `localhost:3010` y `:3020` (`next dev`). Producción: merge de `feature/device-fleet-live-view` → `main` en el repo anidado → Vercel deploya solo (envs `NEXT_PUBLIC_API_URL=https://api.southfarm.tech`, `NEXT_PUBLIC_SCREEN_BRIDGE_URL/TOKEN` horneadas). OJO: `next.config.ts` y `tsconfig.json` tienen cambios locales sin commitear que no son de esta intervención — revisar antes de mergear |
| **App mobile** | Fuentes en `C:\SouthFarm\source\southfarm_app_v2` (la más nueva, 1.2.0+120). `flutter build apk` → instalar por `adb install -r`. Al reinstalar: re-login + re-emparejar (código desde web Device Fleet) + reactivar accesibilidad en Ajustes. Downgrade de versión requiere desinstalar (Android bloquea versionCode menor) |
| **Publisher worker** | `ops/windows/install-southfarm-publisher-worker.ps1`; credenciales en `C:\ProgramData\SouthFarm\config\backend-runtime.json` (ACL admin) |

---

## 9. Estado y versiones al 27/08/2026

- **Backend**: branch `feature/device-fleet-live-view` (= origin, commits hasta `d3cca6f`),
  runtime productivo corriendo idéntico. Últimos fixes: token de dispositivo estable
  (`e71f051`), crash-loop FK + fatal-guard (`51869c4`), supervisor inmune a stderr
  (`5050118`/`879afcf`), dedupe global de slots del planner (`97af908`), anti-logout
  refresh-grace + JWT 12h (`2f3a4e4`/`78d88d9`), mapeo bridge flota real (`d3cca6f`).
- **App instalada en flota**: 1.1.8 (versionCode 22). **Fuentes**: `southfarm_app_v2` 1.2.0+120
  (más nueva) y `southfarm_app` 1.2.0+20. ⚠️ Discrepancia: la flota corre un APK más viejo que
  ambas fuentes — cualquier fix de app exige elegir fuente canónica y plan de rollout
  (desinstalar/instalar → re-login + re-emparejar + reactivar accesibilidad).
- **Webapp**: feature `device-fleet-live-view` con vista en vivo estable; pendiente decidir
  merge a `main` (Vercel). Cambios locales sin commitear en `next.config.ts`/`tsconfig.json`
  (no de esta intervención).
- **Flota**: 4 teléfonos USB, latiendo, warmups operativos; scheduler del workspace en
  `manual_only` y rutinas **pausadas** por decisión del dueño; cola de tareas limpia.
- **Bugs abiertos conocidos**: (a) switcher de Instagram no accesible en teléfono 07 → scans
  IG completan con 0 cuentas ahí; (b) pendiente implementar sistema de reservas de slots
  (plan completo en PLAN_SISTEMA_RESERVAS_SLOTS.md, Fases 1-4 sin comenzar); (c) planner aún
  no tiene dedupe de *ventanas* (solo instante exacto).

---

## 10. Tips de trabajo diario

- **Logcat del teléfono**: `adb -s <serial> logcat -d | grep SouthFarmA11y` (el servicio
  loguea TODO su razonamiento con tag `E SouthFarmA11y`). Capturas: `adb exec-out screencap -p`.
- **Serial ↔ alias**: `C:\ProgramData\SouthFarm\screen-bridge\devices.json`
  (02=...d44eca24c, 07=...7ef3e36c, 08=...ca492874c, 09=...d997f1d4c).
- **Probar una tarea remota**: `POST /api/tasks/run` (ver §6) y mirar `task_events`.
- **DB**: `sqlite3 C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db` (tablas clave:
  task_runs, task_events, devices, social_accounts, scan_sessions, warmup_sessions,
  publication_jobs, cluster_routines, account_clusters, workspace_controls).
- **Regla del dueño (AGENTS.md)**: cada versión funcional → commit inmediato en los repos
  correspondientes antes de seguir iterando; webapp es repo anidado separado. Nunca entregar
  cambios que solo existan en el working tree.
