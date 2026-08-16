# Publicación móvil semántica con UiSnapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que las publicaciones de Instagram Reels, TikTok y YouTube Shorts se ejecuten desde la webapp mediante el worker Windows, localizando cada control en un `UiSnapshot` jerárquico fresco y ejecutando únicamente `adb shell input tap` con bounds actuales, con publicación, verificación y recuperación fail-closed.

**Architecture:** `SafeAdb` capturará un árbol UIAutomator inmutable y `UiSnapshot` conservará padres, hijos, atributos e índices exactos. `GuardedPublisher` resolverá `resource-id → content-desc → text`, separará la identidad pasiva del target clickable y ejecutará transacciones dump → resolver → tap/input/back/swipe → dump → evidencia positiva. Los adaptadores conservarán sus guards de cuenta, package, galería, visibilidad, baseline y acción final; `PublicationRunner` seguirá siendo dueño de checkpoints, lease y estados terminales.

**Tech Stack:** Python 3.12 worker, ADB/UIAutomator XML, `unittest`, fakes de subprocess y fixtures XML sanitizados, adaptadores Instagram/TikTok/YouTube existentes, backend Node/Express/SQLite existente, webapp TypeScript/Next existente y comandos operativos Windows documentados en `docs/SEMIOGANIC_PUBLISHING_HANDOFF_ES.md`.

## Global Constraints

- La fuente de desarrollo es `C:\SouthFarm\source\.worktrees\semiorganic-publishing`; preservar los cambios preexistentes de `common.py` y `test_platform_adapters.py`, revisar sus diffs antes de cada staging e integrar en el commit funcional correspondiente sólo los hunks aprobados. No resetear ni revertir esos cambios. `phone-after-exit.png`, `phone-current.png` y `publisher_worker/southfarm_publisher_worker.egg-info/` se conservan fuera de todos los commits.
- La interacción física móvil debe usar exclusivamente `adb -s SERIAL shell input tap X Y`; no usar `click`, `performClick`, `UiObject.click`, Appium ni métodos equivalentes.
- No usar coordenadas fijas para botones ni fallback geométrico adivinado; todo tap y swipe se deriva de bounds válidos del snapshot inmediatamente anterior.
- Cada acción física toma dump fresco antes y después, exige package/contexto esperado y evidencia positiva; el retorno `0` de ADB o la desaparición del control anterior no prueban éxito por sí solos.
- La resolución exacta sigue `resource-id → content-desc → text`; cero resultados, colisiones, package incorrecto, target disabled, label sin ancestro accionable, bounds inválidos o transición no observable deben fallar cerrado.
- Una identidad pasiva puede ser `clickable=false`; sólo un control directo enabled/clickable o su único ancestro enabled/clickable puede recibir el tap.
- La web mantiene React `onClick`, teclado, focus y accesibilidad; no se agregan taps ADB ni se reemplazan handlers web.
- La cuenta del job proviene del snapshot inmutable del último escaneo del teléfono; no se inicia login ni se introducen credenciales, contraseñas, PIN, 2FA, cookies o tokens sociales.
- `santilorennzo`/Santiago se excluye sólo del rollout y pruebas live de esta sesión; no se codifica una política permanente, `forbidden_accounts`, `FORBIDDEN_ACCOUNT` ni branching productivo por username.
- TikTok cleanup permanece `CLEANUP_SELECTOR_UNVERIFIED` sin swipe/delete hasta contar con dump live autorizado, fixture sanitizado y selector exacto; Instagram autorizado no queda bloqueado por esa tarea.
- `Share`, `Post` y `Upload Short` tienen checkpoint `publishing` previo, una única oportunidad de tap y, ante incertidumbre posterior, finish existente una sola vez con `status=review_required`, `error_code=FINAL_ACTION_UNCERTAIN`, `error_message` seguro y `result` compacto; no agregar `final_action_uncertain` ni reintentar.
- Cleanup sólo se ejecuta después de validar sin ADB la autorización server-signed, humana, vigente, no consumida y scopeada; luego preflight, consumo atómico inmediatamente antes del primer delete y cero delete si el consumo falla.
- Antes de tocar frontend Next se debe leer la guía relevante bajo `node_modules/next/dist/docs/` del checkout que se vaya a modificar, conforme a `AGENTS.md`.
- La autorización live vigente permite como máximo dos Instagram Reels en `@growtech.news` con `MP-V-1.mp4` y, sólo si el primer ciclo completo termina bien, `MP-V-2.mp4`; no autoriza publicaciones reales TikTok/YouTube.

---

## File Structure

El plan separa el modelo UI, las acciones físicas, el contrato común, los adaptadores, el runner, cleanup y la verificación. Los nombres de interfaz de cada tarea son el contrato para las tareas siguientes.

