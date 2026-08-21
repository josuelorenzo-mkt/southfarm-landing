# Plan de continuidad — Etapa de estabilización Activity Planner (2026-08-20)

> **Propósito**: este documento permite continuar la etapa de estabilización en un chat nuevo
> (con agentes de otros providers) sin perder contexto. Lo escribió el orquestador (ZCode) al
> quedarse sin créditos del provider de subagentes. **Leelo completo antes de operar.**

---

## 1. Contexto general del proyecto

**Southfarm** = plataforma de agencia social media con flota de Androids que ejecutan
warmups/scans/publicaciones (Instagram/TikTok/YouTube).

- **Repos**: `C:\SouthFarm\source` (repo principal: backend + docs + app Android) y
  `C:\SouthFarm\source\webapp` (repo git ANIDADO — commits separados, regla del dueño).
- **Webapp**: Next.js 16.2.6 + React 19 (`webapp/`). **Backend**: Express 4 + better-sqlite3
  (`backend/`, código en `src/`, build `tsc` → `dist/`).
- **Android**: `C:\SouthFarm\southfarm_app_v2` (Flutter + servicio de accesibilidad Kotlin).

### Reglas del dueño (binding, de AGENTS.md y conversación)
1. **Cada versión funcional entregada se commitea ANTES de avanzar** (webapp tiene git propio).
2. El orquestador NO codea (excepto fixes quirúrgicos); los subagentes "goat" codean.
3. QA visual con capturas reales multi-fase; review del designer senior SOLO guía (no codea).
4. Entregar solo con calidad 9-10, con honestidad sobre lo que entregan los subagentes.

### Node runtime (crítico)
El node del PATH default es ABI-incompatible con better-sqlite3. SIEMPRE:
```bash
PATH="/c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64:$PATH" <comando>
```

---

## 2. Estado al momento de este documento

### Etapas previas COMPLETAS (commits en repo webapp)
Rediseño Activity Planner: v3 `f50b4e0` → v4 `56a136a` → v5 `19f66fb` (glow cometa perimetral
SVG, shimmer de barras clipeado, tooltip máx 2) → commit `d7dc54d` (crear cluster con picker
de cuentas + suite E2E + bloqueo de devices revocados — incluye todo el trabajo de la etapa
de estabilización del lado webapp). **El dueño aprobó el rediseño con un 9.**

**Corrección histórica importante**: durante la sesión del 20/08 el orquestador reportó commits
(v6 `8f4a19b`, v6.1 `f0c9824`, v7 `2e0b715`, v8 `b6d9c12`) que NUNCA EXISTIERON — fueron parte
de bloques defectuosos de esa sesión (contexto corrupto). El trabajo sí era real y quedó en el
working tree; se commiteó de verdad recién como `d7dc54d`. Las funciones descritas en "v7/v8"
(breadcrumb del detalle, chip AHORA de la vista día) ya existían desde v3. El estado real y
verificado del webapp es: v5 + `d7dc54d`, con suite E2E 10/10 PASS contra staging.

### Etapa ACTUAL: estabilización (para testeo del dueño y luego producción)

**Objetivo del dueño**: "todas las funciones anden correctamente de manera estabilizada,
conectada con todo nuestro sistema y servicios. Que yo pueda testearla. Si está ok nivel 10,
subimos a producción en la próxima etapa."

### Trabajo ya hecho en esta etapa (VERIFICADO con runs reales)

1. **Staging con datos reales levantado**: clon de la DB de producción vía `VACUUM INTO` →
   `backend/data/southfarm-planner-staging.db`. Backend de staging en **puerto 3102** con
   `SOUTHFARM_PLANNER_SEED=1` y usuario de test `staging@southfarm.local` / `southfarm`
   (owner del workspace 6 = flota real: 3 devices activos, 22 cuentas).
2. **Auditoría Android completa** (agente researcher, finalizada):
   - La app Android soporta 6 task_types: `warmup_ig/tiktok/youtube`, `scan_instagram/tiktok/youtube`.
   - **`publish_reel` NO está soportado por la app** (lo descarta silenciosamente al claim).
   - Protocolo device: `POST /api/devices/heartbeat` + `POST /api/tasks/claim` cada 5s →
     `POST /api/tasks/runs/:id/heartbeat` cada 15s → `PATCH /api/tasks/runs/:id` para
     completar/error. Auth: device_token (JWT opaco, sha256 en DB).
   - La app NO lee `scheduled_for` (el backend la retiene hasta su hora — correcto).
