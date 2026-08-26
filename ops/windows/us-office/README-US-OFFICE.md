# Oficina EEUU — Runbook de configuración

Guía para dejar andando la segunda oficina de SouthFarm: una PC Windows con 3
celulares Android conectados por USB que se sincronizan a la flota, transmiten
pantalla y se administran con ADB a distancia.

**Regla de oro**: todo lo que requiera pensar o decidir ya está hecho. En EEUU
solo hay que ejecutar cosas y verificar. Tiempo total estimado: ~2 horas.

---

## Fase 0 — Preparado desde la oficina AR (ya hecho)

- [x] Web soporta `bridge_url` por workspace (deploy en Vercel).
- [x] Backend con columna + endpoint (`PATCH /api/team/workspace`) publicado.
- [x] Kit de instalación armado (este ZIP).
- [ ] Workspaces "EEUU" creados (cuentas a definir por el dueño).
- [ ] Configurar `Bridge URL = https://screen-us.southfarm.tech` en Settings
  de cada workspace EEUU (desde la web, sección Settings → LIVE VIEW).

## Qué contiene el kit

| Archivo | Para qué |
|---|---|
| `install-southfarm-us-office.ps1` | Instalador one-shot (toolchain + bridge + túnel + Windows) |
| `southfarm-screen-bridge-supervisor.ps1` | Supervisor inmortal del bridge |
| `screen-bridge/` | Código del bridge con su dependencia `ws` incluida |

Lo único que descarga el instalador solo, de URLs oficiales: adb, Node 22,
scrcpy-server v4.1 y cloudflared.

## Datos que necesitás a mano antes de empezar

1. **AuthToken**: el mismo token del bridge de la oficina AR. Se lee así en la PC AR:
   ```powershell
   type C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json
   ```
   (campo `auth_token`). También está en Vercel como `NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN`.
2. **CloudflaredToken**: crear el túnel en Cloudflare Zero Trust → Networks →
   Tunnels → Create tunnel (nombre sugerido: `southfarm-us`) → copiar el token
   que ofrece la ventana "Install connector". El hostname/CNAME se hace aparte.

## Fase 1 — Dejar la PC controlable (~30 min, con el amigo)

1. Renombrar la PC (ej. `SOUTHFARM-US`) y traer Windows Update al día.
2. Instalar **Tailscale** y loguear la máquina al tailnet (auth key generada en AR).
3. Habilitar **Escritorio remoto** (el instalador también lo hace después).
4. Crear el usuario con contraseña conocida.

✅ Desde acá se toma control con RDP vía Tailscale y el deja de ser necesario.

## Fase 2 — Ejecutar el instalador (~20 min, ya a distancia)

Copiar el ZIP descomprimido a la PC EEUU (ej. `C:\Users\<user>\Downloads\southfarm-us-kit\`)
y en PowerShell **como Administrador**, parado en esa carpeta:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-southfarm-us-office.ps1 -AuthToken "<EL_TOKEN>" -CloudflaredToken "<EL_TOKEN_DEL_TUNNEL>"
```

El script: descarga toolchain, instala el bridge con auto-arranque al login,
levanta cloudflared como servicio, deshabilita suspensión y habilita RDP.

**Pendiente manual que el propio script recuerda**: `netplwiz` → destildar
"Los usuarios deben escribir su nombre y contraseña". CRÍTICO: sin auto-login,
un reinicio remoto deja el bridge caído hasta que alguien abra sesión.

Luego, en el dashboard de Cloudflare: Public Hostname del túnel nuevo →
`screen-us.southfarm.tech` → `http://127.0.0.1:8100`, y crear el CNAME
`<tunnel-id>.cfargotunnel.com` si el dashboard no lo crea solo.

**Verificación**: desde cualquier PC:
```powershell
curl.exe "https://screen-us.southfarm.tech/api/health?token=<EL_TOKEN>"
```

## Fase 3 — Celulares (~10 min cada uno)

1. Hub USB **alimentado** con cables de datos; conectar los 3 teléfonos.
2. En cada teléfono: activar opciones de desarrollador + depuración USB,
   aceptar la huella RSA marcando "siempre".
3. Ver seriales: `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe devices`
4. Registrarlos en `C:\ProgramData\SouthFarm\screen-bridge\devices.json`
   (se relee en cada request, no hay que reiniciar nada):
   ```json
   { "863d...": "US01", "863d...": "CLIENTE01" }
   ```
5. Instalar la app:
   ```powershell
   Invoke-WebRequest "https://southfarm-webapp.vercel.app/southfarm.apk" -OutFile southfarm.apk
   adb install -r southfarm.apk
   ```
6. Abrir la app → escanear el QR del workspace EEUU correspondiente (generado
   en la web: Fleet → Vincular celular) → habilitar el **servicio de
   accesibilidad** de SouthFarm → desactivar optimización de batería →
   dejar enchufado.
7. Repetir QR/registro según corresponda en el otro workspace (los 3 celulares
   pueden compartir la misma PC y el mismo túnel sin problema).

## Fase 4 — Verificación final

- Los 3 aparecen **online** en la web (heartbeat ~90 s) en sus workspaces.
- "Ver pantalla" transmite en los 3 al mismo tiempo.
- Lanzar un warmup y verlo ejecutarse.
- **Reiniciar la PC completa** y verificar que bridge, túnel y celulares
  vuelven solos (prueba del auto-login + Startup).

## Después (no urgente)

- Publisher worker si esos celulares van a publicar contenido.
- ADB WiFi como backup: activar "Depuración por WiFi" en cada teléfono y
  conectarlos desde la oficina AR vía Tailscale (`adb connect <ip-tailscale>:5555`).
- Subir bitrate a 4M/1024 (`-Bitrate 4000000 -MaxSize 1024`) si el USB va fluido.

## Diagnóstico rápido

| Síntoma | Mirar |
|---|---|
| Bridge no responde local | Logs en `C:\ProgramData\SouthFarm\logs\screen-bridge.*.log` |
| Health local OK pero web no llega | Servicio cloudflared: `Get-Service cloudflared` / CNAME / hostname del túnel |
| Teléfono online pero sin video | `devices.json` tiene el serial correcto; probar "Ver pantalla" otra vez |
| Todo caído tras reinicio | Auto-login configurado? Sesión abierta? Startup cmd existe? |
