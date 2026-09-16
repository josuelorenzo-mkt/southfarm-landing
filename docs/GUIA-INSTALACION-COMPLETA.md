# SouthFarm — Guía completa de instalación desde cero

**Workspace nuevo + computadora nueva + teléfono nuevo.**

Destinatario: cualquier agente o persona que necesite montar un workspace SouthFarm funcional en una máquina remota desde cero.

**Última actualización:** 2026-09-16

---

## Arquitectura de referencia

```
Navegador (cualquier lugar)
    │
    ▼ HTTPS
southfarm-webapp.vercel.app (Vercel)
    │
    ▼ Bearer JWT usuario
api.southfarm.tech (backend — hoy en la PC principal, migrando a nube)
    │
    ▼ Bearer sfb_ (bridge_token)
Screen Bridge en cada computadora remota (puerto 8100)
    │
    ▼ ADB USB (exclusivamente USB, nunca TCP/IP)
Teléfonos Android con app SouthFarm instalada
```

**Dos planos independientes:**
- **Control** (warmups, scans): teléfono ↔ API por internet. No necesita el bridge.
- **Video** (vista en vivo): bridge ↔ ADB ↔ teléfono. No necesita la app.

---

## Componentes del paquete

| Archivo/carpeta | Qué es | Obligatorio |
|---|---|---|
| `paquete/screen-bridge/server.mjs` | El bridge v0.2.0 (auth, tickets, capabilities, reconciliación) | ✅ |
| `paquete/screen-bridge/node_modules/` | Dependencias (ws 8.x) | ✅ |
| `paquete/screen-bridge/devices.example.json` | Ejemplo — el devices.json real es estado local | Referencia |
| `paquete/config/screen-bridge-runtime.example.json` | Config de ejemplo | Referencia |
| `paquete/scrcpy/scrcpy-server` | Capturador que se sube a los teléfonos | ✅ |
| `paquete/runtime/node-v22.23.1-win-x64/` | Node.js portable | ✅ |
| `paquete/apk/southfarm.apk` | App Android 1.1.12+69 | Para teléfonos |
| `paquete/ops/*.ps1` | Scripts de instalación/verificación | ✅ |
| `paquete/build-tools/35.0.0/` | Para verificar firmas APK (opcional) | No |
| `checksums.sha256` | Hashes de todos los archivos | ✅ |

**NO incluido (y por qué):**
- **platform-tools/ADB**: cada máquina debe usar su ADB canónico. En el config, `adb_path` apunta a la ruta local. Nunca iniciar un segundo daemon ADB desde otra copia.
- **Secretos**: auth_token se genera localmente, bridge_token se obtiene del panel.

---

## Requisitos previos de la máquina

- Windows 10/11 con sesión iniciada (el bridge corre al iniciar sesión, no como servicio SYSTEM).
- Node.js v22+ portable (incluido en el paquete) o instalado en el sistema.
- Puertos USB funcionales para los teléfonos.
- **Un ADB funcional** (el del sistema o instalado desde platform-tools). El config apunta a la ruta con `adb_path`.
- Conexión a internet (el bridge reporta al backend y los teléfonos hablan con el API).
- Si se necesita vista en vivo remota: túnel Cloudflare o IP accesible desde el navegador del operador.

---

## Flujo completo (orden obligatorio)

### FASE A — Preparar el workspace (web, 5 min)

1. Entrar a `southfarm-webapp.vercel.app`.
2. **Registrar usuario nuevo** → se crea un workspace nuevo automáticamente. El usuario es Owner.
3. El workspace empieza vacío y con **modo estricto: OFF** (correcto para empezar).

> **No tocar LFG FARM ni otros workspaces existentes.** El modo estricto es por workspace.

### FASE B — Instalar la app en el teléfono (10 min)

