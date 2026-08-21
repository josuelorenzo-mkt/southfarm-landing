# Handoff — publicación manual de Instagram por ADB

Fecha: 2026-08-16 (America/Argentina/Buenos_Aires)

## Contexto de primer contacto: dónde está cada cosa

### Fuente canónica y checkout de esta tarea

- Fuente canónica de desarrollo Windows: `C:\SouthFarm\source`.
- Checkout utilizado para esta iniciativa: `C:\SouthFarm\source\.worktrees\semiorganic-publishing`.
- Rama del checkout: `codex/semiorganic-publishing`.
- La carpeta `webapp` dentro del checkout tiene su propio `.git`; revisar su estado por separado antes de editarla.
- El checkout de la iniciativa contiene `webapp`, `backend` y `publisher_worker`, pero **no** contiene `southfarm_app_v2`.
- La documentación de autoridad sobre la centralización Windows es `C:\SouthFarm\source\WINDOWS_SOURCE_OF_TRUTH.md`.

### Componentes del sistema

- Frontend de la herramienta: `C:\SouthFarm\source\.worktrees\semiorganic-publishing\webapp` (Next.js 16.2.6; scripts `dev`, `build`, `lint`, `test`).
- Backend API: `C:\SouthFarm\source\.worktrees\semiorganic-publishing\backend` (Node/TypeScript; scripts `build`, `start`, `dev` y pruebas de publicaciones).
- Worker de publicación: `C:\SouthFarm\source\.worktrees\semiorganic-publishing\publisher_worker` (Python >=3.11; `southfarm_publisher`, tests en `publisher_worker\tests`).
- Aplicación Android fuente que contiene el servicio de accesibilidad v2: `C:\SouthFarm\source\southfarm_app_v2`.
- Aplicación Android fuente cuyo `applicationId` coincide con el paquete actualmente instalado en el teléfono: `C:\SouthFarm\source\southfarm_app`.
- Runtime backend instalado en Windows (no es fuente de desarrollo): `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend`.

### Producción, API y material de prueba

- Webapp desplegada que el usuario dejó abierta: `https://southfarm-webapp.vercel.app/`.
- Health check documentado del API: `https://api.southfarm.tech/api/health`.
- Videos autorizados para pruebas: `C:\Users\josu_\Downloads\Videos to test`.
- Evidencia ADB de la ejecución manual previa: `C:\ProgramData\SouthFarm\evidence\manual-trace-instagram-direct-20260816`.

### Distinción crítica de paquetes Android

El teléfono probado no debe asumirse igual a la fuente v2:

- Paquete instalado observado por ADB: `com.example.southfarm_app`, versión `1.1.8`, `versionCode=10`; su servicio bound fue `com.example.southfarm_app/.SouthFarmAccessibilityService`.
- `C:\SouthFarm\source\southfarm_app` usa `applicationId = com.example.southfarm_app`.
- `C:\SouthFarm\source\southfarm_app_v2` usa `applicationId = com.example.southfarm_app_v2` y no se instaló durante este diagnóstico.

Antes de compilar, instalar o cambiar el servicio, verificar explícitamente el package instalado; no mezclar `com.example.southfarm_app` con `com.example.southfarm_app_v2`.

### Primeros pasos para otro agente

1. Leer `C:\SouthFarm\source\AGENTS.md`, el `AGENTS.md` del checkout y este handoff completo.
2. Ejecutar `git status --short` tanto en el checkout padre como en `webapp`; preservar cambios existentes.
3. Consultar `WINDOWS_SOURCE_OF_TRUTH.md` y `southfarm_app_v2\WINDOWS_V2_HANDOFF_2026-08-03.md` antes de construir APKs.
4. Confirmar ADB, package instalado y estado de accesibilidad con los comandos de este documento.
5. No publicar ni declarar el flujo funcional hasta resolver la captura semántica fresca descrita más abajo.

### Estado Git observado al crear este handoff

El checkout ya estaba sucio antes de cerrar la tarea. No se deben descartar ni resetear estos cambios sin autorización:

- Modificados: `docs/superpowers/plans/2026-08-16-semantic-mobile-publishing.md`, `publisher_worker/southfarm_publisher/platforms/common.py`, `publisher_worker/tests/test_platform_adapters.py`.
- No versionados: este handoff, `phone-current.png`, `phone-after-exit.png` y `publisher_worker/southfarm_publisher_worker.egg-info/`.

La única adición realizada para cerrar esta tarea es este archivo de handoff; los demás cambios listados se preservaron y no se atribuyen a esta ejecución.

## Estado final

Se detuvo el trabajo a pedido del usuario. En este turno no se creó una nueva publicación, no se modificó código, no se hizo commit/push y no se desplegó nada.

Tampoco se ejecutó una prueba final desde la webapp ni se validaron TikTok o YouTube en este intento.

El intento directo llegó a abrir Instagram y confirmar la cuenta seleccionada, pero se detuvo antes de `Perfil -> + -> Reel -> galería -> video -> caption -> Compartir`. El bloqueo fue la imposibilidad de obtener un `UiSnapshot` fresco de Instagram: `uiautomator dump` devolvió repetidamente `ERROR: could not get idle state.`

## Objetivo funcional

Replicar desde ADB el flujo que el usuario realiza manualmente:

1. Abrir Instagram desde el home del teléfono.
2. Ir a `Profile` y confirmar que la cuenta activa sea `marczell.vibes`.
3. Abrir el creador con `+`/`Create New`.
4. Elegir `Reel`/`Create new reel`.
5. Elegir un video de la galería.
6. Avanzar con `Next`.
7. Escribir un caption de hasta 10 palabras relacionado con mindset.
8. Ejecutar `Share`.
9. Volver a `Profile`, refrescar/scroll semánticamente y verificar que apareció un reel nuevo con evidencia temporal de la publicación.

Restricciones confirmadas por el usuario:

- Las interacciones físicas móviles deben ser `tap`, no `click`.
- No usar coordenadas fijas como estrategia; resolver elementos por jerarquía/etiqueta (`resource-id`, `content-desc`, `text`) y tocar el centro de los bounds frescos del nodo resuelto.
- La web puede seguir usando `onClick`.
- No usar `santilorennzo` para pruebas. La cuenta autorizada para Instagram es `marczell.vibes`.

## Dispositivo y estado al detener

- Teléfono 08 / ADB serial: `863d00583048313238510ca492874c`
- `adb get-state`: `device`
- Foreground al último chequeo: `com.instagram.android/.activity.MainTabActivity`
- `settings get secure accessibility_enabled`: `1`
- Servicio habilitado: `com.example.southfarm_app/com.example.southfarm_app.SouthFarmAccessibilityService`
- No quedaron procesos de trace ADB activos.

La accesibilidad quedó habilitada al terminar; no se realizó ninguna acción destructiva sobre la cuenta ni sobre los datos del teléfono.

## Evidencia previa: proceso manual del usuario

La evidencia está en:

`C:\ProgramData\SouthFarm\evidence\manual-trace-instagram-direct-20260816`

Archivos principales:

- `touch-events.log`
- `logcat.log`
- `window.log`
- `ui_*.xml` (31 snapshots)
- `monitor-start.txt`

La captura de pantalla automática no produjo PNG porque el helper de PowerShell usado para `Out-File -Encoding byte` no era válido en PowerShell 7. `monitor-end.txt` tampoco está disponible.

Fragmentos temporales de la ejecución manual del usuario (hora local):

- `13:41:24.561`: tap en launcher `Instagram`; el XML resolvió el label con bounds `[528,586][696,831]`.
- `13:41:36.756`: selección del video con content-desc `Unselected Video thumbnail created on August 16, 2026 1:37 PM`, resource id `com.instagram.android:id/gallery_grid_item_thumbnail`, bounds `[243,402][477,818]`.
- Editor mostró `Edit video`, `Next`, `Add audio`, `Captions`, `Cancel` y `Reel preview playing`.
- `13:41:49.931`/`13:41:50.081` y `13:41:50.309`/`13:41:50.435`: dos pares `KEY_VOLUMEDOWN` (el usuario bajó volumen).
- `13:42:07.501`: tap en `Next`, resource id `com.instagram.android:id/clips_right_action_button`, bounds `[540,1452][696,1544]`.
- `13:42:10.175`: tap en `com.instagram.android:id/caption_input_text_view` (`Write a caption`).
- Caption observado progresivamente: `Be aware of the present, tomorrow isn't guaranteed`.
- `13:42:41.151`: tap en `Share`, resource id `com.instagram.android:id/share_button`, bounds `[376,1416][688,1504]`.
- `13:42:41.836`: Instagram inició `androidx.work.impl.foreground.SystemForegroundService`.

