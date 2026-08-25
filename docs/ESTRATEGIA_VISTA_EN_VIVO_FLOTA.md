# Vista en Vivo de Device Fleet — Estrategia, Arquitectura y Bitácora Técnica

> **Documento de referencia** para la funcionalidad de transmisión de pantalla en vivo de la flota Android.
> Escrito para que cualquier agente/desarrollador pueda entender qué se construyó, por qué se tomó cada
> decisión, cómo replicarlo y cómo refaccionarlo sin romper nada.
> Última actualización: 2026-08-25. Estado: **en producción**.

---

## 1. Objetivo

Ver en tiempo real la pantalla de los teléfonos Android de la flota desde la web de SouthFarm
(https://southfarm-webapp.vercel.app), para monitorear tareas y warmups sin tocar los teléfonos.
Requisitos que moldearon el diseño:

- **Opt-in por dispositivo**: nada corre ni se conecta hasta que el operador lo pide.
- **Multi-vista**: varios teléfonos simultáneos en el mismo panel (objetivo: 10).
- **WiFi o USB**: el transporte no debe cambiar la aplicación.
- **Acceso remoto**: debe funcionar desde cualquier red, no solo la LAN de la oficina.
- **Sin modificar la app mobile**: cero riesgo para el producto que ya corre en los teléfonos.

---

## 2. Arquitectura (la cadena completa)

```
Navegador (Vercel, cualquier red del mundo)
  │  WebCodecs VideoDecoder (H.264 Annex B) → canvas "latest-frame-wins"
  │  WSS https://screen.southfarm.tech  (túnel fijo Cloudflare, auth por token)
  ▼
screen-bridge  (Node ESM puro, única dependencia `ws`)
  │  corre en la PC de la oficina, puerto 8100
  │  - autentica clientes por token
  │  - 1 proceso scrcpy-server por teléfono solicitado
  │  - cachea el GOP y re-empaqueta a WebSocket
  │  - watchdog de 2 capas + auto-recuperación con backoff y jitter
  ▼
adb (C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe)
  │  USB (serial físico, preferido en producción) o WiFi (ip:5555)
  │  `adb reverse localabstract:scrcpy tcp:<puerto>` (en v4 el server CONECTA hacia la PC)
  ▼
scrcpy-server v4.1  (dentro de cada teléfono, lanzado vía app_process)
  │  captura el display y codifica H.264 con el encoder hardware (MediaCodec)
  │  parámetros: max_size=720, max_fps=30, video_bit_rate=2000000,
  │             video_codec_options=repeat-previous-frame-after=33333,i-frame-interval=2
  ▼
pantalla del teléfono (no se toca la app, no se inyecta input)
```

Componentes por repositorio:

| Pieza | Ubicación | Notas |
|---|---|---|
| Bridge | `screen-bridge/server.mjs` (~660 líneas, Node ESM) | único archivo de lógica del servidor |
| Mapeo serial→alias | `screen-bridge/devices.json` | se re-lee en cada request, sin reiniciar; **en producción vive en `C:\ProgramData\SouthFarm\screen-bridge\devices.json`** |
| Frontend | `webapp/src/app/fleet-live-view.tsx` | hook + DeviceLiveView + LiveViewToggle |
| Integración web | `webapp/src/app/page.tsx` (FleetPage/DeviceCard) | multi-vista, array `liveDeviceIds` |
| Estilos | `webapp/src/app/globals.css` (`.cc-live-*`) | |
| Tests | `webapp/src/app/fleet-live-view.test.tsx` | vitest + jsdom, 11 tests |
| Ops productivas | `ops/windows/` | instalador de servicio, supervisor, ingress de túnel |
| Binario scrcpy-server | `C:\Users\josu_\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1\scrcpy-server` | configurable con `SCREEN_SCRCPY_JAR` |
| adb | `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe` | configurable con `SCREEN_ADB` |

---

## 3. Elección de tecnologías y por qué

### 3.1 scrcpy-server directo (y no VNC, ni app propia, ni capturas periódicas)

- **scrcpy-server v4.1** es el server de scrcpy (Genymobile) sin el cliente: un JAR que se pushea al
  teléfono y se lanza con `app_process`. Captura el display vía `SurfaceControl`/`VirtualDisplay` y
  codifica con el **encoder hardware** del teléfono (MediaCodec → H.264).
- Ventajas decisivas:
  - **No requiere modificar la app mobile** (cero riesgo de producción).
  - Calidad/latencia de encoder hardware: 30fps reales a ~2-4 Mbps.
  - Proyecto maduro y auditado; el protocolo v4 está validado empíricamente (ver §5).
- Descartadas:
  - *VNC*: requiere instalar un server VNC con permisos especiales por teléfono; latencia y fps peores.
  - *App propia con MediaProjection*: modifica el producto mobile; permisos que el usuario debe aceptar por teléfono.
  - *Capturas periódicas (`screencap`)*: 1-2 fps, sin fluidez; útil solo como herramienta de diagnóstico.

### 3.2 ADB como transporte (USB y WiFi)

- Los teléfonos ya estaban manejados por ADB; el bridge lanza scrcpy-server por esa vía sin tocar nada más.
- **USB (producción)**: serial físico (`863d...`), ~100× el ancho de banda necesario, sin contención.
  Peor silencio medido: **~100-220 ms** (vs 2-17 s por WiFi).
- **WiFi (`ip:5555`, fallback)**: funciona, pero es un medio compartido half-duplex; con varios
  teléfonos subiendo video + descargando feeds, aparecen micro-cortes de túnel. Con bitrate 2M/720p
  los cortes bajan a ~1 cada 8 min y se recuperan en 2-4 s. **Para 10 teléfonos: hub USB alimentado**.
- El mecanismo `adb reverse localabstract:scrcpy tcp:<puerto>` crea un túnel donde **el server dentro
  del teléfono conecta HACIA la PC** (en scrcpy v4; con `adb forward` falla con "Connection refused").

### 3.3 Bridge propio en Node ESM (y no un proxy genérico)

- El protocolo de scrcpy v4 requiere re-empaquetado activo (framing, GOP, SPS/PPS): un proxy tonto no alcanza.
- Node ESM con **una sola dependencia (`ws`)**: fácil de auditar, de correr como servicio y de versionar.
- El bridge es el único componente con estado: clientes WebSocket, cache de GOP, procesos scrcpy, watchdogs.

### 3.4 WebCodecs + canvas "latest-frame-wins" (y no MSE/HLS ni <video>)

- **WebCodecs `VideoDecoder`** decodifica H.264 Annex B crudo con `optimizeForLatency`, sin contenedor.
- El render usa `requestAnimationFrame` con estrategia **latest-frame-wins**: si el decode va más rápido
  que el vsync, solo el cuadro más fresco llega al canvas (mínima latencia, sin acumulación).
- Descartadas:
  - *MSE/HLS*: requieren empaquetado fMP4 + latencia de buffer; pensado para streaming, no para monitoreo.
  - *WASM decoder*: CPU en el navegador, peor calidad/latencia.
  - *scrcpy-web clients existentes*: acoplados a su propia infraestructura (websockify/adb en el navegador).

### 3.5 Seguridad: token opt-in

- El bridge en LAN puede correr abierto (`SCREEN_AUTH_TOKEN` sin definir).
- Expuesto por túnel (producción), exige token en HTTP (`?token=` o `Authorization: Bearer`) y en el
  WebSocket, con comparación en tiempo constante. El token viaja horneado en la build de la web
  (`NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN`, variable *Sensitive* en Vercel).

---

## 4. Protocolo scrcpy-server v4.x (validado empíricamente)

Descifrado con capturas crudas del socket (11 MB / 709 paquetes / 0 anomalías) porque no hay
documentación accesible del framing interno:

1. `adb -s <serial> push scrcpy-server /data/local/tmp/sf_scrcpy_server.jar`
2. Listener TCP en la PC + `adb reverse localabstract:scrcpy tcp:<puerto>`
3. Spawn:
   `adb -s <serial> shell "CLASSPATH=/data/local/tmp/sf_scrcpy_server.jar app_process / com.genymobile.scrcpy.Server 4.1 log_level=info max_size=720 max_fps=30 video_bit_rate=2000000 video_codec=h264 video=true audio=false send_frame_meta=true control=false cleanup=false video_codec_options=repeat-previous-frame-after=33333,i-frame-interval=2"`
4. Por el socket llega:
   - `64B` nombre del dispositivo (se descarta) + `4B` códec ASCII (`h264`) + `12B` metadata
     (u32 flags=0x80000000, u32 width, u32 height)
   - luego paquetes `[header 12B][payload]` donde **header bytes 8..11 = u32 BE longitud** y
     payload = H.264 **Annex B** (start codes `00 00 00 01`).
5. El bridge clasifica los NAL (`classifyAnnexB`): SPS(7)/PPS(8) sueltos se retienen en `pendingConfig`
   y se **anteponen a CADA IDR (5)** — ver §7.5, el bug más sutil de todo el proyecto.

**Lección crítica del protocolo**: los IDRs de un encoder recién respawned pueden llegar *sin* SPS/PPS
in-band. Todo cliente WebCodecs configurado sin `description` los necesita pegados a cada keyframe.
El bridge los retiene para siempre y los antepone siempre (nunca los borra tras el primer uso).

---

## 5. Decisiones de diseño del bridge (`server.mjs`)

1. **Opt-in estricto**: no existe proceso scrcpy hasta que un cliente WS pide ese serial; sin
   espectadores N segundos, el capturador se mata (`stop (sin espectadores)`).
2. **GOP cache con replay**: se cachea el GOP completo (techo 120 frames, ~4 s). Todo cliente nuevo
   recibe header + replay del cache → imagen al instante sin esperar el próximo IDR.
3. **SPS/PPS anteponidos a cada IDR** (en vivo y en el cache): cualquier cliente puede empezar a
   decodificar en cualquier keyframe. Esta decisión nació de un bug en producción (§7.5).
4. **Watchdog de dos capas** (tick 2 s):
   - stream activo (>50 frames) sin frames nuevos en 2 ticks → respawn silencioso;
   - >30 s sin UN byte con espectadores → respawn silencioso.
   Antes era 3 ticks × 2.5 s (7.5 s): cada segundo de detección es un segundo de imagen trabada.
5. **Auto-recuperación con backoff + jitter**: reintento indefinido mientras haya espectadores,
   delay `min(3000·fallos, 15000) · (0.75+rand·0.5)` (jitter ±25 % para desfasar N dispositivos).
   El tope duro de 50 reintentos se eliminó: dejaba la vista muerta para siempre con el WS abierto.
6. **Backpressure por cliente**: `WS_SOFT_LIMIT=2MB` (descarta deltas de ese cliente hasta el próximo
   IDR) y `WS_HARD_LIMIT=8MB` (terminate del cliente muerto). Un cliente lento no afecta a los demás.
7. **`fail()` no re-entrante + flag `tearingDown` + token de generación (`gen`)**: un incidente cuenta
   UN fallo; los cierres derivados del teardown no son fallas; los `start()` en vuelo se invalidan.
8. **Fallos recuperables = silenciosos**: solo el desincronizado de protocolo notifica error al
   navegador; todo lo demás entra al ciclo de recuperación avisando `{type:"waiting"}`.
9. **Recuperación rápida**: entre reintentos se conserva el listener TCP + `adb reverse` y se omite el
   push del jar si ya está en el teléfono con tamaño correcto. Corte típico: de ~18 s a ~2-4 s.
10. **Auth opt-in por token** (§3.5).

---

## 6. Decisiones de diseño del frontend (`fleet-live-view.tsx`)

1. **Un `DeviceLiveView` por dispositivo**: WS + decoder + rAF + interval de stats propios (sin estado
   compartido entre vistas).
2. **Auto-reconexión con backoff exponencial** (500 ms → 5 s, reset tras 30 s estable): `onclose`/
   `onerror` no intencionales reconectan solos; el bridge re-envía el GOP cache al volver.
3. **Watchdog de datos**: sin mensajes >8 s (socket half-open) → cierre deliberado → reconexión.
4. **Timeout de resync**: `resyncPending` sin output del decoder >4 s → reconexión (GOP fresco).
5. **Backpressure con gracia**: no evalúa `decodeQueueSize` durante el replay del GOP cache; exige
   sobrecarga sostenida (2 lecturas o >300 ms) antes de descartar deltas; al armar resync hace
   `decoder.reset()` inmediato.
6. **Decay de errores**: `decodeErrors` vuelve a 0 cada 60 frames sanos (sesiones largas no acumulan).
7. **`{type:"waiting"}`** del bridge → estado "Recuperando…" (spinner) sin cortar socket ni decoder.
8. **La vista no se desmonta por flaps** del polling de `connection_status` (solo depende de `liveActive`).
9. **Botón ⟳ de reconexión forzada**: escape manual del operador, sin esperar backoff.
10. **Instrumentación `data-*`** en `.cc-live-panel`: `data-phase`, `data-resync-count`,
    `data-decode-errors`, `data-last-msg-age-ms`, `data-queue-size` — actualizados cada 1 s; permiten
    diagnóstico automatizado sin abrir DevTools.

---

## 7. Bugs encontrados en producción y sus causas raíz (bitácora)

Ordenados por gravedad. Todos verificados con evidencia (logs, sondas crudas, reproducción controlada).

### 7.1 La recuperación cancelada (`fail()` re-entrante)
- **Síntoma**: con video real, cortes de ~2 s se convertían en freezes de minutos.
- **Causa**: el watchdog llamaba `fail(silencioso)` → `teardownProc()` → los handlers `close` del
  socket/proceso disparaban `fail()` OTRA VEZ con notificación → el navegador recibía errores
  fantasma, cerraba su WS → `clients=0` → la auto-recuperación se cancelaba ("sin espectadores").
- **Fix**: guard `status==="error"` en `fail()`, flag `tearingDown`, identidad por-intento.

### 7.2 Muerte permanente tras 50 fallos
- Por el triple conteo de 7.1, el tope se alcanzaba en ~17 incidentes: WS abierto + último frame
  congelado + nadie reintenta. Fix: reintentos indefinidos (backoff capado 15 s) + jitter.

### 7.3 Backpressure del navegador mal calibrada
- El replay del GOP cache al conectar superaba `decodeQueueSize>=5` instantáneamente con video real →
  descarte de deltas hasta el próximo IDR → freeze de segundos en cada conexión.
- Fix: gracia inicial + sobrecarga sostenida + `reset()` inmediato al armar resync.

### 7.4 Navegador sin reconexión ni watchdog
- Socket half-open = canvas congelado con badge EN VIVO para siempre. Fix: reconexión automática +
  watchdog de 8 s + timeout de resync (§6.2-6.4).

### 7.5 **SPS/PPS solo en el primer IDR — el bug más sutil (causa del "Conectando" eterno)**
- **Síntoma**: tras un respawn del capturador, toda vista que reconectara (o se abriera nueva) quedaba
  en "Conectando…" para siempre, sin error; los clientes ya calentados seguían viendo video perfecto.
- **Causa**: el codificador emite SPS/PPS una sola vez por sesión. El bridge los pegaba al primer IDR
  y **borraba** `pendingConfig`. Todos los keyframes siguientes salían sin parameter sets. Un decoder
  WebCodecs sin `description` los necesita in-band: espera eterna, silenciosa, sin contador de errores.
- **Detección**: sonda WS cruda en Node contando NAL types (5/7/8) por chunk — los IDR llegaban `[5,5]`,
  sin 7/8. El canvas del navegador medía 316×720 (pintó una vez) pero `data-phase="connecting"` con
  datos fluyendo: decodificador sin inicializar.
- **Fix**: `pendingConfig` se retiene y se antepone a TODOS los IDR (§4.5). Verificado: IDR llega
  `[SPS,SPS,PPS,PPS,IDR]`, 3/3; cliente fresco a mitad de sesión → EN VIVO en 5 s.

### 7.6 Supervisor que muere en silencio
- `$ErrorActionPreference=Stop` + `Move-Item` sobre un log abierto = supervisor muerto → tarea en
  "Ready" sin nadie reintantando. Fix: try/catch por iteración ("supervisor inmortal") y pre-loop
  protegido con log de inicialización.

---

## 8. Despliegue productivo (cómo quedó montado)

| Componente | Detalle |
|---|---|
| Bridge | `C:\ProgramData\SouthFarm\screen-bridge\` (runtime copiado, desacoplado de checkouts). Corre como proceso del usuario con **supervisor inmortal** + auto-arranque al login (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\iniciar-screen-bridge.cmd`). Puerto 8100, bitrate 2M, maxSize 720. |
| Token | `C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json` (ACL SYSTEM/Admins). Mismo token como variable Sensitive en Vercel. |
| Túnel fijo | `screen.southfarm.tech` → `127.0.0.1:8100`, ingress agregado al config del túnel productivo (`d93e5fe4-24b6-4141-9047-5dbc4c004187`, el mismo de `api.southfarm.tech`). CNAME creado en el dashboard de Cloudflare. |
| Web | Vercel (`southfarm-webapp`), rama `main`. Envs de producción: `NEXT_PUBLIC_API_URL=https://api.southfarm.tech`, `NEXT_PUBLIC_SCREEN_BRIDGE_URL=https://screen.southfarm.tech`, `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN=<token>`. |
| Teléfonos | 4 por USB con nombres reales (02, 07, 08, 09) en `C:\ProgramData\SouthFarm\screen-bridge\devices.json`. |
| Tarea SYSTEM legado | "SouthFarm Screen Bridge" registrada pero **deshabilitada** (quedó en investigación: en contexto SYSTEM el supervisor no arrancaba; la vía usuario-login es estable). |

