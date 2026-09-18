# SouthFarm — Estrategia de reparación estructural: ciclo de vida de dispositivos, presencia y streaming

**Fecha:** 2026-09-09
**Rol:** Arquitectura / mejoras estructurales
**Entrada:** propuesta técnica del auditor (device-lifecycle-and-stream-auth) + auditoría de código con evidencia archivo:línea sobre `C:\SouthFarm\source` (backend `9a9ced6`, webapp `main` `0c12f50`, app `southfarm_app` `1.1.9+66`, screen-bridge en worktree `visualize-phone`).
**Estado:** Estrategia aprobada para discusión. **No se ejecutó ningún cambio de código.**

---

## 1. Veredicto sobre el documento del auditor

La hipótesis central del documento es **correcta y quedó confirmada con evidencia de código**: no existe una fuente de verdad común entre enrolamiento, heartbeat y streaming. Además, la auditoría encontró que la situación real es **peor** de lo que el documento asumía en un punto, y **distinta** en otro:

| # | Afirmación del documento | Veredicto | Evidencia |
|---|---|---|---|
| 1 | "El bridge puede transmitir aunque la app no esté enrolada" | **Confirmado — y peor**: `devices.json` ni siquiera actúa como allowlist. El serial viaja libre en la URL del WebSocket y cualquiera con el token estático puede streamear cualquier serial. | `screen-bridge/server.mjs:653,662-664` (el serial es parámetro de la URL); `devices.json` solo se consulta para alias cosméticos (`server.mjs:130-137`); el token del bridge está **horneado en el bundle público del navegador** (`webapp/src/app/fleet-live-view.tsx:81`, `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN`). |
| 2 | "El backend acepta heartbeats de instalaciones no enroladas" | **Confirmado por combinación de 3 huecos**: (a) la app nunca limpia su `device_token` cuando el backend responde `409 DEVICE_NOT_PAIRED` (`southfarm_app/lib/main.dart:1328-1338`); (b) el servicio Kotlin hace heartbeat cada 5 s con `device_token ?? auth_token` y **ignora 401/403/409** sin detenerse (`SouthFarmAccessibilityService.kt:234-239, 514-528`); (c) el backend acepta heartbeat con **JWT de usuario** (cualquier owner/admin/operator), no solo con token de dispositivo (`backend/src/index.ts:2723-2725`). |
| 3 | "`devices.json` actúa de facto como autorización" | **Corrección**: no llega a actuar como nada. Es un mapa cosmético serial→alias; el path del WS ni lo consulta. | `server.mjs:555-562, 653` |
| 4 | "El backend no invalida token al revocar" | **Matiz**: sí lo invalida (DELETE → `device_token_hash=NULL`, `index.ts:2984-2993`) y el middleware exige `lifecycle_status='active'` (`index.ts:2281`). Los huecos reales son otros: `touchDevice` escribe `lifecycle_status='active', revoked_at=NULL` incondicionalmente (`index.ts:592`, bomba latente de reactivación), hay un fallback de resolución de dispositivo **sin filtro de lifecycle** (`index.ts:557-559`, hoy inalcanzable), y el token de dispositivo es permanente, sin versión ni rotación. |
| 5 | "`4 Online / 7 Activos` mezcla planos" | **Confirmado**: "activo" = no revocado (conteo de filas DB), "online" = heartbeat < 90 s, "live" = bridge local. La web no distingue enrolamiento / agente / USB / pantalla y `lifecycle_status=revoked` ni siquiera se renderiza en la flota. | `webapp/src/app/page.tsx:605,629,662`; `fleet-live-view.tsx:594` |
| 6 | "El síntoma crítico (pantalla de enrolamiento transmitida en vivo)" | **Explicado**: el bridge no tiene conexión alguna con el backend (cero HTTP/fetch en `server.mjs`); el único vínculo enrolamiento↔stream es un match de strings por alias en el cliente, eludible con el selector manual de seriales (`fleet-live-view.tsx:596-611, 689-716`). |