Importante: después de `Share`, los snapshots todavía mostraban la pantalla de detalles/compositor con `Share`; no hubo toast, transición inequívoca ni delta de perfil. Por lo tanto esa ejecución demuestra el inicio del share/upload, pero **no demuestra publicación exitosa**.

## Qué se intentó en el último turno

### 1. Resolución semántica de Instagram desde el launcher

Se hizo `uiautomator dump` y se buscó el nodo por label `Instagram`. La primera fórmula tuvo un error de concatenación que generaba un centro inválido; se corrigió y se resolvió el centro actual de los bounds (`612,708`). Instagram quedó en foreground.

No se usó una coordenada fija como selector lógico: el punto se calculó a partir del bounds del nodo recién leído. El flujo se detuvo antes de usar otros taps porque no se pudo obtener un XML fresco.

### 2. Recuperación de la accesibilidad

`dumpsys accessibility` inicialmente mostraba el servicio de SouthFarm en `Crashed services` y el flag global deshabilitado. Se reestableció el componente en `enabled_accessibility_services`, se activó `accessibility_enabled` y se hizo un ciclo de limpieza/rebind. Luego se observó:

- `Bound services:{Service[label=SouthFarm,...]}`
- `Crashed services:{}`

Se hizo además una prueba controlada desactivando temporalmente el flag global; eso no resolvió el error de `uiautomator`. Al finalizar, el flag volvió a `1`.

### 3. Reintentos de `uiautomator dump`

Se intentó:

- dump normal hacia `/dev/tty`;
- `--compressed`;
- dump con espera y varios reintentos;
- volver a Home y relanzar Instagram;
- consultar `dumpsys window`/`dumpsys power` para correlacionar la ventana y el estado de idle.

Todos los dumps durante Instagram terminaron en `ERROR: could not get idle state.`. Los diagnósticos mostraron actividad/superficie de Instagram (`GrootPlayer`) y una pantalla que no llegaba a un estado de idle utilizable. El XML que quedaba en disco era el snapshot viejo del launcher, por eso no debía reutilizarse para tocar controles de Instagram.

### 4. Scanner existente de SouthFarm

Como alternativa de diagnóstico, se invocó el receiver existente (sin cambiar código):

```powershell
adb -s 863d00583048313238510ca492874c shell am broadcast `
  -n com.example.southfarm_app/.WarmupReceiver `
  -a com.example.southfarm_app.DETECT_ACCOUNTS `
  -e platform instagram