- `publisher_worker/southfarm_publisher/ui_snapshot.py` (crear): `ScreenSize`, `Bounds`, `UiNode`, `UiSnapshot`, `SemanticSelector`, prioridad de atributos, validación geométrica y resolución de ancestros.
- `publisher_worker/southfarm_publisher/adb_device.py` (modificar): captura de snapshots, wrapper seguro de subprocess, `input tap`, `keyevent 4`, `input text`, launch y swipe derivado de bounds.
- `publisher_worker/southfarm_publisher/platforms/common.py` (modificar): guards de package/cuenta/contexto, `tap_and_wait`, identidad pasiva, target accionable, frescura y errores estables; retirar política permanente de cuentas prohibidas. El diff dirty preexistente se revisa antes de staging y sus hunks funcionales aprobados se integran aquí o en el commit común correspondiente.
- `publisher_worker/southfarm_publisher/platforms/instagram.py` (modificar): selectores y flujo semántico de Instagram Reels, baseline, publicación, verificación y cleanup.
- `publisher_worker/southfarm_publisher/platforms/tiktok.py` (modificar): flujo semántico TikTok, guards `Create`/`Post`, verificación de cover/contador y cleanup con guard hasta fixture live.
- `publisher_worker/southfarm_publisher/platforms/youtube.py` (modificar): flujo semántico YouTube Shorts, canal, galería, visibilidad, publicación, verificación y cleanup.
- `publisher_worker/southfarm_publisher/runner.py` (modificar): factory/config sin variables antiguas de cuenta prohibida, checkpoints, finish terminal y clasificación `review_required`.
- `publisher_worker/southfarm_publisher/api_client.py` (modificar sólo si las firmas existentes no soportan los campos/llamadas del contrato): finish, validate/consume cleanup y no exposición de secretos.
- `publisher_worker/southfarm_publisher/cleanup_cli.py` (modificar): orden validate sin ADB → preflight → consume one-use → primer tap destructivo → baseline restaurado.
- `publisher_worker/southfarm_publisher/models.py` (modificar sólo si los tipos de estado/error/result existentes no cubren el contrato): errores y resultado compacto sin campo nuevo `final_action_uncertain`.
- `publisher_worker/tests/test_ui_snapshot.py` (crear): parser, jerarquía, selectores, bounds y errores fail-closed.
- `publisher_worker/tests/test_adb_device.py` (modificar): fake de subprocess, argv exacto, `shell=False`, acciones especiales y dumps frescos.
- `publisher_worker/tests/test_platform_adapters.py` (modificar): fixtures/guards de los tres adaptadores y regresiones de usernames sin política prohibida. El test dirty preexistente se conserva, se revisa contra la implementación y sólo sus asserts funcionales aprobados se agregan al commit que los hace verdes.
- `publisher_worker/tests/test_runner.py` (modificar): config, checkpoints, finish incierto y no reintento.
- `publisher_worker/tests/test_cleanup_cli.py` (modificar): orden de autorización, preflight, consumo y cero delete ante fallos.
- `publisher_worker/tests/test_semantic_publishing_integration.py` (crear): secuencias completas con fake ADB, capturas de argv y estados terminales.
- `publisher_worker/tests/fixtures/ui_snapshot_hierarchy.xml` (crear) y fixtures específicos sanitizados existentes (ampliar sólo cuando un caso nuevo lo requiera): no guardar XML live ni contenido sensible.
- `webapp/src/app/publication-panel.tsx` y sus tests Vitest (modificar sólo para completar el copy exacto y preservar handlers): no cambiar la estrategia web a taps.
- `backend/` (sin cambio de contrato ni migración): ejecutar build y suites del handoff; modificar sólo si un test demuestra que el endpoint existente no acepta `error_message`/`result` compactos ya definidos.
- `docs/superpowers/plans/2026-08-16-semantic-mobile-publishing.md` (este archivo): documento de ejecución; no mezclarlo con código funcional.

Antes de cada commit que toque un archivo dirty se ejecuta `git diff -- <path>` y se identifica qué hunks pertenecen a la tarea. Se agrega con `git add -p` o staging equivalente sólo el contenido funcional aprobado, se verifica `git diff --cached --name-only` y se excluyen siempre los PNG y `egg-info`; no se usa `git reset`, `git checkout --` ni revert para limpiar el resto.

---

### Task 1: Crear `UiSnapshot` jerárquico y resolver selectores exactos

**Files:**
- Create: `publisher_worker/southfarm_publisher/ui_snapshot.py`
- Create: `publisher_worker/tests/test_ui_snapshot.py`
- Create: `publisher_worker/tests/fixtures/ui_snapshot_hierarchy.xml`

**Interfaces:**
- `ScreenSize(width: int, height: int)` y `Bounds(left: int, top: int, right: int, bottom: int)` son dataclasses inmutables; `Bounds.validate(screen: ScreenSize) -> None` rechaza ausencia, inversión, tamaño cero y salida de pantalla.
- `UiNode(node_id: str, parent_id: str | None, child_ids: tuple[str, ...], class_name: str, resource_id: str | None, content_desc: str | None, text: str | None, bounds: Bounds, enabled: bool, clickable: bool, visible_to_user: bool, focused: bool, selected: bool)` conserva la relación XML.
- `SemanticSelector(resource_id: str | None = None, content_desc: str | None = None, text: str | None = None)` sólo acepta valores exactos no vacíos.
- `ResolvedTarget(identity: UiNode, target: UiNode | None)` separa label pasivo y control físico.
- `UiSnapshot.from_xml(xml: str | bytes, *, package: str, snapshot_id: str, captured_at: float, screen_size: ScreenSize) -> UiSnapshot` rechaza XML inválido, jerarquía incompleta y package vacío.
- `UiSnapshot.resolve(selector: SemanticSelector, *, require_action: bool, require_visible: bool = True) -> ResolvedTarget` aplica exactamente `resource-id`, luego `content-desc`, luego `text`; levanta `SELECTOR_NOT_FOUND`, `SELECTOR_COLLISION`, `CONTROL_DISABLED` o `ACTION_TARGET_UNAVAILABLE` según el caso.

- [ ] **Step 1: Escribir la prueba roja de jerarquía y prioridad.** Añadir `ui_snapshot_hierarchy.xml` con raíz, contenedor clickable y texto hijo pasivo, más dos matches de `text` para una colisión. La prueba debe afirmar `parent_id`, `child_ids`, orden pre-order, `node_id` reproducible y que `content_desc` gana a `text` cuando ambos duplican la cuenta.

