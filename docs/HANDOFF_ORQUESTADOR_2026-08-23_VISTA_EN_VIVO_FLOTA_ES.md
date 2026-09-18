# HANDOFF — Vista en vivo de Device Fleet (screen streaming) — 2026-08-23

> **Para:** próximo agente/orquestador.
> **Desde:** sesión del orquestador que construyó la feature completa y dejó UN problema abierto (freezes bajo carga real de video).
> **Regla de oro de este repo:** cada versión funcional que el dueño pueda probar → commit inmediato (`AGENTS.md`). Nunca dejar trabajo solo en el working tree. `webapp/` es repo git anidado y requiere commit separado.

---

## 1. Qué se pidió y dónde está la feature

El dueño quiere **ver en tiempo real la pantalla de los teléfonos Android** desde la sección **Device Fleet** de la web SouthFarm, para monitorear las tareas lanzadas. Debe ser **opcional (opt-in)** por dispositivo. Escala objetivo: **10 teléfonos simultáneos**. Debe funcionar con teléfonos por **ADB WiFi o USB**.

Estado actual: **feature completa y funcional** (vista opt-in, multi-vista, USB+WiFi, auto-recuperación) pero con **un problema ABIERTO**: con varios teléfonos reproduciendo video en redes sociales, las pantallas se congelan a los pocos segundos. Detalle completo en §7.

## 2. Arquitectura implementada

```
Navegador Chrome (WebCodecs H.264 Annex B → canvas)
   ↑ WebSocket  ws://localhost:8100/ws/stream/<serial-ADB>
screen-bridge/ (Node ESM puro, única dependencia 'ws')  ← C:\SouthFarm\source\.worktrees\visualize-phone\screen-bridge\
   ↑ socket TCP local + `adb reverse localabstract:scrcpy tcp:<puerto>`
scrcpy-server v4.1 corriendo DENTRO del teléfono (lanzado vía app_process; jar pusheado a /data/local/tmp/sf_scrcpy_server.jar)
```

**NO se modificó la app mobile** (cero riesgo de producción). El bridge lanza el server de scrcpy por cuenta propia.

### Protocolo scrcpy-server v4.x (descifrado empíricamente, validado con captura de 11MB / 709 paquetes sin anomalías)
1. `adb -s SERIAL push scrcpy-server /data/local/tmp/sf_scrcpy_server.jar`
2. Listener TCP en la PC + `adb -s SERIAL reverse localabstract:scrcpy tcp:<puerto>` (**en v4 el server conecta HACIA la PC**; con `adb forward` falla con "Connection refused").
3. Spawn: `adb -s SERIAL shell "CLASSPATH=/data/local/tmp/sf_scrcpy_server.jar app_process / com.genymobile.scrcpy.Server 4.1 log_level=info max_size=1024 max_fps=30 video_bit_rate=4000000 video_codec=h264 video=true audio=false send_frame_meta=true control=false cleanup=false video_codec_options=repeat-previous-frame-after=33333,i-frame-interval=2"`
4. Por el socket llega: `[64B nombre dispositivo][4B códec ASCII "h264"][12B metadata: u32 flags=0x80000000, u32 width, u32 height]` y luego paquetes `[header 12B][payload]` donde header bytes 8..11 = **u32 BE longitud** y payload = H.264 **Annex B**. Sin dummy byte inicial. Un solo socket (control=false).
5. El bridge pega SPS/PPS sueltos al siguiente keyframe y cachea el GOP completo para replay instantáneo a quien se conecte a mitad.
6. Navegador: WebCodecs `VideoDecoder` con `optimizeForLatency`, sin `description` (implícito annexb), render "latest-frame-wins" vía rAF con ctx `{alpha:false, desynchronized:true}`, backpressure por `decodeQueueSize>=5` (descarta deltas hasta IDR + `reset()`), auto-rearme ante DecodeError.

### Archivos de la feature
- Bridge: `screen-bridge/server.mjs` (+ `devices.json` aliases serial→alias, se re-lee sin reiniciar; `.gitignore`; `README.md`).
- Webapp (repo anidado): `src/app/fleet-live-view.tsx` (hook + DeviceLiveView + LiveViewToggle), `src/app/fleet-live-view.test.tsx` (vitest, 5 tests), integración en `src/app/page.tsx` (FleetPage mantiene array `liveDeviceIds` → **multi-vista simultánea**; botón "Ver pantalla" solo si device online) y estilos `.cc-live-*` en `src/app/globals.css`.
- Constante web: `SCREEN_BRIDGE_URL = process.env.NEXT_PUBLIC_SCREEN_BRIDGE_URL || "http://localhost:8100"` en `page.tsx`.

