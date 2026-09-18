# SouthFarm Screen Bridge

Espeja en vivo la pantalla de los teléfonos Android de la flota (conectados por ADB WiFi) y la sirve por WebSocket para la **vista en vivo de Device Fleet** en la webapp.

## Cómo funciona

```
Navegador (WebCodecs H.264 → canvas)
   ↑ WebSocket ws://host:8100/ws/stream/<serial>
screen-bridge (este servicio, Node)
   ↑ socket local + adb reverse
scrcpy-server v4.1 (corriendo EN el teléfono, lanzado vía app_process)
   ↑ MediaCodec H.264 del propio Android
pantalla del teléfono
```

- **No toca la app mobile** ni requiere nada instalado en el teléfono: usa el binario `scrcpy-server` que viene con scrcpy 4.x.
- Protocolo verificado contra scrcpy v4.1: handshake `[64B nombre][4B códec][12B metadata w/h]` y luego paquetes `[header 12B][payload Annex B]` con longitud big-endian en los bytes 8–11 del header.
- El bridge pega SPS/PPS al primer keyframe y cachea la última GOP: quien abre la vista a mitad del stream ve imagen al instante.
- **100% opt-in**: no hay ningún proceso ni conexión ADB hasta que un operador abre una vista en la web. Sin espectadores por 3s, el stream se corta solo.

## Uso

```bash
cd screen-bridge
npm install
npm start          # escucha en http://localhost:8100
```

Variables de entorno opcionales:

| Variable | Default | Descripción |
|---|---|---|
| `SCREEN_BRIDGE_PORT` | `8100` | Puerto HTTP/WS |
| `SCREEN_ADB` | adb del toolchain | Binario adb a usar |
| `SCREEN_SCRCPY_JAR` | ruta winget scrcpy 4.1 | Binario scrcpy-server |
| `SCREEN_MAX_FPS` | `30` | Techo de fps del encoder del teléfono |
| `SCREEN_MAX_SIZE` | `1024` | Lado mayor de la captura (px) |
| `SCREEN_VIDEO_BITRATE` | `4000000` | Bitrate de video en bits/s (subilo si tu red WiFi lo banca) |
| `SCREEN_CODEC_OPTIONS` | `repeat-previous-frame-after=33333,i-frame-interval=2` | Opciones MediaCodec (fps estable en pantalla estática + GOP corto) |
| `SCREEN_DEBUG_RAW` | — | Si está seteado, vuelca bytes crudos del protocolo |

## Endpoints

- `GET /api/health` → `{ok:true, activeStreams}` (para el check de la web).
- `GET /api/devices` → `{devices:[{serial, alias, model, online}]}` desde `adb devices`.
- `WS /ws/stream/<serial>` → primer mensaje TEXTO `{codec:"h264", width, height}`, luego BINARIOS H.264 Annex B.

## Aliases

`devices.json` mapea serial ADB → alias visible en la web. Se re-lee en cada request: editar el archivo no requiere reiniciar. Ejemplo:

```json
{ "aliasBySerial": { "192.168.0.21:5555": "02" } }
```

En la web, si el alias del bridge coincide con el alias del dispositivo en Device Fleet, la vista se conecta sola; si no, aparece un selector manual de seriales.

## Requisitos

- Windows con `adb` (platform-tools) y dispositivos autorizados (`adb devices` debe listarlos como `device`).
- scrcpy 4.x instalado (se usa su `scrcpy-server`; probado con 4.1 sobre Android 15 / HyperOS).
- Node.js 18+.