```

El log del scanner confirmó:

- `marczell.vibes` con `selected=true`;
- cuentas inactivas: `growtech.news`, `marczell.wisdom`, `santilorennzo`;
- apertura del switcher por id semántico `com.instagram.android:id/action_bar_username_container`;
- resultado `["marczell.vibes", "growtech.news", "marczell.wisdom", "santilorennzo"]`.

No se tocó `santilorennzo`. Después el receiver devolvió el control a SouthFarm y se relanzó Instagram.

## Bloqueo técnico real

El problema no fue la elección de caption ni la cuenta. El problema verificable es que no hubo una fuente confiable de árbol UI fresco durante Instagram:

1. `uiautomator dump` no alcanzó idle.
2. El archivo XML disponible podía ser stale (launcher), por lo que usarlo habría podido tocar un elemento equivocado.
3. Los comandos ADB aceptados no son prueba de que el tap haya producido el estado esperado.
4. Sin snapshot fresco no se puede resolver con seguridad `Profile`, `+`, `Reel`, el video, `Next`, caption o `Share`.

La accesibilidad de SouthFarm sí llegó a quedar bound y el scanner de cuentas sí pudo leer nodos semánticos; eso indica que hay una ruta alternativa posible, pero todavía no está implementada como capturador jerárquico reusable para todo el flujo.

### Diagnóstico complementario del campo de caption

También se hizo una revisión read-only del adapter y de la evidencia disponible. No se confirmó un selector semántico live inequívoco para el campo de caption:

- La evidencia de perfil `C:\ProgramData\SouthFarm\publish-evidence\instagram-live-20260816-061503.json` tiene `RawXmlStored: false`, por lo que no conserva el árbol de la pantalla de caption.
- La captura `C:\ProgramData\SouthFarm\evidence\manual-instagram-20260816\ig-details-after-editor-next.png` demuestra el placeholder visual, pero no demuestra que Instagram lo exponga como nodo accesible.
- El adapter actual espera `Write a caption and add hashtags...`/`Continue` y luego un `EditText`; debe volver a verificarse contra XML live.
- `SafeAdb.parse_ui()` actualmente aplana el XML y pierde la relación padre/hijo; esto contradice el `UiSnapshot` jerárquico aprobado.
- Los tests actuales modelan un `EditText` ideal y no prueban la superficie Compose real de Instagram.

Conclusión de este diagnóstico: no inventar un tap geométrico para caption. Sólo continuar si aparece un campo visible, enabled y focusable (o una etiqueta única con un ancestro accionable) en un snapshot fresco.

## Inventario de selectores observado

Selectores de la traza manual/documentación previa que deben volver a validarse en cada snapshot:

| Etapa | Selector observado |
|---|---|
| Identidad | `com.instagram.android:id/action_bar_title` con texto de la cuenta activa |
| Selector de cuenta | `com.instagram.android:id/action_bar_username_container` |
| Perfil | content-desc/text `Profile`; en una traza previa `profile_tab` `[576,1456][720,1544]` |
| Crear | `Create New` / botón `+` según versión |
| Tipo | `Create new reel` / `Reel` |
| Galería | content-desc `Video thumbnail` o descripción temporal; resource id `com.instagram.android:id/gallery_grid_item_thumbnail` |
| Editor | `com.instagram.android:id/clips_right_action_button` / `Next` |
| Caption | `com.instagram.android:id/caption_input_text_view` / `Write a caption` |
| Publicar | `com.instagram.android:id/share_button` / `Share` |

Estos son indicios, no contratos permanentes: cada acción debe tomar un snapshot nuevo y fallar de forma segura si el selector no tiene una única coincidencia.

## Código y documentación relevantes

Checkout de trabajo de la iniciativa:

`C:\SouthFarm\source\.worktrees\semiorganic-publishing`

- `docs/SEMIOGANIC_PUBLISHING_HANDOFF_ES.md`: handoff anterior; es parcialmente histórico y menciona `growtech.news`, por lo que debe prevalecer la autorización actual `marczell.vibes`.
- `docs/superpowers/specs/2026-08-16-semantic-mobile-publishing-design.md`: diseño aprobado de `UiSnapshot` jerárquico, snapshot fresco antes/después, prioridad `resource-id -> content-desc -> text`, taps calculados desde bounds y fail-closed.
- `docs/superpowers/plans/2026-08-16-semantic-mobile-publishing.md`: plan de implementación; contempla `publisher_worker/southfarm_publisher/ui_snapshot.py` y verificación de perfil.
- `publisher_worker/southfarm_publisher/adb_device.py`: `SafeAdb.dump_ui()` usa `uiautomator dump /dev/tty`; `tap_bounds()` calcula el centro del bounds, aunque el comando físico termina siendo `shell input tap`.
- `publisher_worker/southfarm_publisher/platforms/instagram.py`: flujo viejo con selectores básicos; `verify()` solo revisa un delta de tile y todavía no implementa la verificación solicitada de refrescar perfil/fecha-hora.
- `C:\SouthFarm\source\southfarm_app_v2\android\app\src\main\kotlin\com\example\southfarm_app\SouthFarmAccessibilityService.kt`: scanner existente; `detectInstagramAccounts()` y `openInstagramAccountSwitcher()` ya muestran una ruta semántica mediante `AccessibilityNodeInfo`.
- `...\WarmupReceiver.kt`: expone la acción `DETECT_ACCOUNTS` usada arriba.

## Comandos útiles para retomar

Comprobar conexión y estado sin interactuar:

```powershell
adb -s 863d00583048313238510ca492874c get-state
adb -s 863d00583048313238510ca492874c shell dumpsys window windows | Select-String 'mCurrentFocus|mFocusedApp'
adb -s 863d00583048313238510ca492874c shell settings get secure accessibility_enabled
adb -s 863d00583048313238510ca492874c shell settings get secure enabled_accessibility_services
```

Probar un dump y validar su salida (no reutilizar un XML anterior si el comando falla):

```powershell
$serial = '863d00583048313238510ca492874c'
$xml = adb -s $serial exec-out uiautomator dump --compressed /dev/tty 2>&1
$xml
```

Repetir la detección de cuentas sin publicar:

```powershell
adb -s 863d00583048313238510ca492874c shell am broadcast `
  -n com.example.southfarm_app/.WarmupReceiver `
  -a com.example.southfarm_app.DETECT_ACCOUNTS `
  -e platform instagram
```

