# AGENT-SETUP — Instrucciones para un agente de AI

Estás en la PC de la oficina EEUU de SouthFarm. Tu tarea: dejar esta computadora
operativa como estación de la flota (celulares Android por USB que se sincronizan,
transmiten pantalla y publican). El kit que tenés al lado contiene todo lo
necesario. Este documento es tu guía de ejecución.

**Reglas de oro:**
1. NO toques nada de la oficina Argentina. `api.southfarm.tech` es PRODUCCIÓN
   compartida: nunca hagas llamadas destructivas (DELETE/revokes) a la API.
2. Verificá cada fase antes de pasar a la siguiente (los checks te dicen si pasó).
3. Si un paso requiere un dato que no tenés (tokens, IDs), STOP → pedíselo al
   dueño. No inventes valores ni sigas con placeholders.
4. Los secretos se pasan por parámetro en la línea de comandos. Nunca los
   guardes en archivos fuera de las rutas de config del kit.

---

## Datos que te debe proveer el dueño ANTES de empezar

| Dato | Para qué | Quién lo tiene |
|---|---|---|
| `AuthToken` (token del bridge) | Instalador principal y verificación | Dueño: `type C:\ProgramData\SouthFarm\config\screen-bridge-runtime.json` en la PC AR |
| `CloudflaredToken` | Túnel Cloudflare | Dueño: dashboard Cloudflare, túnel `southfarm-us` |
| Usuario/contraseña de Windows local | Auto-login y RDP | Dueño |
| Código + access key de pairing (por teléfono) | Emparejar la app | Dueño: los genera en la web de cada perfil |
| `DeviceId` numérico (por teléfono que publique) | Publisher worker | Dueño (después del pairing, se los pide a la oficina AR) |
| `WorkerToken` del publisher | Publisher worker | Dueño: `type C:\ProgramData\SouthFarm\config\publisher-worker.json` (campo `worker_token`) en la PC AR |

## Fase A — Instalador principal

En PowerShell **como Administrador**, parado en la carpeta del kit:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install-southfarm-us-office.ps1 `
  -AuthToken "<AuthToken>" `
  -CloudflaredToken "<CloudflaredToken>" `
  -AutoLoginUser "<usuario_windows>" `
  -AutoLoginPassword "<contrasena_windows>"
```

Notas:
- Descarga adb/Node/scrcpy/cloudflared de internet (5-10 min). Si falla una
  descarga, corré de nuevo: es idempotente (saltea lo ya instalado).
- `-AutoLogin*` configura el auto-login por registro (crítico: sin eso, un
  reinicio deja el bridge caído). Si el dueño no pasó esas credenciales, STOP →
  pedilas antes de seguir (o que haga netplwiz a mano).
- Si `-CloudflaredToken` viene vacío, el túnel no queda instalado: avisar al dueño.

**Verificación Fase A:**
```powershell
.\verify-us-office.ps1 -AuthToken "<AuthToken>"
```
Deben dar PASS al menos: adb, Node, scrcpy, bridge local, servicio cloudflared,
auto-arranque, auto-login, RDP, suspensión. El "tunel publico" puede tardar unos
minutos en conectar; si falla, esperá 2 min y repetí el check.

## Fase B — Teléfonos (por cada uno)

1. Conectar por cable de datos a un hub USB **alimentado**.
2. En el teléfono: activar Opciones de desarrollador → Depuración USB.
3. Al conectar: aceptar la huella RSA marcando "Siempre permitir".
4. Verificar: `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe devices`
   → debe listar `<serial>\tdevice`.
5. Registrarlo en `C:\ProgramData\SouthFarm\screen-bridge\devices.json`:
   ```json
   { "<serial>": "<ALIAS, ej US01 o CLIENTE01>" }
   ```
   (se relee solo; no hay que reiniciar nada)
6. Instalar la app: `adb install -r .\southfarm.apk`
7. **Servicio de accesibilidad** (sin tocar la pantalla del teléfono):
   ```powershell
   adb -s <serial> shell settings put secure enabled_accessibility_services com.example.southfarm_app/com.example.southfarm_app.SouthFarmAccessibilityService
   adb -s <serial> shell settings put secure accessibility_enabled 1
   adb -s <serial> shell dumpsys deviceidle whitelist +com.example.southfarm_app
   ```
8. **Emparejar con Southfarm**: abrí la app en el teléfono y completá el pairing
   con el código + access key que dió el dueño para el perfil correspondiente.
   Si la app no ofrece entrada manual, se puede abrir el teléfono por ADB:
   `adb -s <serial> shell monkey -p com.example.southfarm_app 1` para lanzarla,
   y usar `adb shell input text/tap` (ver coordenadas con
   `adb shell uiautomator dump`). Si el flujo se complica, STOP → pedirle al
   dueño que lo haga por videollamada: son 2 minutos.
9. Verificar en la web (dueño): el teléfono aparece **online** en su perfil y
   "Ver pantalla" transmite.

## Fase C — Publisher (solo teléfonos que publican)

Una corrida por teléfono, con ese teléfono conectado y ya emparejado:

```powershell
.\install-southfarm-us-publisher.ps1 -DeviceId <DeviceId> -DeviceSerial <serial> -WorkerToken "<WorkerToken>"
```

- Descarga Python portátil y ffmpeg la primera vez.
- El script termina validando identidad del teléfono y arrancando la tarea
  "SouthFarm Publisher Worker <DeviceId>".
- Log por teléfono: `C:\ProgramData\SouthFarm\logs\publisher-<DeviceId>\`.

## Diagnóstico rápido (agente)

| Síntoma | Acción |
|---|---|
| Bridge local no responde | `Get-Content C:\ProgramData\SouthFarm\logs\screen-bridge.error.log -Tail 20` |
| Cloudflared Running pero público no responde | Revisar que la ruta publicada sea `screen-us.southfarm.tech → http://127.0.0.1:8100` en el dashboard |
| Teléfono figura "unauthorized" en adb devices | Tocar "Permitir depuración USB" en el teléfono (pantalla) |
| Teléfono offline en la web (sin late) | Verificar accesibilidad activa: `adb -s <serial> shell settings get secure enabled_accessibility_services` |
| Publisher muere en loop | Leer `southfarm-publisher.error.log`; causa típica: serial/android_id mal configurado o teléfono sin autorizar |
| Tras reinicio no hay nada arriba | ¿Auto-login configurado? ¿Sesión abierta? `query user` |

## Cuándo parar y pedir ayuda al dueño

- Cualquier FAIL en verify que no se resuelva con la tabla de arriba.
- El túnel público sigue sin responder tras 10 min del servicio Running.
- El pairing del teléfono no avanza (requiere ojos en la pantalla).
- Cualquier error que sugiera tocar la API de producción o la oficina AR.
