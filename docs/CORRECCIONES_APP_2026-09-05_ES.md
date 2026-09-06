# Correcciones y mejoras de la app SouthFarm — Cierre 2026-09-05

> Registro de todo lo corregido entre la vc42 (2026-08-28) y el release
> **1.1.8+57** (2026-09-05), en la branch `feature/ui-redesign-granja-tecnologica`.
> Complementa (no reemplaza) `docs/HANDOFF_AGENT_TASKS_POLISHING_2026-09-03_ES.md`.

## Release actual

- **Versión**: `1.1.8+57` (producción, overlays completos activos).
- **Instalada en toda la flota conectada** (5 teléfonos): 08, 02, y los tres
  históricos vc11/vc22 (reinstalación fresca — ver §Notas de flota).
- **Commits**: `5f92c87` (última corrección) y `f01f4b7` (release). Push a
  `origin`. Webapp: `e882014` + `0c12f50` pusheados a `main` (Vercel deploya).

## Flags de overlays (importante para el próximo release/QA)

En `SouthFarmAccessibilityService.kt` (líneas ~30-37) hay DOS flags:

| Flag | Producción | QA (ver pantalla en vivo) | Qué controla |
|---|---|---|---|
| `TEST_NO_OVERLAYS` | `false` | `false` | SOLO la burbuja de control. `false` = burbuja visible (siempre visible en ambos modos). |
| `TEST_NO_LOADING_OVERLAY` | `false` | `true` | SOLO las capas fullscreen (4 capas opacas de carga + bordes de onda). `true` = ocultas en QA. |

⚠️ El release 57 quedó con `TEST_NO_LOADING_OVERLAY = false`. Si se vuelve a
modo QA, ponerlo en `true` y recordarlo devolver a `false` para el próximo
release.

## Correcciones incluidas (en orden)

### 1. Scans pulidos (vc42, `d2ee684`)
- **TikTok**: el sleep fijo de 3.5s tras abrir la app (que se pagaba siempre)
  se reemplazó por espera acotada con polling (hasta 6s, sale apenas la app
  responde); fallback del tab "Perfil" en español; esperas de reintento
  reducidas (1s→0.6s, 1.8s→1.2s). Home → Profile notablemente más rápido.
- YouTube: se había simplificado el scan, **revertido por decisión del dueño**
  (ver §3).

### 2. Avatares persistentes de todas las plataformas (vc43, `daf86e7`; fixes vc44/45)
- **Causa raíz del problema histórico**: los escáneres no pueden capturar fotos
  (el árbol de accesibilidad no expone URLs de imágenes) y el backend solo
  compensaba Instagram con URLs del CDN que **expiran** → fotos rotas con el
  tiempo.
- **Solución**: el backend descarga cada foto a `data/avatars/` y la sirve por
  `GET /api/avatars/:filename` (sin auth, cache 7 días, path traversal
  protegido). El POST `/social-accounts` preserva fotos entre rescans
  (snapshot antes del DELETE) y enriquece async las que faltan.
- **Scrapers** (backend/src/avatars.ts): Instagram sirve `og:image` SOLO a
  user-agents de crawler (facebookexternalhit) — login-wall a navegadores;
  orden: crawler UA → `i.instagram.com/api/v1/users/web_profile_info`
  (X-IG-App-ID 936619743392459) → browser UA. TikTok bloquea el scrape directo:
  og:image → Googlebot → regex estado embebido → `unavatar.io?fallback=false`
  (evita guardar placeholder). YouTube: og:image + fallback ytInitialData.
- **App**: `resolveAvatarUrl` resuelve rutas relativas contra el ORIGEN del API
  base (API_BASE termina en `/api`; concatenar directo producía
  `/api/api/avatars/...` → 404). Fix de `mergeAccountMetadata` que pisaba la
  URL con '' en YouTube.
- **Auto-refresh** en AccountsScreen: timer de 5s que re-fetchea SOLO mientras
  haya cuentas con avatar vacío + pull-to-refresh + setState solo si cambiaron
  los datos. Ya no hace falta cambiar de pestaña para ver las fotos.

### 3. Scan de YouTube — visita de cuentas inactivas (vc43, revertido y re-aplicado)
- YouTube solo expone el **@handle de la cuenta Google activa** en el
  desplegable. El ciclo "entrar a cada cuenta inactiva → leer → volver" ES
  necesario para capturar todos los handles (decisión del dueño tras entender
  el trade-off). Quedó como estaba originalmente.

### 4. Scan de Instagram — 4/4 cuentas garantizado (vc44/46, `6c5241d`, `6c586d0`)
- **Causa raíz de la cuenta faltante**: el extractor solo aceptaba la cuenta
  activa o filas con sufijo de actividad (", N chats" / ", N notifications").
  Una cuenta sin pendientes tiene desc pelado ("growtech.news") y era
  rechazada SIEMPRE — la intermitencia dependía de si tenía badge de
  notificaciones.
- **Fix**: validación en dos niveles. Tier 1 = lógica original; Tier 2 = desc
  de username pelado válido, aceptado SOLO si hay ≥1 fila Tier 1 (protege
  contra el falso positivo histórico de la pantalla de perfil).