3. **Suite de integración backend (53 checks, 0 failed)** creada por agente backend:
   `bash scripts/run-planner-tests.sh` (build + copia DB + main + seed-gate A/B).
   **Verificada de forma independiente por el orquestador: `RESULTS: main=0 nogate=0 gate=0`.**
4. **8 fixes backend aplicados** (en working tree, SIN commit todavía):
   - FIX 1 [CRÍTICO] `EXECUTABLE_TASK_TYPES` en `src/index.ts:65-88`: claim/re-claim solo
     entrega los 6 tipos que la app ejecuta. `publish_reel` jamás entra al loop de lease.
   - FIX 2 [CRÍTICO] `generatePublishingWeek` ya NO materializa placeholders (las
     publicaciones son PLAN derivado de la rutina + tasks reales solo con video subido).
     Series `posts[]` = ejecutadas reales + plan (verificado: próxima semana `[0,2,0,2,0,0,0]`).
   - FIX 3 `existingNonCancelledForDay` excluye `expired`/`error` → los días se regeneran.
   - FIX 4 publish endpoint rechaza 400 sin archivo ni video_url.
   - FIX 5 seed gateado por `SOUTHFARM_PLANNER_SEED=1` (default OFF — producción no auto-crea nada).
   - FIX 6 overdue de rutinas aprobadas se cancelan (`routine_overdue_replanned`) y regeneran.
   - FIX 7 [CRÍTICO] planner solo asigna tareas a devices `lifecycle_status='active'`;
     `cancelRevokedDeviceTasks` auto-sanea huérfanas en cada generate (235 canceladas por
     `device_revoked` en staging). `accounts[].deviceActive` expuesto en week response.
   - FIX 8 `GET /api/publications` (nuevo endpoint, lo consumía el PublicationPanel).
5. **Suite E2E webapp** (`webapp/e2e/run-e2e.mjs`, correr con `npm run e2e` contra :3006):
   primera corrida 10/10 PASS. Re-corrida tras los fixes backend: **8/10** con 2 fallos que
   son FALSOS NEGATIVOS del test (comportamiento nuevo correcto):
   - Test 3 (crear cluster): elegía cuentas de devices revocados → 0 tareas (correcto).
   - Test 7 (vista día): las overdue fueron re-planificadas por FIX 6 → 0 diferenciadas.
6. **Fix UX del modal crear-cluster (orquestador, quirúrgico, SIN build todavía)**:
   cuentas en devices revocados ahora bloqueadas con chip "celular revocado" +
   empty state "No quedan cuentas con celular activo". Archivos tocados:
   - `webapp/src/app/activity-planner/cluster-create-modal.tsx` (deviceOf/isRevoked/isBlocked/selectableCount)
   - `webapp/src/app/activity-planner/types.ts` (WorkspaceDevice + lifecycle_status)
   NOTA: también `types.ts` tiene `ClusterAccount.deviceActive?: boolean` (additivo, del agente backend).

---

## 3. Trabajo RESTANTE (en orden)

### Paso 1 — Ajustar la aserción del test 7 del E2E
`webapp/e2e/run-e2e.mjs`, test "VISTA DÍA": la aserción de overdue debe ser CONDICIONAL
(si hay ≥1 overdue, verificar diferenciación; si hay 0, PASS — las overdue se re-planifican
por diseño ahora). El test 3 NO necesita cambio: con el fix del modal, las filas de devices
revocados quedan `disabled` + clase `is-occupied` → el selector `.ap-pick-row:not(.is-occupied)`
ya elige solo cuentas agrupables → el cluster creado SÍ tendrá tareas.

### Paso 2 — Rebuild webapp + restart :3006
```bash
cd C:/SouthFarm/source/webapp
PATH="/c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64:$PATH" \
  NEXT_PUBLIC_API_URL=http://localhost:3102 npm run build
# matar el server viejo de :3006 y relanzar:
PATH="..." PORT=3006 npm run start   # background
```

### Paso 3 — Re-run E2E completo → esperar 10/10
```bash
cd C:/SouthFarm/source/webapp && PATH="..." npm run e2e
```
Si falla algo nuevo: investigar con capturas en `C:\SouthFarm\source\.tmp-qa\e2e-*.png`.

### Paso 4 — Commits (REGLA del dueño: antes de entregar)
- **Repo webapp** (`cd webapp`): `cluster-create-modal.tsx`, `types.ts`, `e2e/` (suite),
  `package.json` (script e2e). Mensaje sugerido:
  `feat(planner): estabilización — modal bloquea cuentas de devices revocados + suite E2E`