### Causa raíz única

**La identidad de dispositivo no es canónica a través de los tres planos.** El backend enrola por `(device_id = ANDROID_ID, installation_id)`; el bridge identifica por `serial ADB`; y nadie mantiene la relación serial↔device. Sobre ese vacío se apoyan credenciales permanentes sin rotación, un servicio Android que opera con credenciales que la UI considera inválidas, y un bridge cuya "autorización" es un token estático compartido y público en el bundle.

---

## 2. Respuestas a las 7 preguntas de implementación del documento

1. **¿Identificador estable de instalación y dónde persiste?** `installation_id` = `sf-install-<24 hex>` generado en Dart y persistido en `SharedPreferences` (`main.dart:1249-1258`); `device_id` = `ANDROID_ID` real vía MethodChannel (`MainActivity.kt:70`). Backend: `devices.installation_id` (`index.ts:223`), con índice único parcial `(workspace_id, installation_id) WHERE lifecycle_status != 'revoked'` (`index.ts:1656-1666`). La reinstalación regenera ambos → `register` responde 409 → correcto; el problema es que el teléfono queda con credenciales huérfanas (ver Fase 0).
2. **¿UI y servicio usan el mismo store?** Sí: ambos leen `FlutterSharedPreferences` (`SouthFarmAccessibilityService.kt:227-252`). Pero comparten solo los tokens: el servicio **nunca lee `device_paired`** y su `authToken()` cae al token de sesión de usuario (`flutter.auth_token`) si no hay device_token — el desacople exacto que produce "UI no vinculada + heartbeat 200".
3. **¿Endpoints de pairing?** `POST /api/devices/pairing-codes` (owner/admin, `index.ts:2612-2644`): code de 4 bytes hex + `access_key` `sfpk_*`, TTL 10 min (2-60), solo hashes SHA-256, uso único. `POST /api/devices/claim` (usuario operator/admin, `index.ts:2646-2702`): transacción atómica que revoca registros previos del mismo `device_id` con otra instalación, crea/activa, emite `device_token` `sfd_*` permanente y consume el código. **El diseño de pairing es sólido; no hay que rehacerlo**, solo agregar rotación de token.
4. **¿Dónde vive alias ↔ device_id ↔ serial?** **No existe en el backend.** `devices.device_alias` vive en DB; el serial vive solo en el `devices.json` local del bridge; la web los correlaciona con un match de strings por alias en el cliente (`fleet-live-view.tsx:596-611`). Este vacío es el bloqueador principal para autorizar streaming por enrolamiento (ver Fase 2).
5. **¿El bridge puede consultar la API?** Hoy no habla con el backend en absoluto. Recomendación: no acoplarlo en tiempo real. Emitir **capabilities firmadas (HMAC, TTL 60-120 s, `aud=bridge_id`)** que el bridge valida offline, más un **polling firmado de attachments** (30-60 s) para inventario y corte de sesiones. El backend ya tiene el patrón: `PUBLISHER_WORKER_TOKEN` con comparación `timingSafeEqual` (`publication-worker-routes.ts:23-29`).
6. **¿Cómo se publican eventos de revocación al bridge?** Sin WebSocket disponible hoy, el camino pragmático: TTL corto de la ScreenSession (≤ 120 s) + validación contra el backend al renovar → un revoke corta el stream en ≤ 1 TTL sin infraestructura nueva. Push (SSE/WebSocket backend→bridge) queda como mejora posterior, no prerrequisito.
7. **¿Retención de cuentas e historial al revocar?** Hoy DELETE es soft-revoke que no borra datos; el worktree de live-view además desvincula `task_runs.social_account_id` antes de borrar cuentas por constraint. Mantener la política: **revocar nunca borra historial ni cuentas**; el borrado es una operación explícita separada (clean accounts).

---

## 3. Estrategia por fases