```python
def test_passive_label_resolves_to_only_clickable_ancestor(self):
    snapshot = UiSnapshot.from_xml(
        fixture("ui_snapshot_hierarchy.xml"),
        package="com.instagram.android",
        snapshot_id="s-1",
        captured_at=1.0,
        screen_size=ScreenSize(1080, 2400),
    )
    resolved = snapshot.resolve(
        SemanticSelector(text="growtech.news"), require_action=True
    )
    self.assertEqual(resolved.identity.text, "growtech.news")
    self.assertEqual(resolved.target.node_id, "0/0")
    self.assertTrue(resolved.target.clickable)
```

- [ ] **Step 2: Ejecutar sólo el test nuevo y confirmar fallo.** Ejecutar `py -3 -m unittest publisher_worker.tests.test_ui_snapshot -v`; debe fallar porque aún no existe el módulo/modelo jerárquico.
- [ ] **Step 3: Implementar el parser mínimo y la resolución fail-closed.** Parsear con `xml.etree.ElementTree`, construir rutas de hijos desde la raíz, indexar `nodes` por `node_id` y recorrer ancestros directos sin saltar subárboles.

```python
@dataclass(frozen=True)
class ResolvedTarget:
    identity: UiNode
    target: UiNode | None

def resolve(self, selector: SemanticSelector, *, require_action: bool,
            require_visible: bool = True) -> ResolvedTarget:
    for field in ("resource_id", "content_desc", "text"):
        expected = getattr(selector, field)
        if expected is None:
            continue
        matches = tuple(n for n in self.nodes.values()
                        if getattr(n, field) == expected)
        if len(matches) > 1:
            raise UiResolutionError("SELECTOR_COLLISION")
        if len(matches) == 1:
            return self._resolve_match(matches[0], require_action,
                                       require_visible)
    raise UiResolutionError("SELECTOR_NOT_FOUND")
```

- [ ] **Step 4: Completar pruebas negativas y verificar verde.** Cubrir XML inválido, package vacío, screen size ausente/inválido, `visible_to_user=false`, bounds invertidos/cero/fuera de pantalla, cero matches, colisión del primer campo, dos ancestros accionables, ancestro disabled y label pasivo aceptado sólo como identidad (`require_action=False`). Ejecutar de nuevo el test focalizado y luego `py -3 -m unittest discover -s publisher_worker\\tests -q` para detectar incompatibilidades sin alterar los hunks dirty preexistentes.
- [ ] **Step 5: Commit aislado.** Ejecutar `git diff --check -- publisher_worker/southfarm_publisher/ui_snapshot.py publisher_worker/tests/test_ui_snapshot.py publisher_worker/tests/fixtures/ui_snapshot_hierarchy.xml`, agregar sólo los tres paths nuevos y confirmar que ningún hunk de `common.py`/`test_platform_adapters.py` ni los PNG/egg-info fue stageado. Commit: `feat(worker): add hierarchical semantic UI snapshots`.

### Task 2: Integrar dumps frescos y acciones físicas seguras

**Files:**
- Modify: `publisher_worker/southfarm_publisher/adb_device.py`
- Modify: `publisher_worker/southfarm_publisher/platforms/common.py`
- Modify: `publisher_worker/tests/test_adb_device.py`
- Create: `publisher_worker/tests/test_physical_actions.py`

**Interfaces:**
- `SafeAdb.dump_snapshot(expected_package: str, screen_size: ScreenSize) -> UiSnapshot` toma un solo dump, valida foreground/package y devuelve snapshot inmutable con `snapshot_id` nuevo.
- `SafeAdb.tap_bounds(bounds: Bounds) -> None` ejecuta argv `['adb', '-s', serial, 'shell', 'input', 'tap', str(x), str(y)]` con `shell=False`.
- `SafeAdb.swipe_bounds(container: Bounds, *, direction: Literal['left', 'right', 'up', 'down'], duration_ms: int) -> None` calcula start/end acotados del rectángulo actual.
- `GuardedPublisher.tap_and_wait(selector: SemanticSelector, *, expected_package: str, expect: Callable[[UiSnapshot], bool], label: str) -> UiSnapshot` obtiene snapshot antes, resuelve identidad/target, ejecuta un tap y obtiene un snapshot posterior que satisface `expect` o lanza un error estable.
- `GuardedPublisher.back_and_wait`, `input_text_and_wait`, `launch_and_wait` y `swipe_and_wait` aplican el mismo contrato antes/después, con sus excepciones explícitas.

- [ ] **Step 1: Revisar el diff dirty y añadir pruebas rojas con fake de subprocess.** Ejecutar `git diff -- publisher_worker/southfarm_publisher/platforms/common.py` para conservar la distinción de identidad pasiva ya existente; luego capturar `argv`, `shell` y la secuencia de dumps, afirmar que el centro de `[100,200][500,600]` produce `300,400`, que no aparece `.click`/`performClick`/`UiObject.click`, y que un target del snapshot anterior no se reutiliza.

```python
def test_tap_uses_current_bounds_and_shell_false(self):
    adb, calls = fake_adb_with_snapshots(before_xml, after_xml)
    publisher = GuardedPublisher(adb)
    publisher.tap_and_wait(
        SemanticSelector(resource_id="button.publish"),
        expected_package="com.instagram.android",
        expect=lambda snap: snap.resolve(
            SemanticSelector(text="Processing"), require_action=False
        ).identity.text == "Processing",
        label="share",
    )
    self.assertEqual(calls[-1].argv[-3:], ["tap", "300", "400"])
    self.assertFalse(calls[-1].shell)
```

