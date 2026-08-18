# Handoff — Publicación móvil semiautomática (IG/TT/YT) + verify unificado "tercer tile + scroll"

Fecha: 2026-08-18. Orquestador: sesión ZCode 2026-08-17/18.
Checkout: `C:\SouthFarm\source\.worktrees\semiorganic-publishing` (branch `codex/semiorganic-publishing`, worktree SUCIO — NADA commiteado todavía).
Handoffs previos (contexto histórico): `docs/HANDOFF_ORCHESTRATOR_2026-08-17_ES.md`, `docs/HANDOFF_AGENT_INSTAGRAM_MANUAL_ADB_2026-08-16_ES.md`.

## Reglas operativas (del usuario — OBLIGATORIAS)

- Cuentas autorizadas: Instagram `marczell.vibes` (NUNCA `santilorennzo`), TikTok `@marczell.vibes`, YouTube canal `@MarczellWisdom`.
- Fail-closed es innegociable: ante incertidumbre nunca tapear el botón destructivo (Share/Post/Upload). Un solo tap final por corrida, jamás re-tapear.
- Posts de prueba: NO se borran salvo orden explícita del usuario. **Actualmente acumulados: 4 reels IG + 2 posts TikTok + 1 Short YouTube.**
- El usuario orquesta y supervisa en vivo (mira el celular); los subagentes ejecutan.
- Subagentes: los custom (backend-pro, etc.) usan un proveedor con cuota limitada (falla por rate-limit); `general-purpose` corre sobre otro proveedor. Si el proveedor custom está sin cuota, usar `general-purpose` o que el orquestador haga el cambio directo.
- PROBLEMA DEL ENTORNO: el proveedor de los subagentes MUERE si leen imágenes (PNG/JPG) con Read → PROHIBIDO abrir imágenes; solo XML/logs/texto. Screenshots se guardan como evidencia pero nunca se abren.
- Prompts de subagentes < 3000 palabras. Trabajos que tocan los mismos archivos → serializar. TODO lo que toca el teléfono se serializa SIEMPRE (un agente a la vez).

## Dispositivo y entorno

- ADB serial `863d00583048313238510ca492874c`; pantalla 720×1640 (POCO C71, HyperOS, navegación de 3 botones ACTIVA — la navbar SystemUI aparece en los dumps).
- Servicio de accesibilidad SouthFarm (app `com.example.southfarm_app`, instalada): dump XML por broadcast `am broadcast -n com.example.southfarm_app/.WarmupReceiver -a com.example.southfarm_app.DUMP_UI` → `/sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml`, frescura por `seq` en `<hierarchy seq="N">`. LEER con `MSYS_NO_PATHCONV=1 adb exec-out cat /sdcard/...` (Git Bash corrompe paths /sdcard como args).
- MSYS/Git Bash: SIEMPRE subprocess con lista de args o MSYS_NO_PATHCONV=1 para paths de device.
- Videos de prueba autorizados: `C:\Users\josu_\Downloads\Videos to test\0730 MA-V-{1..4}.mp4` (HEVC 1080×1920, 14-17s). **NO usar los MP-V-*.mp4 viejos: son HEVC 4K y la galería de Instagram los ignora (bug ya diagnosticado — fue del archivo, no del sistema).**
- WiFi del teléfono dependiente del ISP del usuario: SIEMPRE correr `ensure_network_up()` antes de publicar (ya está en el runner).

## Estado del sistema (todo verificado con tests + corridas en vivo)

**Suite: 255 tests OK** (`cd publisher_worker && python -m unittest discover -s tests`). Worker: `publisher_worker/` (Python ≥3.11).

### Logros validados en vivo (2026-08-17)
- **Instagram**: reel publicado y verificado `completed` de punta a punta (live5: delta a +27s, identidad confirmada a +68.9s leyendo el caption en el viewer).
- **TikTok**: 2 posts publicados reales, confirmados por toast "Video posted!" (+23s y +10.6s). El verify formal quedó `unverified` dos veces por límites del detector (matching exacto de fila de play-counts vs grilla que renderiza 5 counts por viewport + tile de draft) — YA CORREGIDO el detector (delta por prepend: "0" plays al frente no presente en baseline).
- **YouTube**: Short publicado real, confirmado por tile "No views" al frente + snackbar "Uploaded to Your Channel" (+33s). El verify abortó por navegación post-subida (tab You aterriza directo en la página del canal) — YA CORREGIDO (`_enter_channel` con tolerancia "ya en canal").

