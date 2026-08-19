# Handoff — Sesión 2026-08-19 (tarde): fix del bug de deslogueo de la app + rollout a la flota

Continúa de `docs/HANDOFF_SESSION_2026-08-19_FLOTA_Y_REVERT_ES.md` (leerlo primero: flota, infra, reglas y credenciales siguen vigentes). Esta sesión cubrió: diagnóstico del deslogueo automático de 07/08, fix de sesión en la app Flutter, test de campo en el 02 nuevo, rollout a los 4 teléfonos pareados, y el commit de la fuente. **Todo quedó estable.** El usuario arranca sesión nueva para seguir con web y app.

---

## 0. Resumen ejecutivo

- **Bug del deslogueo: ARREGLADO, TESTEADO Y DESPLEGADO.** Los 4 teléfonos pareados corren builds con el fix: 07/08/09 en debug **vc11**, 02 nuevo en release **vc22** (todos versionName 1.1.8, pareos y cuentas intactos).
- **Commit del fix: `6fe2b96`** en el checkout principal `C:\SouthFarm\source` (branch `feature/ui-redesign-granja-tecnologica`), **NO pusheado**. Solo toca `southfarm_app/lib/main.dart` (2327+/427- porque además captura 2.5 meses de evolución sin commitear — ver §5.2).
- **Los APKs públicos de la web siguen sirviendo los builds CON bug** (`webapp/public/southfarm.apk` = release vc21 viejo, `southfarm-debug.apk` = debug vc10 viejo). El usuario decidió diferir su actualización hasta agregar también la sección de descarga en la web (pendiente #1).
- Flota: 4 pareados + **.22/.31 sin parear** esperando onboarding.

## 1. El incidente (mañana del 19-ago, ya resuelto)

**Síntoma**: 07 y 08 "se salieron solos de sus cuentas" tras estar bloqueados >15 min.

**Forense** (todo verificado con logcat/DB/prefs mtime):
- Se borraron SOLO `flutter.auth_token` y `flutter.device_token` de las prefs locales (12:45:45 en 07, 12:46:29 en 08), ~18 s después del relanzamiento de MainActivity al desbloquear. `refresh_token`, `device_paired`, cuentas locales: intactos.
- **El backend NUNCA revocó nada**: device_token_hash presentes, sin 401s, sin refresh intentados, filas activas. Cuentas sociales intactas en la DB.
- Trigger: reapertura de la app con el JWT de usuario vencido (dura 15 min). 09 y 02 nuevo no se afectaron porque nadie les reabrió la app (su servicio a11y sigue latiendo solo).
- El camino de código EXACTO del build viejo nunca se identificó al 100% (el patrón de borrado no existe en la fuente actual); por eso el fix es defensa-en-profundidad: hace la clase de fallo imposible sin importar el camino.

## 2. El fix (política implementada)

Archivo: `southfarm_app/lib/main.dart` (único tocado). Commit `6fe2b96`:
1. **`device_token` intocable por flujos automáticos**: `logout()` ahora limpia solo `auth_token`/`refresh_token`/`user_email`/`user_name`. Ningún camino borra `device_token`/`device_paired` → el teléfono nunca queda offline por sesión.
2. **Escrituras serializadas** (cola `_enqueue` + guards `_refreshInFlight`/`_logoutInFlight`) y **CAS** en el refresh 200 (una respuesta stale no pisa sesión nueva).
3. **Splash/onboarding usan `getValidAuthToken()`**: JWT vencido → refresh automático en vez de mandar al login.
4. **`_ensureDevice()` en resume**: auto-sana un `device_token` faltante.
5. **Logging forense**: todo set/remove de claves de sesión loguea `[Auth] session <set|remove> <key> reason=<motivo> at <ISO>` en logcat. Si algún día algo borra tokens, queda el rastro con caller.

Review: reviewer-pro-CCGOAT "APTO CON OBSERVACIONES"; las 3 observaciones relevantes ya aplicadas antes de compilar (try/catch del CAS, splash con refresh, guard anti doble navegación).

## 3. Builds con fix (artefactos y pipeline)

En `C:\SouthFarm\source\southfarm_app\dist-fixed\`:

| Archivo | Para | versionName/Code | SHA-1 |
|---|---|---|---|
| `southfarm-1.1.8-debug-arm64-vc11-FIXED.apk` (106 MB) | 07/08/09 | 1.1.8 / 11 | `b69d164a01cf0679bae4152d1e268eb2ff4dd58e` |
| `southfarm-1.1.8-release-arm64-vc22-FIXED.apk` (33 MB) | 02nuevo, .22/.31, web pública | 1.1.8 / 22 | `1236890b7661200c485e07d4c4e815a8f3241dc6` |

**Pipeline (replicar para futuros builds)**: desde **WSL** (`/home/josue/flutter`, Flutter 3.44.0, `~/android-sdk`):
```bash
flutter build apk --debug   --target-platform android-arm64 --build-name 1.1.8 --build-number 11
flutter build apk --release --target-platform android-arm64 --build-name 1.1.8 --build-number 22
```
Firmas (verificar con `keytool -printcert -jarfile` + `aapt dump badging`):
- **Debug**: Android Debug SHA-1 `77a6173e7d224555561cb4ea2abeb8afe4ebf3c1` = `~/.android/debug.keystore` de WSL = copia en `C:/ProgramData/SouthFarm/tmp-cert/wsl-debug.keystore`. OJO: el `debug.keystore` de WINDOWS es OTRO (20:8AE0...) — build debug desde Windows sale con firma distinta → INSTALL_FAILED. Usar WSL o re-firmar con apksigner.
- **Release**: CN=SouthFarm SHA-1 `9675ed186c67c7a17b1f969e8a50bbccd43d0774`, keystore `southfarm_app/southfarm-release.jks` (alias `southfarm`) vía `android/key.properties` — ambos git-ignored, NO borrarlos.

## 4. Test y rollout (evidencia)

- **Test en 02 nuevo** (escenario fiel: JWT vencido + reapertura SIN force-stop): **4/4 PASS** — refresh automático al arrancar (`set ... reason=refresh`), CERO removes de tokens, heartbeat 200 continuo antes/durante/después (rotación de token sin un solo corte), pareo intacto. El teléfono quedó en vc22 operativo.
- **Rollout 07→08→09** (serializado, `install -r` debug vc11): **3/3 PASS**. En los tres: `set ... reason=refresh` al arrancar, cero removes, latido 200, mismos device_ids, sin necesidad de la receta a11y. Infra: 4 procesos python, tareas Publisher Running.

## 5. Aprendizajes operativos NUEVOS de esta sesión

1. **`am force-stop` desactiva el servicio a11y en Android 15/HyperOS** (el teléfono queda sin latido). NO usar force-stop como método de test/reinicio. Receta de restauración (verificada, autorizada por el usuario): `settings put secure enabled_accessibility_services com.example.southfarm_app/com.example.southfarm_app.SouthFarmAccessibilityService` + `settings put secure accessibility_enabled 1` + relanzar la app con `monkey -p com.example.southfarm_app 1`.
2. **`.gitignore` línea 42 = `southfarm_app/`** — ignora el directorio ENTERO de la app. Consecuencia: la fuente no se commiteaba desde el 4 de junio (39bee49) y los builds se hacían de un working tree sin respaldo (raíz del dolor forense de ayer). `6fe2b96` corrige el drift, pero **falta afinar la regla** (ignorar solo `build/`, `.gradle/`, `local.properties`). Usar `git add -f` mientras exista la regla. El checkout principal tiene además mods preexistentes SIN commitear (backend/src+dist, gradles, drawable) — no tocarlos sin preguntar.
3. **DNS de la mañana**: los resolvers CGNAT del ISP (100.72.3.x) fallaron intermitentemente 10:48–11:53 afectando a todos los teléfonos (no solo SouthFarm); se auto-recuperó. Mitigación posible (decisión del usuario): fijar 1.1.1.1/8.8.8.8 en el router.
4. **Filas duplicadas en `devices`**: 07 tiene filas 21 y 26 activas (mismo device_id+installation_id), 08 tiene 22 y 28. No causó el bug, higiene pendiente.
5. **Política de builds** (explicada al usuario): misma app 1.1.8 para todos; debug = para teléfonos con worker legacy (`legacy_app_identity: true`, valida por `run-as`), release = modo moderno (`legacy_app_identity: false`, valida por android_id). Unificar todo a release requiere desinstalar (cambio de firma borra pareo) → re-pareo de 07/08/09 + update de configs de workers: proyecto chico futuro, no urgente.
6. **APKs públicos**: se sirven desde `webapp/public/` en las URLs `https://southfarm-webapp.vercel.app/southfarm.apk` y `/southfarm-debug.apk`, pero **NO están linkeados desde ninguna parte de la UI** (verificado por grep). El flujo "Vincular un celular" asume la app instalada.

## 6. Estado de la flota (al cierre de esta sesión)

| Alias | IP | device_id app | Fila | Build | Pareo | Worker |
|---|---|---|---|---|---|---|
| 08 | 192.168.0.21 | fd2f46b48e71496a | #28 | 1.1.8 debug **vc11 FIX** | ✅ latea 200 | ✅ windows-28 |
| 07 | 192.168.0.27 | a66078d5b320725d | #26 | 1.1.8 debug **vc11 FIX** | ✅ | ✅ windows-26 |
| 09 | 192.168.0.36 | b0f723cc06ae120e | #27 | 1.1.8 debug **vc11 FIX** | ✅ | ✅ windows-27 |
| 02 nuevo | 192.168.0.32 | eb94fec659bb37b6 | #30 | 1.1.8 release **vc22 FIX** | ✅ | ✅ windows-30 |
| sin parear | 192.168.0.22 | — | — | 1.1.8 release vc21 (viejo) | ❌ | — |
| sin parear | 192.168.0.31 | — | — | 1.1.8 release vc21 (viejo) | ❌ | — |

API producción OK (`https://api.southfarm.tech/api/health`), 4 workers Running, cloudflared OK.

## 7. Pendientes (orden recomendado)

1. **Web: sección de descarga + swap de APKs públicos JUNTOS** (decisión del usuario: el swap solo tiene sentido con la sección). Agregar en la tarjeta "Vincular un celular" (`webapp/src/app/page.tsx`) un bloque "¿No tenés la app? Descargala" con link/QR al release vc22 (debug vc11 como secundario), reemplazar los 2 archivos en `webapp/public/`, commit al repo webapp (checkout `C:\SouthFarm\source\webapp`, rama main) → deploy Vercel.
2. **Corregir `.gitignore`** (línea 42) para no ignorar fuente de `southfarm_app/`.
3. **Parear .22/.31** (usuario genera código en web + lo entra en la app) → crear sus workers con patrón de la fila 30 (`legacy_app_identity: false`). Antes conviene instalarles el release vc22 FIX (misma firma que su vc21 actual → `install -r` sin pérdida).
4. **Push de `6fe2b96`** (el usuario no lo pidió aún).
5. **Test de publicación del usuario sobre los 4 teléfonos** (arrastrado del handoff anterior, nunca hecho).
6. Unificación de flota a un solo build release (proyecto chico, requiere re-pareo).
7. Opcional: FASE 6 verify unificado (`docs/HANDOFF_VERIFY_UNIFIED_2026-08-18_ES.md`), limpieza de filas duplicadas, DNS del router.

## 8. Mapa de repos (no confundir)

- `C:\SouthFarm\source` — monorepo principal, branch `feature/ui-redesign-granja-tecnologica`. App Flutter en `southfarm_app/` (commit `6fe2b96` = fuente EXACTA de los APKs desplegados). Tiene mods preexistentes sin commitear (backend, gradles) — NO commitearlos sin permiso.
- `C:\SouthFarm\source\webapp` — repo propio del webapp, rama main, deploy auto a Vercel al push. Sirve los APKs públicos desde `public/`.
- `.worktrees/semiorganic-publishing` — este worktree (branch master): backend/webapp dev + docs/handoffs.
- `southfarm_app_v2/` — árbol hermano, TODO untracked, package distinto (`..._v2`): no usar para la flota.

## 9. Reglas vigentes (recap)

- Fail-closed innegociable; un solo tap final por corrida; posts de prueba no se borran; captions ≤10 palabras sin repetir; teléfonos serializados; usuario presente en corridas en vivo.
- **NO cambiar versiones/firmas de app en teléfonos sin permiso explícito**; **NO usar `am force-stop`** (ver §5.1).
- Subagentes: usar los CCGOAT/GOAT como preferencia del usuario; PROHIBIDO que lean imágenes. Orquestador + delegación.
- Git Bash + paths `/sdcard` → `MSYS_NO_PATHCONV=1`. IG jamás `santilorennzo`.
- Verificación rápida de flota: `adb devices` → `logcat | grep Heartbeat` (200 = sano); workers: `Get-Process python` + `Get-ScheduledTask *Publisher*`.

— Fin del handoff. Desechables de esta sesión (logs de test) quedaron untracked a pedido del usuario.
