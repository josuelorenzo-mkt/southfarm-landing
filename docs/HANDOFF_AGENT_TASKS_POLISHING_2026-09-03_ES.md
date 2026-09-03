# Handoff — Pulido de Warmup/Scan + cierre de app social + avatares (2026-09-03)

> Sesión de origen: continuation de `sess_85b4f52a` ("Pulir funcionalidades WarmUp Posting Scan")
> en el worktree `C:\SouthFarm\source\.worktrees\tasks-polishing`, branch
> `feature/ui-redesign-granja-tecnologica`. Documento autocontenido: no requiere
> conocer sesiones anteriores.

## 1. Qué es SouthFarm (30 segundos)

Sistema de automatización de redes sociales sobre una flota de teléfonos Android
(POCO C71). Un backend Node sirve una web de command center; los teléfonos
corren una app Flutter con un `AccessibilityService` Kotlin que maneja
Instagram/TikTok/YouTube como lo haría un humano (warmup, scan de cuentas,
posting). Hay además un worker Python de publishing (otro worktree) y scripts
de ops en Windows.

**Modo de trabajo con el dueño (Josue)**: él hace TODOS los tests manuales en
el teléfono. El agente orquesta, los subagentes escriben código (usar
`general-purpose`; los agentes GLM-5.3-flash devolvieron placeholder sin hacer
nada — no usar). Cada versión instalable en el teléfono = commit inmediato
(regla de AGENTS.md). Nunca entregar algo que solo exista en el working tree.

**LEER PRIMERO**: `C:\SouthFarm\SESIONES_Y_PUERTOS.md` — contrato de puertos
entre sesiones simultáneas. Producción = puerto 3001 (intocable sin OK del
dueño). NUNCA matar node por nombre de imagen; verificar CommandLine del PID
antes de matar nada (esta sesión mató por error un proceso del puerto 3000 de
otra sesión — no repetir).

## 2. Mapa del sistema y rutas críticas

| Pieza | Ruta | Notas |
|---|---|---|
| Repo principal | `C:\SouthFarm\source` | branch `feature/ui-redesign-granja-tecnologica` |
| App móvil ACTIVA | `southfarm_app/` | `lib/main.dart` (~3800 líneas, toda la app Flutter) |
| Escáneres/warmup | `southfarm_app/android/app/src/main/kotlin/com/example/southfarm_app/SouthFarmAccessibilityService.kt` | ~4600 líneas, TODO el automovilismo |
| `southfarm_app_v2/` | copia NO usada (1.2.0+120) | ignorar |
| Backend | `backend/` (TS, express, better-sqlite3) | `npm run build` = tsc → `dist/` |
| Web | `webapp/` | **repo anidado con git propio**, linkeado a Vercel (deploy desde GitHub) |
| DB producción | `C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db` | ⚠️ NO es `backend/data/southfarm.db` (esa es dev) |
| Runtime producción | `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend` | copia deployada; corre `node dist/index.js` |
| Avatares producción | `...\runtime\backend\data\avatars\` | módulo-relativo (ver avatars.ts) |
| API pública | `https://api.southfarm.tech` → cloudflared → `127.0.0.1:3001` | tarea programada "SouthFarm API" |

### Teléfonos (adb)
- **08** (el de pruebas del dueño): serial `863d00583048313238510ca492874c`
- **02** (operativo, NO desinstalar la app): `863d00583048313238510d44eca24c`
- Screen 720x1640. Instalar con `adb -s <serial> install -r` (NUNCA bajar
  versionCode: Android bloquea downgrades; para A/B usar versionCodes altos).

### Comandos adb útiles (Git Bash en Windows)
```bash
# SIEMPRE MSYS_NO_PATHCONV=1 en comandos con rutas
MSYS_NO_PATHCONV=1 adb -s <serial> shell am broadcast \
  -n com.example.southfarm_app/.WarmupReceiver \
  -a com.example.southfarm_app.DETECT_ACCOUNTS --es platform instagram
# Otras acciones: START_WARMUP / STOP_WARMUP / GET_STATUS / DUMP_UI
#   extras: --es username X --ei duration N --es platform instagram|tiktok|youtube
adb logcat -s SouthFarmA11y:E        # logs del servicio (buffer rota en segundos)
```
⚠️ Un scan lanzado por broadcast NO hace POST al backend (solo callback local);
el POST `/api/social-accounts` lo dispara la app Flutter al escanear desde la
UI. Para probar enriquecimiento de avatares, el scan debe salir de la app.