**Comandos productivos** (todos en `ops/windows/`):
- `install-southfarm-screen-bridge-task.ps1` — instalador completo (runtime + token + tarea).
- `southfarm-screen-bridge-supervisor.ps1` — supervisor inmortal.
- `add-screen-bridge-tunnel-ingress.ps1` — agrega hostname al túnel productivo.

---

## 9. Runbook de operaciones

### Agregar un teléfono nuevo
1. Conectar por **cable de datos** USB a la PC.
2. Aceptar "Permitir depuración USB" en el teléfono (marcando "siempre").
3. `adb devices` → copiar el serial nuevo.
4. Agregar a `C:\ProgramData\SouthFarm\screen-bridge\devices.json`:
   `"<serial>": "<nombre-del-teléfono>"` (recargá la página; no se reinicia nada).
5. "Ver pantalla" en su tarjeta → transmite.

### Renombrar un teléfono
- Cambiar el alias **en la web** (✎) o en `devices.json` — cualquiera de las dos; sincronizar la otra
  si querés mantener auto-conexión. **Nunca corta una transmisión activa**: el alias solo se usa al
  abrir vistas nuevas.

### Síntomas → diagnóstico (tabla de decisión)

| Síntoma | Mirar primero | Causa probable |
|---|---|---|
| "Conectando…" eterno | `data-last-msg-age-ms` del panel | si es bajo (<1000): decoder sin SPS/PPS o sin keyframes → revisar §7.5; si crece: socket muerto → reconexión automática |
| "Recuperando…" unos segundos y vuelve | log del bridge (`auto-reintento #N`) | micro-corte de transporte; **funcionamiento normal** |
| "Sin señal" + botón Reintentar | mensaje del error | error fatal real (protocolo/red) |
| Tarjeta Offline pero transmite | `last_seen_at` del dispositivo en la DB | la **app** del teléfono no late (abrir la app) — independiente del streaming |
| fps bajos con todos transmitiendo | transporte de cada teléfono | contención WiFi → pasar a USB |

