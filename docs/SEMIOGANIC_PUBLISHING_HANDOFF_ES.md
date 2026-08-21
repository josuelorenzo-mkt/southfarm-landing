# SouthFarm — handoff completo de publicación semiorgánica

Última actualización: 2026-08-14 (America/Argentina/Buenos_Aires)

Este documento deja el contexto operativo y técnico para continuar el trabajo con otro agente. Describe lo que está implementado, lo que se verificó y el bloqueo exacto que quedó pendiente. No contiene tokens, contraseñas ni credenciales.

## 1. Objetivo acordado

La sección **Crear publicación** de SouthFarm debe permitir:

1. Elegir un teléfono de la flota.
2. Elegir una cuenta social proveniente del último escaneo de cuentas del teléfono.
3. Subir un video MP4/MOV/WebM.
4. Escribir un caption de 1 a 10 palabras.
5. Publicar ahora o programar fecha/hora.
6. Enviar el trabajo al teléfono mediante ADB.
7. Abrir Instagram, TikTok o YouTube Shorts.
8. Cambiar al perfil/canal exacto seleccionado antes de tocar la galería.
9. Subir, publicar y verificar el resultado con checkpoints observables.

Reglas importantes:

- El último escaneo del teléfono es la fuente de cuentas disponibles.
- Si la cuenta escaneada ya no aparece en el selector real de la aplicación, el trabajo debe fallar sin publicar y mostrar exactamente: `La cuenta seleccionada ya no está disponible en este teléfono. Volvé a escanear sus cuentas o elegí otra cuenta disponible.`
- No se deben ingresar credenciales automáticamente ni pedir al usuario que lo haga en el mensaje de error.
- Nunca usar la cuenta de Instagram `santilorennzo`/Santiago.
- Para las pruebas actuales pueden quedar como máximo dos publicaciones exitosas en una cuenta.
- No iniciar otra prueba de Instagram hasta resolver el bloqueo documentado en la sección 10.

## 2. Checkout y fuentes autoritativas

Checkout canónico de desarrollo/runtime:

```text
C:\SouthFarm\source\.worktrees\semiorganic-publishing
```

Branch del repositorio principal:

```text
codex/semiorganic-publishing
```

El frontend es un repositorio anidado:

```text
C:\SouthFarm\source\.worktrees\semiorganic-publishing\webapp
```

Branch del frontend:

```text
codex/semiorganic-publishing
```

No usar como fuente canónica la copia atrasada de OneDrive ni `southfarm-legacy` para modificar el producto. Los documentos de experiencia que se leyeron están en `docs/`:

- `GUIA_AUTONOMA_SUBIDA_VIDEO_INSTAGRAM_ADB.md`
- `GUIA_POSTEO_VIDEO_TIKTOK_ADB.md`
- `GUIA_POSTEO_VIDEO_YOUTUBE_SHORTS_ADB.md`
- `REEL_POST_PROCESS_MP-V-4.md`

También se revisaron los cuatro videos de `C:\Users\josu_\Downloads\Videos to test`.

## 3. Arquitectura implementada

```text
Web Crear publicación
        |
        | multipart upload + job
        v
Backend SouthFarm / SQLite
        |
        | claim atómico + claim_token + lease + checkpoints
        v
Windows Publisher Worker
        |
        | ADB seguro + selector exacto de cuenta
        v
Instagram / TikTok / YouTube
        |
        | publicación + verificación + identidad remota
        v
Cola web / timeline / completed | failed | review_required
```

El backend usa claim atómico, token de claim, lease, heartbeat, lock del teléfono, checkpoints monotónicos y estado `review_required` cuando la acción final quedó incierta. El worker descarga el media privado, valida hash/tamaño/MIME/metadata, lo copia por ADB a un nombre seguro y lo elimina del teléfono al terminar.

Los adapters de plataforma tienen, en términos generales, este orden:

```text
preparing
transferring
selecting_media
editing
captioning
ready_to_publish
publishing (checkpoint antes del tap irreversible)
verifying
completed / failed / review_required
```

La selección de cuenta no escribe texto ni credenciales. Solo navega y toca controles explícitos del selector de perfiles.

## 4. Frontend entregado

La web ya tiene una sección responsive **Crear publicación** con:

- Navegación desktop/mobile.
- Selección de plataforma, teléfono y cuenta exactos.
- Dropzone y selector de archivo.
- Preview y metadata del video.
- Aviso de formato vertical 9:16.
- Caption de 1 a 10 palabras.
- Límite de 100 caracteres para YouTube.
- Publicar ahora/programar en zona horaria de Buenos Aires.
- Upload multipart con progreso.
- Reintento único de upload únicamente ante HTTP 401 después de refrescar sesión.
- Cola, tabs, polling, detalle, timeline, cancelación y reprogramación.
- Mensaje de cuenta no disponible y retención de teléfono/cuenta seleccionados.
- Estados `review_required` y errores observables.
- RBAC y accesibilidad básica.

Commits principales del frontend anidado:

| Commit | Propósito |
|---|---|
| `157a68a` | Composer, upload y cola inicial |
| `ad24b72` | Refresh seguro del upload ante 401 |
| `1ab4e60` | Mensaje de cuenta no disponible |
| `54083c5` | Preservar timeline de detalle durante polling |

El superproyecto avanzó el gitlink con `73060ed`. El nested repo fue empujado a `origin/main` hasta `54083c5`. Producción web: [https://southfarm-webapp.vercel.app/](https://southfarm-webapp.vercel.app/).

Verificación frontend más reciente:

- Tests Vitest: 19/19.
- Lint: 0 errores; queda un warning preexistente de `<img>` en `page.tsx`.
- Build Next: OK.
- La URL pública responde HTTP 200.

## 5. Backend, worker y operaciones entregados

El backend productivo es el servicio Windows `SouthFarm API`, compilado con Node portable 22.23.1 desde este checkout. La API pública es `https://api.southfarm.tech` y `/api/health` respondió `200 / ok`.

Rutas/runtime importantes:

```text
DB activa:
C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db

Runtime backend:
C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend

Config worker protegida:
C:\ProgramData\SouthFarm\config\publisher-worker.json

Logs worker:
C:\ProgramData\SouthFarm\logs\southfarm-publisher.out.log
C:\ProgramData\SouthFarm\logs\southfarm-publisher.error.log
```

Scheduled tasks actuales:

```text
SouthFarm API                    Running
SouthFarm Publisher Worker      Running
```

El worker está configurado para usar el checkout actual, ADB exacto, Node/Python portables, ffprobe estable y política explícita de Instagram prohibida. No imprimir ni copiar el campo secreto del worker token.

La instalación Windows incluye validación de identidad, ACL de config/log/media/evidence, ffprobe protegido, task interactiva no-SYSTEM, reinicio supervisado y revalidación del teléfono antes de arrancar cada worker.

## 6. Identidad real del teléfono

Teléfono utilizado en las pruebas:

```text
ADB serial: 863d00583048313238510ca492874c
Android secure ID: aaa9c7a1f6cdb7a1
Backend device row id: 28
Backend legacy device_id: fd2f46b48e71496a
```

El teléfono usa la compatibilidad de identidad legacy: el backend mantiene el `device_id` histórico y la instalación Flutter, mientras el worker valida el serial físico y el Android ID exactos. No cambiar estas identidades ni reinstalar la app sin revisar primero el puente de identidad.

La cuenta `growtech.news` quedó verificada manualmente abierta en Instagram. La cuenta prohibida `santilorennzo` no debe utilizarse.

## 7. Historial de implementación y commits relevantes

La funcionalidad se construyó y revisó en iteraciones TDD. Estos son los commits más relevantes para continuar:

### Dominio/API/worker

- `c8bbeca` — API de upload/publicaciones.
- `8519a18`, `8ae02dfa`, `ce50d356`, `9e6de75b` — endurecimiento de validación, abortos, MIME/WebM/MP4 y carreras de transición.
- `a219c49` — contrato HTTP del publisher worker.
- `8869b2f`, `a8efc97`, `14e515c` — claim exacto, lease, lock, final action y validación booleana.
- `f79d063`, `5839075` — metadata de media y snapshot atómico de claim.

### Runtime Python y adapters

- `43deb8c` y follow-ups — núcleo ADB publisher y runner.
- `c9beeca` — terminalización idempotente: nunca se reintenta un `finish` ambiguo.
- `533dd4a` — adapters iniciales Instagram/TikTok/YouTube.
- `c50f8a0`, `6cd7445` — cuenta exacta, metadata ffprobe, waits frescos, verificación y cleanup fail-closed.
- `c66d2db`, `ae69ab6`, `9184589` — delta de galería, perfil y cleanup contextual.
- `22a17f9`, `1d00caa`, `43c1d93`, `9b4c566` — evidencia fresca, target nuevo, baseline ordenada, transiciones de borrado y restauración.
- `3a5ddf6` — CLI explícita de cleanup de posts de prueba.

### Cuenta seleccionada y errores web

- `5f424ce` — contrato de cuenta escaneada.
- `8ffbfd2` — cambio al perfil seleccionado.
- `eb6ce20` — verificación de cuenta activa específica por plataforma.
- `a7dbf2c` — fail-closed para controles faltantes/ambiguos.
- `3a5e858` — rechazo de switchers ambiguos en las tres plataformas.
- `bab3335` — cobertura de Instagram ambiguo.
- `41764f6` — error `ACCOUNT_UNAVAILABLE` antes de download/push.
- `8049d93`, `314daa6` — reutilizar Profile ya abierto y permitir continuar desde Profile aunque la cuenta activa todavía sea otra.
- `43cbad2` — selector real con padre clickeable y etiqueta hija: prioriza un único padre clickeable y rechaza dos padres clickeables.

### Ops/identidad/despliegue

- `5710f99`, `85b6d53`, `9130599`, `c8bbd50`, `deb8be2` — supervisor, instalador, ACL, ffprobe, serial/Android ID y fixtures Windows.
- `a1a6d8f` — compatibilidad explícita para identidad legacy de la app Flutter.
- `564b06c` — autorizaciones de cleanup firmadas, humanas, scopeadas por workspace/device/account/worker.
- `73060ed` — avance final del gitlink web en el superproyecto.

## 8. Pruebas automatizadas ejecutadas

Node debe ser el portable 22.23.1:

```powershell
$env:PATH = "C:\Users\josu_\AppData\Local\SouthFarm\node-v22.23.1-win-x64;$env:PATH"
```

Backend, desde `backend/`:

```powershell
npm run build
node scripts/test-publications-domain.mjs
node scripts/test-publications-api.mjs
node scripts/test-publication-worker-api.mjs
```

Las tres suites pasaron. `test:auth` se ejecutó con un media root temporal aislado porque el `.tmp` protegido de `C:\ProgramData\SouthFarm\publish-media` da EPERM al usuario de desarrollo; la prueba de refresh/rotación/replay pasó con el root temporal y el directorio temporal fue eliminado.

Worker Python, desde la raíz del worktree:

```powershell
py -3 -m unittest discover -s publisher_worker\tests -q
```

Último resultado antes del bloqueo pendiente: **110 tests OK**.

Ops Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\windows\test-southfarm-publisher-worker.ps1 -CreateTemporaryFixture
```

El fixture aislado de instalación/verificador pasó y no modifica producción.

## 9. Pruebas live realizadas desde la web

Todas las pruebas usaron:

```text
Teléfono: 08 / backend id 28
Cuenta: @growtech.news
Caption: you just need to think bigger
```

No se usó `santilorennzo` y no se publicó ningún video exitosamente.

| Job | Video | Resultado | Evidencia |
|---:|---|---|---|
| `#4` | `MP-V-1.mp4` | `failed`, 1%, `UI_TIMEOUT` | Se quedó en `preparing`; Instagram ya estaba en Profile y el runner tocaba la pestaña Profile activa, por lo que esperaba una transición que no ocurría. |
| `#5` | `MP-V-1.mp4` | `failed`, 1%, `ACCOUNT_UNAVAILABLE` | El selector real de Instagram tiene un padre clickeable `content-desc=growtech.news` y un hijo `text=growtech.news`; el matcher contaba ambos como dos cuentas. Se corrigió en `43cbad2`. |
| `#6` | `MP-V-1.mp4` | `failed`, 1%, `ACCOUNT_UNAVAILABLE` | Reproducción directa con ADB confirmó que `action_bar_title` es una etiqueta pasiva con `clickable=false`; `account_control()` la clasificaba incorrectamente como no disponible. Este es el bloqueo actual. |

El teléfono quedó en el perfil de Instagram `growtech.news`. La pestaña de Chrome con SouthFarm quedó abierta para continuar.

El selector real observado al inspeccionar `uiautomator` fue:

```text
profile_header_container                    [0,180][720,795]
profile_tab desc=Profile                    [576,1456][720,1544]
action_bar_username_container clickable=true [128,68][512,180]
action_bar_title text= growtech.news
```

En el switcher se observó además:

```text
padre: content-desc=growtech.news, clickable=true
hijo:  text=growtech.news, clickable=false
```

## 10. Bloqueo exacto pendiente

El worktree tiene un parche **sin commit** dejado deliberadamente para continuar:

```text
M publisher_worker/southfarm_publisher/platforms/common.py
M publisher_worker/tests/test_platform_adapters.py
```

El cambio pendiente elimina la exigencia de `clickable=true` de `GuardedPublisher.account_control()`. Es correcto porque `action_bar_title`, `profile_account` y `account_name` son etiquetas de identidad pasivas; los controles accionables siguen pasando por `_one()`/`tap_and_wait()`, que sí rechazan un selector no clickeable o deshabilitado.

El diff pendiente también agrega un test para:

- aceptar etiquetas de identidad pasivas en Instagram/TikTok/YouTube;
- mantener el switcher clickeable;
- rechazar un switcher deshabilitado.

### Próximo paso exacto

1. Revisar el diff pendiente; no descartarlo.
2. Ejecutar el test nuevo y la suite completa.
3. Commit sugerido: `fix(worker): accept passive account identity labels`.
4. Reiniciar `SouthFarm Publisher Worker`.
5. Reproducir directamente con `SafeAdb`/`InstagramPublisher` que `account_control(action_bar_title)` ya no da `ACCOUNT_UNAVAILABLE`.
6. Volver a Crear publicación en la web, usar `MP-V-1.mp4`, publicar en `@growtech.news` y observar el timeline completo.
7. Solo si la primera publicación termina `completed` y se verifica en el perfil, repetir con `MP-V-2.mp4`.
8. No superar dos publicaciones exitosas y no tocar Santiago.

Para reiniciar el worker después de un commit validado:

```powershell
Stop-ScheduledTask -TaskName 'SouthFarm Publisher Worker'
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'SouthFarm Publisher Worker'
Get-ScheduledTaskInfo -TaskName 'SouthFarm Publisher Worker' | Select-Object LastRunTime,LastTaskResult
```

Para una inspección concisa del perfil real:

```powershell
$adb='C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe'
$serial='863d00583048313238510ca492874c'
& $adb -s $serial shell uiautomator dump /sdcard/window.xml 2>$null | Out-Null
[xml]$doc=(& $adb -s $serial exec-out cat /sdcard/window.xml)
$doc.SelectNodes('//node') |
  Where-Object { $_.'resource-id' -in @(
    'com.instagram.android:id/action_bar_title',
    'com.instagram.android:id/action_bar_username_container',
    'com.instagram.android:id/profile_header_container',
    'com.instagram.android:id/profile_tab'
  ) -or $_.'content-desc' -in @('Profile','Create New') } |
  ForEach-Object { "text=[$($_.text)] desc=[$($_.'content-desc')] rid=[$($_.'resource-id')] click=$($_.clickable) bounds=$($_.bounds)" }
```

## 11. Browser/file-upload notes

El upload desde Chrome necesitó habilitar en la extensión de Codex/Chrome la opción de acceso a URLs de archivo. El patrón que funcionó después de recargar la página y abrir nuevamente **Crear publicación** fue:

```javascript
var input = tab.playwright.locator('input[type="file"]');
var chooserPromise = tab.playwright.waitForEvent('filechooser', {timeoutMs: 10000});
await input.click();
var chooser = await chooserPromise;
await chooser.setFiles(['C:/Users/josu_/Downloads/Videos to test/MP-V-1.mp4']);
```

Si el componente quedó reutilizado después de un job fallido, recargar la web y volver a entrar a **Crear publicación** antes de abrir el file chooser.

## 12. Estado Git al pausar

HEAD del superproyecto:

```text
43cbad2 fix(worker): select clickable account options
```

Cambios no commit intencionales que deben preservarse para el próximo agente:

```text
M  publisher_worker/southfarm_publisher/platforms/common.py
M  publisher_worker/tests/test_platform_adapters.py
?? phone-after-exit.png
?? phone-current.png
?? publisher_worker/southfarm_publisher_worker.egg-info/
```

Los tres paths `??` son artefactos locales y no deben entrar en un commit funcional. El repo nested `webapp` estaba limpio en `54083c5`.

## 13. Criterio de finalización real

No declarar la funcionalidad terminada hasta tener, en orden:

1. Una publicación Instagram `completed` desde la web.
2. Evidencia de timeline con `publishing`, `verifying` y `completed`.
3. Verificación de identidad remota en el perfil correcto `@growtech.news`.
4. Una segunda publicación consecutiva `completed` con otro video.
5. Sin taps de credenciales, sin uso de `santilorennzo`, sin jobs activos trabados y sin más de dos publicaciones exitosas en la cuenta.
