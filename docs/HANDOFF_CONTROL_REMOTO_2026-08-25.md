# HANDOFF — Control Remoto de la Flota (fase 2 de la vista en vivo) — 2026-08-25

> **Para:** agente que construirá la funcionalidad de **control remoto** de los teléfonos de la flota
> (ver la pantalla en vivo + controlarla con mouse/touch desde la web).
> **Desde:** sesión del orquestador que implementó y puso en producción la **vista en vivo** (fase 1).
> **Regla de oro del repo:** cada versión funcional que el dueño pueda probar → commit inmediato.
> Nunca dejar trabajo solo en el working tree. `webapp/` es repo git anidado y requiere commit separado.

---

## 1. Contexto: qué existe hoy y por qué estás en ventaja

La **vista en vivo** (fase 1) ya está **en producción y funcionando**:

- 4 teléfonos (02, 07, 08, 09) conectados por **USB** a la PC de la oficina.
- El bridge (Node, puerto 8100) transmite la pantalla de cada uno por WebSocket.
- La web productiva es **https://southfarm-webapp.vercel.app** (Vercel, rama `main` del repo anidado).
- Túnel fijo: **https://screen.southfarm.tech** → `localhost:8100` con auth por token.
- Todo el código está mergeado a `master` (padre) y `main` (webapp).

**Tu funcionalidad es la fase 2:** además de ver, **controlar** el teléfono (mouse = taps/scroll,
botones de navegación, texto). El dueño ya aprobó la dirección; pidió este handoff para arrancar.

### 📖 LECTURA OBLIGATORIA ANTES DE ESCRIBIR CÓDIGO

**`docs/ESTRATEGIA_VISTA_EN_VIVO_FLOTA.md`** (mismo repo, carpeta docs). Ahí está documentada toda
la arquitectura, el protocolo scrcpy v4 descifrado, las decisiones de diseño del bridge y del
frontend, los 6 bugs de producción con sus causas raíz, el runbook y el checklist de despliegue.
Este handoff NO repite ese contenido: lo referencia. Léelo completo primero.

---

## 2. Mapa de dónde está cada cosa

### Código