1. Transferir `southfarm.apk` al teléfono (USB, Drive, o QR de descarga del panel).
2. Instalar: el teléfono acepta actualizaciones de la misma firma (certificado SouthFarm continuo).
3. Abrir la app → login con el usuario del workspace nuevo.
4. Activar **accesibilidad** cuando la app lo pida (Settings → Accessibility → SouthFarm).
5. En la web del workspace: generar código de vinculación → cargarlo en la app.
6. El teléfono aparece **"Online"** en la flota.

> **Historial scoping (desde 1.1.12):** cada teléfono solo ve SU historial, no el del workspace completo. Las sesiones se atribuyen automáticamente al teléfono que las genera.

### FASE C — Instalar el bridge en la computadora (30 min)

#### C.1 — Transferir el paquete

Copiar la carpeta del paquete a la máquina (Drive, USB, RDP). La carpeta debe estar accesible para los scripts.

#### C.2 — Preflight (SIN tocar producción)

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\paquete\ops\validate-package.ps1 -PackageRoot <ruta_del_paquete>
```

Debe terminar en `PAQUETE VALIDO`. Si falla, cortar acá.

#### C.3 — Instalación staged (COMO ADMINISTRADOR)

```powershell
.\paquete\ops\install-staged.ps1 -PackageRoot <ruta_del_paquete>
```

Este script:
- Hace backup de todo lo que reemplaza.
- Copia server.mjs, supervisor, scrcpy-server a `C:\ProgramData\SouthFarm\`.
- **Nunca sobrescribe** `devices.json` ni la config existente.
- Registra el auto-arranque en el Startup.

#### C.4 — Configurar

```powershell
.\paquete\ops\migrate-runtime-config.ps1
```

Este script:
- Crea o migra `C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json`.
- Genera `auth_token` localmente (nunca se distribuye).
- Agrega claves faltantes con defaults seguros (`require_capability: false`).
- `bridge_token` queda vacío — se llena en el paso C.5 con el token del panel.

**Editar la config** para agregar el `bridge_token` (se obtiene en la FASE D):

```json
{
  "auth_token": "<generado automáticamente>",
  "port": 8100,
  "bitrate": 2000000,
  "max_size": 720,
  "allowed_origins": ["https://southfarm-webapp.vercel.app"],
  "backend_url": "https://api.southfarm.tech",
  "adb_path": "C:\\<ruta_adb_local>\\adb.exe",
  "bridge_token": "sfb_<token_del_panel>",
  "require_capability": false
}
```

> **`adb_path`**: apuntar al ADB canónico de la máquina. Si la máquina no tiene, instalar platform-tools y apuntar acá. Nunca usar copias alternativas de otro software.

#### C.5 — Arrancar el bridge

```powershell
# Ejecutar el .cmd del Startup (arranca el supervisor minimizado)
& "$([Environment]::GetFolderPath('Startup'))\iniciar-screen-bridge.cmd"
```

O arrancar el supervisor directamente:
```powershell
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\ProgramData\SouthFarm\config\ops\southfarm-screen-bridge-supervisor.ps1' -BridgePath 'C:\ProgramData\SouthFarm\screen-bridge' -NodePath '<ruta_node>' -RuntimeConfigPath 'C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json' -LogDirectory 'C:\ProgramData\SouthFarm\logs' -AdbPath '<ruta_adb>' -ScrcpyJarPath 'C:\ProgramData\SouthFarm\scrcpy\scrcpy-server' -Port 8100"
```

#### C.6 — Verificar

```powershell
# Puerto 8100 escuchando
netstat -ano | findstr :8100 | findstr LISTEN

# Health: 401 sin token, 200 con token
curl -s -o /dev/null -w "%{http_code}" http://localhost:8100/api/health
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer <auth_token>" http://localhost:8100/api/health