- [ ] **Step 2: Ejecutar pruebas focalizadas y confirmar fallo.** Ejecutar `py -3 -m unittest publisher_worker.tests.test_adb_device publisher_worker.tests.test_physical_actions -v`; debe fallar ante la falta de snapshot jerárquico/contrato de frescura.
- [ ] **Step 3: Implementar la captura y wrappers físicos mínimos.** Conectar `SafeAdb` a `UiSnapshot.from_xml`, validar foreground y `screen_size`, mantener `shell=False`, y hacer que cada helper tome un snapshot nuevo tanto antes como después del único comando físico.

```python
def tap_bounds(self, bounds: Bounds) -> None:
    bounds.validate(self.screen_size)
    x, y = bounds.center()
    self._run(["adb", "-s", self.serial, "shell", "input", "tap",
               str(x), str(y)], shell=False)
```

- [ ] **Step 4: Implementar input/back/launch/swipe y pruebas verdes.** `input_text_and_wait` debe localizar un `EditText` visible/enabled/focusable y verificar cada prefijo sin loguear tokens; `back_and_wait` debe exigir perfil/cuenta/destino; `launch_and_wait` puede usar sólo `monkey` antes del primer package check; `swipe_and_wait` debe usar proporciones del contenedor y validar contexto posterior. Un `adb` return code exitoso sin evidencia positiva debe fallar.
- [ ] **Step 5: Ejecutar estático y commit.** Ejecutar `rg -n "\.click\(|performClick|UiObject\.click|900,900|100,900" publisher_worker/southfarm_publisher` y revisar manualmente que cualquier coincidencia sea texto de prueba/documentación, no un gesto productivo. Revisar de nuevo `git diff -- publisher_worker/southfarm_publisher/platforms/common.py`, stagear sólo los hunks funcionales aprobados de ese archivo y excluir PNG/egg-info. Commit: `feat(worker): enforce fresh semantic physical actions`.

### Task 3: Unificar identidad de cuenta y retirar la política permanente prohibida

**Files:**
- Modify: `publisher_worker/southfarm_publisher/platforms/common.py`
- Modify: `publisher_worker/southfarm_publisher/runner.py`
- Modify: `publisher_worker/tests/test_platform_adapters.py`
- Modify: `publisher_worker/tests/test_runner.py`

**Interfaces:**
- `GuardedPublisher.require_identity(snapshot: UiSnapshot, selector: SemanticSelector, expected_username: str) -> UiNode` valida una etiqueta pasiva exacta, permitiendo sólo la representación documentada con o sin `@`.
- `GuardedPublisher.require_selected_account(snapshot: UiSnapshot, expected_username: str, identity_selector: SemanticSelector) -> None` devuelve `ACCOUNT_UNAVAILABLE` si falta/ambigua y nunca toca el label pasivo.
- `platform_adapters(config: WorkerConfig) -> dict[str, GuardedPublisher]` no recibe `forbidden_instagram_accounts`.
- `_config() -> WorkerConfig` no lee `SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS` ni `SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS`.

- [ ] **Step 1: Revisar e incorporar el test dirty aprobado y escribir pruebas rojas para tres usernames y config limpia.** Ejecutar `git diff -- publisher_worker/tests/test_platform_adapters.py` y conservar los asserts ya aprobados sobre identidad pasiva; probar que `santilorennzo`, `growtech.news` y `another.valid` recorren el mismo camino de identidad, retirar de los tests las construcciones de `forbidden_accounts` y reemplazarlas por asserts de igualdad exacta. Añadir test que envía esas variables de entorno y demuestra que `_config()` las ignora/no las exige.

```python
def test_no_username_uses_a_product_forbidden_branch(self):
    for username in ("santilorennzo", "growtech.news", "another.valid"):
        publisher = adapter_for(username)
        self.assertNotIn("FORBIDDEN_ACCOUNT", publisher.selected_account_username())
```

- [ ] **Step 2: Ejecutar tests focalizados y confirmar fallo.** Ejecutar `py -3 -m unittest publisher_worker.tests.test_platform_adapters publisher_worker.tests.test_runner -v`; el checkout actual debe fallar mientras exista el parámetro/branch antiguo.
- [ ] **Step 3: Implementar el contrato común.** Eliminar sólo el wiring de `forbidden_accounts`, branches username y error `FORBIDDEN_ACCOUNT`; conservar guards de package, dispositivo, identidad esperada y `ACCOUNT_UNAVAILABLE` para cuentas ausentes/ambiguas.
- [ ] **Step 4: Verificar regresiones y ausencia de wiring.** Ejecutar los tests focalizados y `rg -n "forbidden_accounts|FORBIDDEN_ACCOUNT|SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS|SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS" publisher_worker`; el comando no debe encontrar runtime/config/tests productivos de esa política. Confirmar manualmente que la exclusión de Santiago sólo existe en el checklist live del Task 10.
- [ ] **Step 5: Revisar diff y commit.** Inspeccionar `git diff -- publisher_worker/southfarm_publisher/platforms/common.py publisher_worker/tests/test_platform_adapters.py`, integrar sólo los hunks funcionales aprobados junto con los cambios de esta tarea usando `git add -p`, verificar `git diff --cached --name-only` y confirmar que PNG/egg-info no aparecen. No resetear ni revertir hunks no relacionados. Commit `refactor(worker): remove permanent account exclusion wiring`.

### Task 4: Migrar Instagram Reels al contrato semántico

**Files:**
- Modify: `publisher_worker/southfarm_publisher/platforms/instagram.py`
- Modify: `publisher_worker/tests/test_platform_adapters.py`
- Create/Modify: `publisher_worker/tests/fixtures/instagram_account_switcher.xml`, `instagram_profile_identity.xml`, `instagram_reel_flow.xml`