### Herramientas de diagnóstico
- **Salud del bridge**: `curl "http://localhost:8100/api/health?token=<token>"` → fps y clientes por stream.
- **Sonda WS cruda** (la que encontró el bug de SPS/PPS): cliente Node que conecta, cuenta chunks y
  clasifica NAL types por chunk (5=IDR, 7=SPS, 8=PPS). Si los IDR no traen 7/8 pegados, hay bug.
- **`stress3.mjs`** (`C:\Users\josu_\sf_shots\`): 3 streams simultáneos 120 s; criterio de calidad:
  avg >15 fps y peor silencio <15 s (por USB medimos 9.8-12 s; con pantalla quieta, <2.5 s).
- **Captura de pantalla del teléfono**: `adb -s <serial> exec-out screencap -p > out.png`.
- **Identificar qué teléfono físico es qué serial**: captura de pantalla por serial y comparación visual.
- **Logs productivos**: `C:\ProgramData\SouthFarm\logs\screen-bridge.{out,error}.log` (UTF-16, rotan a 10 MB).

---

## 10. Limitaciones conocidas y roadmap

1. **Bridge depende de la sesión logueada** (auto-arranque por Startup folder). La tarea SYSTEM quedó
   deshabilitada: en ese contexto el supervisor no arrancaba y quedó sin diagnosticar (requiere admin
   + `LastTaskResult` de la tarea). Si algún día se quiere 24/7 sin login, retomar desde ahí.
2. **Pestañas en segundo plano**: Chrome pausa el rAF → el canvas muestra el último cuadro y la fase
   lee "Conectando…" aunque los datos fluyan. Al volver a la pestaña, retoma solo (verificado). Mejora
   futura: pintar por timer cuando `document.hidden` o mostrar estado honesto "pausado".
3. **Calidad 2M/720p**: elegida para WiFi. Con toda la flota por USB se puede volver a **4M/1024**
   (`SCREEN_VIDEO_BITRATE`, `SCREEN_MAX_SIZE` en el arranque del servicio).
4. **Escala a 10 teléfonos**: requiere **hub USB alimentado multi-TT** con puertos de datos (ver
   recomendación de compra en la conversación del 2026-08-24) + cables USB-C de datos.
5. **Tareas SYSTEM "SouthFarm ADB WiFi Keepalive"**: re-conecta los seriales WiFi automáticamente;
   conviene saber que existe cuando un teléfono "vuelve solo" al WiFi ADB.
6. **Futuro probable**: control táctil remoto (scrcpy lo permite con `control=true`), thumbnails MJPEG
   para el grid con 10+ vistas, y que la app mobile reporte su IP/serial para auto-mapear device↔teléfono.

---

## 11. Cómo replicar el sistema desde cero (checklist)

1. PC Windows con `adb` (platform-tools) y `scrcpy-server` v4.1 accesibles.
2. Node 22+ (para el bridge alcanza cualquier Node moderno con `ws`).
3. `screen-bridge/`: `npm install` (trae `ws`), configurar `devices.json` con los seriales.
4. Variables: `SCREEN_AUTH_TOKEN`, `SCREEN_VIDEO_BITRATE`, `SCREEN_MAX_SIZE`, `SCREEN_ADB`,
   `SCREEN_SCRCPY_JAR`, `SCREEN_BRIDGE_PORT`.
5. Webapp: variables `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SCREEN_BRIDGE_URL`,
   `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN` **antes del build** (se hornean).
6. Teléfonos: depuración USB activada + aceptar la huella RSA; conectar por cable.
7. Verificar: `/api/health`, `/api/devices`, abrir una vista, y correr la sonda de NAL types
   (§9) para confirmar que los IDRs traen SPS/PPS pegados.
8. Producción: túnel fijo con hostname dedicado + CNAME → `<tunnel-id>.cfargotunnel.com`, token en
   Vercel como Sensitive, servicio/auto-arranque del bridge.

---

## 12. Commits relevantes (rama `master` / webapp `main`, agosto 2026)

| Commit | Contenido |
|---|---|
| `b3dc6b0` | Recuperación automática robusta (fail re-entrante, reintentos indefinidos, túnel persistente) |
| `3dee532` | Auth por token opcional |
| `f57343c` | Detección de stall en 4 s |
| `bf54b0b` | **SPS/PPS a todos los IDR (causa raíz del "Conectando" eterno)** |
| `e07824a` | Runtime productivo (servicio + supervisor + túnel) |
| `bf8d22a`/`3ce923f`/`661a0f8` | Fixes del instalador y supervisor |
| `097d1db` | Mapeo dev a USB |
| webapp `d195320` | Merge de la feature a main |
| webapp `63ea862`/`7c3cc7c` | Botón ⟳ + estilo |
| webapp `13932c6` | Redeploy con envs |