Principios: (1) primero cerrar las brechas activas con cambios pequeños y reversibles; (2) después construir la fuente de verdad; (3) recién al final, el modo estricto y la migración de flota. Cada fase termina en entrega probada + commit inmediato (regla del dueño, incluye el repo anidado `webapp/`).

### Fase 0 — Cerrar las brechas activas (días, sin cambios de modelo) — **P0**

Objetivo: que el síntoma de producción sea imposible, sin migraciones.

| # | Componente | Cambio | Evidencia del hueco |
|---|---|---|---|
| 0.1 | App | En `registerDevice`, ante `409 DEVICE_NOT_PAIRED` y `401`: borrar `device_token`, poner `device_paired=false` y detener el polling del servicio | `main.dart:1328-1338` |
| 0.2 | App | `logout()` borra `device_token` y `device_paired` (portar lo que la v2 sí tenía, `southfarm_app_v2/lib/main.dart:784-786`) | `main.dart:1140-1165` |
| 0.3 | App (Kotlin) | El servicio, ante 401/403 en heartbeat/claim: borra `flutter.device_token`, pausa el polling y notifica a la UI; no usar `auth_token` de usuario como credencial para endpoints device-scoped (`/devices/heartbeat`, `/tasks/claim`) | `SouthFarmAccessibilityService.kt:234-239, 514-528` |
| 0.4 | Backend | Heartbeat exige device token (rechazar JWT de usuario con 403 `USER_TOKEN_NOT_ALLOWED`); cerrar el fallback sin filtro de lifecycle de `findDeviceForUser` | `index.ts:2723-2725, 557-559` |
| 0.5 | Bridge | Fallar el arranque si `SCREEN_AUTH_TOKEN` no está definido; eliminar el token de la query string (solo header); CORS restringido al dominio de la web | `server.mjs:36-52, 582` |

**Criterio de aceptación F0:** app mostrando "no vinculada" no emite ningún heartbeat (verifiable en logs del backend); bridge sin token no arranca; un JWT de usuario no puede heartbeatear dispositivos.

### Fase 1 — Fuente de verdad del ciclo de vida (backend) — **P0/P1**

1. **Estados explícitos**: `pending | enrolled | revoked` sobre `lifecycle_status` (migración aditiva, `active`→`enrolled` con compatibilidad de lectura). Transiciones documentadas: claim→enrolled, DELETE→revoked, nada más revivice (ver 3).
2. **Heartbeat sin efectos secundarios**: separar "refrescar presencia" de "revivir registro". `touchDevice` deja de escribir `lifecycle_status='active', revoked_at=NULL`; la reactivación solo existe en `claim`. Exigir que `installation_id` del body coincida con el del registro (hoy no se valida en heartbeat).
3. **Rotación de token de agente**: columna `agent_token_version` (INT). El token del dispositivo pasa a incluir la versión; un bump invalida todos los tokens previos. Base para revocación inmediata y para la migración de Fase 6.
4. **Contrato de `GET /api/devices`**: cada dispositivo expone sus señales separadas (`enrollment`, `agent`, más `attachment` y `screen` cuando existan en Fase 2), cada una con timestamp.
5. **Reconciliar el drift backend principal ↔ worktree live-view** (4 hunks: refresh-grace, re-pairing en claim, desvinculación social_account, guards de proceso): definir la rama canónica y portar los 4 hunks a una sola línea antes de construir encima.

**Criterio F1:** un heartbeat de un dispositivo revocado o con `installation_id` disinto → 401/403 con código explícito; ningún endpoint reactiva registros; los 4 estados son visibles por API.

### Fase 2 — Autorización de streaming: `ScreenSession` + attachments — **P1**

Diseño (adaptado de la propuesta, ajustado a la evidencia):

1. **Tablas nuevas** (migraciones aditivas, nada destructivo):
   - `screen_bridges`: `id, workspace_id, name, token_hash (rotable), last_seen_at`.
   - `bridge_attachments`: `bridge_id, adb_serial_hash, device_id (FK nullable), status, last_seen_at` — el **mapeo serial↔device vive por fin en la DB**, administrado desde la web (con 7-20 teléfonos, el alta manual una vez por teléfono es el costo/beneficio correcto; el reconciliador de Fase 5 detecta conflictos).
   - `screen_sessions`: `id, workspace_id, device_id, bridge_id, expires_at (TTL 60-120 s), status requested|live|ended|denied`.