## 3. Entorno de ESTA PC (crítico)

- Windows, Git Bash. **ADB del sistema:** `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe`. scrcpy 4.1 instalado por winget: `C:\Users\josu_\AppData\Local\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1\scrcpy.exe` (su carpeta contiene el binario `scrcpy-server` v4.1 que usa el bridge).
- Node 26 en shell; **backend de producción corre con runtime dedicado Node 22**: `C:\Users\josu_\AppData\Local\SouthFarm\node-v22.23.1-win-x64\node.exe dist/index.js` (ts-node dev NO anda con Node 26: usar `dist` compilado). JWT tiene secret default dev.
- **Teléfonos físicos conectados por ADB WiFi** (Xiaomi POCO 25028PC03G, Android 15): hoy visibles `.21`, `.32`, `.36` (= aliases del bridge cam-21/cam-32/cam-36 en `devices.json`). El dueño llama a sus teléfonos "02,07,08,09" — mapeo físico→IP SIN confirmar. **Evitar perturbar el teléfono "08"** (otro agente lo usaba; no inyectar input). Los launchers tienen "gogo.launcher" que **BLOQUEA inyección de `input swipe/tap` por ADB** (exit 0 pero sin efecto); para generar contenido usar `am start -a android.settings.SETTINGS` (funciona) o video real.
- Puertos ocupados por otros servicios/agentes: 3000/3006 (webs), 3101/3102 (backends reales). **Usados por esta feature: bridge 8100, backend aislado 3110, webapp dev 3010.**
- Backend aislado de prueba: `cd C:\SouthFarm\source\backend && PORT=3110 SOUTHFARM_DB_PATH='C:\Users\josu_\sf_shots\sf_e2e.db' SOUTHFARM_DEVICE_ONLINE_WINDOW_SECONDS=7200 SOUTHFARM_PUBLICATION_MEDIA_ROOT='C:\Users\josu_\sf_shots\publish-media' "C:/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64/node.exe" dist/index.js`
  - Usuario de prueba: `e2e@southfarm.local` / `southfarm123` (owner, workspace propio).
  - Dispositivos virtuales creados por pairing+claim: `e2e-cam21/32/36` con alias `cam-21/32/36` (matchean los aliases del bridge ⇒ auto-resolución de serial en la UI).
  - **Los devices aparecen Offline cuando `last_seen_at` envejece** → refrescar directo en sqlite: `UPDATE devices SET last_seen_at=datetime('now')...` (script python usado; ver §6).
- Webapp dev: `cd ...\webapp && NEXT_PUBLIC_API_URL=http://localhost:3110 NEXT_PUBLIC_SCREEN_BRIDGE_URL=http://localhost:8100 npx next dev -p 3010`

## 4. Git / repos / ramas

- Repo padre: `C:\SouthFarm\source` → remote GitHub `https://github.com/josuelorenzo-mkt/southfarm-landing.git` (usuario ya logueado). Rama de la feature: **`feature/device-fleet-live-view`**, trabajada en worktree `C:\SouthFarm\source\.worktrees\visualize-phone` (¡esta feature NO debe pisar master ni las ramas de otros agentes!). Base: b836c83.
- Commits del padre (todos pushed): `83123b9` feat bridge · `7d9cdca` perf 30fps/backpressure/GOP · `5f425f2` docs env vars · `ff46f98` USB+WiFi/multi-device/auto-recuperación · `03f44be` fix recuperación ante túneles colapsados · (último, pendiente de push si aplica) fix reintentos indefinidos + handoff.
- `webapp/` anidado: remote origin = **ruta local file:///C:/SouthFarm/source/webapp** (NO tiene GitHub). Rama `feature/device-fleet-live-view`: `7ce63e8` vista opt-in · `a14695d` perf latencia/WebCodecs · `7fa71de` multi-vista. Push va al local (queda disponible para el dueño/Vercel).
- Identidad git configurada LOCALMENTE en el clone del worktree: Josue Lorenzo <josuelorenzo.mkt@gmail.com>.
- Otros agentes trabajan sobre el MISMO repo padre: **no commitear archivos ajenos**, no tocar ramas ajenas, revisar `git status` antes de add (usar `git -C <path> add <archivos exactos>`).