**Interfaces:**
- `InstagramPublisher.prepare(job: PublicationJob) -> PreparedPublication` debe abrir/verificar `com.instagram.android`, seleccionar sólo la cuenta del snapshot y capturar baseline antes de media.
- `InstagramPublisher.publish(prepared: PreparedPublication) -> None` debe resolver caption/Next/`About Reels`/Share en snapshots frescos y persistir checkpoint antes de Share.
- `InstagramPublisher.verify(prepared: PreparedPublication) -> VerificationResult` exige exactamente un tile nuevo delante del baseline e identidad remota observable.
- `InstagramPublisher.cleanup_test_post(manifest: CleanupManifest, authorization: str) -> CleanupResult` usa guards de identidad, autorización y baseline; no selecciona Santiago durante el rollout.

- [ ] **Step 1: Revisar el test dirty y añadir fixtures y pruebas rojas.** Ejecutar `git diff -- publisher_worker/tests/test_platform_adapters.py` antes de editar; conservar e integrar los asserts funcionales aprobados. Cubrir identidad pasiva `com.instagram.android:id/action_bar_title`, padre/hijo `action_bar_username_container`, `Create New`, `Create new reel`, thumbnail `Video thumbnail` con `gallery_grid_item_label`, `clips_right_action_button`, `Downloads privacy`, `About Reels`, colisión Next/Share y Share disabled. Cada test debe afirmar cero tap irreversible ante wrong package, cuenta ausente, colisión, transición stale o contexto final faltante.
- [ ] **Step 2: Ejecutar sólo tests Instagram y observar fallo.** Ejecutar `py -3 -m unittest publisher_worker.tests.test_platform_adapters.InstagramAdapterTests -v` (o el nombre real equivalente del módulo, manteniendo el filtro) y confirmar que el flujo actual trata `action_bar_title` como target o acepta selector incorrecto.
- [ ] **Step 3: Implementar navegación semántica.** Usar `identity_label` para el título pasivo, `switcher_option` para la opción exacta y `tap_and_wait` para el único padre accionable; no tocar el título ni usar coordenadas. Asociar duración al tile por geometría del mismo snapshot y rechazar duplicados/ausencia.

```python
IDENTITY = SemanticSelector(resource_id="com.instagram.android:id/action_bar_title")
SWITCHER = SemanticSelector(resource_id="action_bar_username_container")
SHARE = SemanticSelector(resource_id="com.instagram.android:id/clips_nux_sheet_share_button")

def _require_about_reels_share(self):
    snapshot = self._fresh_snapshot("com.instagram.android")
    self._require_context(snapshot, text="About Reels")
    return snapshot.resolve(SHARE, require_action=True)
```

- [ ] **Step 4: Probar verde y límites.** Ejecutar el módulo de adaptadores, verificar que Share exige enabled/clickable y checkpoint previo, y que post-final sólo usa navegación semántica al perfil con delta exacto; desaparición del botón termina `review_required`.
- [ ] **Step 5: Commit.** Revisar el diff de `test_platform_adapters.py`, stagear sólo los hunks funcionales aprobados junto con adapter/fixtures/tests de esta tarea, confirmar que PNG/egg-info no están staged y commit `feat(worker): migrate Instagram publishing to semantic UI actions`.

### Task 5: Migrar TikTok y bloquear cleanup no verificado hasta dump live

**Files:**
- Modify: `publisher_worker/southfarm_publisher/platforms/tiktok.py`
- Modify: `publisher_worker/tests/test_platform_adapters.py`
- Create/Modify: `publisher_worker/tests/fixtures/tiktok_account_switcher.xml`, `tiktok_gallery.xml`, `tiktok_post_context.xml`
- Do not add a cleanup fixture until the authorized live dump gate in Task 10 is satisfied.

**Interfaces:**
- `TikTokPublisher.prepare(job: PublicationJob) -> PreparedPublication` exige `com.zhiliaoapp.musically`, `profile_account` pasivo, cuenta exacta y baseline de covers `ev2`.
- `TikTokPublisher.publish(prepared: PreparedPublication) -> None` distingue `Create` de `Create a Story`, selecciona media nueva, verifica caption/`Everyone can view this post` o `Public` y hace una sola acción `st6`.
- `TikTokPublisher.cleanup_test_post(...) -> CleanupResult` devuelve `CLEANUP_SELECTOR_UNVERIFIED` antes de cualquier swipe/delete mientras no exista el fixture live aprobado.

- [ ] **Step 1: Revisar el diff dirty y escribir pruebas rojas de publicación y cleanup guard.** Ejecutar `git diff -- publisher_worker/tests/test_platform_adapters.py` y preservar los hunks aprobados; añadir casos `Create` versus `Create a Story`, identity passive, `Upload`, `ica`, `Next (1)`, `Next`, `h00`, keyboard-open, visibilidad, `st6`, cover y contador `tv_play_count=0`. Probar explícitamente que cleanup no llama `swipe` ni `tap` si no existe el fixture autorizado.
- [ ] **Step 2: Ejecutar tests TikTok y confirmar fallo.** `py -3 -m unittest publisher_worker.tests.test_platform_adapters.TikTokAdapterTests -v`; debe fallar por la navegación plana/coordenada fija actual o por falta de guard.
- [ ] **Step 3: Implementar el flujo semántico y el checkpoint final.** Resolver cada control con snapshots frescos, verificar el contador asociado a la cover y persistir `publishing` antes de Post; nunca aceptar `Create a Story` ni un `Post` fuera del contexto de descripción/visibilidad.
- [ ] **Step 4: Mantener cleanup fail-closed.** Sustituir la llamada productiva `[900,900] → [100,900]` por una ruta que, hasta contar con selector live, lance `CLEANUP_SELECTOR_UNVERIFIED` antes de cualquier swipe. Cuando Task 10 provea fixture/selector, implementar `swipe_and_wait` con bounds del carrusel y tests en dos resoluciones.
- [ ] **Step 5: Ejecutar regresiones y commit.** Ejecutar tests TikTok y `rg -n "900,900|100,900" publisher_worker/southfarm_publisher/platforms/tiktok.py`; no debe quedar coordenada fija. Revisar `git diff -- publisher_worker/tests/test_platform_adapters.py`, stagear sólo hunks funcionales aprobados y excluir PNG/egg-info. Commit `feat(worker): migrate TikTok publishing to semantic UI actions`.

