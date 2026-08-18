# Handoff maestro — Estado del proyecto y ruta para dejar la publicación funcional en la web

Fecha: 2026-08-18. Orquestador: sesión ZCode 2026-08-17/18.
Checkout: `C:\SouthFarm\source\.worktrees\semiorganic-publishing` (branch `codex/semiorganic-publishing`). **NADA commiteado — TODO el trabajo vive en el worktree sucio.**
Documentos complementarios (leer si toca el tema):
- `docs/HANDOFF_VERIFY_UNIFIED_2026-08-18_ES.md` — diseño pendiente del verify unificado "tercer tile + scroll" (mejora opcional, NO bloqueante).
- `docs/HANDOFF_ORCHESTRATOR_2026-08-17_ES.md` — contexto histórico del inicio de esta iniciativa.

---

## 1. Reglas operativas (del usuario — OBLIGATORIAS)

- Cuentas autorizadas: Instagram `marczell.vibes` (NUNCA `santilorennzo`), TikTok `@marczell.vibes`, YouTube canal `@MarczellWisdom`.
- Fail-closed innegociable: ante incertidumbre NUNCA tapear el botón destructivo (Share/Post/Upload). Un solo tap final por corrida, jamás re-tapear.
- Posts de prueba NO se borran salvo orden explícita. **Acumulados al 2026-08-18: 4 reels IG + 2 posts TikTok + 1 Short YouTube.**
- El usuario orquesta y supervisa en vivo (mira el celular); los subagentes ejecutan. Prompts < 3000 palabras. Trabajos sobre los mismos archivos → serializar. TODO lo que toca el teléfono → SIEMPRE serializado (un agente a la vez), y el usuario debe estar presente para las corridas en vivo.
- Subagentes: los custom (backend-pro, reviewer-pro, etc.) usan un proveedor con cuota limitada que falla por rate-limit; `general-purpose` corre sobre otro proveedor. Alternar según disponibilidad; si ambos caen, el orquestador puede hacer los cambios directamente (precedente: fix de youtube.py del 2026-08-18 hecho a mano).
- **RESTRICCIÓN CRÍTICA DEL ENTORNO**: el proveedor de los subagentes MUERE si leen imágenes (PNG/JPG) con Read → PROHIBIDO abrir imágenes; solo XML/logs/texto/código. Los screenshots se guardan como evidencia pero jamás se abren.
- Git Bash/MSYS corrompe paths `/sdcard` pasados como argumentos → SIEMPRE subprocess con lista de args o `MSYS_NO_PATHCONV=1`.

## 2. Dispositivo y entorno

- ADB serial `863d00583048313238510ca492874c`; pantalla 720×1640 (POCO C71, HyperOS, Android 15, **navegación de 3 botones ACTIVA** — la navbar SystemUI aparece en los árboles y su botón "Home" puede colisionar con tabs de las apps; ya resuelto por package-scoping).
- Servicio de accesibilidad SouthFarm (app `com.example.southfarm_app` instalada en el teléfono): dump XML por broadcast `am broadcast -n com.example.southfarm_app/.WarmupReceiver -a com.example.southfarm_app.DUMP_UI` → archivo `/sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml`, frescura por atributo `seq` de `<hierarchy>`. Leer con `MSYS_NO_PATHCONV=1 adb exec-out cat /sdcard/...`.
- El servicio muere esporádicamente (~4 veces documentado; HyperOS a veces limpia `enabled_accessibility_services` a null). El worker ya lo maneja: `SafeAdb.ensure_accessibility_healthy()` (check + reparación 1 vez con escritura explícita del componente canónico + gracia 6s sin dumps + rebind 15s; si no revive → abort `ACCESSIBILITY_SERVICE_DOWN` antes de tocar apps).
- WiFi del teléfono dependiente del ISP del usuario → el runner ya corre `ensure_network_up()` (abort `DEVICE_OFFLINE` sin red).
- Videos de prueba autorizados: `C:\Users\josu_\Downloads\Videos to test\0730 MA-V-{1..4}.mp4` (HEVC 1080×1920, 14-17s). **NO usar los `MP-V-*.mp4` viejos: HEVC 4K, la galería de Instagram los muestra pero ignora sus taps (bug del archivo, diagnosticado).**
- Node 22 para el harness/backend local: `C:/Users/josu_/AppData/Local/Temp/southfarm-node22/node.exe` (vía `SOUTHFARM_TEST_NODE_PATH`).

