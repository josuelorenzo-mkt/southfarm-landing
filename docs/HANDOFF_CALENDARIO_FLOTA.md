# HANDOFF — Activity Planner: reservas, cascada y UI de día (septiembre 2026)

> **Documento de continuación** para el agente/desarrollador que tome esta sección.
> Complementa a `docs/PLAN_SISTEMA_RESERVAS_SLOTS.md` (el plan original) y a
> `C:\SouthFarm\SESIONES_Y_PUERTOS.md` (coordinación de sesiones/puertos).
> Última actualización: 2026-09-06.

---

## 1. Qué es esta etapa

Sobre el plan de "reservas de slots" (ventanas `[inicio + duración + 5' margen]` por
teléfono) se construyó, probó y pulió toda la experiencia del **Activity Planner**:

- **Fase 1** — reservas con corrimiento automático en la creación.
- **Fase 2** — movimiento individual validado (hueco sugerido al chocar).
- **Fase 2.5** — movimiento en cascada ("meterla acá y recorrer las demás") todo-o-nada.
- **Vista día dual** — "Día completo" (todos los clústeres) y "Día clúster" (scopped).
- **UI unificada de día** — ambas vistas usan carriles por hora con mini-cards compactas
  (logos de red, teléfono, cuenta, horario inicio→fin), pill AHORA en el gutter,
  glow por ventana de ejecución, panel de **acciones rápidas** en el día de clúster.

**Estado: todo implementado, testeado (47/47 backend + 38/38 webapp) y pusheado en
branches. PRODUCCIÓN NO FUE TOCADA.** Falta el deploy (ver §6).

## 2. Dónde vive cada cosa

| Pieza | Dónde |
|---|---|
| Trabajo de esta etapa (backend) | worktree `planer-rework`, branch **`feature/slot-reservations`** |
| Trabajo de esta etapa (webapp) | submódulo `webapp/` (repo `southfarm-webapp`), branch **`feature/day-overview-strip`** (base: `feature/slot-reservations`) |
| Sandbox de pruebas | API `http://127.0.0.1:3002` + web `http://localhost:3000` |
| Producción | API `:3001` (tarea "SouthFarm API") + api.southfarm.tech + Vercel — **intocada** |
| Coordinación de puertos | `C:\SouthFarm\SESIONES_Y_PUERTOS.md` (hay OTRA sesión activa en `visualize-phone` sirviendo en 3010) |

## 3. Cómo levantar el entorno de pruebas (sandbox)

```bash
# Terminal 1 — API sandbox (usar el node 22 del runtime por el ABI de better-sqlite3)
cd backend
C:\Users\josu_\AppData\Local\SouthFarm\node-v22.23.1-win-x64\node.exe scripts/dev-sandbox.mjs --keep
#   --keep preserva los datos de prueba; sin él re-snapshottea producción (read-only)

# Terminal 2 — webapp apuntando al sandbox
cd webapp
NEXT_PUBLIC_API_URL=http://127.0.0.1:3002 npm run dev
# → http://localhost:3000  · login: qa-sandbox@test.local / southfarm-qa-123
```

Utilidades:
- `node scripts/seed-demo-day.mjs [--date YYYY-MM-DD]` — día demo: 3 tareas RUNNING en la
  hora actual, apiladas de 4 teléfonos a las 15:00, completadas, atrasada (cancela demos
  previas del día antes de crear).
- `node scripts/audit-slot-overlaps.mjs [db]` — **0 solapes ACTIVOS** esperado (los
  `completed` históricos no cuentan). Estado actual: producción 0/73, sandbox 0/66.
- `node scripts/test-slot-reservation.mjs` — suite de integración: **47/47 checks**
  (arranca su propio server en :3111 contra DB temporal; seguro de correr en cualquier
  momento).

⚠️ better-sqlite3 compila para el Node del runtime (v22). Con otro Node va a fallar el
require — correr SIEMPRE los scripts con el `node.exe` v22.23.1 del runtime.

## 4. Arquitectura de lo implementado

### Backend (`backend/src`)