## 3. Qué se hizo en esta sesión (histórico, commits en orden)

1. **`c0dce36` (vc28)** — Cierre de app social al terminar/detener toda tarea
   (warmup/scan/publish), secuencia: Recents → fling arriba → Home →
   killBackgroundProcesses. El fling debe arrancar DENTRO de la tarjeta
   (0.45h→0.08h, 250ms; el 0.60h original fallaba). **Validado por el dueño**.
   Incluye `TEST_NO_OVERLAYS=true` (modo QA sin overlays; volver a false para
   producción).
2. **A/B con versión pre-cierre (1.1.8-ab1+40)** — probó que los scans YA
   andaban mal antes del cierre: no fue una regresión nuestra.
3. **`d2ee684` (vc42)** — TikTok más rápido (sleep 3.5s fijo → poll acotado,
   fallback tab "Perfil", waits reducidos). YouTube: sacó la visita de cuentas
   inactivas → **REVERTIDO por el dueño en el commit siguiente**.
4. **`daf86e7` (vc43)** — Revert del scan YouTube (la visita de cuentas
   inactivas ES necesaria: YouTube solo expone el @handle de la cuenta activa
   en el desplegable). Avatares persistentes (backend descarga y sirve fotos
   locales, GET `/api/avatars/:filename` sin auth, preservadas entre rescans).
   Logos de plataforma reales en la app (widget `PlatformLogo`, CustomPainter:
   cámara IG con gradiente, play rojo YT, nota musical TikTok) en 3 sitios.
   Web: avatar con foto + fallback inicial (commit webapp `c82e056`).
5. **`6c5241d` (vc44, ACTUAL)** — Fix doble `/api` en `resolveAvatarUrl` del
   móvil (API_BASE termina en `/api` → concatenaba `/api/api/...` → 404).
   Scrapers IG/TikTok robustecidos (ver §5). Scan IG tolerante a cold start
   (retry de switcher + lectura consolidada + log verbose de filas).

## 4. Estado al cerrar la sesión

- **Teléfono 08**: vc44 (`1.1.8+44`) instalada. `TEST_NO_OVERLAYS=true`
  (QA). Accesibilidad activa.
- **Backend producción**: corriendo con todo el código nuevo (avatares +
  scrapers). Health 200. Ruta de avatares verificada devolviendo imágenes.
- **Web**: commit `c82e056` en `webapp` local, **NO pusheado** (Vercel deploya
  desde GitHub → el cambio de avatares en la web NO está vivo hasta push).
- **Verificado por agente**: scan IG en cold start detecta **4/4 cuentas**
  (marczell.wisdom, santilorennzo, marczell.vibes, growtech.news) con la
  traza completa en logcat. Avatares IG y TikTok descargan OK a nivel módulo.
- **PENDIENTE de validación del dueño** (avisarle que pruebe): scan IG desde
  la app → 4 cuentas + fotos a los pocos segundos; scan TikTok → fotos;
  sección de cuentas mostrando las fotos de YouTube (ya estaban en DB).

## 5. Conocimiento duro adquirido (no obvio, costó descubrirlo)

- **Cierre de app ⇒ cold start siempre**: al cerrar la app social al final de
  cada tarea, el próximo scan abre IG/TikTok en frío. Todos los sleeps fijos
  son frágiles → usar polls con timeout. El switcher de IG puede tardar >3s
  en exponer el header accionable.
- **Filas del switcher IG**: content-desc = `"username"` (activa, selected),
  `"username, N chats"`, `"username, N likes and X more"`, `"username, N
  notifications"`. El extractor `findSwitcherAccountsStrict` valida estricto
  (hay basura histórica "3followers"/"14following" en la DB de cuando no).
- **Instagram sirve `og:image` SOLO a user-agents de crawler**
  (facebookexternalhit/Googlebot); a UAs de navegador responde login-wall.
  Orden actual en `avatars.ts`: crawler UA → `i.instagram.com
  /api/v1/users/web_profile_info` (X-IG-App-ID 936619743392459) → browser UA.