## 3. Estado del proyecto — qué funciona HOY (todo verificado en vivo 2026-08-17/18)

**Suite del worker: 255 tests OK** (`cd publisher_worker && python -m unittest discover -s tests`).

### 3.1 Publicación real validada en las 3 plataformas
| Plataforma | Publica | Confirmación lograda | Verify formal |
|---|---|---|---|
| Instagram | ✅ punta a punta | ✅ `completed` (caption leído en el viewer, +68.9s post-Share) | ✅ cerrado |
| TikTok | ✅ punta a punta | ✅ 2 posts reales (toast "Video posted!" +10.6s/+23s) | ⚠️ `unverified` ×2 (detector ya corregido: delta por "0 plays" prepend) |
| YouTube | ✅ punta a punta | ✅ 1 Short real (tile "No views" al frente + snackbar "Uploaded to Your Channel" +33s) | ⚠️ abort corregido (`_enter_channel` tolerancia "ya en canal") |

### 3.2 Arquitectura del worker (`publisher_worker/`, Python ≥3.11)
- `adb_device.py` — `SafeAdb`: `dump_ui()` (servicio, anti-stale por seq), `dump_ui_explicit('uiautomator')` (para la pantalla "Add details" de YouTube, protegida por Google — único caso), `swipe_bezier()` (curva Bézier cúbica replicando `SouthFarmAccessibilityService.swipe()`, vía `input motionevent` con fallback), `ensure_accessibility_healthy()` (reparación), `ensure_network_up()`.
- `platforms/common.py` — `GuardedPublisher`: `_one` (fail-closed + `package=` excluye SystemUI), `_fresh_tap_target` (re-dump + re-localización semántica + bounds dentro de viewport — fix "tap fantasma"), `_clickable_target` (ancestro clickeable de labels no-clicables — fix Next TikTok), `validate_caption` (10 palabras; YouTube ≤100 chars con rechazo `CAPTION_INVALID` pre-UI).
- `platforms/instagram.py|tiktok.py|youtube.py` — adapters con selectores reales validados en vivo. YouTube selecciona media por NOMBRE de archivo (`publication-<job>-<media>.mp4`).
- `runner.py` — `run_once(device_id)` / `run_forever(device_id)` (loop continuo, línea 129) / `main()` (línea 165). Pre-checks → prepare (identity+baseline) → push+scan → publish → verify. Mapea `unverified` → backend como `review_required` + `VERIFICATION_PENDING` + evidencia (el backend NO tiene estado nativo `unverified`).
- `models.py` — `PublicationStatus.UNVERIFIED` (terminal local: publicación real sin confirmación digital; JAMÁS re-publicación).
- Env del worker: `SOUTHFARM_API_URL`, `SOUTHFARM_PUBLISHER_WORKER_TOKEN`, `SOUTHFARM_PUBLISHER_WORKER_ID`, `SOUTHFARM_PUBLISHER_DEVICE_ID` (ver `runner.py:_config`).

### 3.3 Backend y webapp (ya desplegados, SIN cambios pendientes)
- `backend/src` y `webapp/src` están **limpios** (sin modificaciones en el worktree) — todo el sistema de publicaciones web ya existe y está commiteado: creación de jobs, media upload, claims con lease, checkpoints, polling 5s en la UI, estados `completed/cancelled/failed/review_required`, pestaña "Requiere revisión" en `webapp/src/app/publication-panel.tsx`, reprogramar/cancelar.
- Producción: webapp `https://southfarm-webapp.vercel.app`, API `https://api.southfarm.tech/api/health`.
- Estado máquina: `backend/src/publications-domain.ts` (`PUBLICATION_TRANSITIONS`, `PUBLICATION_TERMINAL_STATES`); finish del worker: `backend/src/publication-worker-routes.ts` (`FINISH_STATES`, línea 12; regla: `final_action_uncertain` → SIEMPRE `review_required`, línea 88).
- **Claim gate (importante para la Fase 3)**: `publications-domain.ts` línea ~107 — la query de claim de jobs `NOT EXISTS (... review.status = 'review_required')` por `social_account_id`: **una cuenta con un job pendiente de revisión no recibe nuevos claims**. Es correcto como fail-closed, pero hoy NO hay forma de resolver un review desde la web (solo se muestra) → con `unverified` siendo desenlace esperado, la cuenta queda congelada hasta intervención manual.
- Operación del worker ya diseñada (commits previos): `ops/windows/install-southfarm-publisher-worker.ps1`, `southfarm-api-supervisor.ps1`, `run-southfarm-maintenance.ps1`, `backend/scripts/southfarm-maintenance.mjs`.