### Arquitectura del worker (resumen)
- `southfarm_publisher/adb_device.py` — `SafeAdb`: `dump_ui()` (servicio, anti-stale por seq), `dump_ui_explicit(source)` (uiautomator puntual), `swipe_bezier(x1,y1,x2,y2,ms)` (curva Bézier cúbica replicando `SouthFarmAccessibilityService.swipe()` — cubicTo 25%/75% + jitter ±24px, vía `input motionevent` con fallback a swipe recto), `ensure_accessibility_healthy()` (check + reparación 1 vez: force-stop + escritura explícita del componente canónico de `enabled_accessibility_services` + gracia 6s sin dumps + rebind 15s; si sigue muerto → `ACCESSIBILITY_SERVICE_DOWN`), `ensure_network_up()` (ping 8.8.8.8 con fallback dumpsys connectivity VALIDATED; sin red → `DEVICE_OFFLINE`).
- `southfarm_publisher/platforms/common.py` — `GuardedPublisher`: selectores `_one` (única coincidencia, fail-closed, `package=` para excluir SystemUI), `_fresh_tap_target` (re-dump fresco + re-localización semántica + bounds DENTRO del viewport antes de cada tap — fix del "tap fantasma"), `_clickable_target` (ancestro clickeable más cercano cuando la hoja no es clickeable — fix del Next de TikTok `pjg`→`pje`), viewport (720,1640) inyectable, `validate_caption` (10 palabras compartido; YouTube ≤100 chars).
- `southfarm_publisher/platforms/instagram.py` / `tiktok.py` / `youtube.py` — adapters con selectores reales validados en vivo. Publish de punta a punta en los tres. YouTube: "Add details" SOLO legible por uiautomator (árbol a11y vacío, protegido por Google); selección de media por NOMBRE de archivo exacto (`publication-<job>-<media>.mp4`).
- `southfarm_publisher/runner.py` — orquesta: pre-checks (accesibilidad + red) → prepare (identity + baseline) → push+scan → publish → verify; mapea `unverified` → backend como `review_required` + `VERIFICATION_PENDING` con evidencia (el backend aún no conoce el estado nativo — pendiente).
- `southfarm_publisher/models.py` — `PublicationStatus.UNVERIFIED` (estado terminal local: publicación real sin confirmación; JAMÁS re-publicación).

### El verify actual (lo que hay ahora — a REEMPLAZAR por el diseño nuevo)
Cada plataforma tiene su propia rama de detección (lo que el usuario quiere unificar):
- IG: 20s → tab-cycle Profile→Home→Profile (3s) → swipe Bézier → delta por post-count (9→10) o tile → identidad abriendo el tile row1col1. Retries 20s/10s.
- TT: 20s → tab-cycle → swipe → delta por "0" plays prepend. Retries 20s/10s.
- YT: 20s → ciclo Home→You→View channel (o skip si ya en canal) → swipe → delta por tile "No views" + prefijo caption (50 chars). Retries 20s/10s.
Constantes `_VERIFY_INITIAL_WAIT/_VERIFY_TAB_WAIT/_VERIFY_RETRY_WAITS` en cada adapter. Swipes Bézier de refresh fijos `(360,350)→(360,1000) 400ms`.

### Evidencia de las corridas (en `diag/`)
Prefijos: `igverify2-*` / `igverify3-*` / `igverify4-*` / `igverify5-*` (IG), `ttverify1-*`…`ttverify4-*` (TT), `ytverify1-*` + `ytrecon-*` (YT). Harnesses reutilizables en la raíz del worktree: `ig-verify-live*.py`, `tt-verify-live*.py`, `yt-verify-live1.py`, `tt-verify-identity.py` (verify-only con `--caption`/`--prefix`).

## EL CAMBIO PENDIENTE — verify unificado "tercer tile + scroll" (diseño del usuario, 2026-08-18)