## 5. Metodología de trabajo del orquestador (replicarla)

1. **Explorar primero con subagentes** (Agent tool): Explore para mapear código, researcher para tecnología. ⚠️ En esta sesión los subagentes especializados (*-flash/*-pro/researcher de CCGOAT) se cayeron por rate-limit del proveedor ("free-models-per-day-stealth") → **usar `general-purpose`**, que funciona con otro proveedor.
2. **Decidir arquitectura con evidencia**, no por fama: se eligió scrcpy-server directo porque los teléfonos ya estaban por ADB y evitaba tocar la app mobile.
3. **Descubrimiento empírico contra hardware real** cuando la doc no alcanza (el protocolo v4 no estaba documentado accesible): sondas Node crudas (scripts en `C:\Users\josu_\sf_shots\`).
4. **Subagente reviewer general-purpose** antes de dar por bueno un módulo crítico (produjo 4 P0 + P1 valiosos: GOP cache completo, backpressure doble umbral, zero-copy, rAF render, i-frame-interval).
5. **Verificación obligatoria pre-commit** en webapp: `npx tsc --noEmit` + `npx eslint <archivos>` + `npx vitest run src/app/fleet-live-view.test.tsx`. En bridge: `node --check server.mjs` + smoke WS real contra teléfono.
6. **Commits chicos y frecuentes** en español estilo convencional (`feat(screen-bridge): ...`), push a GitHub del padre al cerrar cada tanda.
7. **E2E visual con skill `browser-use:control-browser`** (IAB): login → fleet → toggles → screenshots como evidencia. Ojo: los conteos por texto suelto dan falsos positivos ("Actividad **en vivo**" matchea "EN VIVO"); usar selectores CSS exactos (`.cc-live-badge`) y scopes por `hasText: e2e-camXX`.

## 6. Herramientas/scripts ya construidos (reutilizar)

Todos en `C:\Users\josu_\sf_shots\` salvo indicación:
- `stress3.mjs` — 3 streams WS simultáneos 120s; reporta avg fps, **peor silencio entre chunks**, keyframes, errores (usa `createRequire` hacia screen-bridge/node_modules/ws).
- `motion3b.mjs`, `amstart3.mjs` — variantes con actividad forzada.
- `raw_capture.mjs` + `analyze.mjs` — captura cruda del socket scrcpy a `raw_stream.bin` y análisis forense del framing (validó 709 paquetes/0 anomalías).
- `recovery_test.mjs`, `recovery_test2.mjs` — cortan túnel / asesinan el capturador mid-stream y miden tiempo de recuperación automática (validado: 4.0s).
- `/tmp/ws_smoke.mjs` — smoke básico 1 stream (header JSON, primer keyframe, fps).
- Refresco de "online": `python -c "import sqlite3,time; db=sqlite3.connect(r'C:\Users\josu_\sf_shots\sf_e2e.db'); db.execute('UPDATE devices SET last_seen_at=?',(time.strftime('%Y-%m-%dT%H:%M:%S',time.gmtime())+'.000Z',)); db.commit()"`
- Health del bridge: `curl http://localhost:8100/api/health` (incluye fps medido por stream). Log del bridge: `/tmp/sf_bridge.log` (líneas `wd fps=... bytes=... bufLen=... clients=...` cada 2.5s por stream activo).

## 7. PROBLEMA ABIERTO: freezes con videos reales en los teléfonos

**Reporte del dueño (última prueba):** puso los 3 teléfonos reproduciendo video en redes sociales desde la web en Chrome → las pantallas del dashboard se traban a los pocos segundos. Antes también: "transmite bien unos segundos y se traba; tengo que salir y volver a entrar".

**Lo que YA se diagnosticó y arregló (no repetir):**
- Framing del protocolo: VALIDADO correcto (captura cruda 709 paquetes, 0 anomalías). No perder tiempo ahí.
- Watchdog anterior mataba streams por silencio en pantallas estáticas → corregido: ahora hay 2 capas (activo sin frames ~7.5s; y >30s sin ningún byte con espectadores) + reconexión silenciosa con backoff creciente (3s→15s, tope 50 reintentos) mientras haya espectadores.
- Recuperación mecánica validada: matando el capturador dentro del teléfono, el video vuelve solo en 4.0s sin cartel de error.
- Bitrate bajado 8M→4M default (8M×N colapsa WiFi). Tuning por env: `SCREEN_MAX_FPS` (30), `SCREEN_MAX_SIZE` (1024), `SCREEN_VIDEO_BITRATE` (4000000), `SCREEN_CODEC_OPTIONS`, `SCREEN_DEBUG_RAW` (hexdump crudo).

**Hipótesis priorizadas para el freeze restante (atacar EN ESTE ORDEN):**
1. **H1 — Discriminar capa culpable (30 min, hacer PRIMERO):** reproducir con 3 videos corriendo y mirar SIMULTÁNEAMENTE (a) `/tmp/sf_bridge.log` líneas `wd fps=` de cada stream y (b) `curl :8100/api/health` (fps por stream) y (c) el navegador. Si el bridge sigue midiendo fps sanos pero el canvas se congela ⇒ bug FRONTEND (decoder/rAF/WS); si el fps del bridge cae a 0 ⇒ transporte (túnel/WiFi/adbd). Hoy NO sabemos cuál de las dos es bajo carga de video real: todas mis validaciones fueron con pantallas semi-estáticas.
2. **H2 — Agotamiento de reintentos (ya mitigado, verificar en logs):** antes el puente abandonaba la fuente tras 5 fallos (coincidía con "tengo que salir y volver"). Ahora reintenta indefinido con backoff. Confirmar en log (`auto-reintento #N`) que recupera siempre; si ves `#40+` seguidos, el problema es que el túnel muere más rápido de lo que reconecta → bajar bitrate/fps (H3) o cambiar transporte.
3. **H3 — Capacidad WiFi:** cada teléfono reproduce video DESCARGÁNDOLO por su WiFi y a la vez SUBE 4Mbps del stream. Con N teléfonos satura el AP. Probar: (a) **USB** (pedirle al dueño conectar cables; el bridge ya soporta serial USB sin cambios), (b) bajar a `SCREEN_VIDEO_BITRATE=2000000 SCREEN_MAX_FPS=15 SCREEN_MAX_SIZE=720`, (c) router 5GHz / canal limpio.
4. **H4 — Probe activo de salud del túnel:** el socket muerto no emite close. Si H1 apunta a transporte y H3 no alcanza, agregar ping periódico bridge→teléfono (`adb -s X shell true` con timeout 2s cada 5s mientras haya stream; si falla/lento → fail+reconexión inmediata) o habilitar `control=true` y usar el socket de control como latido.
5. **H5 — Frontend:** si H1 señala navegador, revisar `fleet-live-view.tsx`: pausa de rAF en pestaña oculta, `decodeQueueSize` creciendo, o WS bufferedAmount del lado browser. Instrumentar con contadores en pantalla (fps ya existe; sumar decodeQueueSize y gap ms).

**Cómo validar un fix:** repetir EXACTAMENTE la prueba del dueño (videos en redes en los 3 teléfonos + Chrome) durante ≥5 minutos sin un solo freeze perceptible, Y `stress3.mjs` mostrando peorSilencio<15s en los tres. No dar por resuelto con menos.

## 8. Roadmap posterior al fix

- Correr bridge como servicio permanente de Windows (NSSM/Tarea programada) y definir despliegue real: la web productiva (Vercel) necesita alcanzar el bridge → `NEXT_PUBLIC_SCREEN_BRIDGE_URL` apuntando a IP LAN de esta PC o túnel (Cloudflare Tunnel ya está en su stack según "Browser → Cloudflare → Windows backend"). Evaluar auth simple del bridge (hoy LAN abierta, CORS *) si sale de la LAN.
- Merge de ambas ramas `feature/device-fleet-live-view` a main/master tras aprobación del dueño (recordar: dos repos).
- Mapeo definitivo alias físico (02/07/08/09) ↔ serial ADB en `devices.json`.
- Futuro probable: control táctil remoto (protocolo scrcpy lo permite; requiere `control=true` + mensajes de inyección), thumbnails MJPEG de baja tasa para el grid cuando haya 10+ dispositivos.
- La app mobile podría algún día reportar su propia IP/serial ADB al backend para auto-mapear device↔teléfono sin config manual.

## 9. Estado al momento de entregar (verificar al retomar)

- Servicios esperados corriendo: web `:3010` (next dev), bridge `:8100`, backend aislado `:3110`. Si faltan, comandos en §3.
- Última acción: fix de reintentos indefinidos aplicado y sanity-check OK (.32: 224 chunks/12s). Commit + push de ese fix y de este handoff: ver `git log` de la rama.
- El dueño prueba SIEMPRE en Chrome normal (WebCodecs requerido; Firefox no).