### Task 6: Migrar YouTube Shorts al contrato semántico

**Files:**
- Modify: `publisher_worker/southfarm_publisher/platforms/youtube.py`
- Modify: `publisher_worker/tests/test_platform_adapters.py`
- Create/Modify: `publisher_worker/tests/fixtures/youtube_account_switcher.xml`, `youtube_gallery.xml`, `youtube_short_flow.xml`

**Interfaces:**
- `YouTubePublisher.prepare(job: PublicationJob) -> PreparedPublication` verifica `com.google.android.youtube`, canal e identidad pasiva `account_name`, y selecciona sólo el nombre remoto `publication-JOB_ID-MEDIA_ID.EXT`.
- `YouTubePublisher.publish(prepared: PreparedPublication) -> None` resuelve `Create`/`Short`, galería, `multi_select_next_button`, `creation_next_button`, `shorts_post_bottom_button`, caption, `Public` y `upload_bottom_button` enabled.
- `YouTubePublisher.verify(prepared: PreparedPublication) -> VerificationResult` exige tarjeta nueva en `You -> View channel` con caption exacto y marcador `play Short`.

- [ ] **Step 1: Revisar el diff dirty, añadir pruebas rojas y fixtures sanitizados.** Ejecutar `git diff -- publisher_worker/tests/test_platform_adapters.py` antes de editar y preservar los hunks aprobados; cubrir `Short` versus `Shorts`, canal ausente/ambiguo, galería duplicada, Upload disabled, `Private`/`Unlisted`, tarjeta de verificación y `More actions` geométricamente asociado. Cada caso negativo debe afirmar cero tap final.
- [ ] **Step 2: Ejecutar tests YouTube y confirmar fallo.** `py -3 -m unittest publisher_worker.tests.test_platform_adapters.YouTubeAdapterTests -v` debe evidenciar el incumplimiento actual de selector/guard.
- [ ] **Step 3: Implementar selectores y guards.** Resolver la identidad pasiva sin tocarla, exigir nombre remoto exacto y rechazar duplicados; usar sólo targets enabled/clickable, checkpoint antes de `Upload Short`, y evidencia positiva de la tarjeta remota.
- [ ] **Step 4: Implementar cleanup semántico.** Asociar `More actions` a la tarjeta verificada por geometría del snapshot, resolver delete/confirmación en snapshots nuevos y comprobar baseline ordenado restaurado; nunca borrar por posición fija.
- [ ] **Step 5: Ejecutar tests y commit.** Revisar `git diff -- publisher_worker/tests/test_platform_adapters.py`, stagear sólo los hunks funcionales aprobados junto con esta tarea, verificar que PNG/egg-info no están staged y commit `feat(worker): migrate YouTube Shorts to semantic UI actions`.

### Task 7: Endurecer runner, finish incierto y copy de cuenta no disponible

**Files:**
- Modify: `publisher_worker/southfarm_publisher/runner.py`
- Modify if required by existing signatures: `publisher_worker/southfarm_publisher/api_client.py`, `publisher_worker/southfarm_publisher/models.py`
- Modify: `publisher_worker/tests/test_runner.py`
- Modify: `webapp/src/app/publication-panel.tsx`
- Modify: `webapp/src/app/publication-types.ts` only if an existing typed error field is insufficient
- Modify: corresponding webapp Vitest test file

**Interfaces:**
- `PublicationRunner.finish_uncertain(job: PublicationJob, *, platform: str, final_action: str, snapshot_id: str, reason: str) -> None` llama una sola vez al endpoint existente con `status="review_required"`, `error_code="FINAL_ACTION_UNCERTAIN"`, `error_message` seguro y `result={"platform", "final_action", "snapshot_id", "reason"}`.
- `PublicationRunner.run_once()` nunca repite Share/Post/Upload Short después de persistir `final_action=true`; libera lease/heartbeat de forma segura.
- Web mappea `ACCOUNT_UNAVAILABLE` al copy exacto: `La cuenta seleccionada ya no está disponible en este teléfono. Volvé a escanear sus cuentas o elegí otra cuenta disponible.` y conserva dispositivo/cuenta/timeline y handlers React `onClick`.

- [ ] **Step 1: Leer la guía Next relevante antes de tocar frontend.** Desde el checkout frontend, localizar la guía aplicable bajo `node_modules/next/dist/docs/`, leerla completa y anotar en el handoff de la tarea cualquier API vigente que afecte el componente o sus tests.
- [ ] **Step 2: Añadir pruebas rojas.** En `test_runner.py`, simular checkpoint final exitoso y ADB error/transition stale, afirmar una sola llamada finish, estado `review_required`, código/result compactos y cero segundo tap. En Vitest, afirmar copy exacto, selección visible y ausencia de un handler web sustituido por ADB.

```python
def test_uncertain_final_action_finishes_once_without_retry(self):
    runner, api, adb = runner_with_checkpointable_fake()
    runner.run_once(job_with_final_action("Share"))
    self.assertEqual(adb.tap_commands.count("Share"), 1)
    self.assertEqual(api.finish_calls, 1)
    self.assertEqual(api.finished[0]["status"], "review_required")
    self.assertEqual(api.finished[0]["error_code"], "FINAL_ACTION_UNCERTAIN")
    self.assertNotIn("final_action_uncertain", api.finished[0])
```