No copiar tokens, encabezados de autenticación ni valores sensibles que puedan aparecer en logs. En esta documentación se omitieron deliberadamente.

### Comandos de orientación y validación local

Ejecutar desde PowerShell y revisar primero el estado Git:

```powershell
Set-Location C:\SouthFarm\source\.worktrees\semiorganic-publishing
git status --short

Set-Location .\publisher_worker
python -m unittest discover -s tests -v

Set-Location ..\webapp
npm run lint
npm test -- --run
npm run build

Set-Location ..\backend
npm run build
```

Para la variante Android v2 (sin instalarla automáticamente):

```powershell
Set-Location C:\SouthFarm\source\southfarm_app_v2
flutter pub get
flutter test
flutter build apk --debug
```

La documentación de v2 informa Flutter 3.44.0, Dart 3.12.0, Java 17 y SDK Android Windows en `C:\SouthFarm\toolchain\android-sdk`. La instalación del APK debe ser una decisión separada porque el teléfono actualmente usa `com.example.southfarm_app`.

## Próxima ruta recomendada para el agente continuador

1. Resolver primero la captura de UI de Instagram. Investigar por qué `GrootPlayer`/la transición de superficie mantiene el dispositivo fuera de idle. Si `uiautomator` sigue siendo inservible, adaptar el servicio bound de SouthFarm para exponer una captura jerárquica de `AccessibilityNodeInfo`, con timestamp, package/activity y validez del root.
2. Implementar la capa `UiSnapshot`/selector semántico definida en el spec; nunca hacer fallback silencioso a coordenadas fijas ni ejecutar un tap si el snapshot es stale o la coincidencia no es única.
3. Repetir el flujo manual completo con `marczell.vibes`, seleccionando un video de la galería y caption de <=10 palabras. Registrar cada acción, selector, bounds, activity y snapshot posterior.
4. Validar publicación con evidencia positiva: transición posterior a `Share`, ausencia de estado de upload pendiente, volver a `Profile`, refresh/scroll mediante acciones de accesibilidad y aparición de un tile nuevo. La hora/caption deben correlacionarse con el test; si Instagram no expone timestamp en el árbol, documentar la evidencia alternativa en vez de inventarla.
5. Solo cuando el flujo directo pase de forma repetible, integrar el mismo worker en la webapp y probar el recorrido web completo. Antes de eso no hacer deployment ni declarar funcionalidad terminada.
6. Para cada plataforma futura (TikTok/YouTube), mantener la misma política: pruebas limpias repetidas, publicación verificable y limpieza de posts de prueba antes de considerar el flujo operativo.

## Criterio de continuidad

El handoff debe considerarse resuelto únicamente cuando otro agente pueda reproducir el diagnóstico, demostrar una publicación real en la cuenta autorizada y mostrar evidencia de verificación desde el perfil. El estado actual es **bloqueado en captura semántica fresca de Instagram**, no “publicado con éxito”.