- **TikTok bloquea el scrape directo**; cadena actual: og:image → Googlebot →
  regex estado embebido → `https://unavatar.io/tiktok/{user}?fallback=false`
  (fallback=false evita guardar el placeholder genérico; un usuario inválido
  devuelve 403 y el downloader lo rechaza).
- **YouTube**: og:image del canal funciona + fallback ytInitialData. Solo
  expone @handles de la cuenta Google ACTIVA (por eso el scan visita las
  inactivas; el dueño lo confirmó necesario).
- **Kotlin**: `break` no compila dentro de `repeat{}` (es lambda) → usar
  `for`.
- **Deploy backend producción**:
  ```bash
  cd backend && npm run build
  powershell -File ops/windows/publish-southfarm-backend-runtime.ps1 \
    -SourceBackendPath "C:\SouthFarm\source\backend" \
    -RuntimeBackendPath "C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend"
  # (los paths explícitos son OBLIGATORIOS: $PSScriptRoot llega vacío desde bash)
  # El copy de node_modules falla con IOException en better_sqlite3.node
  # (bloqueado por el proceso en 3001): EXPECTADO e inofensivo si no cambiaron
  # dependencias. NUNCA dejar que copie el better_sqlite3.node del repo (está
  # compilado para otro Node que el del runtime).
  schtasks /End /TN "SouthFarm API" && schtasks /Run /TN "SouthFarm API"
  # verificar: netstat :3001 LISTENING con PID nuevo + curl health
  # taskkill directo falla con Access Denied (proceso SYSTEM): usar la tarea.
  ```
  El proceso NO recarga módulos: hay que reiniciar la tarea para que un
  deploy aplique. Registrar cada deploy en SESIONES_Y_PUERTOS.md (regla 7).
- **`pubspec.yaml` está en .gitignore**: commitear con `git add -f`.
- **versionCodes usados**: ...24 (vc24 BACK-loop viejo), 26, 27-28 (cierre),
  40 (A/B pre-cierre), 41, 42, 43, 44 (actual). Próximo: **45**.

## 6. Pendientes conocidos (backlog)

1. **`TEST_NO_OVERLAYS` sigue `true`** en `SouthFarmAccessibilityService.kt`
   — volver a `false` antes de cualquier build para el dueño final/flota.
2. **Webapp sin push** (`c82e056`): el dueño decide cuándo pushear a GitHub
   (Vercel deploya solo). Sin push, la web no muestra avatares.
3. Avatares IG son thumbs 100x100 (og:image); aceptable por ahora, HD
   requiere el endpoint interno de IG (hoy rate-limited).
4. Worker Python `force_stop` (commit `00960b4`, repo
   `feature/device-fleet-live-view`) **sin desplegar a producción**.
5. Instalación fresca de la app crashea el scan sin permiso de overlay:
   `adb shell appops set com.example.southfarm_app SYSTEM_ALERT_WINDOW allow`.
6. Ruido `Global control poll failed: HTTP 401` en el teléfono 08 (sin
   diagnosticar).
7. Duplicados históricos en `social_accounts` (mismo username, distintos
   device_id) — normal por diseño (DELETE+INSERT por dispositivo).

## 7. Cómo continuar (guía rápida del próximo agente)

1. Leer `SESIONES_Y_PUERTOS.md` y este doc. Verificar `git log --oneline -10`
   y `git status` (puede haber artefactos: `.tmp-qa/`, `visual-tests/`, etc.
   — no son de esta sesión, no tocarlos).
2. Preguntar al dueño el resultado de sus tests manuales pendientes (§4).
   Si algo falla: reproducir con broadcast + `logcat -s SouthFarmA11y:E`
   (las filas del switcher IG ahora dejan traza completa de aceptadas y
   rechazadas).
3. Para cambios en la app: editar → `flutter build apk --release` (build
   incremental ~1-6 min) → `install -r` en el 08 → dejar que el dueño
   pruebe → commitear (`git add -f` para pubspec).
4. Para cambios en backend: editar `src/` → tsc → testear módulos con
   `node -e "import('./dist/...')"` → deploy (§5) → registrar en el doc de
   puertos.
5. Subagentes `general-purpose` para escribir código; prompts con rutas
   absolutas, números de línea verificados y lista explícita de "no tocar".