### 3.4 Harness local E2E (verificado)
- `backend/scripts/local-pub-e2e.mjs`: levanta backend temporal con DB/seed (device android_id `aaa9c7a1f6cdb7a1`, cuentas marczell.vibes IG/TT + MarzellWisdom YT) + crea job real con metadata ffprobe. Uso: `node scripts/local-pub-e2e.mjs --video "<mp4>" --platform instagram --keep --monitor` (imprime el bloque de env completo para el worker). Requiere Node 22 (`SOUTHFARM_TEST_NODE_PATH`) y ffprobe (`SOUTHFARM_FFPROBE`).
- Harnesses de publicación en vivo (raíz del worktree, desechables, replican al runner): `ig-verify-live{2..5}.py`, `tt-verify-live{1..4}.py`, `yt-verify-live1.py`, `tt-verify-identity.py` (verify-only con `--caption`/`--prefix`).
- Evidencia de todas las corridas: `diag/` con prefijos `igverify*`, `ttverify*`, `ytverify*`, `ytrecon*` (+ logs `*-live.log` con timings). Los `e2e4-*` de la raíz son de corridas IG previas (jobs 9/10).

### 3.5 Git: qué está sucio (para la Fase 1)
- Modificados: `publisher_worker/southfarm_publisher/{adb_device,models,runner}.py`, `platforms/{common,instagram,tiktok,youtube}.py`, `tests/{test_adb_device,test_platform_adapters,test_runner,test_instagram_startup,test_youtube_adapter}.py`, `tests/fixtures/tiktok_{create_collision,verify_item}.xml`, `docs/superpowers/plans/2026-08-16-semantic-mobile-publishing.md`.
- Nuevos sin trackear: `backend/scripts/local-pub-e2e.mjs` (¡es del backend aunque esté en la carpeta de scripts — decidir si se commitea en esta rama o aparte!), `docs/HANDOFF_*_2026-08-1{6,7,8}_ES.md`, harnesses `*-verify-*.py` (raíz), `diag/` (evidencia — probablemente NO commitear, o solo logs), `publisher_worker/southfarm_publisher_worker.egg-info/` (ignorar), `e2e4-*`, `phone-*.png` (no commitear).
- `webapp/` tiene su propio `.git` — sin cambios pendientes.

---

## 4. LA RUTA: dejarlo funcional en la web (fases en orden, para ejecutar)

### FASE 1 — Commits por componente (BLOQUEANTE, riesgo máximo: hoy un accidente pierde todo)
1. `git status --short` y separar: (a) worker+tests+fixtures → 3-5 commits lógicos (ej: "feat(publisher): accessibility health + network pre-checks", "feat(publisher): guarded taps (fresh-target, clickable-ancestor, package scoping)", "feat(publisher): agile verify + unverified status per platform", "test(publisher): regression suite a 255"), (b) docs/handoffs → "docs: ...", (c) `local-pub-e2e.mjs` → decidir (va con backend pero vive en la rama del worker; commitearlo acá con scope `chore(harness)` es aceptable), (d) NO commitear: `diag/`, `*.png`, `e2e4-*`, egg-info, harnesses desechables (o un commit `chore` aparte si el usuario los quiere preservar).
2. PR a `main` (branch actual: `codex/semiorganic-publishing`). El usuario aprueba el merge.
3. Verificar suite verde antes de cada commit.