**Decisión del usuario**: resolver el verify con UNA sola acción unificada para las tres plataformas, sin ramas divergentes por plataforma. Su mecanismo, palabra por palabra:

> Luego de tocar Share/Publicar, esperamos **25 segundos**. Luego vamos al perfil, y ahí seleccionamos el **tercer video en la grilla** y **scroleamos hacia abajo** — esto hace que nos vayamos moviendo hacia el video más nuevo que existe en nuestro perfil. Si no apareció el video: botón de retroceder para volver al perfil, **esperamos 10 segundos**, volvemos a elegir la tercer publicación de la grilla y scroleamos.

### Racional (por qué es mejor que lo actual)
- El grid del perfil es lento/stale en las tres apps (hubo que forzar recomposición con tab-cycles; counts que no renderizan; tiles truncados). El **viewer** que se abre al tapear un tile carga contenido fresco de red al scrollear: navegando por posts alcanzamos el más nuevo sin depender del re-render del grid.
- La señal de confirmación es la más fuerte posible: **el caption de nuestro post visible en el viewer** (match por texto, ya probado en vivo en IG live2/live5 y TT `_opened_caption`).
- Un solo mecanismo = una sola implementación en `common.py` + configuración mínima por plataforma.

### Especificación funcional (aplicar EXACTAMENTE esto)
1. Tras la confirmación del tap final (toast TT / marker o fin de subida YT / transición post-Share IG — tal como está hoy): esperar **25s fijos** (`_VERIFY_INITIAL_WAIT = 25.0`).
2. Navegar al perfil del propio canal (IG: tab Profile; TT: tab Profile; YT: tab You → View channel con la tolerancia "ya en canal" existente `_enter_channel`).
3. Seleccionar el **tercer VIDEO de la grilla** (no el tercer nodo): los grids tienen tiles que no son videos y deben EXCLUirse del conteo — IG: tiles posicionales "Reel by … row N, column M" (todos los tiles son videos); TT: ignorar el tile de **Drafts** (ocupa el primer slot); YT: ignorar el tile "Drafts". Usar `_fresh_tap_target` para el tap (bounds frescos dentro del viewport — fix del tap fantasma).
4. En el viewer abierto, **scrollear hacia abajo** con swipe Bézier (definir `_SCROLL_SWIPE` fijo de pantalla, ej. `(360,1000)→(360,350) 400ms` — INVERSO al refresh; dirección exacta a validar empíricamente en el paso 0 de abajo). Tras cada swipe, leer dump fresco y buscar el **caption del job** (IG: nodo de texto del caption en el viewer; TT: `_opened_caption`; YT: caption del player; en todos match por texto/prefijo ya implementado).
5. Si el caption aparece → identidad confirmada → `completed` (retornar el texto/caption como identity, como hoy).
6. Si tras scrollear una cantidad acotada de swipes (sugerencia: **6 swipes** por intento, configurable `_VERIFY_MAX_SCROLLS`) el caption no apareció → **BACK** al perfil → esperar **10s** (`_VERIFY_RETRY_WAIT = 10.0`) → repetir desde el paso 3 (tercer video + scroll).
7. Límite de intentos: sugerencia **3 intentos** en total (inicial + 2 retries), constante `_VERIFY_MAX_CHECKS = 3`. Agotados → retornar `PublicationStatus.UNVERIFIED` con evidencia del último dump (`_verification_pending_evidence` existente) y log "verification pending". NUNCA error, NUNCA re-publicación (mantener semántica actual).
8. Fail-closed en cada paso: selector ambiguo/stale → error explícito como hoy; el BACK solo con verificación por dump; nunca taps a ciegas.

### Punto 0 OBLIGATORIO antes de escribir código: validación empírica en vivo
Con permiso ya dado por el usuario para explorar YouTube (extensible a IG/TT con su OK explícito en esa sesión): un subagente debe NAVEGAR MANUALMENTE el mecanismo en cada app (perfil → tercer video → scroll → observar hacia qué post se avanza) y responder con dumps de evidencia:
- **Dirección real del scroll**: ¿scrollear "hacia abajo" (swipe up, contenido sube) avanza hacia posts MÁS NUEVOS o MÁS VIEJOS en cada app? El usuario afirma que llega al más nuevo — confirmarlo por plataforma y ajustar `_SCROLL_SWIPE`/sentido si difiere. NO asumir: validar por app (el orden del viewer puede ser inverso al del grid).
- Si el viewer muestra indicador de "primer post alcanzado" (fin de navegación), documentarlo como condición de corte adicional.
- Qué expone el viewer de cada app en el árbol (caption completo/truncado, timestamps) para calibrar el matching.