# Teléfonos conectados por USB
& "<ruta_adb>" devices
```

> **Todos los teléfonos deben estar en estado `device`.** Si aparecen `unauthorized`, aceptar la huella RSA en el teléfono.

### FASE D — Conectar el bridge con el workspace (web + config, 10 min)

1. En la web del workspace: **Settings → Computadoras de transmisión** → "Registrar bridge".
   - Nombre: ej. `US-OFFICE`
   - URL pública: la URL por la que el navegador alcanza el bridge (ver FASE E).
2. **Copiar el token `sfb_...`** (se muestra UNA vez).
3. En la config del bridge (`screen-bridge-runtime.json`), setear:
   ```json
   "bridge_token": "sfb_<el_token_copiado>"
   ```
4. Reiniciar el bridge (matar node → el supervisor lo relanza).
5. En ~45 segundos el bridge aparece **"Conectado"** en el panel con los seriales USB.

6. **Mapear serial → dispositivo**: en el panel, asignar cada serial USB al dispositivo correspondiente del workspace.

### FASE E — Acceso a la vista en vivo

El navegador necesita alcanzar el bridge. Opciones:

| Opción | Cuándo usarla | Setup |
|---|---|---|
| **localhost:8100** | El navegador está EN la misma máquina del bridge | Solo setear `bridge_url` del workspace |
| **IP LAN** | El navegador está en la misma red que el bridge | `bridge_url` = `http://<IP_LAN>:8100` |
| **IP Tailscale** | Ambas máquinas en la misma red Tailscale | `bridge_url` = `http://<IP_Tailscale>:8100` |
| **Túnel Cloudflare** | Acceso desde cualquier lugar | Crear túnel → `cloudflared service install <token>` → hostname → localhost:8100 |

> En todos los casos, el `auth_token` del bridge debe coincidir con el que el webapp envía (está en las env de Vercel como `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN`).

### FASE F — Validación del piloto

1. **Flota**: los teléfonos aparecen "Online" en el workspace.
2. **Warmup desde la web**: lanzar un warmup → el teléfono lo reclama y ejecuta → aparece en el historial (solo suyo).
3. **Vista en vivo**: abrir el stream del teléfono → el video fluye.
4. **Historial scoping**: verificar que el teléfono muestra solo SU historial.
5. **Reconciliador**: el bridge aparece "Conectado" en el panel sin alertas.

### FASE G — Modo estricto (opcional, después de validar todo)

1. En la config del bridge: `"require_capability": true`
2. En el panel: toggle **"Modo estricto: ON"**
3. Re-validar la vista en vivo.
4. **Reversión**: toggle OFF + `require_capability: false` + reiniciar.

---

## Vista en vivo — cómo funciona

En **modo normal**: el navegador pide un ticket al bridge (`POST /api/stream-ticket` con el auth_token global) y abre el WebSocket con ese ticket. El matching serial↔teléfono se hace por alias entre `devices.json` del bridge y el alias del dispositivo en el workspace.

En **modo estricto**: el navegador pide una sesión al backend (`POST /api/devices/:id/screen-session`), el backend valida usuario + enrolamiento + attachment y devuelve una URL firmada (capability HMAC de un solo uso, TTL 120s). El bridge valida la firma offline. **No hay matching por alias** — el serial viene del attachment mapping en la DB.

---

## El reconciliador (automático)

Cada 60 segundos el backend compara los tres planos y genera alertas:

| Alerta | Severidad | Causa | Auto-resolución |
|---|---|---|---|
| Conflicto de seriales | 🔴 crítica | Un dispositivo mapeado en 2+ bridges | No — manual |
| Bridge sin señal | 🟡 warn | Bridge no reporta > 5 min | Sí, al volver |
| Serial sin señal del bridge | ℹ️ info | Serial asignado no visto > 5 min | Sí, al volver |
| Actividad de revocado | 🔴 crítica | Dispositivo revocado con heartbeat | Sí, si cesa |
| Rechazos de autenticación | 🟡 warn | Bridge reporta fallos de auth | Sí, al reportar 0 |

Visible en: **Flota → banner arriba** (rojo si hay críticas). Botón "Descartar" por alerta.