### FASE 2 — Test E2E desde la WEB (nunca ejecutado; era el punto 4 de la cola original)
Objetivo: crear una publicación desde la UI web y verla ejecutada por el worker real en el teléfono, con checkpoints en vivo.
1. Levantar el backend local con el harness (`local-pub-e2e.mjs --keep` imprime URL/puerto/env). Nota: el harness crea el job él mismo; para probar DESDE LA WEB usar `--keep` sin job o adaptar: lo esencial es que el backend local quede corriendo con las seeds.
2. Webapp local apuntando al backend local: `NEXT_PUBLIC_API_URL=http://localhost:<puerto>` (ver cómo lo lee `webapp/src`; el puerto lo imprime el harness).
3. Crear la publicación desde la UI (usuario supervisando) con un video `0730 MA-V-*.mp4` y cuenta/plataforma autorizadas.
4. Worker: script mini que llama `runner._config()` con el env del harness + `run_once(device_id)` (patrón de los e2e4) — o `run_forever` para verlo pullear.
5. Verificar en la web: job claimed → checkpoints (preparing/transferring/selecting_media/editing/captioning/publishing/verifying) → estado final (`completed` o `review_required`).
6. Documentar todo lo que falle del paso web (etiquetas, polling, errores de render de estados) — es la gracia del test.

### FASE 3 — Flujo de resolución de "Requiere revisión" (gap funcional REAL)
Problema: `unverified` → `review_required` es un desenlace ESPERADO del worker (publicación real sin confirmación digital), pero la web solo MUESTRA el estado; no hay acción para resolverlo, y el claim gate (`publications-domain.ts:107`) congela la cuenta hasta resolución.
1. Backend: nuevo endpoint `POST /api/publications/:id/review` (o similar) con dos desenlaces operador: **confirmar** (→ `completed` con evidencia manual, ej. "verificado por el operador") y **descartar/marcar fallido** (→ `failed` o un estado `dismissed`; definir semántica con el usuario). Solo para jobs `review_required`, solo rol con permisos (`canManage` ya existe en la webapp). Registrar evento en el historial del job.
2. Máquina de estados: agregar transición `review_required → completed|failed` por intervención manual (hoy `review_required: []` en `PUBLICATION_TRANSITIONS`).
3. Webapp: en la pestaña "Requiere revisión" (`publication-panel.tsx`, filtro línea ~103), botones "Confirmar publicación" / "Marcar como fallida" para jobs `review_required`, mostrando la evidencia que adjuntó el worker (`result` con dumps; render seguro de texto).
4. Tests backend (`backend/scripts/test-publications-*.mjs` existen como patrón) + test del panel (`publication-panel.test.tsx`).
5. Opcional en esta fase o después: estado nativo `unverified` en backend+webapp (hoy se mapea a review_required/VERIFICATION_PENDING — funciona, pero es menos expresivo; requiere tocar `FINISH_STATES`, transiciones y types).

### FASE 4 — Guard de media (lección HEVC 4K)
Problema: un video incompatible (HEVC 4K en IG) falla recién en la galería del teléfono con `MEDIA_UNSELECTABLE` — 2 minutos de corrida para un error que se sabía al subirlo.
1. Mínimo (recomendado primero): al crear la publicación/subir media, el backend ya corre ffprobe (`SOUTHFARM_FFPROBE` existe en el env del backend) → validar códec/resolución contra reglas por plataforma (IG: HEVC≤1080p OK, 4K NO; TT/YT: HEVC 1080p OK) y rechazar temprano con mensaje claro.
2. Ideal después: normalización automática (transcode ffmpeg a H.264 ≤1080p antes de que el worker lo pushee) — worker-side o backend-side; el usuario ya conoce la propuesta.
3. Registrar las reglas como datos por plataforma (misma tabla conceptual que los selectores).

