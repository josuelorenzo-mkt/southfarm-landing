# Handoff — Publicación semiautomática multiplataforma (Instagram/TikTok/YouTube)

Fecha: 2026-08-17 (noche). Orquestador: sesión ZCode anterior.
Checkout: `C:\SouthFarm\source\.worktrees\semiorganic-publishing` (branch `codex/semiorganic-publishing`).
Leé TAMBIÉN: `docs/HANDOFF_AGENT_INSTAGRAM_MANUAL_ADB_2026-08-16_ES.md` (contexto histórico del bloqueo original, ya resuelto).

## Reglas operativas (del usuario — OBLIGATORIAS)

- Cuenta Instagram autorizada: `marczell.vibes`. NUNCA usar `santilorennzo`.
- El usuario orquesta y analiza; los subagentes ejecutan (sus subagentes custom: backend-pro, reviewer-pro, frontend-flash, researcher-flash, architect-luna).
- Publicaciones de prueba: MÁXIMO cuidados; TODO post de prueba se borra al final, SALVO orden explícita del usuario. **AHORA MISMO hay 1 reel de prueba SIN BORRAR en el perfil (job 10, caption "Stay present, tomorrow is not promised") — NO borrarlo hasta que el usuario lo autorice.**
- Fail-closed es innegociable: ante incertidumbre nunca tapear el botón destructivo (Share/Post/Upload/Delete).

## Estado del sistema (todo sin commit, en 2 checkouts)

### 1. App Android (canónica: `C:\SouthFarm\source\southfarm_app`, NO la copia del worktree)
- Servicio de accesibilidad expone dump XML estilo uiautomator por broadcast:
  `am broadcast -n com.example.southfarm_app/.WarmupReceiver -a com.example.southfarm_app.DUMP_UI`
  → escribe atómicamente `/sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml`
- Features: `flagReportViewIds` (resource-ids visibles), `@Synchronized` + contador `seq` en `<hierarchy seq="N">` (anti-stale), dedup de ventanas por firma, `packageNames` incluye instagram+tiktok+youtube+apps.creation.
- INSTALADA en el teléfono (debug firmada con keystore WSL — para reinstalar: `cp C:/ProgramData/SouthFarm/tmp-cert/wsl-debug.keystore C:/Users/josu_/.android/debug.keystore`, `flutter build apk --debug`, restaurar `windows-debug.keystore.bak`, `adb install -r`).
- LIMITACIÓN conocida: la pantalla "Add details" de YouTube tiene árbol VACÍO por el servicio (protegida por Google) → el adapter usa `dump_ui_explicit('uiautomator')` ahí (funciona, es pantalla estática).

### 2. Worker (`publisher_worker/` del worktree) — suite 158/158 verde
- `adb_device.py`: `SafeAdb.dump_ui()` usa el servicio por defecto (`SOUTHFARM_UI_SOURCE`); polling tolerante a rc=1 + delay 0.3s + validación frescura por `seq`; `dump_ui_explicit(source)` para uiautomator puntual.
- `platforms/instagram.py`: reescrito con selectores reales (verificados en vivo). Publica de punta a punta: **job 10 terminó `completed`** (identidad verificada) en integración real con arranque en frío.
- `platforms/tiktok.py` y `platforms/youtube.py`: reescritos con selectores reales (flujos manuales completados publicando+verificando+borrando en vivo), tests verdes, PERO sin test de integración worker-real todavía.
- Tests: `tests/test_adb_device.py`, `test_platform_adapters.py`, `test_instagram_startup.py` (nuevo), `test_youtube_adapter.py` (nuevo), `test_runner.py`. Correr: `cd publisher_worker && python -m unittest discover -s tests`.

### 3. Harness E2E (`backend/scripts/local-pub-e2e.mjs` — verificado)
- Levanta backend temporal + seeds (device android_id `aaa9c7a1f6cdb7a1`, cuentas marczell.vibes IG/TT + MarzellWisdom YT) + crea job real con metadata del video.
- REQUIERE Node 22: `export SOUTHFARM_TEST_NODE_PATH=C:/Users/josu_/AppData/Local/Temp/southfarm-node22/node.exe`.
- Uso: `node scripts/local-pub-e2e.mjs --video "C:/Users/josu_/Downloads/Videos to test/MP-V-2.mp4" --platform instagram --keep --monitor` (imprime bloque env completo para el worker).
- Worker de prueba: mini script que llama `runner._config()` + `run_once(device_id)` (crear y borrar al terminar; no quedó ninguno).

