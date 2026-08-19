# Handoff — Sesión 2026-08-18/19: publicación en producción + flota WiFi + incidente del revert de app

Continúa de `docs/HANDOFF_SESSION_2026-08-18_FASE1-4_ES.md` (fases 1-5 del proyecto publishing, todas completas). Este documento cubre TODO lo posterior: despliegue a producción, E2E web real, flota WiFi completa, y el **incidente de versiones de app con estado roto pendiente de decisión**. La sesión anterior sufrió compactación de contexto (43 MB) que BORRÓ segmentos de conversación — leer sección 9 antes que nada.

---

## 0. LO URGENTE — estado roto del teléfono "08" (decisión pendiente del usuario)

El teléfono principal ("08", fila #28) fue **revertido a la app 1.1.8** a las ~00:28 del 19-ago durante un segmento de conversación que la compactación borró (detalle en sección 9). Estado actual verificado:

- App **1.1.8** (build SIN debug → `run-as` falla → el supervisor del worker no puede validar identidad legacy)
- **Latidos con error 401** (`Heartbeat: response=401 device=fd2f46b48e71496a` en logcat) → la fila "08" aparece offline en la web; scan/warmup/publicación NO funcionan en él
- **Worker "SouthFarm Publisher Worker" (windows-28) MUERTO** — el supervisor falla el check de identidad (run-as) y no reinicia
- Su identidad/pareo NO se perdió (device_id fd2f46b48e71496a sigue en la app)

**Opciones presentadas al usuario (no eligió aún):**
1. **Restaurar 1.2.0 debug en el lugar** (recomendada): `adb -s 192.168.0.21:5555 install -r <app-debug.apk>` (misma firma debug → conserva datos/pareo), reiniciar tarea "SouthFarm Publisher Worker", verificar latidos 200. Si el 401 persiste tras reinstalar, re-parear (el token pudo invalidarse).
2. Investigar el 401 sobre la 1.1.8 (resultado incierto, y el worker seguiría bloqueado por run-as).

**Política de APKs (decision pendiente):** la web distribuye **1.1.8** desde el commit `cbae4d3` (revert del APK público). La 1.2.0 es la única validada para publicación. Hay DOS builds locales con firmas/flags distintos:
- `C:/SouthFarm/source/southfarm_app/build/app/outputs/flutter-apk/app-debug.apk` (1.2.0+20, **167 MB, debuggable → run-as OK**) — el que HAY que usar en teléfonos con workers legacy (07, 09, 08)
- `.../app-release.apk` (1.2.0+20, 67 MB, **NO debuggable → run-as FALLA**) — solo sirve para workers con `legacy_app_identity: false` (fila 30)
- El APK público viejo (1.0.0) tiene **firma distinta** → instalarlo encima exige uninstall → **borra el pareo**. Nunca mezclar.

**Regla de oro aprendida: NO cambiar versiones de app en los teléfonos sin permiso explícito del usuario.**

---

## 1. Producción — todo desplegado y verificado (18-ago tarde)

| Componente | Estado | Detalle |
|---|---|---|
| API | 🟢 | Runtime republicado desde worktree master (estaba del 14-ago): parar tarea "SouthFarm API" → `ops/windows/publish-southfarm-backend-runtime.ps1 -SourceBackendPath <worktree>\backend -RuntimeBackendPath <AppData>\runtime\backend` → arrancar. (Parar primero: `better_sqlite3.node` queda lockeado). Salud: `http://127.0.0.1:3001/api/health` y `https://api.southfarm.tech/api/health` |
| Webapp | 🟢 | Vercel auto-deploy desde `main`. PRs mergeados: landing#1 (92c17c4, worker), landing#2 (1f6790d8, resolución de reviews + media guard), webapp#1 (4a8f3f9, UI resolución). Después: APK a 1.2.0 (a65e6fd) y **revert a 1.1.8 (cbae4d3)** |
| E2E real | ✅ | Job 2 IG desde la web local: `completed` con verify digital (`remote_post_identity: "marczell.vibes this mindset can change your day"`, 2min36s). Baseline IG: **13 posts**. Caption agregado a la lista de no-repetir |
| Funciones nuevas live | ✅ | Resolución de "Requiere revisión" (botones en web, `POST /api/publications/:id/review`), media guard (`MEDIA_UNSUPPORTED` rechazo temprano ≤1080×1920 h264/hevc), evidencia del worker restringida a roles owner/admin/operator |

---

## 2. La flota — mapa COMPLETO y estado por teléfono (verificado 19-ago ~00:50)

Todos POCO C71 (25028PC03G), Android 15, HyperOS, WiFi, navegaćión 3 botones. Conexión: **ADB tcpip 5555 por WiFi** (keepalive los reconecta). El `android_id` cambia con factory reset; la app reporta su PROPIO `device_id` (no el android_id) — así mapea la web.

| Alias web | Fila | IP:puerto | android_id real | device_id de app | App | Pareo/latido | Worker |
|---|---|---|---|---|---|---|---|
| **08** (principal, el histórico) | #28 | 192.168.0.21:5555 | aaa9c7a1f6cdb7a1 | fd2f46b48e71496a (legacy) | **1.1.8 ROTA** | ❌ 401 | ❌ muerto |
| **07** | #26 | 192.168.0.27:5555 | 34a0d159897c0346 | a66078d5b320725d | 1.2.0 debug | ✅ | ✅ windows-26 |
| **09** | #27 | 192.168.0.36:5555 | d75d9f4b77255782 | b0f723cc06ae120e | 1.2.0 debug | ✅ | ✅ windows-27 |
| **02 nuevo** | #30 | 192.168.0.32:5555 | 66adeaad094687c2 | eb94fec659bb37b6 | 1.2.0 release | ✅ | ✅ windows-30 |
| *(sin parear)* | — | 192.168.0.22:5555 | f9e621f7db7dee8f | — | 1.2.0 release | ❌ token=NULL | — |
| *(sin parear)* | — | 192.168.0.31:5555 | 1842abb89fc68859 | — | 1.2.0 release | ❌ token=NULL | — |

Notas de flota:
- **07 y 09** son veteranos de semanas (usados para scan/warmup siempre). Se les actualizó 1.1.8→1.2.0 **in place** (`install -r` con build debug, misma firma) **conservando pareo y cuentas**. Sus usuarios los identifican físicamente conectándolos por USB uno por uno.
- **"02 viejo" (#29, android_id 1054e25ddf423424)**: fila fantasma pre-reset, el usuario la borró de la web.
- **"02 nuevo" (.32)**: tenía la app `com.example.southfarm_app_v2` (protocolo de dumps INCOMPATIBLE con el worker) — se desinstaló y se instaló v1 1.2.0; se pareó de cero (fila #30, 1 cuenta TT).
- Los **2 sin parear** (.22/.31): apps 1.2.0 instaladas + servicio a11y bound remotamente, esperando que el usuario los paree (web → Device fleet → "Vincular un celular" → código+llave en la app). Después de cada pareo: crear su worker (patrón sección 4, `legacy_app_identity: false` como el 30).
- **Cuentas sociales por teléfono** (para publicación): el 08 tiene 9 (IG 4 / TT 2 / YT 3, incluye marczell.vibes, MarcellWisdom), 07 tiene 2 (IG 1/TT 1), 09 tiene 5 (IG 3/TT 2), 02 nuevo 1 (TT). **IG NUNCA santilorennzo** (ya bloqueado por config en todos los workers).
- tcpip 5555 **se apaga si el teléfono se reinicia** → reconectar por USB una vez para re-activar (el keepalive NO puede con eso).

---

## 3. Infraestructura de la PC (Windows, TOMILLO\josu_)

- **API**: tarea "SouthFarm API" (trigger booteo) → `C:\SouthFarm\source\ops\windows\southfarm-api-supervisor.ps1` → runtime `C:\Users\josu_\AppData\Local\SouthFarm\runtime\backend` (node v22.23.1 propio), DB `C:\Users\josu_\AppData\Local\SouthFarm\data\southfarm.db`, config `C:\ProgramData\SouthFarm\config\backend-runtime.json`, logs `C:\ProgramData\SouthFarm\logs\southfarm-api.*.log`.
- **Workers**: una tarea + config + LogDirectory POR TELÉFONO (el lock del supervisor es por directorio — JAMÁS compartir LogDirectory):
  - Configs: `C:\ProgramData\SouthFarm\config\publisher-worker.json` (08/row28, serial WiFi .21), `publisher-worker-26.json` (.27), `publisher-worker-27.json` (.36), `publisher-worker-30.json` (.32). **Escribirlos requiere elevación UAC** (patrón usado: script .ps1 en %TEMP% + `Start-Process -Verb RunAs`).
  - Tareas: "SouthFarm Publisher Worker" (28, trigger logon), "... Worker 26/27/30" (trigger logon, agregado 19-ago ~00:15). Logs: `C:\ProgramData\SouthFarm\logs\publisher-XX\southfarm-publisher.out.log`.
  - Campos clave del config: `device_id` (fila backend), `device_serial` (ip:5555), `android_id` (REAL del teléfono, case-sensitive), `legacy_app_identity` (true → exige run-as + `legacy_device_id`/`legacy_installation_id` = device_id de la app + `sf-install-*` de sus prefs), `worker_token` (base64 32B, compartido), `worker_id` único (windows-XX), `forbidden_instagram_accounts: santilorennzo`.
  - El supervisor valida identidad en CADA restart del runner: get-state + android_id + (si legacy) run-as prefs.
- **Keepalive ADB**: tarea "SouthFarm ADB WiFi Keepalive" cada 5 min vía **wrapper VBS silencioso** (`C:\Users\josu_\AppData\Local\SouthFarm\ops\adb-wifi-keepalive-silent.vbs` → `adb-wifi-keepalive.ps1`, IPs .21/.22/.27/.31/.32/.36). Sin el VBS la consola parpadea en pantalla.
- Tareas con trigger **AtStartup requieren elevación**; -AtLogOn funciona sin ella.

## 4. Recetas rápidas

```bash
ADB="C:/SouthFarm/toolchain/android-sdk/platform-tools/adb.exe"
# Estado de flota: "$ADB" devices ; descubrir wifi: "$ADB" mdns services ; "$ADB" connect IP:5555
# Identidad de un teléfono: "$ADB" -s SERIAL shell run-as com.example.southfarm_app cat shared_prefs/FlutterSharedPreferences.xml   # solo builds debug
# Mapeo teléfono↔fila web: "$ADB" -s SERIAL shell "logcat -d | grep 'Heartbeat: device=' | tail -2"   # device=<device_id de la fila>
# App pareada? "Poll: token=NULL" en logcat = NO pareada. "response=401" = token rechazado.
# Dump de UI (protocolo worker): am broadcast -n com.example.southfarm_app/.WarmupReceiver -a com.example.southfarm_app.DUMP_UI → cat /sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml (leer con MSYS_NO_PATHCONV=1)
# Nuevo worker por teléfono: copiar config del 30 (legacy false) o 26 (legacy true), cambiar worker_id/device_id/device_serial/android_id(/legacy ids), LogDirectory publisher-XX, UAC para ProgramData, Register-ScheduledTask con -AtLogOn (sin elevación) + Start-ScheduledTask
# Workers vivos: Get-Process python ; tareas: Get-ScheduledTask *Publisher*
```

Upgrade de app SIN perder pareo: `install -r` con build de **misma firma** (debug sobre debug). Cambio de firma = uninstall = **pareo borrado**.

## 5. Pendientes (en orden)

1. **Decisión usuario: teléfono 08** (sección 0). Recomendada: restaurar 1.2.0 debug + reiniciar worker + verificar 200.
2. **Parear .22/.31** (usuario genera código en web y lo entra en la app) → crear sus workers (filas nuevas).
3. **Decidir APK público canónico** de la web (hoy 1.1.8; publicación requiere 1.2.0+debug para rows legacy).
4. Verificar Vercel deploy tras `cbae4d3` (el APK 1.1.8 se sirve correctamente).
5. Test de publicación del usuario sobre los 4 teléfonos (no llegó a hacerse por el incidente).
6. Opcional: FASE 6 verify unificado (`docs/HANDOFF_VERIFY_UNIFIED_2026-08-18_ES.md`).

## 6. Cuentas autorizadas / reglas operativas (vigentes)

- IG `marczell.vibes` (JAMÁS `santilorennzo`), TikTok `@marczell.vibes`, YT `@MarczellWisdom` + cuentas secundarias ya detectadas por teléfono (mindset/clips/wisdom/growtech.news/kleinquotes/josuee.lorenzo).
- Fail-closed innegociable: jamás re-tapear botón destructivo; un solo tap final por corrida.
- Posts de prueba NO se borran. Captions ≤10 palabras sin repetir (lista previa + "this mindset can change your day").
- Teléfono: trabajos serializados; usuario presente en corridas en vivo.
- Subagentes: los CCGOAT (GOAT) funcionaron toda la sesión sin rate-limits. PROHIBIDO que lean imágenes.
- Git Bash corrompe paths /sdcard → `MSYS_NO_PATHCONV=1` o subprocess con lista.

## 7. Credenciales / acceso

- Webapp prod: `https://southfarm-webapp.vercel.app` (usuario: josue, owner). API prod: `https://api.southfarm.tech` (Cloudflare → localhost:3001).
- GitHub via credencial almacenada (git credential manager) — API REST con `Authorization: Bearer` extraído de `git credential fill` (patrón usado toda la sesión para merges/PRs sin gh CLI).
- Local E2E harness: `backend/scripts/local-pub-e2e.mjs --keep` (Node 22: `C:/Users/josu_/AppData/Local/Temp/southfarm-node22/node.exe`), owner temporal con email `local-e2e-<ts>@example.test` / `test-password-123`. Puede seguir corriendo de la sesión anterior (puertos 3000/3325) o levantarse de nuevo.
- Videos de prueba: `C:\Users\josu_\Downloads\Videos to test\0730 MA-V-{1..4}.mp4` (HEVC 1080×1920 OK). Clip 4K para probar el media guard: `%TEMP%\southfarm-4k-test.mp4`. **Ya no quedan MP-V reales** (MP-V-2 fue sobreescrito con copia 1080p).

## 8. Bugs/conocimiento de la sesión

- `scheduled_for` exige RFC3339 con offset y fracción 1-3 dígitos (Python: `isoformat(timespec='milliseconds')`; el `+` se pierde en form-encoding → usar offset `-03:00`).
- `run-as` solo funciona en builds debuggables; el build público 1.0.0 y el release 1.2.0 NO lo permiten.
- La app reporta `device_id` propio (uuid) — la web muestra ESE id como identidad; el worker usa android_id REAL + legacy ids de prefs.
- HyperOS: a11y remoto (`settings put`) bindea SOLO después de lanzar la app (monkey -p ... LAUNCHER 1) — con 1.2.0 funciona sin toggle manual; tras uninstall/reinstall re-habilitar.
- Vercel + webapp: el checkout `main` canónico vive en `C:\SouthFarm\source\webapp` (el worktree tiene su propio repo en branch feat).
- `C:\SouthFarm\source` (checkout principal) está en branch `feature/ui-redesign-granja-tecnologica` con dist sucio — NO tocar sin preguntar.
- ADB `install -d` permite downgrade (misma firma). `-r` upgrade in place.
- Dos `tail` de archivos inexistentes devuelven exit 1 — no confundir con fallo del comando principal.

## 9. EL INCIDENTE — compactación de contexto y el revert fantasma (LEER)

**Qué pasó**: la sesión del 18/19 fue gigante (43 MB de model-I/O). El sistema compacta el contexto cuando llega al límite: **resume y descarta segmentos** — de la memoria del agente Y de la vista de chat del usuario. El segmento donde el usuario pidió revertir la app a 1.1.8 y donde ese revert se ejecutó (build de 1.1.8 desde fuente, downgrade del teléfono 08, commit `cbae4d3` 00:28:01, push) fue **borrado por la compactación**. Resultado: el agente "no recordaba" haberlo hecho, atribuyó el commit a una "sesión paralela inexistente", y el usuario vio su conversación desaparecer del chat.

**Forense (cómo se resolvió)**: logs en `C:\Users\josu_\.zcode\cli\log\zcode-AAAA-MM-DD.jsonl` (eventos `sendText accepted` con timestamp + textLength) y transcripts en `C:\Users\josu_\.zcode\cli\rollout\model-io-sess_*.jsonl` (una por sesión; solo existía UNA). La secuencia reconstituida: 00:25 "contame que fue lo ultimo" (37 chars) → 00:26 reclamo del revert (239 chars) → 00:28 commit → 00:37 inventario (95) → 01:01 investigación (190).

**Lecciones**:
1. Ante "desapareció del chat" → ir directo a esos logs, no teorizar.
2. Sesiones de este tamaño = riesgo de compactación. **Empezar sesión nueva** (este handoff es el puente). Mantener turnos cortos.
3. Cambios de versión de app en teléfonos: SOLO con permiso explícito previo del usuario (fue la queja original y es justa).
4. Si el usuario contradice tu memoria, verificá empíricamente antes de insistir (el caso 07/09 "están funcionales" era cierto).

## 10. Primeras verificaciones sugeridas para la sesión nueva

```bash
# 1) Flota y workers
"C:/SouthFarm/toolchain/android-sdk/platform-tools/adb.exe" devices
powershell "Get-ScheduledTask *SouthFarm* | ft TaskName,State"
powershell "Get-Process python | ft Id,StartTime"
# 2) Salud API
curl https://api.southfarm.tech/api/health
# 3) Estado del 08 (roto): versión app + latidos
adb -s 192.168.0.21:5555 shell dumpsys package com.example.southfarm_app | grep versionName
adb -s 192.168.0.21:5555 shell "logcat -d | grep 'Heartbeat' | tail -3"
```

— Fin del handoff. Rama de trabajo actual del worktree: `master` (todo mergeado). Los desechables del worktree siguen untracked a pedido del usuario.