### FASE 5 — Worker operativo continuo
1. Con el merge hecho: actualizar el checkout que corre en la PC del teléfono y reinstalar/actualizar el servicio con `ops/windows/install-southfarm-publisher-worker.ps1` (supervisor ya commiteado).
2. El worker corre `run_forever(device_id)` con las 4 env vars (`SOUTHFARM_API_URL/TOKEN/WORKER_ID/DEVICE_ID`) contra el backend de producción.
3. Requisitos operativos del teléfono: conectado por USB, servicio de accesibilidad habilitado (el worker lo auto-repara si crashea), WiFi activo (abort limpio si no), cuenta correcta logueada en cada app.
4. Monitoreo inicial: logs del supervisor + pestaña de la web. Los aborts `ACCESSIBILITY_SERVICE_DOWN`/`DEVICE_OFFLINE` son retryables por diseño.

### FASE 6 (opcional, no bloqueante) — Verify unificado "tercer tile + scroll"
Diseño completo del usuario + especificación en `docs/HANDOFF_VERIFY_UNIFIED_2026-08-18_ES.md`. Empieza por su "paso 0" (validar en vivo la dirección del scroll por plataforma). Puede hacerse antes o después de la Fase 5; no bloquea el funcionamiento web.

---

## 5. Conocimiento operativo acumulado (para no re-aprender a los golpes)

- Captions ya usados (NO repetir; tema mindset/self-improvement, inglés, ≤10 palabras, ≤100 chars YT): "Stay hungry, stay humble, and keep moving forward every day" / "Consistency compounds quietly so show up and do the work" / "Discipline is choosing what you want most" / "Fall in love with the process and trust it" / "Stay present, tomorrow is not promised" / "Your future is built by what you do today" / "Your habits shape your future not your dreams" / "Growth begins where your comfort zone ends" / "Push yourself because no one else will do it".
- Baselines de perfiles al 2026-08-18: IG 12 posts; TikTok 7 posts (6 + "Your habits shape…"; counts con drift orgánico); YT 7 Shorts (6 + "Push yourself…").
- Anomalías conocidas de los árboles a11y: bounds stale fuera de viewport (spans negativos o desplazados ~1400px — ya filtrado por viewport checks); nodos preload duplicados en TikTok; YouTube "Add details" invisible al servicio (solo uiautomator); navbar SystemUI colisiona por content-desc (ya excluida por package).
- Rids TikTok obfuscados: `o70` (Create), `o76` (Profile), `o74` (Home), `ofk` (grid), `gi4` (labels), `x4j` (Next picker), `pjg`/`pje` (Next editor hoja/contenedor), `st6` (Post), `h00` (caption), `zxp` (toast), `su5/su6` (upload %/status). Id completo: `com.zhiliaoapp.musically:id/o70`.
- YouTube: bottom bar SIN resource-ids (Buttons por content-desc: Home/Shorts/Create/Subscriptions/You); tabs del perfil solo Shorts/Posts; grid orden "Latest" (nuevo primero); tiles truncan caption (~80 chars) → matching por prefijo (50 chars, `_CAPTION_PREFIX_CHARS`).
- Historia de bugs y sus fixes (todos con test de regresión): tap fantasma por bounds stale → `_fresh_tap_target`; labels no-clicables → `_clickable_target`; colisión SystemUI → package-scoping; grilla lenta IG → tab-cycle + count; TikTok picker ya en Videos → skip; subidas lentas → ventana 90s; WiFi caído → `ensure_network_up`; servicio muerto → reparación con componente canónico + gracia; YT post-subida auto-navega → `_enter_channel`.

## 6. Comandos de referencia

```bash
# Suite del worker (255 OK hoy)
cd publisher_worker && python -m unittest discover -s tests

# Dump del árbol del teléfono (read-only)
adb -s 863d00583048313238510ca492874c shell am broadcast -n com.example.southfarm_app/.WarmupReceiver -a com.example.southfarm_app.DUMP_UI
MSYS_NO_PATHCONV=1 adb -s 863d00583048313238510ca492874c exec-out cat /sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml

# Harness E2E local (backend + seeds + job)
cd backend && SOUTHFARM_TEST_NODE_PATH=C:/Users/josu_/AppData/Local/Temp/southfarm-node22/node.exe node scripts/local-pub-e2e.mjs --video "C:/Users/josu_/Downloads/Videos to test/0730 MA-V-1.mp4" --platform instagram --keep --monitor

# Estado git (recordar: webapp tiene SU propio .git)
cd C:/SouthFarm/source/.worktrees/semiorganic-publishing && git status --short
```