| Pieza | Qué hace |
|---|---|
| `slot-reservation.ts` | Núcleo. `reserveSlot()` transaccional (políticas shift/reject, límites por tipo: manual 24h, automática su día local BA). `planCascadeMove()` simula la cascada SIN aplicar. `busyUntilForDevice()` para deviceView. Regla clave: una tarea `running` con lease vencido NO bloquea (está muerta). |
| `POST /api/tasks/run` | Crea vía `reserveSlot('shift', 24h)`; acepta `cluster_id` (validado contra workspace) y `duration_minutes` de nivel superior; responde `scheduled_for_effective`/`shifted_from`; audita `shifted_from` y `cluster_id`. |
| `PATCH /api/tasks/runs/:id/schedule` | Movimiento individual: valida con `reserveSlot('reject')` excluyendo la propia; 409 con `conflicts` + `next_free_slot`; audita `rescheduled_manual` {from, to, by_user_id}. |
| `POST /api/tasks/runs/:id/move/preview` y `/move` | Cascada: preview devuelve el plan completo sin aplicar; `/move` RECALCULA dentro de la transacción y aplica todo-o-nada. Semántica de inserción: tareas ANTERIORES al punto de inserción quedan CONGELADAS; si el destino roza el margen de una anterior, la tarea insertada se DESLIZA al primer minuto válido; solo las posteriores pisadas se recorren; running/completadas son bloqueos inmóviles (si el destino pisa una, plan rechazado). Audita `rescheduled_manual` con `cascade_root_id` por tarea recorrida. |
| `GET /api/planner/day?cluster_id=N` | Día scopped a un clúster (tareas + publicaciones vía account_cluster_members); 404 si el clúster no es del workspace. `hourly` cubre 0–23. |
| `deviceView` | Expone `busy_until` (fin de la ventana que cubre "ahora"). |

### Webapp (`webapp/src/app/activity-planner`)