- [ ] **Step 3: Implementar finish y clasificación.** Mantener el endpoint/contrato existente, serializar sólo razón/snapshot IDs seguros y no enviar caption, XML, Authorization ni el campo nuevo. Si el checkpoint falla, no ejecutar tap; si ya quedó persistido, no transformar el caso en retryable.
- [ ] **Step 4: Completar web sin cambiar interacción.** Leer la guía Next aplicable, ajustar sólo el mapeo/copy y tests; no reemplazar `onClick`, focus, teclado ni accesibilidad.
- [ ] **Step 5: Ejecutar y commit.** Backend/worker focalizados y tests Vitest; commit `fix(worker-web): classify uncertain final actions safely`.

### Task 8: Aplicar autorización de cleanup en el orden obligatorio

**Files:**
- Modify: `publisher_worker/southfarm_publisher/cleanup_cli.py`
- Modify if needed: `publisher_worker/southfarm_publisher/api_client.py`
- Modify: `publisher_worker/tests/test_cleanup_cli.py`

**Interfaces:**
- `CleanupApi.validate_authorization(token: str, manifest: CleanupManifest) -> CleanupAuthorization` no abre ADB y valida firma, expiración, no-consumido, workspace, job, device, social account, platform, worker, identidad remota, baseline y cuenta.
- `CleanupApi.consume_authorization(token: str, manifest: CleanupManifest) -> None` consume atómicamente una sola vez y sólo se llama inmediatamente antes del primer tap destructivo.
- `execute_cleanup(manifest: CleanupManifest, authorization: str, *, device_factory: Callable[[], SafeAdb]) -> CleanupResult` implementa validate → open/preflight → consume → delete → baseline.

- [ ] **Step 1: Escribir pruebas rojas de orden y cero taps.** Usar fakes con eventos `validate`, `open_adb`, `preflight`, `consume`, `tap_delete`; probar token inválido/expirado/consumido/scope mismatch sin `open_adb`, preflight fallido sin consumo, consume fallido con cero delete y éxito con consume una sola vez antes del primer tap.

```python
def test_consume_failure_executes_zero_destructive_taps(self):
    api, device = cleanup_fakes(consume_error="CLEANUP_AUTH_INVALID")
    with self.assertRaises(CleanupError) as ctx:
        execute_cleanup(manifest, "signed-token", device_factory=lambda: device)
    self.assertEqual(ctx.exception.code, "CLEANUP_AUTH_INVALID")
    self.assertEqual(device.delete_taps, 0)
    self.assertEqual(api.events[:3], ["validate", "open_adb", "preflight"])
```

- [ ] **Step 2: Ejecutar test focalizado y confirmar fallo.** `py -3 -m unittest publisher_worker.tests.test_cleanup_cli -v` debe mostrar el orden actual incorrecto o consumo temprano.
- [ ] **Step 3: Implementar la secuencia sin side effects tempranos.** Canonicalizar cuenta en memoria, validar por HTTP antes de abrir ADB, hacer preflight completo, consumir una vez justo antes de delete, y detener ante cualquier mismatch; nunca aceptar token local generado por el worker.
- [ ] **Step 4: Cubrir las tres plataformas y baseline.** Añadir regresiones de cleanup Instagram/TikTok/YouTube; TikTok debe conservar `CLEANUP_SELECTOR_UNVERIFIED` antes de swipe/delete. La confirmación y snapshot posterior deben probar baseline ordenado restaurado.
- [ ] **Step 5: Ejecutar y commit.** Commit `fix(worker): enforce signed cleanup authorization order`.

### Task 9: Integración, regresiones estáticas y gates automatizados

**Files:**
- Create: `publisher_worker/tests/test_semantic_publishing_integration.py`
- Modify only if a regression exposes a missing assertion: `publisher_worker/tests/test_adb_device.py`, `test_platform_adapters.py`, `test_runner.py`, `test_cleanup_cli.py`

**Interfaces:**
- `ScriptedAdb` entrega snapshots en orden, captura todos los argv y expone `tap_commands`, `swipe_commands`, `push_commands` y `dump_ids` para las pruebas.
- `run_scripted_publication(platform: str, snapshots: list[UiSnapshot]) -> RunEvidence` ejecuta el worker hasta `completed`, `failed` o `review_required` sin teléfono real.

- [ ] **Step 1: Escribir prueba roja de secuencia completa.** Construir una secuencia mínima por plataforma con dumps antes/después, assert de checkpoints `preparing → transferring → selecting_media → editing → captioning → ready_to_publish → publishing → verifying`, y assert de un solo final action.
- [ ] **Step 2: Ejecutar integración y documentar cualquier fallo real.** `py -3 -m unittest publisher_worker.tests.test_semantic_publishing_integration -v`; corregir sólo la implementación necesaria, sin eliminar casos dirty.
- [ ] **Step 3: Ejecutar suite worker completa.** Desde raíz del worktree: `py -3 -m unittest discover -s publisher_worker\\tests -q`. Debe pasar junto con las regresiones que prueban ausencia de wiring prohibido y sin incorporar PNG/egg-info.
- [ ] **Step 4: Ejecutar backend y ops según handoff.** Desde `backend/`, configurar Node portable 22.23.1 y correr:

```powershell
$env:PATH = "C:\Users\josu_\AppData\Local\SouthFarm\node-v22.23.1-win-x64;$env:PATH"
npm run build
node scripts/test-publications-domain.mjs
node scripts/test-publications-api.mjs
node scripts/test-publication-worker-api.mjs
```