- **Repo principal** (`cd C:\SouthFarm\source`): `backend/src/activity-planner.ts`,
  `backend/src/index.ts`, `backend/scripts/` (test-planner*.mjs, run-planner-tests.sh,
  copy-db.mjs), `backend/dist/`. Mensaje sugerido:
  `feat(planner): estabilización backend — 8 fixes (claim filter, plan publicaciones, devices revoked, /api/publications) + suite 53 checks`
- CUIDADO: el working tree del repo principal tiene MUCHOS archivos sucios de compilación
  de Android (`southfarm_app/android/.gradle/*`, `dist/` viejos). Commitear SOLO los
  archivos listados arriba (git add explícito, nunca `git add -A`).

### Paso 5 — Entorno final de testeo para el dueño
El dueño debe testear contra STAGING (datos reales clonados, producción intacta):
- Webapp staging: `:3006` (build apuntando a :3102).
- Backend staging: `:3102` (`SOUTHFARM_PLANNER_SEED=1`, DB southfarm-planner-staging.db).
- Login: `staging@southfarm.local` / `southfarm`.
- Si se quiere regenerar el clon: `node backend/scripts/copy-db.mjs` (backup online).
- **Demo anterior**: `:3002` (webapp v8 con datos demo) + `:3101` (demo DB) siguen vivos.
- **PRODUCCIÓN**: `:3001` — NO TOCAR (aún corre build viejo sin planner; deploy = próxima etapa).

### Paso 6 — Reporte al dueño con matriz de testeo manual
Incluir: qué probar en cada vista, limitación conocida (publicaciones = plan + subida de
video, SIN ejecución automática en celulares hasta que la app Android soporte publish_reel —
desarrollo futuro), devices revocados identificados (n8/n7: 11 cuentas inactivas).

---

## 4. Decisiones de diseño ya tomadas (no re-litigar)

1. Publicaciones del planner = PLAN visual + tasks reales SOLO al subir video (multipart).
   Los celulares no ejecutan publish_reel (la app no lo soporta). Ejecución automática de
   publicaciones = desarrollo futuro de la app Android.
2. Seed de demo gateado por env (default OFF en producción).
3. Overdue se re-planifica al generate; pending/running/paused intocables (idempotencia).
4. Cuentas en devices revocados: visibles en clusters pero no planificables; el modal de
   creación las bloquea con chip.
5. El week response mantiene el shape del contrato (`docs/plans/2026-08-19-activity-planner-api.md`)
   + campos aditivos (`accounts[].deviceActive`, `tasks[].params`).

## 5. Riesgos conocidos / pendientes post-estabilización

- Self-heal de huérfanas corre por generate (no hay tick automático) — opcional sumarlo al
  scheduler para producción.
- `SUPPORTED_TASK_TYPES` (API manual) sigue incluyendo publish_reel — es intencional.
- Placeholders históricos quedan en task_runs (filtrados en vistas) — limpieza física opcional.
- Producción requiere: deploy del nuevo backend + migraciones de cluster + verificación
  con UN device real antes de abrir a toda la flota.

## 6. Procesos de QA establecidos en este proyecto

- **Backend**: `bash backend/scripts/run-planner-tests.sh` → `RESULTS: main=0 nogate=0 gate=0`.
- **Frontend**: webapp en :3006 + backend :3102 → `cd webapp && npm run e2e` → 10/10.
- **Visual**: puppeteer-core contra Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`,
  headless "shell", userDataDir `C:/SouthFarm/source/.tmp-qa/pptr/profile-e2e`) + análisis
  de capturas. Scripts ejemplo en `.tmp-qa/pptr/qa-*.js`.
- **Credenciales**: staging `staging@southfarm.local/southfarm` (ws 6, owner).
  Demo `demo@southfarm.local/southfarm` (ws demo, :3101/:3002).

## 7. Mapa de puertos (al momento de escribir esto)

| Puerto | Qué es | Estado |
|---|---|---|
| 3001 | Backend PRODUCCIÓN (build viejo, sin planner) | NO TOCAR |
| 3002 | Webapp demo v8 (apunta :3101) | vivo |
| 3005 | Snapshot v3 (comparación) | puede estar caído — irrelevante |
| 3006 | Webapp STAGING (apunta :3102) | vivo (rebuild pendiente paso 2) |
| 3101 | Backend demo (southfarm-planner-demo.db) | vivo |
| 3102 | Backend STAGING (clon real + fixes) | vivo |
| 3103 | Puerto de test de la suite backend | efímero (lo maneja run-planner-tests.sh) |