- **Robustez cold start**: retry de apertura del switcher (10×700ms, árbol
  fresco por intento) + lectura consolidada del listado (14 pasadas, corte
  tras 3 sin novedades Y ≥5s) + log verbose de cada fila rechazada con motivo
  ("Switcher row rejected: ..."). Verificado 4/4 en cold starts consecutivos.

### 5. Sección de cuentas y Warm Up (vc46-49)
- **Orden alfabético** de cuentas en Accounts y Warm Up
  (`sortAccountsByUsername`, case-insensitive) aplicado en los 12 puntos de
  asignación de datos — cubre listado, picker y cuenta por defecto.
- **Foto en la fila colapsada del Warm Up**: la carga inicial usaba solo cache
  local (sin fotos); ahora usa la misma estrategia que el picker (YouTube =
  merge local+backend, TikTok = backend-first).
- **Cuenta fantasma tras "Clean accounts"**: el clean solo borraba en el
  backend. Ahora también limpia cache local (`_accountCacheKey`) y la
  preferencia de última cuenta por plataforma, y la selección solo se
  conserva si la cuenta existe en la lista.
- **Refresco entre secciones**: Accounts y Warm Up viven en un `IndexedStack`
  (ambas montadas) — se agregó `AccountsChangeNotifier`: Accounts dispara tras
  un clean exitoso y tras cada scan; Warm Up escucha y recarga sola (con guard
  `!_isRunning` para no pisar un warmup en curso).

### 6. Logos oficiales de plataforma (vc43 + vc54)
- Instagram: cámara con gradiente (CustomPainter). YouTube: play rojo oficial.
- **TikTok (vc54, `185097c`)**: reemplazada la nota musical genérica por el
  glifo oficial (path de simple-icons convertido a CustomPainter con doble
  verificación aritmética) con tratamiento tricolor: cian #25F4EE
  arriba-izquierda, rojo #FE2C55 abajo-derecha, blanco al centro.
- Orden global de plataformas en toda la app y la web:
  **Instagram, YouTube, TikTok** (warmup chips, clean dialog, PLATFORMS web,
  publication panel, activity planner).

### 7. Overlays en modo QA (vc51-53)
- El flag de QA tenía una vía sin cubrir: `MainActivity.startOverlay()`
  (MethodChannel del Flutter al lanzar warmup) arrancaba el overlay igual.
  Corregido, y luego el flag se dividió en dos (ver tabla de arriba).
- **Descubrimiento clave**: la "burbuja" era en realidad 4 capas fullscreen
  opacas + bordes de onda, con un botón circular de 120px encima. En QA ahora
  queda ÚNICAMENTE el botón circular (+ su popup Pausar/Detener); las capas
  fullscreen solo se dibujan en producción.

### 8. Save en YouTube Shorts adaptado al nuevo YouTube (vc55/56, `907ff9d`, `5f92c87`)
- YouTube actualizó Shorts: ahora hay botón directo "Save" en la barra lateral.
- **Regla nueva**: al intentar un guardado, primero se busca el botón directo;
  si está, un toque y el save queda hecho. Si no está, cae sin abortar al
  flujo completo histórico (⋮ Más → "Save to playlist" → sheet → "Watch
  later"/primera playlist → verificación), que quedó intacto como fallback.
- **Selector calibrado con dump real** (`uiautomator dump` con un Short en
  pantalla): el botón es el ÚNICO nodo del árbol con content-desc EXACTO
  "Save" (ViewGroup clickable propio, SIN resource-id, rail derecho ~82% del
  ancho). Por eso el matching es por **igualdad exacta** Save/Guardar — el
  estado ya-guardado expone "Saved" y un `contains` habría re-tapado y
  DESGUARDO el video. Lección de método: calibrar selectores contra el árbol
  real, no contra supuestos.
- Probado por el dueño en el 08: guardado funcionando correctamente.

## Notas de flota (release 57)

- Los 5 teléfonos conectados quedaron en **vc57** con accesibilidad activa y
  permiso de overlay (`appops SYSTEM_ALERT_WINDOW allow`) verificados.
- **Dos teléfonos** (...d997f1d4c y WiFi 192.168.0.36) tenían builds con OTRA
  firma (era vc11): fue necesario desinstalar y reinstalar. Consecuencia:
  `ANDROID_ID` cambia al cambiar la firma → aparecen como dispositivos NUEVOS
  en el backend y necesitan re-emparejamiento/provisionamiento (los registros
  viejos quedan huérfanos).
- Google Play Protect intercepta instalaciones frescas con un diálogo ("Send
  app for a security check?") — se responde "Don't send" para desbloquear.
  En installs -r (updates) no aparece.
- Tras cada `install -r` conviene verificar accesibilidad
  (`settings get secure enabled_accessibility_services`) — a veces se apaga.
- ⚠️ El worker Python de posting: fix `force_stop` (commit `00960b4`, repo
  `feature/device-fleet-live-view`) sigue SIN desplegar a producción.