Luego desde raíz: `powershell -NoProfile -ExecutionPolicy Bypass -File .\ops\windows\test-southfarm-publisher-worker.ps1 -CreateTemporaryFixture`.
- [ ] **Step 5: Ejecutar web tests/lint/build.** Usar los scripts declarados por el `package.json` real del frontend y la guía Next leída en Task 7; comprobar Vitest, lint y build, y confirmar que los handlers siguen siendo `onClick`. No afirmar producción por un build local solamente.
- [ ] **Step 6: Revisar diff y commit de pruebas.** Ejecutar `git diff --check`, `git diff --stat`, `git status --short`, y `rg -n "\.click\(|performClick|UiObject\.click|input tap [0-9]+ [0-9]+|900,900|100,900" publisher_worker/southfarm_publisher`. Revisar cualquier diff preexistente antes de staging, agregar sólo el test/instrumentación y asserts funcionales aprobados de esta tarea, y excluir PNG/egg-info. Commit `test(worker): cover semantic publishing end to end`.

### Task 10: Dry-run físico, despliegue controlado y rollout Instagram autorizado

**Files:**
- Create only if the implementer needs a durable checklist: `docs/superpowers/runbooks/2026-08-16-semantic-mobile-publishing-rollout.md`
- Protected live evidence: worker evidence directory already configured; do not commit XML live, captions, screenshots públicos, tokens or media paths.

**Interfaces / gates:**
- `runbook.preflight()` must confirm serial `863d00583048313238510ca492874c`, Android ID `aaa9c7a1f6cdb7a1`, backend device row `28`, legacy device `fd2f46b48e71496a`, installed packages and current worker config.
- `runbook.publish_one(video: MP-V-1.mp4 | MP-V-2.mp4, account="@growtech.news", platform="instagram")` must stop after any ambiguous selector, wrong account/package, stale transition, failed verification, cleanup mismatch or `review_required`.
- `runbook.cleanup_one(...)` must use the server-signed human authorization and prove baseline restoration before allowing the next video.

- [ ] **Step 1: Preserve and inspect the worktree.** Before deployment, run `git status --short`, review the preexisting diffs of `common.py` and `test_platform_adapters.py`, verify that approved functional hunks were integrated only in their corresponding commits and that unapproved hunks remain intact. Confirm PNG/egg-info are never staged. Review only functional commits from Tasks 1–9. Do not use `git reset`, `git checkout --` or broad cleanup commands.
- [ ] **Step 2: Execute physical dry-run.** Obtain fresh sanitized dumps and run Instagram, TikTok and YouTube until before `Share`, `Post` or `Upload Short`. Confirm every tap has a preceding snapshot ID/bounds record, every post-action dump has positive context evidence, and swipes vary with two screen sizes. TikTok cleanup remains blocked until its live selector gate.
- [ ] **Step 3: Deploy only after automated green.** Restart the Windows worker only after Python, backend, ops and web tests pass; verify `https://api.southfarm.tech/api/health`, queue/lease/heartbeat logs, worker task state, protected logging and remote media deletion. Open `https://southfarm-webapp.vercel.app/` and check that `Crear publicación` preserves device/account selection after recoverable errors and still uses web `onClick`.
- [ ] **Step 4: Select only the authorized account.** Record in the protected rollout checklist that `@growtech.news` is selected and `santilorennzo`/Santiago is not selected, published or cleaned. This is an orchestration fact, never a runner/adaptor guard.
- [ ] **Step 5: Publish and clean `MP-V-1.mp4`.** From the production webapp create one Instagram Reel for `@growtech.news`; observe `publishing → verifying → completed`, verify exactly one new Reel in the correct profile against baseline, validate/consume cleanup authorization, delete it semantically and prove baseline restoration. If any stage is uncertain, stop with human review and do not create `MP-V-2`.
- [ ] **Step 6: Only after the first cycle is complete, publish and clean `MP-V-2.mp4`.** Repeat the exact gates and stop permanently on the first ambiguity. Maximum is two successful Instagram publications; no TikTok/YouTube live publication is authorized by this plan.
- [ ] **Step 7: Handoff evidence and final status.** Report commit SHAs, test commands/results, deployment health, job IDs/statuses, sanitized profile/baseline evidence and any `review_required`; never report success from a `completed` job without profile/channel evidence. Do not commit protected live artifacts.

---

## Self-review checklist

- [ ] Every acceptance criterion in the approved spec maps to at least one task: hierarchy/priority/ancestors (1), fresh physical actions (2), account policy removal (3), Instagram (4), TikTok guard/dynamic swipe (5), YouTube (6), final checkpoint/web copy (7), cleanup authorization (8), integration/build gates (9) and live rollout (10).
- [ ] No task relies on a fixed button coordinate, Android click method, login automation or a permanent Santiago exclusion.
- [ ] Interface names are consistent: `UiSnapshot`, `UiNode`, `SemanticSelector`, `ResolvedTarget`, `SafeAdb.dump_snapshot`, `GuardedPublisher.tap_and_wait`, `PublicationRunner.finish_uncertain`, `CleanupApi.validate_authorization` and `consume_authorization`.
- [ ] Every implementation task starts with a failing test, runs the focused test, implements the minimum change, runs a green test and commits only its own paths.
- [ ] The plan contains no unspecified follow-up; live unknowns are explicit gates that stop the rollout, especially TikTok cleanup selector capture.
- [ ] The plan preserves unapproved dirty hunks, integrates approved functional hunks through reviewed staging, excludes PNG/egg-info from every commit and keeps all live evidence outside commits.

Plan complete and saved to `docs/superpowers/plans/2026-08-16-semantic-mobile-publishing.md`. Two execution options:

1. **Subagent-Driven (recommended):** dispatch a fresh agent per task, review after each task and keep the worktree gates visible.
2. **Inline Execution:** use `superpowers:executing-plans` in this session with checkpoints.