| Qué | Dónde |
|---|---|
| Bridge (Node ESM, ~660 líneas, única dependencia `ws`) | `C:\SouthFarm\source\.worktrees\visualize-phone\screen-bridge\server.mjs` |
| Mapeo serial→alias | `screen-bridge\devices.json` (en dev: el del worktree; **en producción: `C:\ProgramData\SouthFarm\screen-bridge\devices.json`** — ojo permisos, ver §7) |
| Frontend vista en vivo | `webapp\src\app\fleet-live-view.tsx` (worktree o checkout principal `C:\SouthFarm\source\webapp`) |
| Integración en la flota | `webapp\src\app\page.tsx` (FleetPage/DeviceCard, multi-vista con `liveDeviceIds`) |
| Estilos | `webapp\src\app\globals.css` (clases `.cc-live-*`) |
| Tests | `webapp\src\app\fleet-live-view.test.tsx` (vitest + jsdom, 11 tests — deben seguir pasando) |
| App mobile (Flutter) | `C:\SouthFarm\source\southfarm_app\` (solo relevante si el experimento de inyección requiere el accessibility service) |
| Scripts productivos | `ops\windows\` (instalador del bridge, supervisor inmortal, ingress de túnel) |
| Binario scrcpy-server v4.1 | `C:\Users\josu_\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1\scrcpy-server` |
| adb | `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe` |

### Credenciales y configuración productiva

| Qué | Dónde encontrarlo |
|---|---|
| Token de auth del bridge (producción) | `C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json` (campo `auth_token`; ACL SYSTEM/Admins → leerlo como admin o pedírselo al dueño; también está como variable Sensitive en Vercel) |
| Envs de producción de la web | Vercel → proyecto `southfarm-webapp` → Settings → Environment Variables (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SCREEN_BRIDGE_URL`, `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN`). CLI de Vercel ya autenticado y vinculado en `C:\SouthFarm\source\webapp` (`npx vercel whoami` → josuelorenzo-mkt) |
| Runtime del bridge productivo | `C:\ProgramData\SouthFarm\screen-bridge\` (copia desacoplada de los checkouts — **editar ese devices.json, no el del worktree**) |
| Logs productivos | `C:\ProgramData\SouthFarm\logs\screen-bridge.{out,error}.log` (UTF-16, rotan a 10 MB) |
| DB productiva | `C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db` (SQLite; tabla `devices` tiene `device_alias`, `last_seen_at`, `lifecycle_status`) |

⚠️ **El bridge productivo está corriendo** (supervisor + auto-arranque al login de `josu_`). Si
necesitas reiniciarlo o correr un bridge de prueba en otro puerto, NO mates el 8100 sin avisar al
dueño — o usá `SCREEN_BRIDGE_PORT=8101` para tus experimentos.

### Hardware conectado ahora mismo

4 teléfonos Xiaomi POCO 25028PC03G (Android 15) por USB:
`863d...ca492874c`=08 · `863d...d44eca24c`=02 · `863d...d997f1d4c`=09 · `863d...7ef3e36c`=07
(los seriales pueden cambiar de puerto USB pero el serial es estable). Además hay seriales WiFi
(`192.168.0.x:5555`) que se reconectan solos — hay una tarea programada "SouthFarm ADB WiFi Keepalive".

---

## 3. FASE 0 — Experimento de validación (HACER ESTO PRIMERO, medio día)

**No escribas ninguna línea de la funcionalidad antes de validar esto.** Define todo lo demás.

### La pregunta
scrcpy-server puede inyectar touches si se lanza con `control=true`. Pero en esta flota ya
descubrimos que el launcher de los teléfonos ("gogo.launcher") **bloquea inyecciones de input**:
`adb shell input swipe/tap` sale exit 0 pero **no tiene efecto**. scrcpy inyecta por su propio canal
(InputManager vía shell uid, modo INJECT_INPUT_EVENT_MODE) — *podría* funcionar donde el comando
fallaba, o podría chocar con el mismo bloqueo. **Este experimento responde esa pregunta.**

### Cómo hacerlo
1. **No toques el bridge productivo.** Trabajá con un script Node suelto (como las sondas de la fase
   1, en `C:\Users\josu_\sf_shots\`) contra UN teléfono USB.
2. Push + spawn manual de scrcpy-server con `control=true` (mismo comando del §4 del documento de
   estrategia, agregando `control=true`).
3. Conectá un socket TCP crudo (sin bridge): vas a RECIBIR el video y podés ENVIAR mensajes de control
   por el mismo socket (con `control=true` el canal es bidireccional).
4. Inyectá un tap en una coordenada visible (ej: abrir el panel de ajustes rápidos deslizando desde
   arriba, o tocar un ícono del launcher) y **verificá visualmente**:
   `adb -s <serial> exec-out screencap -p > antes.png` → inyectar → `despues.png` → comparar.
5. Probá también scroll (type 3) y un keycode (type 0, ej. KEYCODE_HOME=3).

### Formato de los mensajes de control (verificar empíricamente)
El protocolo de control de scrcpy está en el código abierto del proyecto (GitHub Genymobile/scrcpy,
`server/src/main/java/com/genymobile/scrcpy/control/ControlMessage.java` y el binario ya descargado
en la PC). Tipos que vas a necesitar:
- `0` inject keycode: [type][action u8][keycode u32][repeat u32][metaState u32]
- `1` inject text
- `2` **inject touch**: [type][action u8][pointerId s64][x u32][y u32][screenW u16][screenH u16]
  [pressure u16][actionButtons u32][buttons u32] — x/y en **enteros 0..32767** normalizados a la pantalla
- `3` inject scroll
⚠️ Los layouts pueden diferir levemente entre versiones de scrcpy: **validalos contra el JAR v4.1 que
tienes en disco** (descompilá `ControlMessageReader.java` o probá byte a byte como hicimos con el
framing de video). Documenta el layout exacto que funcionó.

### Resultados posibles y qué significan
- **Inyección funciona** → seguís con Fase 1 (§4). 
- **Inyección bloqueada por el launcher** → probá inyectar sobre OTRA app en primer plano (no el
  launcher): si funciona solo sobre apps normales, el bloqueo es del launcher y la solución es
  documentar "el control no opera sobre el launcher" o cambiar el launcher. Si no funciona en
  ningún lado, evaluá con el dueño: (a) cambiar el launcher de los teléfonos, (b) inyección vía el
  accessibility service que la app SouthFarm ya tiene (`SouthFarmAccessibilityService` en
  `southfarm_app`), (c) descartar la fase 2.
- **El server crashea con control=true** → revisa el log del app_process (`adb logcat`) y el framing
  de tus mensajes; la auto-recuperación del bridge no te cubre en el script crudo.

---

## 4. FASE 1 — Control de un solo espectador (1-2 días, si Fase 0 valida)

Alcance mínimo viable, detrás del token actual:

1. **Bridge**: lanzar el capturador con `control=true` (nueva env/flag, ej. `SCREEN_CONTROL=true`).
   El socket del teléfono pasa a bidireccional: el bridge sigue leyendo video y ahora ESCRIBE los
   mensajes de control que le reenvía el navegador.
2. **Bridge**: nuevo tipo de mensaje WS del cliente (texto JSON, ej. `{"type":"control","msg":"<base64 o estructura>"}`),
   que el bridge convierte al binario de scrcpy y escribe al socket del teléfono. Validar readyState
   y límites (mismo patrón que el envío de video).
3. **Frontend**: handlers `mousedown/mousemove/mouseup` (y `touchstart/move/end` para controlarte
   desde el celular) sobre `canvas.cc-live-canvas` → normalizar coordenadas considerando el
   letterbox del `object-fit: contain` → enviar por el WS.
4. **Frontend**: botones Back/Home/Recents bajo el video (keycodes 3/4/187).
5. **Test**: extender `fleet-live-view.test.tsx` (mockear el WS y verificar que se envían mensajes
   de control con coordenadas correctas) y una sonda Node que inyecte taps contra el bridge.

**Criterio de aceptación (el dueño debe poder):** abrir la vista de un teléfono por USB, mover el
mouse, abrir una app, scrollear un feed y apretar back — sin tocar el teléfono, con la fluidez de
hoy (~100-250 ms en LAN/USB).

---

## 5. FASE 2 — Pulido (1 día)

- **Candado de control multi-espectador**: hoy varias personas pueden VER el mismo teléfono. Con
  control, un solo espectador a la vez: botón "Tomar control" en el frontend, el bridge otorga un
  lock por serial y rechaza controles de otros clientes mientras dure.
- **Teclado**: inyección de texto (type 1) para campos de búsqueda/login en el teléfono.
- **Aviso de tarea en curso**: si el teléfono está ejecutando un warmup/tarea (tabla
  `device_automation_locks` de la DB productiva), mostrar aviso antes de dar control.

## 6. FASE 3 — Seguridad para producción (1 día, decisión de producto)

El token único compartido alcanza para LAN/uso interno, pero control remoto expone el MANEJO total
de los teléfonos (cuentas logueadas incluidas). El paso natural es integrar el RBAC del backend:
- Solo roles owner/admin/operator ven los controles (la web ya conoce el rol del usuario).
- El bridge valida un JWT del backend (endpoint de verificación) en vez del token estático, o recibe
  un "control token" de corta duración emitido por el backend al abrir la vista.
**Decisión pendiente del dueño** (ver §8).

---

## 7. Gotchas de esta PC (todos los sufrimos — no los repitas)

1. **adb con múltiples dispositivos**: SIEMPRE `adb -s <serial>` (hay 4 USB + 3 WiFi conectados).
2. **Git Bash convierte rutas** `/data/local/tmp/...` → `C:/Program Files/Git/data/...`. Usá
   `MSYS_NO_PATHCONV=1` antes del comando, o citá la ruta dentro de `adb shell "..."`.
3. **`grep` de este sistema es `ugrep`**: patrones que empiezan con `-` o `/` fallan. Usá `grep -e`
   o Python para análisis de texto.
4. **Logs del bridge productivo en UTF-16**: leelos decodificando (Python maneja el BOM mixto).
5. **`devices.json` productivo** (`C:\ProgramData\SouthFarm\screen-bridge\`) es de solo lectura para
   tu usuario salvo que el dueño corra `icacls <archivo> /grant "josu_:M"` (ya lo hizo una vez; el
   permiso persiste). El bridge re-lee el archivo en cada `/api/devices` — no requiere reinicio.
6. **El bridge productivo está vivo en 8100** (supervisor + auto-arranque al login de josu_). Para
   experimentos usá `SCREEN_BRIDGE_PORT=8101`. No mates el 8100 sin avisar al dueño.
7. **La tarea SYSTEM "SouthFarm Screen Bridge" está deshabilitada** a propósito (quedó en
   investigación; el bridge corre como proceso del usuario josu_ con supervisor inmortal +
   auto-arranque por Startup folder). No la rehabilites sin coordinar.
8. **Vercel hornea las `NEXT_PUBLIC_*` en build**: cambiar envs requiere redeploy. El CLI está
   autenticado (`npx vercel whoami` → josuelorenzo-mkt) y el proyecto vinculado.
9. **El dueño prueba siempre en Chrome** (WebCodecs). Firefox no.
10. **Los teléfonos tienen la app de SouthFarm con latidos**: el "Online" del panel lo decide la app,
    no el bridge. Un teléfono puede transmitir pantalla y figurar Offline si su app no late.
11. **Xiaomi/MIUI bloquea broadcasts a apps en segundo plano sin "inicio automático"** — relevante si
    tu experimento usa broadcasts (la app mobile tiene receiver `SET_API_BASE` que apunta el servidor
    de la app; el teléfono 07 lo tenía mal configurado y se corrigió editando
    `shared_prefs/FlutterSharedPreferences.xml` vía `run-as`).
12. **No toques los checkouts de otros agentes**: el checkout principal `C:\SouthFarm\source` está en
    la rama `feature/ui-redesign-granja-tecnologica` con cambios sin commitear de otro agente.
    Trabajá en el worktree `C:\SouthFarm\source\.worktrees\visualize-phone` (rama
    `feature/device-fleet-live-view`, ya mergeada a `master`/`main` — creá tu propia rama desde ahí).

---

## 8. Preguntas de dirección para resolver CON EL DUEÑO (antes de Fase 3)

1. **Seguridad**: ¿control detrás del token compartido (rápido) o integrado al RBAC del backend
   (correcto)? ¿Se emite un control-token por sesión desde la web?
2. **Multi-espectador**: ¿candado de un controlador a la vez (recomendado) o control compartido?
3. **Alcance de acciones**: ¿solo navegación (touch/scroll/back/home) o también texto y clipboard?
   ¿Botones de power/captura?
4. **Auditoría**: ¿registrar qué operador controló qué teléfono y cuándo? (la DB ya tiene la
   estructura de usuarios/workspaces para ello).
5. **Conflictos con automatizaciones**: ¿bloquear el control mientras el teléfono ejecuta una tarea
   (`device_automation_locks`) o solo avisar?
6. **Exposición**: ¿el control queda disponible también desde `screen.southfarm.tech` (fuera de la
   LAN) o primero solo en LAN/uso interno?

---

## 9. Estado al momento de entregar este handoff (verificar al retomar)

- Bridge productivo corriendo en 8100 (verificar: `curl "http://localhost:8100/api/health?token=<token>"`).
- 4 teléfonos USB conectados y transmitiendo (verificar: `/api/devices` y `/api/health`).
- Vercel desplegado con envs correctas (verificar: `https://southfarm-webapp.vercel.app` carga y el
  JS horneado contiene `screen.southfarm.tech`).
- Tarea SYSTEM "SouthFarm Screen Bridge" en estado Disabled (verificar elevado).
- Si algo no está como se describe, el runbook del documento de estrategia (§9) tiene los comandos
  para re-levantar cada pieza.

**Última acción de la sesión anterior:** entrega del handoff (este documento) tras dejar la flota
completa en producción por USB con los nombres 02/07/08/09.