| Pieza | Qué hace |
|---|---|
| `day-view.tsx` | ÚNICO layout de día (compacto, para ambas vistas): carril por hora (152px), mini-cards apiladas izq→der por minuto, chip 00:00 centrado con aire de grilla (`COMPACT_PAD=18`), pill AHORA en el gutter centrada en el carril actual, bordes del carril con puntos marchando, glow por ventana. **Sin drag & drop**: el movimiento es 100% vía modal de detalle. |
| `quick-add-panel.tsx` | Panel "Agregar tarea al día" (solo clúster): Warmup (slider 5–60') / Scan (10'), multi-cuenta, hora, y dos modos de conflicto: *próximo hueco libre* (creación con shift) o *forzar horario y correr el resto* (crea + `applyCascadeMove`). Publicación deshabilitada (necesita video). Envía `cluster_id` — sin eso las tareas no aparecen en el día del clúster. |
| Modal de detalle | Ficha completa (estado/tipo/cuenta/teléfono/clúster/horario/origen) + "Mover a esa hora" (reutiliza conflicto→hueco→cascada) + "Cancelar tarea". |
| `planner-page.tsx` | Estado `dayClusterId`; tabs "Día completo" / "Día clúster"; clic en un día dentro del chart de un clúster (semana) abre ESE día scopped; navegar días preserva el scope. |
| `platform-logos.tsx` | Logos oficiales SVG (Instagram #E4405F, TikTok #25F4EE, YouTube #FF0033) usados en mini-cards, pills del timeline y modal. |
| Motor de animación (rAF en `day-view.tsx`) | **Importante**: los efectos (marcha de los bordes del carril, pulso de cards running, punto vivo) NO usan animaciones CSS — Chrome las clampa a ~0s con `prefers-reduced-motion: reduce` (config del SO). Un `requestAnimationFrame` escribe `--march-x` / `--pulse` / `--live-op` en la grilla y el shadow del pill AHORA por frame. No agregar gates de reduced-motion sobre estos elementos ni duplicar reglas de los bordes (ver gotcha §7.2). |

## 5. Gotchas aprendidos en esta etapa (no repetir)

1. **CRLF/LF mezclado**: varios archivos terminaron con finales mixtos y los reemplazos
   de texto en python fallaban silenciosamente. Normalizar a LF antes de parchear
   (`read bytes → replace \r\n → write newline='\n'`).
2. **CSS duplicado por commits acumulados**: dos bloques `.ap-c-nowrow::before/::after`
   convivían; el viejo con `animation: apNowMarch` clamp-eada congelaba el
   `background-position` pisando la variable del rAF. Al agregar reglas, verificar que no
   haya duplicados del mismo selector.
3. **LLaves huérfanas** tras eliminaciones por regex → `CssSyntaxError: Unexpected }`.
   El build de Next las reporta con línea exacta.
4. **El clamp de reduced-motion NO afecta a rAF**: si se pide movimiento explícito
   (como pidió el dueño), implementar con rAF + variables CSS, no con `animation`.
5. **`cluster_id` en creación**: sin él, la tarea es invisible en la vista día de
   clúster (filtra por `tr.cluster_id`).
6. **Duración del quick-add**: va en `params.duration_minutes` (el backend deriva
   `planned_duration_sec` de ahí; también acepta `duration_minutes` de nivel superior
   como fallback desde este commit).
7. **Tipos de tarea**: `warmup_ig` (NUNCA `warmup_instagram`), `warmup_tiktok`,
   `warmup_youtube`, `scan_<plataforma>`.
8. **Mapear siempre el archivo real antes de parchear**: varios asserts fallaron por
   trabajar sobre textos de versiones anteriores (CRLF, ediciones previas). Ante
   AssertionError, releer el archivo y re-anclar.

## 6. Pendiente (próximos pasos)

1. **Validación final del dueño** sobre el sandbox (quick-add con cluster_id, cascada,
   glow por ventana).
2. **Deploy backend al runtime**: `npm run build` → copiar `dist/` a
   `%LOCALAPPDATA%\SouthFarm\runtime\backend\dist\` → reiniciar tarea "SouthFarm API" →
   verificar health rico ≥10 min → correr `audit-slot-overlaps.mjs` (0 activos).
   Sugerencia: avisar en `SESIONES_Y_PUERTOS.md` antes, por la otra sesión.
3. **Publicar webapp**: merge `feature/day-overview-strip` → `main` en `southfarm-webapp`
   (Vercel deploya solo). Recomendado: backend primero.
4. **Smoke post-deploy**: mover una tarea real, verificar `rescheduled_manual` con
   from/to, y que una tarea manual a horario vencido sea reclamada por el teléfono.
5. **Mejoras futuras anotadas**: publicación desde acciones rápidas (requiere flujo de
   video), resume real de interrumpidas (Fase 3 del plan original), corrimiento
   correctivo del scheduler y franjas operativas (Fase 4).

## 7. Historial de commits de esta etapa

Backend (`southfarm-landing` · `feature/slot-reservations`):
`97af908` dedupe → `e71f051`/`5050118` fixes previos → `461d377` plan →
`99025c2`..`1e23958` Fase 1 + suite + sandbox → `ce07664` Fase 2 → `bd1346b`/`0edbc6f`
docs → `a25e66c` cascada → `807f3fc` día scopped → `7773c3a` hourly 0-23 →
`3d38d3b` auditoría split → `474861d` cluster_id en creación → `8d7b409`
duration_minutes → `4fd2633` seed v2 → `1ecbd91`/docs.

Webapp (`southfarm-webapp` · `feature/slot-reservations` → `feature/day-overview-strip`):
`4571eda` mover+conflicto → `6789090`/`5eabc2b` timeline → `54aed5b` cascada UI →
`53bdd7a` día dual → `b64d4e0` timeline absoluto → `6b140a9` rAF pill → `c1d9bc8`
regla visible → `fba676a` axis gutter → `6da9d5c` swimlanes → `39b4d38` 24h →
`0c3201b` inicio→fin → `1bef570` pill centrada → `33c7b8e` chip 00:00+glow ventana →
`2262445` logos → `20ef9f8` slider → `1c1d186` warmup_ig → `bc59950` cluster_id UI →
`f037a1a` aire grilla → `8c04a11` glow por ventana → `d0c2a34` motor rAF →
`431ccb1` dedupe march.
