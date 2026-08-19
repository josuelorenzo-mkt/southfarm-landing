# Handoff: rollback estable y compatibilidad del worker (2026-08-19)

## Resultado

Se restauró SouthFarm 1.1.8 en los seis teléfonos sin desinstalar ni limpiar datos. La flota tiene dos cohortes de firma Android, por lo que la web publica dos APK estables:

| Descarga | Versión visible | versionCode | Firma | Tamaño | Uso |
|---|---:|---:|---|---:|---|
| `https://southfarm-webapp.vercel.app/southfarm.apk` | 1.1.8 | 21 | release `6079c6b00b514100233d7e2cdb693c179ccaf863a497ed954a7f6ba9719f391b` | 34,581,189 bytes | Teléfonos release (22, 31, 32) |
| `https://southfarm-webapp.vercel.app/southfarm-debug.apk` | 1.1.8 | 10 | Android Debug `8aeb8425da05a8cdc5a19f273c8a323a4551dfae290600deb7dde81aad90ff9d` | 96,070,569 bytes | Teléfonos debug (08, 27, 36) |

Los dos artefactos son arm64 y tienen paquete `com.example.southfarm_app`. El `versionCode=21` del APK release es intencional: Android no permite instalar un código menor sobre una instalación release no-debuggable sin desinstalarla. La variante debug conserva `versionCode=10` porque esos teléfonos permiten el downgrade firmado y `run-as` sigue disponible.

## Matriz de flota validada

| Serial ADB | SouthFarm device config | Resultado |
|---|---:|---|
| `192.168.0.21:5555` | 28 | 1.1.8 debug, código 10, identidad privada conservada |
| `192.168.0.22:5555` | — | 1.1.8 release, código 21 |
| `192.168.0.27:5555` | 26 | 1.1.8 debug, código 10, identidad privada conservada |
| `192.168.0.31:5555` | — | 1.1.8 release, código 21 |
| `192.168.0.32:5555` | 30 | 1.1.8 release, código 21; worker configurado sin `legacy_app_identity` |
| `192.168.0.36:5555` | 27 | 1.1.8 debug, código 10, identidad privada conservada |

En todos se verificaron `android_id`, versión, componente `SouthFarmAccessibilityService` habilitado y que la instalación no fue reemplazada con un APK de firma incompatible. Los workers 28/26/27/30 quedaron `Running`.

## Compatibilidad del worker

Archivos modificados:

- `publisher_worker/southfarm_publisher/adb_device.py`: acepta `ui_source="auto"`. Prueba el snapshot del servicio una vez; si el APK legacy no implementa `DUMP_UI`, marca el servicio como no disponible y usa `exec-out uiautomator dump /dev/tty` en las acciones siguientes. Si ambas fuentes fallan, devuelve un error retryable y no ejecuta ningún tap.
- `publisher_worker/southfarm_publisher/runner.py`: el default de producción pasó a `auto` y valida `service`, `uiautomator` y `auto`.
- `ops/windows/southfarm-publisher-supervisor.ps1`: configura `SOUTHFARM_UI_SOURCE=auto` cuando el JSON viejo no tiene `ui_source`.
- `ops/windows/install-southfarm-publisher-worker.ps1`: agrega `-UiSource auto` y persiste `ui_source`.

Verificación automatizada: `260` tests del worker OK. Smoke ADB real en 08 (debug) y 32 (release): el servicio no generó `southfarm_ui.xml`, `auto` cayó a uiautomator, obtuvo una jerarquía utilizable y no emitió taps.

## Comandos de verificación

Desde `C:\SouthFarm\source\.worktrees\semiorganic-publishing`:

```powershell
python -m unittest discover -s publisher_worker/tests -q
```

Validación del supervisor del teléfono 08 (no inicia un worker adicional):

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `
  .\ops\windows\southfarm-publisher-supervisor.ps1 `
  -ConfigPath C:\ProgramData\SouthFarm\config\publisher-worker.json `
  -LogDirectory C:\ProgramData\SouthFarm\logs `
  -ValidateOnly
```

Metadatos de un APK local:

```powershell
$bt = 'C:\SouthFarm\toolchain\android-sdk\build-tools\35.0.0'
& "$bt\aapt2.exe" dump badging .\path\southfarm.apk | Select-String '^package:'
& "$bt\apksigner.bat" verify --print-certs .\path\southfarm.apk
```

## Recuperación segura

Las copias verificadas quedaron bajo `C:\ProgramData\SouthFarm\tmp-cert`:

- `southfarm-1.2.0-current.apk` (backup de la web antes del cambio).
- `southfarm-1.1.8-debug-arm64-vc10.apk`.
- `southfarm-1.1.8-release-arm64-vc21.apk`.

Elegir siempre la firma que coincide con el teléfono. Usar únicamente `adb install -r -d <apk>`; no ejecutar `adb uninstall`, `pm clear` ni borrar `shared_prefs`. Un error `INSTALL_FAILED_UPDATE_INCOMPATIBLE` o `INSTALL_FAILED_VERSION_DOWNGRADE` significa que se eligió la variante incorrecta: detenerse y conservar la instalación actual.

## Estado de las pruebas de publicación

La validación realizada en esta etapa fue de instalación, identidad, accesibilidad y fallback UI. El teléfono 08 quedó bloqueado por un keyguard seguro durante el smoke test; por eso todavía no se ejecutó un post real de Instagram/TikTok/YouTube después del rollback. Antes de afirmar que el flujo social end-to-end está aprobado, desbloquear manualmente el teléfono y repetir las pruebas semiorgánicas con las cuentas autorizadas (`marczell.vibes` y `marczellwisdom`), verificando el post desde el perfil y sin usar `santilorennzo`.