2. **Flujo**: botón "Vista en vivo" → `POST /api/devices/:id/screen-session` (valida usuario, rol, workspace, `device.status=enrolled`, attachment vigente) → devuelve URL firmada de **un solo uso** al bridge (HMAC con el secreto del bridge: `device_id`, `bridge_id`, `exp`, `aud=screen-bridge`, nonce) → bridge valida firma offline + que el serial sigue attached → inicia scrcpy para esa sesión → renovación cada TTL revalida contra la API.
3. **El bridge reporta attachments** cada 30-60 s: `POST /api/bridges/:id/attachments` con su token (ya existe el patrón `PUBLISHER_WORKER_TOKEN`). Esto le da al backend visibilidad de "qué seriales hay enchufados dónde" sin acoplar el stream.
4. **Revocación en cascada**: DELETE device → `screen_sessions` revocadas → en la próxima renovación (≤ TTL) el bridge corta el stream; el attachment queda `conflict` hasta reasignación.
5. **Limpieza del cliente**: eliminar `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN` del bundle; la web ya no conoce seriales ni tokens — solo recibe URLs firmadas. `devices.json` queda como caché de alias, no como autoridad.
6. **Rollback seguro**: feature flag por workspace (`strict_bridge_mode`); mientras esté apagado, el flujo actual sigue funcionando. Se enciende primero en un workspace de prueba con auditoría de denegaciones.

**Criterio F2 (el test crítico del documento):** `bridge con serial attached + app sin enrolar + usuario web autorizado => API responde 409 DEVICE_NOT_ENROLLED y no se abre stream`.

### Fase 3 — App: un solo estado de enrolamiento — **P1** (paralelizable con Fase 2)

1. Estado único de enrolamiento (`device_paired` + `device_token`) como única fuente para UI **y** servicio; el servicio no opera (heartbeat ni claim) si `device_paired != true`.
2. Manejo explícito de `401 DEVICE_REVOKED` / token inválido: limpiar credenciales locales, detener servicio, volver a pantalla de enrolamiento (i18n es/pt/en ya existe).
3. Decisión de unificación de paquetes **v1 vs v2** (recomendación en §5).

### Fase 4 — UI de cuatro señales — **P2**

1. Reemplazar `N online / M activos` por el desglose inequívoco del documento: `registros / agentes activos / USB en bridge / pantallas live / pendientes`.
2. Mostrar enrolamiento como estado principal ("Enrolado / Pendiente / Revocado"), "Agente activo hace Xs" en vez de "Online", y **revocados visibles** en flota (hoy `lifecycle_status` no se renderiza).
3. Bloquear acciones sensibles ante contradicciones (no ofrecer "Vista en vivo" sin attachment ni sesión posible).

### Fase 5 — Reconciliación y observabilidad — **P2**

Worker interno (puede ser un job en el propio proceso Express para empezar, sin infra nueva):

| Condición | Acción |
|---|---|
| Heartbeat de dispositivo no enrolado | Rechazar + alerta de seguridad (ya cubierto en F1; aquí se registra) |
| Stream de dispositivo no enrolado | Corte + alerta crítica |
| Attachment sin `device_id` asignado | `unassigned`; sin pantalla web |
| Dos seriales para un mismo `device_id` | `conflict`; resolución manual |
| USB disponible sin agente / agente sin USB | Mostrar ambos planos en la UI |

Todo cambio de estado registra evidencia (timestamps, bridge_id, serial con hash, motivo). Métricas mínimas: enrolados, heartbeats válidos, attachments, streams denegados, conflictos.

### Fase 6 — Migración de la flota actual — **al final, controlada**