### 4. Driver manual (`C:\ProgramData\SouthFarm\tmp-cert\sf_drive.py`)
- dump/find/tap semántico fail-closed/text/key/screenshot/tap-video por duración. Evidencia de toda la sesión en `tmp-cert/*.xml` y `*.png` (ig-*, tt-*, yt-*, e2e*).

## Bug abierto Nº1 (prioridad máxima): verify() de Instagram

**Síntoma:** job 9 publicó OK pero verify falló (falso negativo) — Instagram demoró ~2min en materializar el reel. Job 10 con el mismo código sí cerró `completed`.

**Causas raíz identificadas (con evidencia en código y dumps):**
1. `_refresh_profile` (instagram.py:286) calcula el swipe desde bounds del árbol a11y del perfil, que sufre staleness con bounds fuera del viewport (negativos tipo `[-2160,415]`) → el swipe va a coordenadas fantasma → no produce refresh visible. El usuario CONFIRMÓ que nunca vio el gesto.
2. Ventana `VERIFY_DELTA_TIMEOUT = 75.0` insuficiente (delay real observado ~2min).

**Fix acordado con el usuario (sin aplicar):**
1. Swipe con coordenadas fijas relativas a pantalla física (x=360, y de 350 a 1000, 400ms) — NO derivadas del árbol.
2. Mecanismo alternativo/primario: tab-cycle (Profile→Home→Profile) que fuerza recomposición del árbol (observado funcionando).
3. `VERIFY_DELTA_TIMEOUT` 75→180s.
4. Tests de regresión (tests/test_instagram_startup.py, estilo fakes por cola + swipes grabados; el fake Device ya registra swipes).
5. Hipótesis secundaria a validar empíricamente (Fase A del diagnóstico interrumpido): comparar árbol tras (a) nada, (b) swipe real `adb shell input swipe 360 400 360 1100 400`, (c) tab-cycle — para elegir el mecanismo primario con evidencia. Los tiles del perfil NO exponen IDs únicos (todos "Reel by Marczellvibes at row N, column M"); el feed SÍ expone timestamps ("posted a video N minutes ago").

## Cola de trabajo (en orden)

1. Fix verify() de Instagram (arriba) + tests → re-test integración ×2 frías (force-stop antes de cada corrida; objetivo 2/2 `completed`).
2. Test integración TikTok (worker real ×1-2, cleanup manual posterior — recordar regla de autorización de borrados).
3. Test integración YouTube ×1-2 (adapter híbrido; "Add details" solo por uiautomator).
4. Test end-to-end desde la WEB: webapp con `NEXT_PUBLIC_API_URL=http://localhost:3001` (o el puerto del harness) apuntando al backend local, crear publicación desde la UI, worker local la ejecuta, verificar checkpoints en la UI (polling 5s ya implementado).
5. Borrar el reel de prueba restante SOLO cuando el usuario autorice.
6. Al final de todo: revisión + commits (nada commiteado hasta ahora por decisión del orquestador).

## Datos del dispositivo

- Serial ADB: `863d00583048313238510ca492874c`; android_id `aaa9c7a1f6cdb7a1`; pantalla 720×1640 (POCO C71).
- Cuentas: IG `marczell.vibes` (8 posts baseline real, 1 reel de prueba extra ahora), TikTok `@marczell.vibes`, YouTube canal "Marczell Wisdom".
- Videos de prueba autorizados: `C:\Users\josu_\Downloads\Videos to test` (usar MP-V-2.mp4, 14.9s).

## Notas para subagentes

- Trabajos que tocan los mismos archivos → serializar (un agente por archivo). Telefonología: TODO lo que toca el teléfono se serializa SIEMPRE.
- Prompt <3000 palabras: un agente murió 3 veces con prompts largos (aunque 2 fueron rate-limit del plan GLM).
- Los rids de TikTok son obfuscados (`o70`, `h00`, `st6`...) — full id `com.zhiliaoapp.musically:id/o70`.
- Cuidado con MSYS: paths `/sdcard` como argumento se corrompen en Git Bash → usar `exec-out cat` o subprocess list.