### Implementación sugerida (código)
- Extraer el ciclo completo a `common.py` como primitiva compartida (estilo `_fresh_tap_target`), parametrizada por plataforma: selector del tercer video (callable), matcher del caption (callable), tabs de navegación al perfil. Los tres adapters llaman a la misma primitiva con su config — CERO ramas divergentes de lógica.
- Reemplazar `_tab_cycle_resync`/`_refresh_profile`/`_verify_check` de los tres adapters por la nueva secuencia (borrar las estrategias per-platform de delta por count/No-views/0-plays — el nuevo mecanismo no las necesita; el caption en el viewer es la única señal de confirmación).
- Mantener intactos: pre-checks, publish completo, confirmaciones de subida (toast TT 90s / marker YT 90s+gracia / post-Share IG), `_fresh_tap_target`, `_clickable_target`, package-scoping, estado UNVERIFIED y su mapeo en runner.
- Tests: reloj fake verificando 25s/10s/10s exactos; conteo del tercer video excluyendo Drafts (TT/YT); scroll con `_SCROLL_SWIPE`; confirmación por caption en el viewer en intento 1/2/3; agotar scrolls → BACK → retry; 3 intentos → UNVERIFIED con evidencia; nunca tap destructivo. Actualizar los tests existentes de verify de los tres adapters (los que testean tab-cycle/count-delta se reescriben al mecanismo nuevo).
- Suite debe quedar 100% verde (hoy 255).

### Validación en vivo tras implementar (con el usuario supervisando)
1. IG ×1 corrida completa en frío (force-stop antes) → objetivo `completed`.
2. TT ×1 (además cierra la deuda de los 2 posts `unverified` si el usuario quiere — o usar `tt-verify-identity.py --caption` para confirmarlos sin publicar).
3. YT ×1.
4. Posts de prueba NO se borran salvo autorización explícita.

## Pendientes después de este cambio (orden acordado con el usuario)
1. Fase verify general (este documento es el primer paso).
2. Estado `unverified` NATIVO en backend (`publication-worker-routes.ts`: FINISH_STATES y transiciones) + types del webapp.
3. Normalización de media en el pipeline (detectar HEVC 4K/incompatible → transcodificar a H.264 ≤1080p antes del push — bug de los videos MP-V).
4. Limpieza de posts de prueba SOLO con autorización (4 IG + 2 TT + 1 YT).
5. Revisión final + commits por componente (hoy: cero commits; TODO el trabajo vive en el worktree sucio).

## Notas rápidas para el agente implementador
- Correr tests: `cd publisher_worker && python -m unittest discover -s tests` (255 hoy).
- Captions de prueba usados (NO repetir): "Stay hungry, stay humble, and keep moving forward every day" / "Consistency compounds quietly so show up and do the work" / "Discipline is choosing what you want most" / "Fall in love with the process and trust it" / "Stay present, tomorrow is not promised" / "Your future is built by what you do today" / "Your habits shape your future not your dreams" / "Growth begins where your comfort zone ends" / "Push yourself because no one else will do it". Tema: mindset/self-improvement, inglés, ≤10 palabras (≤100 chars en YT).
- Los rids de TikTok son obfuscados (`o70`, `h00`, `st6`, `ofk`, `gi4`, `x4j`, `pjg`/`pje`...) — id completo `com.zhiliaoapp.musically:id/o70`.
- Baselines de perfiles al 2026-08-17 noche: IG 12 posts; TT 6 posts (counts `[80,209,152,86,578,646…]` con drift orgánico); YT 7 Shorts (6 baseline + "Push yourself…").
- Anomalías conocidas del árbol: bounds stale fuera de viewport (spans negativos o desplazados ~1400px) — ya filtrado por viewport checks; nodos preload duplicados de TT; SystemUI navbar con botón "Home" que colisiona — ya excluido por package-scoping.