Tal como propone el documento (es correcto): Fase 0 respaldo SQLite + inventario exportado → clasificar registros `legacy_unreconciled` → correlación controlada teléfono por teléfono (son 7; preservar cuentas/historial/alias cuando la coincidencia es inequívoca) → rotación de tokens vía `agent_token_version` (invalidar los legacy solo cuando el nuevo vínculo esté probado) → habilitar `strict_bridge_mode` por workspace con auditoría de denegaciones antes de bloquear global. **Nunca borrar registros para "arreglar" el enrolamiento.**

---

## 4. Trabajo estructural paralelo (higiene, bajo riesgo, alto valor)

Detectado durante la auditoría; no bloquea las fases pero evita accidentes futuros (especialmente con agentes trabajando en el repo):

1. **Código muerto peligroso en backend**: `auth.ts`, `devices.ts`, `tasks.ts` definen routers que **nadie importa** (el runtime real es el monolito `index.ts`, ~4.600 líneas). Riesgo: que un agente futuro "conecte" el router legacy con scoping solo por `user_id`, sin workspace ni lifecycle. Acción: mover a `src/legacy/` con README o eliminar.
2. **`southfarm_app_v2` no está en git** (0 archivos trackeados) y su logout tenía una limpieza que la v1 activa perdió. Decidir: archivar fuera del repo o trackear; la fuente activa es `southfarm_app` (v1.1.9+66 = vc66).
3. **Secretos**: `jwt-config.ts:3,12` tiene fallback hardcodeado `'southfarm-secret-change-in-production'` → fallar en producción si falta el env; verificar si ese secreto estuvo en prod y rotarlo.
4. **Artefactos en el repo**: `.tmp-ui-scan.txt` (~864 MB), `.tmp-*.png`, `webapp-v1/v2/v3`, `.round1-reconstruction/`, `app/` — archivar o eliminar del working tree + `.gitignore`. No son fuente.
5. **CI mínimo en GitHub**: build del backend, `flutter analyze`/test, vitest del webapp. Hoy no hay workflows; los tests existen pero nadie los corre.
6. **(Después)** Refactor de `page.tsx` (891 líneas, 8 páginas + toda la capa de datos) siguiendo el patrón ya establecido en el repo (`fleet-live-view.tsx`, `activity-planner/` con capa API propia y tests). Prioridad baja: es deuda localizada, no bloqueante.

---

## 5. Decisiones que necesito del dueño

1. **¿Arrancamos por Fase 0?** Recomendación: sí, es de días, reversible y cierra el agujero de seguridad real (token de bridge público + heartbeats huérfanos).
2. **Unificación de paquetes de la app**: recomiendo congelar `southfarm_app_v2` (archivar fuera del repo), continuar sobre `southfarm_app` v1 y portar de v2 únicamente la limpieza de logout. Alternativa: migrar todo a v2, pero implica re-validar publicación.
3. **Modo estricto del bridge**: recomiendo habilitarlo primero en un workspace de prueba con flag, nunca global de un día para otro.
4. **PostgreSQL (handoff de julio)**: recomiendo implementar primero el modelo de identidad sobre SQLite (las fases 1-2 son migraciones aditivas portables) y dejar la migración a Postgres como iniciativa separada y posterior, con el esquema ya saneado.

---

## 6. Orden de ejecución propuesto

```text
Semana 1      Fase 0 (0.1–0.5)  → entrega probada → commit (backend + webapp + app)
Semana 1-2    Fase 1 (modelo de identidad) + higiene §4.1–4.4
Semana 2-3    Fase 2 (ScreenSession + attachments, flag por workspace) ∥ Fase 3 (app)
Semana 3-4    Fase 4 (UI 4 señales) + Fase 5 (reconciliador)
Después       Fase 6 (migración de flota) + §4.5–4.6
```

Dependencia clave: la Fase 2 depende de la Fase 1 (estados y rotación), y la Fase 6 depende de todo lo anterior. La Fase 0 no tiene dependencias y se puede empezar de inmediato.
