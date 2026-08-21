# Plan de etapa — Publicaciones automáticas en celulares (publish_reel) — 2026-08-21

> **Propósito**: handoff para implementar la ejecución automática de `publish_reel` en la flota
> Android. Escrito por el orquestador al cerrar la etapa del deploy a producción del planner.
> **Leelo completo antes de operar.** Basado en la auditoría real del código (researcher, 2026-08-21).

---

## 1. Estado de partida (verificado 2026-08-21)

- **Planner EN PRODUCCIÓN**: backend (`api.southfarm.tech`, build `deploy/planner-prod` merge
  `c72c1e6`, migraciones aplicadas, flota 3/3 reconectada) + webapp (Vercel `main@d7dc54d`).
  Backup pre-deploy: `C:\SouthFarm\backups-pre-planner-deploy\`.
- **Publicaciones HOY**: el planner crea tasks `publish_reel` reales al subir video (multipart),
  con `params: { title, assetId, assetName, asset_id, cluster_id, cluster_name, account,
  duration_minutes }`. Pero el backend las EXCLUYE del claim (`EXECUTABLE_TASK_TYPES`,
  `backend/src/index.ts:82-88`) porque la app no las ejecuta → quedan en cola (visible en
  `/api/planner/publications`).
- **App Android real**: `C:\SouthFarm\source\southfarm_app` (NO existe `southfarm_app_v2`).
  Flutter, source `1.2.0+20` (`pubspec.yaml:19`); **la flota corre APK 1.1.8**
  (`dist-fixed/southfarm-1.1.8-release-arm64-vc22-FIXED.apk`). Toda la automatización vive en
  `android/app/src/main/kotlin/com/example/southfarm_app/SouthFarmAccessibilityService.kt` (4121 líneas).
- Protocolo device: claim cada 5s → heartbeat 15s → PATCH final. Lease 45s renovable.
  Whitelist de 6 task_types en líneas 512-515 (`setOf(...)`).
- **El endpoint de assets YA sirve para devices**: `GET /assets/cluster/:assetId`
  (`backend/src/activity-planner.ts:2195-2227`) usa `deps.auth` que acepta device_token por
  fallback (`backend/src/index.ts:2196-2240`, rol operator). NO hace falta endpoint nuevo.
- Flota: workspace 6, 3 devices activos (Xiaomi POCO C71 x3), adb-wifi keepalive como tarea
  programada ("SouthFarm ADB WiFi Keepalive"). Device id 30 es el más reciente.

## 2. Brecha (del informe de auditoría, con complejidad)

| # | Ítem | Dónde | Complejidad |
|---|---|---|---|
| a | Aceptar `publish_reel` en whitelist + skeleton `executeRemotePublishTask` con heartbeat | service 512-515, 532-683 (patrón) | BAJA-MEDIA |
| b | Descargar asset con device_token (`GET /assets/cluster/{params.assetId}`) | patrón `sendDeviceHeartbeat` (226-247), `authToken()` (210-215) | BAJA-MEDIA |
| c | Guardar video en galería vía `MediaStore` (`Movies/SouthFarm`, IS_PENDING=false) + permiso `WRITE_EXTERNAL_STORAGE` (solo ≤API 28) en manifest | AndroidManifest.xml:3-7 (hoy SIN permisos de storage) | MEDIA |
| d | **Flujo UI de publicación IG**: `ensureCorrectAccount` → "+" → Reel → galería → pick video → caption → Next → Share → verificar | NO existe nada de texto/galería hoy (cero ACTION_SET_TEXT/PASTE en el código) | **ALTA** (~350-500 líneas) |
| e | Backend: `publish_reel` en `EXECUTABLE_TASK_TYPES` + `planned_duration_sec` 60→~300 (`activity-planner.ts:2181`) | **SOLO cuando la flota tenga la app nueva** | BAJA (2 líneas) |
| f | Verificación post-publicación (poll del árbol por "Shared/Compartido", patrón `hasYouTubeWatchLaterConfirmation` 2424-2429) + resultado en PATCH | | MEDIA |

## 3. Roadmap recomendado (orden e hitos de aceptación)

1. **Fase 1 — Plumbing (sin device)**: ítems a+b+c. App nueva acepta el task, descarga el
   video, lo guarda en galería, heartbeatea, y completa con `result: {downloaded: true, path}`.
   Aceptación: crear publication en staging (:3102) → task claim-eada por emulador/device →
   archivo visible en galería. (Backend de staging ya entrega el claim si se agrega el tipo
   localmente en la DB de test o se prueba contra un backend de dev con el tipo habilitado.)
2. **Fase 2 — Flujo IG en device piloto**: releva el creator de IG con `dumpUiStatic`/
   `dumpActiveWindowXml` (976-1041) ANTES de escribir selectores (los ids rotan entre
   versiones de IG). Implementar d+f con la lista de ids/texts por paso + fallbacks +
   retries `repeat(n)`. Aceptación: publication agendada en staging → device la ejecuta
   sola → reel visible en la cuenta IG del piloto + task completed con evidence.
3. **Fase 3 — Backend + rollout**: ítem e (mismo release), build APK firmada (misma firma
   que la flota — ver `dist-fixed` y handoffs de rollback), instalar en 1 device, verificar,
   luego escalar a los 3. Aceptación: publication desde el webapp de producción → ejecutada
   por la flota sin intervención.

## 4. Riesgos y reglas

- **NO habilitar `publish_reel` en el backend antes de actualizar la app** (revive el loop de
  claims fantasma que FIX 1 eliminó — ver `index.ts:75-81`).
- Fragilidad UI de IG: mitigar con relevado real + múltiples selectores por paso + verificación
  post-acción. Presupuestar iteración.
- Detección de plataforma: mantener la humanización existente (delays 1.5-3s, bezier) en el
  flujo nuevo; no repetir captions idénticos.
- El endpoint de publish no valida duración del video (solo mime video/*): un MP4 muy largo
  falla en IG — opcional validar en backend.
- `planned_duration_sec: 60` es insuficiente para descarga (200MB) + flujo → subir a ~300.
- TikTok (upload ≠ galería) y YouTube (Studio + `ensureCorrectYouTubeChannel`) = fases futuras
  propias. IG primero.

## 5. Entorno y herramientas para esta etapa

- **Node**: SIEMPRE `PATH="/c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64:$PATH"`.
- Staging intacto: backend `:3102` (`southfarm-planner-staging.db`, login
  `staging@southfarm.local/southfarm`, ws 6) + webapp `:3006`. Demo `:3101`/`:3002`.
  Producción `:3001`/`api.southfarm.tech` — NO probar publications reales ahí hasta Fase 3.
- Tests backend: `bash backend/scripts/run-planner-tests.sh` (53 checks). Webapp E2E: `npm run e2e` (:3006).
- Repos: principal `C:\SouthFarm\source` (branch `feature/ui-redesign-granja-tecnologica` =
  planner; `deploy/planner-prod` = lo que corre en producción). Webapp git anidado (regla:
  commit separado por entrega). App: `southfarm_app/` dentro del repo principal.
- Reglas del dueño: commitear cada versión funcional ANTES de avanzar; subagentes ejecutan,
  el orquestador orquesta; QA con evidencia real.

## 6. Pendientes menores heredados (no bloquean esta etapa)

- Re-registrar tareas programadas perdidas: backup diario, maintenance, watchdog
  (hoy solo viven "SouthFarm API", Publisher Workers, ADB Keepalive).
- Worktree `semiorganic-publishing` sucio (WIP del dueño, código que corrió en prod hasta el
  21/08 — ordenarlo/commitearlo).
- Hotfix `hotfix/upload-retry` (6756853, webapp) nunca desplegado — decisión del dueño.