---

## Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `adb devices` vacío | Drivers/cable/depuración USB | Instalar drivers, probar cable, activar depuración |
| `unauthorized` en adb | Huella RSA no aceptada | Aceptar en el teléfono |
| Bridge no arranca | `auth_token` vacío o config malformada | Verificar config, correr `--validate-config` |
| Vista en vivo: "No encontramos..." | Alias del bridge ≠ alias del workspace | Alinear devices.json o usar selección manual |
| Vista en vivo: 401 | auth_token no coincide entre web y bridge | Verificar `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN` en Vercel y `auth_token` en config |
| Bridge "Sin señal" en panel | `bridge_token` vacío o mal configurado | Cargar el sfb_ del panel en la config |
| Warmup no se reclama | API inaccesible desde el teléfono | Verificar conectividad a api.southfarm.tech |
| UAC se cancela solo | Nadie lo aprobó en 2 min | Re-lanzar; tener la pantalla visible |
| Teclado no llega por RDP | Foco del RDP perdido | Re-click en la ventana remota; usar clipboard si es largo |

---

## Aprendizajes de esta sesión (2026-09)

1. **Instalación staged con preflight**: nunca escribir en producción sin validar hashes y artefactos primero. `install-staged.ps1` hace backup + rollback automático.
2. **devices.json es estado local**: nunca sobrescribirlo al instalar. Usar `devices.example.json` como referencia.
3. **Elevación manglea ACLs**: los procesos elevados crean archivos de solo-admin. Corregir ACLs después de cada instalación elevada.
4. **scrcpy-server es un JAR (zip)**: no renombrar durante la transferencia. El hash debe verificarse.
5. **UAC auto-cancela en 2 min**: tener la pantalla remota visible y aprobar inmediatamente. El ZCode remoto lo re-lanza si se cancela.
6. **RDP clipboard sync**: puede ser flaky con comandos largos. Preferir `type` en trozos cortos o escribir archivos intermedios.
7. **RDP windows integration**: las ventanas remotas aparecen individualmente en Task View. Alt+Tab cicla entre locales Y remotas mezcladas.
8. **`bridge_url` = localhost es trampa**: significa "el navegador de quien mira". Para máquinas remotas usar IP LAN, Tailscale o túnel.
9. **alias matching**: en modo normal, el alias en `devices.json` del bridge debe coincidir con el alias del dispositivo en el workspace. En estricto no importa (el backend resuelve por attachment).
10. **scrcpy y wake**: el bridge nunca envía `KEYCODE_WAKEUP` ni gestos al teléfono. Un teléfono bloqueado transmite negro — es lo esperado.
11. **Watchdog conservador**: umbrales configurables (`SCREEN_WD_NET_STALL_MS`, `SCREEN_WD_STALL_TICKS`). Distingue pantalla estática de falla real de transporte.
12. **get-state antes de capturar**: el bridge verifica que el serial esté en estado `device` antes de hacer push/reverse. Un serial ausente no recibe comandos.

---

## Checklist rápido de instalación desde cero

```
[ ] Web: registrar usuario nuevo → workspace creado
[ ] Web: teléfono visible en flota "Online"
[ ] PC: paquete transferido + preflight validado
[ ] PC: install-staged ejecutado (backup + rollback disponibles)
[ ] PC: config migrada con bridge_token del panel
[ ] PC: bridge corriendo (puerto 8100 LISTEN)
[ ] PC: health 401/200 verificado
[ ] PC: ADB ve los teléfonos en estado device
[ ] Panel: bridge "Conectado" con seriales reportados
[ ] Panel: seriales asignados a dispositivos
[ ] Web: warmup lanzado y ejecutado por el teléfono
[ ] Web: vista en vivo funciona
[ ] Web: historial del teléfono muestra solo sus sesiones
[ ] (Opcional) Modo estricto ON + re-validación
```
