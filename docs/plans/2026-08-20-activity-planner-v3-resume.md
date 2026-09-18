# Activity Planner v3 — Estado y guía de reanudación

- **Fecha:** 2026-08-20 ~01:20 BA
- **Motivo del corte:** límite de uso del plan (5h) agotado a las 07:56:40 UTC del 2026-08-20 (= 04:56 BA). Los 3 agentes (backend, designer, frontend) cayeron a mitad de la iteración v3.
- **Importante:** la v2 está COMMITEADA (webapp `64fd2da`, main `d43f285`). Todo lo hecho en v3 está en working tree SIN commitear.

## Servidores corriendo ahora

| Puerto | Qué | Estado |
|---|---|---|
| :3101 | Backend demo (DB copia `backend/data/southfarm-planner-demo.db`) | UP con build v3 PARCIAL del agente backend |
| :3004 | webapp-v2 (snapshot de la v2, para comparar) | UP |
| :3003 | webapp-v1 (reconstrucción ronda 1) | UP |
| :3002 | LIBRE — para la v3 cuando esté lista | — |
| :3001 | PRODUCCIÓN del usuario — NO TOCAR | UP |

Usuarios: `demo@southfarm.local` / `southfarm` (o el real del usuario).

## Estado del trabajo v3 (verificado a las ~01:20)

### Backend — AVANZADO (agent murió en verificación)
- ✅ `backend/src/activity-planner.ts` modificado + `dist` compilado + server reiniciado.
- ✅ `GET /api/clusters/1` ya devuelve `accountsWarmup` (warmup por cuenta, verificado con curl).
- ✅ `npm run build` pasó; multer instalado en `package.json` (2 refs).
- ⚠️ Artefactos basura del agente: `backend/__DEST__-shm`, `backend/__DEST__-wal` (borrarlos) y `backend/scripts/` nuevo (revisar si es de prueba).
- ❓ FALTA VERIFICAR: (1) que el motor genere warmups respetando `sessionsPerDay`/`maxGapHours` (PUT config → approved → GET week → contar sesiones y gaps), (2) publishing con `days`, (3) `POST /api/clusters/:id/publish` multipart con archivo (curl -F) + `GET /assets/cluster/:assetId`, (4) validar `backend/data/uploads` ignorado por git.
- Contrato v3 BINDING: sección "Extensiones v3 (2026-08-20)" al inicio de `docs/plans/2026-08-19-activity-planner-api.md`.

### Frontend — PARCIAL
- ✅ Modificados: `types.ts`, `api.ts`, `auth-client.ts` (variante FormData), `cluster-detail.tsx`, `day-view.tsx`, `planner-page.tsx`.
- ❌ NO tocados: `routine-editor.tsx` (cards ricas + dropzone de archivo = FALTA TODO) y `planner-extra.css`.
- ❓ Verificar con `npx tsc --noEmit` y `npm run build` en `webapp/` qué compila y qué quedó a medio hacer (el agente murió a los ~16 min).
- Breve completo de lo que falta estaba en el prompt del agente; lo esencial:

  1. **routine-editor.tsx** — cards ricas (port fiel del mockup `docs/mockups/activity-planner/routine-editor.html`):
     - Warmup diario: minMinutes + **sesiones por día (1–4)** + **separación máxima entre sesiones (1–10h, default 4)** → config `{minMinutes, sessionsPerDay, maxGapHours}`.
     - Publicaciones: postsPerWeek + **day-chips L..D** → config `{postsPerWeek, days:[1..7]}`.
     - Scan sin cambios. Toggle Aprobado/Editando/Pausado INTOCTO (aprobado por el dueño) + cartel "Cambios aplicados".
     - **Sección "Publicación de Cluster": dropzone de ARCHIVO** (drag&drop + click, accept video/*, nombre+peso, quitar) en vez de URL; título + fecha/hora opcional; `publishToCluster` con FormData (la variante de api.ts ya está hecha); mantener auto-scroll.
  2. **cluster-detail.tsx** — el agente lo tocó: verificar que tenga los mini-charts de warmup POR CUENTA (grilla, uno por cuenta, ECG + is-warn/is-bad por cuenta desde `history.accountsWarmup`, fallback al agregado).
  3. **day-view.tsx / planner-page.tsx** — verificar los 4 fixes: título duplicado eliminado, scroll arreglado, línea AHORA (posición por hora BA 12–22, chip, refresh 30s, auto-scroll al montar), DnD INDIVIDUAL por tarea con modal de confirmación.
  4. Si falta CSS para componentes nuevos → `planner-extra.css` (NO tocar `planner.css`, efectos premium aprobados).

### Designer mockups — NO ARRANCÓ (murió al inicio)
- Actualizar `docs/mockups/activity-planner/`: routine-editor.html (cards ricas + dropzone), cluster-detail.html (grilla mini-charts por cuenta), day-view.html (línea NOW + drag individual), index.html (bloque "v3"). Es la referencia visual que el dueño aprobó — si el frontend ya portó según spec, esto queda como documentación de referencia (prioridad media).

## Pasos para reanudar (cuando el límite se resetee)

1. **Verificar backend v3** (puntos ❓ de arriba). Si algo falta, completarlo en `activity-planner.ts` (contrato v3) + rebuild (`PATH` con Node 22: `/c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64`) + restart :3101 (kill por PID de `netstat -ano | grep :3101`).
2. **Completar frontend v3**: tsc/build para ver el estado, terminar routine-editor + lo que falte. Build final en `webapp/`.
3. **Levantar v3**: `cd /c/SouthFarm/source/webapp && PORT=3002 npm run start` (background).
4. **Verificar en navegador** (Browser Use, main agent): login demo → planner → rutinas (cards ricas, dropzone) → detalle (charts por cuenta) → día (título único, scroll, NOW, DnD individual) → aprobar rutina con sesiones y verificar replanificación.
5. **Commits v3** (regla de entregas en AGENTS.md — webapp y main por separado): mensajes tipo `feat(activity-planner): v3 — cards ricas, warmup por cuenta, publicación con archivo, fixes vista día`.
6. **Reportar al dueño**: :3002 = v3 nueva, :3004 = v2 para comparar. No bajar :3004 hasta que apruebe.
7. Cleanup cuando el dueño apruebe: `webapp-v1/`, `webapp-v2/`, `.round1-reconstruction/` son artefactos locales no commiteados (se pueden borrar salvo que quiera seguir comparando).

## Contexto del producto (para agentes frescos)

- Spec funcional: `docs/plans/2026-08-19-activity-planner.md`. Contrato: `docs/plans/2026-08-19-activity-planner-api.md` (v3 al inicio). Guía de prueba: `docs/plans/2026-08-19-activity-planner-testing.md`.
- Reglas del repo: `AGENTS.md` (Next 16 NO es el que conocés + regla de commits por entrega). Webapp = repo git anidado (commits separados).
- El dueño ya aprobó: estética Granja Sur, efectos premium v2, toggle de rutinas, DnD con confirmación. Pidió v3: recuperar las riquezas de los MOCKUPS (cards con sesiones/gap/días, carga de archivo en vez de URL), warmup por cuenta, y fixes de la vista día.
