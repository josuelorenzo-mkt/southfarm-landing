# Diseño: publicación móvil semántica con UiSnapshot jerárquico

## Objetivo

Hacer que la publicación de videos en Instagram Reels, TikTok y YouTube Shorts avance mediante una representación jerárquica y fresca del árbol UI de Android. Cada acción física debe localizar el elemento por identidad semántica, resolver su target accionable dentro de la jerarquía, calcular sus bounds actuales y ejecutar `adb shell input tap`. El flujo no debe depender de coordenadas fijas de botones ni de métodos de click de la UI.

El resultado debe conservar el contrato de SouthFarm ya implementado: la web crea una publicación, el backend la encola y el Publisher Worker Windows reclama el trabajo, controla el teléfono exacto por ADB, cambia al perfil/canal exacto, transfiere el video, publica, verifica y comunica `completed`, `failed` o `review_required`.

Este documento formaliza el cambio aprobado por el usuario. No autoriza credenciales automáticas ni modifica cuentas sociales. La interacción web conserva los handlers React `onClick`; la regla de `tap` aplica únicamente a la interacción física del worker con las aplicaciones móviles.

## Estado actual verificado

### Fuentes y checkout

La fuente de desarrollo de esta tarea es:

~~~text
C:\SouthFarm\source\.worktrees\semiorganic-publishing
~~~

El handoff leído completo es `docs\SEMIOGANIC_PUBLISHING_HANDOFF_ES.md`, actualizado el 2026-08-14. El checkout está en la rama `codex/semiorganic-publishing`; al iniciar la redacción de esta spec el HEAD observado era `50f9bf9`. Este documento se versiona después de esa observación y no redefine la fuente de runtime.

La producción web documentada por el handoff es `https://southfarm-webapp.vercel.app/`. El backend documentado es `https://api.southfarm.tech`, con los servicios Windows `SouthFarm API` y `SouthFarm Publisher Worker`. Esos datos son contexto operativo del handoff y deben volver a comprobarse durante el rollout; no se presentan aquí como una nueva prueba de producción.

El árbol de trabajo ya contenía cambios ajenos a esta tarea y artefactos locales. Se preservan expresamente:

~~~text
M publisher_worker/southfarm_publisher/platforms/common.py
M publisher_worker/tests/test_platform_adapters.py
?? phone-after-exit.png
?? phone-current.png
?? publisher_worker/southfarm_publisher_worker.egg-info/
~~~

El parche dirty de `common.py` acepta como identidad una etiqueta de cuenta pasiva como `action_bar_title`, `profile_account` o `account_name`, mientras mantiene controles accionables sujetos a `enabled` y `clickable`. El test dirty documenta esa separación. No forma parte del commit de esta spec y no se debe descartar.

### Implementación actual del worker

La inspección de los archivos worker mostró lo siguiente:

- `SafeAdb.dump_ui()` ejecuta `exec-out uiautomator dump /dev/tty` y `parse_ui()` devuelve una lista plana de diccionarios de atributos. La relación padre/hijo del XML se pierde al devolver sólo `dict(node.attrib)`.
- `GuardedPublisher._nodes()` exige que el package en foreground sea el esperado y obtiene un dump nuevo. `_one()` hace coincidencias exactas, rechaza más de un match, comprueba `enabled` y `clickable`, y valida bounds.
- `tap_and_wait()` vuelve a tomar un dump antes de seleccionar el nodo, realiza un tap mediante `SafeAdb.tap_bounds()` y espera una revisión fresca que demuestre el contexto positivo de la siguiente pantalla.
- `SafeAdb.tap_bounds()` calcula el centro de bounds y ejecuta un argv equivalente a `adb -s SERIAL shell input tap X Y`, con `shell=False`. No utiliza un método Android `click`.
- `SafeAdb.back()` usa `shell input keyevent 4`; `SafeAdb.text()` usa `shell input text` después de validar caracteres; `SafeAdb.swipe()` recibe coordenadas y duración. La implementación de cleanup de TikTok todavía llama a `device.swipe(900, 900, 100, 900, 300)`, por lo que ese caso conserva coordenadas fijas y debe migrarse a bounds dinámicos.
- El `PublicationRunner` actual persiste checkpoints monotónicos, marca la intención final antes del gesto irreversible y puede terminar en `review_required`; su llamada actual de finish no garantiza todavía `error_message` ni `result` compactos. El delta objetivo de esta spec exige que una incertidumbre posterior use sólo el estado terminal existente, `error_code`, `error_message` y `result` compacto del endpoint de finish; no agrega ni envía un campo `final_action_uncertain`. No se debe reintentar automáticamente `Share`, `Post` o `Upload Short`.
- Los adaptadores ya tienen guards de package, cuenta, contexto y delta de galería/perfil. Esos guards se conservarán y se implementarán sobre `UiSnapshot`.

### Delta explícito para retirar la política permanente de cuenta

El checkout actual todavía contiene una política permanente que debe eliminarse como parte de la implementación, aunque esta spec no modifica código:

- En `publisher_worker/southfarm_publisher/platforms/common.py`, retirar el parámetro `forbidden_accounts` del constructor y el atributo asociado de `GuardedPublisher`, junto con los branches por username y el error `FORBIDDEN_ACCOUNT` en `_account()` y `selected_account_username()`. La identidad esperada se seguirá validando exactamente, pero ningún username activa una rama de prohibición productiva.
- En `publisher_worker/southfarm_publisher/runner.py`, eliminar `_normalized_accounts`, la lectura y validación de `SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS` y `SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS`, y el cuarto valor de retorno de `_config()`. `platform_adapters()` ya no recibe `forbidden_instagram_accounts`, sus builders ya no reciben ni pasan `forbidden_accounts`, y `main()` deja de cablear esa política.
- El worker/config instalado no debe volver a exigir ni documentar esas variables. Si existen restos en una configuración local, se eliminan del contrato y no cambian el comportamiento.
- En `publisher_worker/tests/test_platform_adapters.py` y `publisher_worker/tests/test_runner.py`, retirar los tests que esperan `FORBIDDEN_ACCOUNT` o que construyen adapters con `forbidden_accounts`. Sustituirlos por regresiones que prueben que `santilorennzo`, `growtech.news` y otro username válido pasan por el mismo camino semántico, que los adapters no tienen un branch de username prohibido, que la factory no recibe esa opción y que `_config()` funciona sin las variables antiguas.

La exclusión de `santilorennzo` se mantiene sólo como entrada del orquestador/checklist de rollout de esta sesión: el orquestador selecciona `@growtech.news`, nunca selecciona la cuenta temporalmente excluida y registra esa elección. El worker y sus tests de producto no codifican esa decisión.

### Evidencia operativa previa

El handoff registra que el teléfono físico usado para las pruebas es:

~~~text
ADB serial: 863d00583048313238510ca492874c
Android secure ID: aaa9c7a1f6cdb7a1
Backend device row id: 28
Backend legacy device_id: fd2f46b48e71496a
~~~

La cuenta segura de trabajo es `@growtech.news`. Para el rollout y las pruebas autorizadas de esta sesión, `santilorennzo`/Santiago queda temporalmente excluida; esta exclusión no es una política permanente del producto.

Los jobs de Instagram 4, 5 y 6 del handoff terminaron en `failed`; no se registró una publicación exitosa. El problema de `#6` fue que `action_bar_title` es una etiqueta de identidad pasiva (`clickable=false`) y se trató como si debiera ser un control accionable. El parche dirty corrige esa distinción.

El handoff también indica que el teléfono quedó en el perfil de Instagram `growtech.news` y que el último dump live se hizo cuando el teléfono estaba en SouthFarm, no en una pantalla de Instagram navegada para esta nueva spec. Por eso el árbol de Instagram no se revalidó de manera live durante esta redacción: hacerlo habría requerido navegar el dispositivo. Los selectores de Instagram que aparecen a continuación son el contrato observado en el handoff y en los fixtures del worker; el rollout debe obtener un dump fresco antes de probarlos.

## Alcance

### Incluido

- Crear `UiSnapshot` y `UiNode` con estructura padre/hijos conservada desde el XML de UIAutomator.
- Indexar por `resource-id`, `content-desc` y `text` con prioridad exacta y determinista.
- Separar la identidad pasiva de una cuenta o etiqueta del target accionable que recibe el tap.
- Resolver un label pasivo al único ancestro habilitado y clickable que lo contiene.
- Fallar cerrado ante cero matches, matches múltiples, bounds inválidos, target deshabilitado, package incorrecto o transición no observable.
- Tomar un dump fresco antes de cada acción física y uno posterior para comprobar la transición esperada.
- Calcular taps y swipes desde bounds del snapshot actual.
- Ejecutar taps físicos exclusivamente como `adb shell input tap`.
- Mantener acciones especiales seguras para abrir una app, volver, escribir texto y deslizar.
- Mantener checkpoints de publicación y `review_required` después de una acción final incierta.
- Adaptar las reglas semánticas de Instagram, TikTok y YouTube Shorts.
- Añadir pruebas TDD con XML sanitizado, fakes de ADB, fixtures de colisiones y pruebas de integración del worker.
- Hacer un rollout de dry-run y una prueba end-to-end real dentro de la autorización explícita de este documento.

### No incluido

- Cambiar la webapp a taps físicos: la web sigue usando React `onClick`, teclado, focus y accesibilidad.
- Usar `click`, `performClick`, `UiObject.click`, Appium u otro método semántico de click dentro de una aplicación móvil.
- Automatizar inicio de sesión, credenciales, contraseñas, PIN, códigos 2FA, cookies o tokens de redes sociales.
- Cambiar el APK Flutter, AccessibilityService, backend de publicaciones, identidad del dispositivo o el contrato de cuentas escaneadas.
- Implementar carruseles, fotos, Stories, música añadida en la plataforma o edición avanzada.
- Publicar automáticamente en varias cuentas o seleccionar una cuenta no proveniente del último escaneo.
- Ejecutar una publicación real en TikTok o YouTube sin una autorización separada. La autorización de rollout real de esta spec se limita a Instagram en `@growtech.news`.
- No seleccionar, publicar ni limpiar en `santilorennzo`/Santiago durante el rollout y las pruebas de esta sesión. Esta exclusión temporal no se implementa como guard permanente en runner, adapters o `cleanup_cli`.
- Reintentar una acción final una vez que su checkpoint fue persistido.

## Arquitectura de UiSnapshot

### Captura y ciclo de vida

Cada `UiSnapshot` representa exactamente una ejecución de `uiautomator dump` del package esperado. Debe contener:

- `snapshot_id`: identificador local monotónico y no sensible.
- `captured_at`: timestamp monotónico local para medir frescura.
- `package`: package obtenido y validado antes de interpretar el árbol.
- `root`: nodo raíz jerárquico.
- `nodes`: índice interno por `node_id`, útil para búsquedas y trazabilidad.
- `screen_size`: ancho y alto conocidos y validados antes de cualquier gesto físico.

La captura debe eliminar sólo el sufijo de estado que imprime UIAutomator y rechazar XML inválido. No se debe aplanar el XML como única representación. La lista pre-order puede existir como índice auxiliar, pero nunca reemplaza los enlaces de parent/children.

Un snapshot es de sólo lectura. Después de una acción que pueda cambiar la UI, ningún nodo, bounds ni target derivado del snapshot anterior puede reutilizarse. El helper de acción debe recibir un snapshot nuevo, resolver de nuevo y ejecutar el gesto sólo contra ese resultado.

### Modelo de nodos y relaciones

Cada `UiNode` debe conservar al menos:

- `node_id`: ruta estable dentro del snapshot, formada por índices de hijos desde la raíz.
- `parent_id`: `node_id` del padre directo, o `None` para la raíz.
- `child_ids`: lista ordenada de hijos directos.
- `class_name`: clase Android.
- `resource_id`: valor exacto del atributo `resource-id`, si existe.
- `content_desc`: valor exacto de `content-desc`, si existe.
- `text`: valor exacto de `text`, si existe.
- `bounds`: string original y bounds parseados validados.
- `enabled`, `clickable`, `visible_to_user`, `focused`, `selected` y otros flags útiles como metadata, sin inferir que un flag vuelve accionable a una etiqueta.

La relación es un árbol: un nodo tiene como máximo un padre, y un padre conserva el orden de sus hijos. Un `UiNode` puede tener una etiqueta hija pasiva y un contenedor padre accionable. La resolución debe poder recorrer todos los ancestros directos hasta la raíz y contar los candidatos accionables.

Para un target físico, `visible_to_user=false`, `screen_size` ausente o inválido, bounds ausentes, bounds con tamaño cero, bounds invertidos o bounds que salgan de la pantalla son errores fail-closed antes del tap o swipe. El helper debe devolver un código estable de UI y no corregir, recortar ni inventar geometría. Una etiqueta pasiva que sólo se usa como evidencia también debe tener bounds válidos, pero no genera un gesto.

El `node_id` o una huella lógica puede aparecer en logs seguros, pero el XML completo, texto de caption y contenido de dumps no debe salir a logs de producción. Las referencias a evidencia local deben ser paths o IDs protegidos, no el contenido de la evidencia.

### Identidad semántica y prioridad exacta

Un selector de acción declara uno o más valores exactos. La búsqueda se ejecuta en este orden:

1. `resource-id` exacto.
2. `content-desc` exacto.
3. `text` exacto.

El primer campo de la lista anterior que tenga un valor configurado y produzca matches determina la identidad principal. No se permiten coincidencias parciales, contains, prefijos, expresiones regulares ni normalización que convierta dos cuentas distintas en una. Los atributos secundarios del selector funcionan como guards de contexto; nunca sirven para escoger arbitrariamente uno entre varios matches.

La semántica de resolución es:

- Si el campo principal produce cero matches, se intenta el siguiente campo configurado de menor prioridad.
- Si el primer campo que produce matches devuelve más de un nodo, se arroja `SELECTOR_COLLISION`; no se prueba otro campo para esconder la colisión.
- Si todos los campos configurados producen cero matches, se arroja el error de ausencia correspondiente.
- Si hay un único match, se validan package, visibilidad necesaria, bounds y el contexto esperado en el mismo snapshot.
- Un match por `resource-id` no se duplica con el mismo valor encontrado en `content-desc` o `text`: la prioridad detiene la búsqueda y el resultado es el nodo del `resource-id`.

Esta regla evita que un padre `content-desc=growtech.news` y un hijo `text=growtech.news` se cuenten como dos cuentas cuando el selector de opción pide primero el `content-desc`. Si sólo se encuentra el texto hijo, la resolución jerárquica todavía puede llevarlo a su padre accionable según la regla siguiente.

### Etiqueta pasiva y target accionable

La identidad pasiva y la acción son objetos diferentes:

- Una identidad pasiva responde “qué cuenta, canal o pantalla está visible”. Puede tener `clickable=false`; por ejemplo, Instagram `action_bar_title`, TikTok `profile_account` y YouTube `account_name`. Su resolución sólo exige una coincidencia exacta, bounds válidos y el valor de cuenta esperado.
- Un target accionable responde “qué control debe recibir el tap”. Debe ser un nodo `enabled != false` y `clickable == true`, con bounds válidos.
- El atributo `clickable` es metadata del árbol Android. No es una instrucción para llamar a `click`; el gesto real siempre es `input tap`.

Cuando el match semántico es una etiqueta pasiva:

1. Se toma la cadena de ancestros directos del nodo, sin saltar nodos ni cruzar otro subárbol.
2. Se seleccionan los ancestros con `enabled != false` y `clickable == true`.
3. Debe existir exactamente un ancestro elegible.
4. Si no existe, se arroja `ACTION_TARGET_UNAVAILABLE`.
5. Si existen dos o más, se arroja `SELECTOR_COLLISION`; no se elige el más cercano ni el primero del XML.
6. El ancestro elegido conserva una relación explícita con la identidad pasiva para logging y evidencia.
7. Se validan nuevamente sus bounds en el mismo snapshot justo antes del tap.

Si el match semántico ya es un control enabled/clickable, puede ser el target directamente y no necesita resolver un ancestro. Si el label es pasivo pero el padre está disabled, el resultado es `CONTROL_DISABLED`. Un nodo de identidad sin target accionable nunca puede provocar un tap por coordenada adivinada.

El selector de una cuenta debe distinguir:

- `identity_label`: la etiqueta que prueba que la cuenta/canal activo coincide.
- `switcher_option`: la opción exacta de cuenta disponible en el selector.
- `action_target`: el padre clickable de esa opción, si la opción visible es sólo un texto hijo.

Por lo tanto, aceptar `action_bar_title` como identidad no relaja el requisito de que el switcher que se va a tocar sea enabled/clickable.

## Contrato de acciones físicas

### Regla general de frescura

Cada acción se ejecuta como una transacción observable:

~~~text
validar package
→ dump fresco
→ resolver identidad/target exacto
→ validar contexto y bounds actuales
→ ejecutar un único comando ADB
→ dump fresco posterior
→ comprobar la transición esperada
~~~

El dump posterior no se sustituye por el código de retorno de ADB. Un retorno exitoso sólo demuestra que el comando fue aceptado por ADB, no que la app procesó el gesto.

La verificación posterior debe tener evidencia positiva: un control, label, package/estado o conjunto de identidad esperado debe aparecer en el snapshot posterior. Que el control anterior desaparezca no es suficiente. Las únicas excepciones son:

- apertura de app: foreground package exacto seguido por un control inicial conocido;
- back desde galería: perfil, identidad de cuenta y control de creación esperados;
- acción final: pantalla de procesamiento/confirmación reconocida o, si la app no ofrece esa pantalla estable, la posterior verificación de perfil/canal con delta exacto; si sólo desaparece el botón final, se termina en `review_required`;
- cleanup: baseline ordenado completo después de la confirmación, nunca sólo la ausencia del post.

Cada excepción tiene guards positivos equivalentes y debe estar codificada en el adapter. Cualquier otro caso sin evidencia positiva termina en el error del paso y no se reintenta a ciegas.

Las acciones comprendidas por esta regla son tap, input text, back, swipe y apertura de la aplicación. Para una espera, cada poll obtiene un dump nuevo; no se reutiliza un objeto de una iteración previa. Si la transición posterior no es observable dentro del timeout, el flujo termina con el error estable correspondiente y no inventa un éxito.

### Tap

El helper de tap debe:

1. Tomar un `UiSnapshot` fresco.
2. Resolver el target por la prioridad exacta.
3. Resolver el único ancestro accionable si corresponde.
4. Parsear bounds actuales y exigir `left < right`, `top < bottom`, coordenadas dentro de la pantalla conocida y un centro entero válido.
5. Ejecutar exactamente `adb -s SERIAL shell input tap X Y` con argv seguro y `shell=False`.
6. Obtener un dump posterior.
7. Verificar evidencia positiva del contexto esperado de la siguiente pantalla. La desaparición del target anterior, por sí sola, no demuestra que la acción fue aceptada.

Nunca se usará una coordenada constante para un botón. Si no hay bounds válidos o la etiqueta no tiene un target accionable inequívoco, se detiene el flujo.

### Input text

Escribir caption no es un tap y usa su acción especial propia:

- Tomar un dump fresco y encontrar exactamente un `EditText` visible, enabled y enfocable, o resolver el campo por su label y target.
- No escribir hasta que el campo esté activo o la acción de foco haya sido verificada.
- Pasar cada palabra mediante el wrapper seguro de `shell input text`; no construir una línea que permita shell injection.
- Después de cada token, tomar dump fresco y comparar el texto observado con el prefijo esperado.
- No registrar el caption ni los argumentos de `input text`.
- Aplicar el contrato de 1 a 10 palabras en las tres plataformas y, adicionalmente, máximo 100 caracteres para YouTube.

No se escriben usuarios, contraseñas, códigos ni credenciales. Un caption divergente o un campo ambiguo termina la publicación antes de la acción final.

### Back

Volver se ejecuta como `adb shell input keyevent 4` sólo cuando el adaptador conoce la pantalla actual y la pantalla de destino esperada. El helper toma dump antes, ejecuta un solo back, toma dump después y verifica la pantalla esperada. Si el back podría abandonar un editor o una publicación sin un guard de contexto, se detiene.

El back usado al salir de la galería durante `prepare` debe demostrar que regresó al perfil correcto y que no dejó un flujo de publicación intermedio.

### Apertura de aplicación

Abrir una app es la única excepción al requisito de tener el package esperado antes del comando: el teléfono puede estar mostrando otro package cuando se ejecuta `adb shell monkey -p PACKAGE 1`. Antes de ese comando se valida la identidad física del dispositivo; cualquier exclusión temporal de la sesión se aplica en el runbook/orquestación, no como guard permanente del worker. No se interpreta todavía un dump de la app destino. Inmediatamente después de `monkey` se consulta `foreground_package()` y se exige el package exacto. Sólo después de esa comprobación se permite tomar el primer dump del flujo, hacer un tap o transferir media.

Después de verificar el package debe existir evidencia positiva de la pantalla inicial o de un control semántico esperado:

- foreground package igual al adaptador;
- dump XML válido;
- una pantalla inicial o control semántico esperado;
- cuenta del job y contexto inicial coherentes con el trabajo.

No se usa una coordenada de launcher ni se acepta un package similar. Si la app no llega al foreground esperado, se devuelve `WRONG_PACKAGE` o `APP_LAUNCH_FAILED` de forma retryable cuando corresponda.

### Swipe dinámico

Los swipes que sigan siendo necesarios deben derivar sus coordenadas de un nodo contenedor del snapshot fresco:

- Resolver el carrusel/contenedor exacto por resource-id, content-desc o text.
- Validar bounds actuales y screen size.
- Elegir el eje y la dirección del adaptador.
- Calcular start y end como proporciones acotadas del rectángulo actual, con un margen interno mínimo; nunca usar X/Y literales de un teléfono concreto.
- Ejecutar `adb shell input swipe X1 Y1 X2 Y2 DURATION`.
- Tomar dump posterior y exigir que el control buscado aparezca dentro del contexto esperado; un cambio de posición o la desaparición de otro nodo, sin ese control positivo, no valida el swipe.

Para TikTok no se inventa todavía el selector del carrusel de cleanup. Primero se debe ejecutar una inspección live autorizada con el post de prueba ya verificado, capturar el dump de la pantalla que contiene el carrusel de acciones, sanitizarlo, añadir un fixture y documentar el selector exacto y su guard de contexto. Hasta que ese fixture y selector estén en el worker, `cleanup_test_post` debe devolver `CLEANUP_SELECTOR_UNVERIFIED` antes de swipe o delete y no puede usar `[900,900]`, `[100,900]` ni ninguna coordenada fija. Esta tarea de verificación bloquea sólo el cambio de cleanup TikTok; no bloquea las publicaciones Instagram autorizadas.

## Flujo y reglas por plataforma

Los nombres siguientes son contratos exactos observados en el worker y sus fixtures. Cada paso debe re-resolver su selector contra un dump fresco; no son una autorización para reutilizar bounds históricas.

### Instagram Reels

Package esperado: `com.instagram.android`.

Secuencia:

1. Abrir Instagram y localizar `Profile` por text o content-desc exactos.
2. Confirmar pantalla de perfil mediante un único `profile_header_container` y la identidad `com.instagram.android:id/action_bar_title`.
3. Tratar `action_bar_title` como identidad pasiva. Comparar exactamente con `@growtech.news`/`growtech.news` según el snapshot normalizado del job; no tocar el título.
4. Si la cuenta activa es distinta, resolver `action_bar_username_container` como control accionable, abrir el switcher y localizar la opción exacta de la cuenta escaneada. Un `content-desc=growtech.news` clickable que contenga un hijo `text=growtech.news` debe producir un solo target accionable.
5. Tocar la opción sólo si es enabled/clickable y confirmar de nuevo `action_bar_title` con el valor esperado.
6. Capturar baseline de los tiles del perfil, preservando orden e identidad lógica.
7. Resolver `Create New`, luego `Create new reel`.
8. En la galería, distinguir el nuevo video por `Video thumbnail` y su etiqueta de duración `gallery_grid_item_label` geométricamente asociada al tile; rechazar duplicados o duración ausente.
9. Resolver el botón Next del editor por `com.instagram.android:id/clips_right_action_button`.
10. Resolver el campo `Write a caption and add hashtags...` o la pantalla `Continue`. Aceptar `Continue` sólo con el contexto `Downloads privacy`; cualquier diálogo no reconocido falla cerrado.
11. Escribir y verificar el caption, resolver Next y verificar el contexto `About Reels`.
12. En un snapshot fresco con `About Reels`, resolver `Share` por `com.instagram.android:id/clips_nux_sheet_share_button`, comprobar que está enabled/clickable y persistir el checkpoint `publishing` antes del tap final.
13. Después del tap, no reintentar. Navegar al perfil sólo mediante guards semánticos y verificar exactamente un tile nuevo delante del baseline, con identidad remota observable.

No se permite compartir por mensaje ni aceptar un botón `Share` sin contexto `About Reels`.

### TikTok

Package esperado: `com.zhiliaoapp.musically`.

Secuencia:

1. Abrir TikTok y resolver `Profile`.
2. Validar la etiqueta pasiva `com.zhiliaoapp.musically:id/profile_account`.
3. Si la cuenta es distinta, resolver el switcher y la opción exacta del account snapshot; verificar la nueva etiqueta pasiva.
4. Capturar baseline de covers `com.zhiliaoapp.musically:id/ev2`.
5. Resolver `Create` exacto. La presencia de `Create a Story` no puede satisfacer este selector ni producir un tap.
6. Resolver `Upload`, abrir la galería y seleccionar el tile `com.zhiliaoapp.musically:id/ica` que sea nuevo respecto del baseline de galería.
7. Resolver `Next (1)`, luego `Next`, y el campo `Add description...` o `com.zhiliaoapp.musically:id/h00`.
8. Escribir y verificar el caption. Exigir visibilidad `Everyone can view this post` o `Public`.
9. En el contexto de descripción/visibilidad, resolver `Post` por `com.zhiliaoapp.musically:id/st6`, persistir `publishing` y tocar una sola vez.
10. Verificar en perfil una cover nueva al frente del baseline y exactamente un contador `tv_play_count` asociado a esa cover con valor visible `0`.

Para cleanup de un post de prueba, el selector del carrusel y el control de delete deben provenir del dump live autorizado descrito en la sección de swipe dinámico. Mientras no exista ese fixture y selector exacto, devolver `CLEANUP_SELECTOR_UNVERIFIED` antes de cualquier swipe o delete. Una vez verificado el selector, usar bounds dinámicos, confirmar la eliminación y verificar que el baseline ordenado quedó restaurado. El cleanup no se ejecuta si la identidad no fue verificada, si la autorización firmada no coincide, si el diálogo de confirmación es ambiguo o si el estado posterior no prueba la restauración.

### YouTube Shorts

Package esperado: `com.google.android.youtube`.

Secuencia:

1. Abrir YouTube y resolver `You`.
2. Si no aparece el canal activo esperado, resolver `Account`, abrir el selector y localizar la opción exacta del snapshot.
3. Tratar `com.google.android.youtube:id/account_name` como identidad pasiva y confirmar el canal exacto.
4. Resolver `Create`, luego `Short` por `com.google.android.youtube:id/creation_mode_button`; `Shorts` no es una coincidencia válida.
5. Resolver `Import video from photo library` o `com.google.android.youtube:id/reel_camera_gallery_button_delegate`.
6. En la galería, localizar exactamente el nombre remoto generado `publication-JOB_ID-MEDIA_ID.EXT`; rechazar cero o múltiples tiles `thumb_image_view`.
7. Resolver Next `multi_select_next_button`, Done `creation_next_button`, Next del editor `shorts_post_bottom_button` y el campo `Caption your Short`.
8. Escribir y verificar el caption, exigir visibilidad `Public` y rechazar `Private` o `Unlisted`.
9. Resolver `Upload Short` por `com.google.android.youtube:id/upload_bottom_button`, exigir enabled/clickable, persistir `publishing` y tocar una sola vez.
10. Verificar en `You -> View channel` una tarjeta nueva cuya identidad contiene el caption exacto y el marcador `play Short`, sin confundirla con el baseline.

El cleanup de YouTube debe asociar geométricamente el control `More actions` con la tarjeta verificada, resolver los controles de delete en snapshots frescos, confirmar y probar la restauración exacta del baseline.

## Cuenta, identidad y seguridad

La cuenta social de un job proviene del snapshot inmutable del último escaneo del teléfono. Antes de transferir media o abrir la galería, el worker debe demostrar que la opción exacta existe en el selector real o que la identidad activa ya coincide. Una etiqueta parecida, una coincidencia parcial o una cuenta no presente produce `ACCOUNT_UNAVAILABLE` sin introducir texto ni credenciales.

La comparación de identidad puede tolerar únicamente la representación visual documentada con o sin `@` cuando el contrato del adaptador lo defina; no puede eliminar caracteres ni hacer matching case-insensitive de manera que fusione cuentas. La exclusión temporal de `santilorennzo`/Santiago pertenece sólo al rollout y las pruebas de esta sesión; no se agrega un guard permanente al runner, adapters ni `cleanup_cli`.

Cuando una cuenta escaneada falta o es ambigua en el selector real, la web debe mostrar exactamente: `La cuenta seleccionada ya no está disponible en este teléfono. Volvé a escanear sus cuentas o elegí otra cuenta disponible.`

El serial ADB, Android ID y backend device identity siguen siendo los del contrato existente. UiSnapshot no reemplaza esa validación y no permite cambiar de teléfono por posición, orden de `adb devices` o similitud del package.

Los cleanups de posts de prueba requieren la autorización existente del backend: un token firmado por el servidor y aprobado humanamente, de un solo uso y con expiración, scopeado al workspace, job, device, social account, platform, worker, identidad remota verificada y baseline.

El orden implementable de `cleanup_cli.execute_cleanup` es obligatorio:

1. Leer y canonicalizar la cuenta del manifiesto en memoria, sin abrir ADB ni llamar al device. No aplicar aquí una política permanente de cuentas prohibidas.
2. Sin abrir ADB, llamar a `POST /api/publication-worker/test-cleanup-authorizations/:authorization/validate`. El servidor debe validar firma, expiración vigente, no-consumido, workspace, job, device, social account, platform, worker, identidad remota verificada, baseline y cuenta; el manifiesto local debe coincidir con todo ese scope.
3. Sólo con validación positiva abrir el registro ADB y ejecutar el preflight físico: serial/Android ID, package, cuenta activa, post verificado y baseline exacto. Un preflight fallido no consume autorización ni ejecuta delete.
4. Inmediatamente antes del primer tap destructivo, llamar una sola vez a `POST /api/publication-worker/test-cleanup-authorizations/:authorization/consume`. El consumo debe ser atómico y de un solo uso. Si falla, expira, ya fue consumido o no coincide el scope, detenerse con `CLEANUP_AUTH_INVALID` y ejecutar cero taps de delete.
5. Sólo después de consumir correctamente se puede resolver el target exacto, hacer el menú/swipe guardado, confirmar delete y demostrar la restauración del baseline. No se permite consumir al comienzo ni reutilizar el token para otro post.

Nunca se acepta un token generado localmente ni se abre ADB para un manifiesto cuya autorización no haya validado. Esta secuencia aplica a Instagram, TikTok y YouTube; el selector TikTok sigue además sujeto a `CLEANUP_SELECTOR_UNVERIFIED` hasta su dump live autorizado.

## Checkpoints, final action y recuperación

El orden de estados se mantiene:

~~~text
preparing
→ transferring
→ selecting_media
→ editing
→ captioning
→ ready_to_publish
→ publishing
→ verifying
→ completed
~~~

Una acción final es `Share` de Instagram, `Post` de TikTok o `Upload Short` de YouTube. Antes de esa acción:

1. Obtener dump fresco y validar package.
2. Validar el contexto de publicación y un único botón final.
3. Validar enabled, clickable y bounds.
4. Confirmar heartbeat/lease.
5. Persistir checkpoint `publishing` con `final_action=true` y evidencia segura.
6. Ejecutar un solo `adb shell input tap`.
7. Obtener dump posterior y pasar a verificación positiva.

Si falla el checkpoint, el tap no se ejecuta. Si el checkpoint ya fue persistido, se considera que la intención final existe aunque ADB devuelva un error o la pantalla quede incierta. No se vuelve a tocar el botón. El runner debe llamar al endpoint existente `POST /api/publication-worker/jobs/:id/finish` exactamente una vez con `status=review_required`, `error_code=FINAL_ACTION_UNCERTAIN`, un `error_message` seguro y un `result` JSON compacto con platform, final_action, snapshot_id y reason. La evidencia del checkpoint puede incluir sólo esos mismos IDs y estados seguros. No se agrega, persiste ni envía `final_action_uncertain` ni se crea una migración o endpoint nuevo.

Un fallo antes del checkpoint puede terminar en `failed` o cancelarse de forma segura según el estado. Un fallo después del checkpoint nunca debe ocultarse como un simple timeout retryable ni convertirse en un segundo intento automático. Un operador podrá revisar y autorizar una acción posterior mediante el proceso existente, pero esa aprobación no forma parte de esta implementación.

## Logging y evidencia

Los eventos pueden registrar job ID, platform, step, package validado, tipo de acción, snapshot ID, cantidad de nodos, código de error, estado del lease y referencias a evidencia protegida. Para explicar un selector se puede registrar el tipo de campo y una versión redacted/hash de su valor; no se imprime el caption ni el username completo si no es necesario para el diagnóstico.

Está prohibido registrar:

- worker token, Authorization header, cookies, contraseña, PIN, código 2FA o cualquier credencial;
- argumentos completos de `input text`, caption o texto ingresado;
- XML completo, dumps sin sanitizar, screenshots públicos o contenido de galería;
- rutas privadas que permitan recuperar media;
- cuentas no seleccionadas o datos de otra cuenta más allá del código de seguridad necesario.

La evidencia live debe guardarse en el directorio protegido que ya usa el worker, con retención y ACL existentes. Los artefactos de esta tarea no deben entrar al commit de la spec.

## Estrategia TDD

La implementación se debe hacer en ciclos de prueba fallida, cambio mínimo y prueba verde. Las pruebas nuevas no deben borrar ni resetear los cambios dirty existentes.

### Modelo y parser

- Un fixture XML con tres niveles debe producir parent/children correctos, orden estable, `node_id` reproducible y bounds válidos.
- XML inválido, jerarquía incompleta, `visible_to_user=false`, screen size ausente/inválido, bounds invertidos, tamaño cero, bounds fuera de pantalla y package inesperado deben fallar cerrado.
- La búsqueda debe demostrar prioridad `resource-id` exacto, después `content-desc` exacto y después `text` exacto.
- Cero matches devuelve ausencia; múltiples matches del primer campo con resultados devuelve `SELECTOR_COLLISION`; no se selecciona el primero.
- Un texto hijo pasivo dentro de un padre clickable produce exactamente ese padre; dos ancestros accionables producen colisión; ningún ancestro accionable produce `ACTION_TARGET_UNAVAILABLE`.
- Un label de identidad `clickable=false` se acepta como identidad, pero no puede ser usado directamente como target de tap.

### ADB y acciones

- Un fake de subprocess debe probar que el tap genera `shell input tap` con centro calculado desde bounds actuales y `shell=False`.
- Debe fallar una acción si el target proviene de un snapshot viejo o si la pantalla posterior no cambia como se esperaba.
- La prueba de cada acción debe exigir evidencia positiva del contexto posterior; una desaparición sin contexto sólo es válida en las excepciones enumeradas y debe tener su guard equivalente.
- `back`, `input text`, apertura de package y swipe deben registrar dump antes y después.
- El fake debe demostrar que ningún comando físico usa `.click`, `performClick`, `UiObject.click` ni una coordenada fija.
- TikTok debe fallar con `CLEANUP_SELECTOR_UNVERIFIED` antes de cualquier swipe de cleanup mientras no exista el dump live autorizado y el fixture del carrusel; después de añadirlos, el swipe debe derivar start/end de sus bounds en dos tamaños de pantalla distintos y producir coordenadas diferentes.
- `input text` debe verificar cada prefijo, rechazar caracteres inseguros y no dejar el valor en logs.

### Adaptadores

Conservar y ampliar los fixtures sanitizados de `publisher_worker/tests/fixtures` para:

- Instagram: identidad pasiva, padre/hijo del switcher, `Create New`, Reel, duración asociada, privacidad, `About Reels`, colisión Next/Share y Share deshabilitado.
- TikTok: `Create` frente a `Create a Story`, identidad pasiva, galería, keyboard-open, visibilidad pública, Post, cover y contador cero, y guard `CLEANUP_SELECTOR_UNVERIFIED` hasta disponer del dump live del cleanup.
- YouTube: `Short` frente a `Shorts`, canal activo pasivo, nombre remoto exacto, galería duplicada, `Public`, botón Upload deshabilitado, tarjeta de verificación y More actions asociado.

Cada adapter debe probar wrong package, cuenta ausente, cuenta ambigua, selector ausente, selector deshabilitado, transición stale, evidencia posterior sólo negativa, final context faltante y final checkpoint fallido. La prueba debe afirmar que no hubo tap irreversible en esos casos. La exclusión temporal de una cuenta durante esta sesión se verifica en el checklist de rollout, no como política o test permanente del producto.

### Integración

- Ejecutar el worker con un fake ADB que entregue una secuencia de snapshots y capture argv.
- Verificar la secuencia de checkpoints, limpieza remota y clasificación `review_required`.
- Probar `cleanup_cli.execute_cleanup` con cada plataforma: validación de firma/scope/cuenta/post/expiración/no-consumido antes de abrir ADB, preflight fallido sin consumo, consumo atómico fallido con cero delete y consumo exitoso de un solo uso antes del primer tap destructivo.
- Ejecutar la suite completa existente con `py -3 -m unittest discover -s publisher_worker\tests -q`.
- Ejecutar build y pruebas del backend que ya forman parte del handoff; la spec no cambia su contrato.
- Verificar que la webapp conserva `onClick`, navegación, accesibilidad y tests existentes. No se añaden taps ADB a React.

## Criterios de aceptación

La implementación se acepta sólo si todos los criterios siguientes tienen evidencia:

1. El worker construye un `UiSnapshot` jerárquico y conserva parent/children; ninguna acción depende exclusivamente de una lista plana.
2. La resolución semántica aplica exactamente `resource-id → content-desc → text`, con igualdad exacta y fail-closed ante cero o múltiples matches.
3. Una etiqueta pasiva puede probar identidad sin ser clickable; si debe provocar una acción, sólo se acepta su único ancestro enabled/clickable.
4. Cada tap físico ejecuta `adb shell input tap` con bounds del dump inmediato. No existe un fallback a coordenadas fijas.
5. Cada acción física obtiene dump fresco antes y después, y el snapshot posterior contiene evidencia positiva del contexto esperado; el retorno de ADB o la desaparición del target por sí solos nunca marcan éxito, salvo las excepciones explícitas con guards equivalentes.
6. El cleanup de TikTok permanece fail-closed con `CLEANUP_SELECTOR_UNVERIFIED` hasta que un dump live autorizado de la pantalla de cleanup produzca un fixture y selector exactos. Después de esa tarea, usa bounds dinámicos y no conserva `[900,900] → [100,900]` ni otra coordenada de teléfono.
7. Instagram, TikTok y YouTube rechazan las colisiones específicas descritas y mantienen sus guards de cuenta, package, contexto, media, visibilidad y baseline.
8. `Share`, `Post` y `Upload Short` tienen checkpoint previo, una única oportunidad de tap y terminan mediante el contrato existente con `status=review_required`, `error_code=FINAL_ACTION_UNCERTAIN` y resultado/evidencia compactos si la acción final queda incierta; no existe un campo nuevo `final_action_uncertain`.
9. No se registran secretos, captions, argumentos de texto, XML sin sanitizar ni screenshots públicos.
10. La web conserva React `onClick`; el cambio de estrategia móvil no altera el comportamiento web.
11. El rollout y las pruebas autorizadas de esta sesión excluyen temporalmente `santilorennzo`/Santiago: no se selecciona, publica ni limpia allí. Esta exclusión se mantiene en la evidencia del rollout y no se convierte en un guard permanente del producto.
12. Cuando la cuenta escaneada falta o es ambigua, la web muestra exactamente: `La cuenta seleccionada ya no está disponible en este teléfono. Volvé a escanear sus cuentas o elegí otra cuenta disponible.`
13. El teléfono, la cuenta `@growtech.news`, el backend device identity y los jobs existentes se verifican antes del rollout. No se declara éxito por un job `completed` sin evidencia de perfil/canal.
14. `cleanup_cli.execute_cleanup` sólo ejecuta cleanups reales con autorización server-signed, humana, no consumida, vigente y de un solo uso, scopeada a workspace/job/device/account/platform/worker/identidad/baseline; primero se valida firma/scope/cuenta/post/expiración sin ADB, luego se abre y se hace preflight, y sólo inmediatamente antes del delete se consume atómicamente. Un consumo fallido produce cero delete.
15. Se ejecutan los tests unitarios, de adaptadores, de integración, build/lint web y pruebas backend especificadas en el handoff sin incorporar los artefactos dirty; además, las regresiones prueban que no quedan `forbidden_accounts`, `FORBIDDEN_ACCOUNT`, variables `SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS`/`SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS` ni wiring de esa política, y que no existe branching productivo por username.
16. Se completa el rollout real autorizado: como máximo dos publicaciones en Instagram sobre `@growtech.news`, usando `MP-V-1.mp4` y `MP-V-2.mp4`, cada una publicada desde la webapp, verificada en el perfil y eliminada después con autorización de cleanup y confirmación de baseline. Si la primera falla o queda `review_required`, no se inicia la segunda.

El criterio 16 no autoriza publicaciones reales en TikTok o YouTube. Esas pruebas requieren aprobación explícita adicional.

## Rollout

### Fase 0: preservación y preflight

- Trabajar en `C:\SouthFarm\source\.worktrees\semiorganic-publishing`.
- Revisar y conservar `common.py`, `test_platform_adapters.py`, PNG y egg-info dirty.
- Confirmar serial ADB, Android ID, device identity, package instalados y worker configurado.
- Registrar `santilorennzo` como exclusión temporal del rollout y pruebas de esta sesión; no añadir una política runtime permanente.
- No navegar ni cambiar cuentas durante la elaboración de la spec.

### Fase 1: implementación aislada

- Implementar primero parser, `UiSnapshot`, selectores, targets accionables y acciones especiales con TDD.
- Migrar gradualmente los adaptadores y retirar el swipe fijo.
- Ejecutar tests con fixtures y fakes sin publicar.
- Revisar diff y hacer un commit funcional separado de esta spec; no mezclar los artefactos previos.

### Fase 2: dry-run físico

- Verificar UI del teléfono con dumps frescos y evidencia sanitizada.
- Ejecutar Instagram, TikTok y YouTube hasta antes de `Share`, `Post` o `Upload Short`.
- Comprobar que todos los taps salen de bounds y que los swipes cambian según la pantalla.
- No ejecutar cleanup TikTok ni sustituir su swipe hasta capturar el dump live autorizado del carrusel, añadir el fixture y revisar el selector exacto; esta guardia no bloquea la publicación ni cleanup autorizados de Instagram.
- Si la cuenta real no coincide, si aparece un selector ambiguo o si el package no es exacto, detenerse.

### Fase 3: despliegue controlado

- Ejecutar suites automatizadas, build backend y build/lint de web.
- Reiniciar el worker sólo después de validar el commit funcional.
- Comprobar health público, task Windows, lease, logs seguros, estado de la cola y eliminación del media remoto.
- Abrir la producción web y comprobar que Crear publicación conserva el dispositivo y cuenta seleccionados ante errores recuperables.

### Fase 4: prueba end-to-end real autorizada

La autorización vigente permite únicamente:

- cuenta: `@growtech.news`;
- plataforma: Instagram Reels;
- videos: `MP-V-1.mp4` y, sólo si la primera prueba completa, `MP-V-2.mp4`;
- máximo: dos publicaciones exitosas;
- fuente: la webapp de producción;
- ciclo obligatorio por cada video: publicar → observar timeline `publishing`/`verifying`/`completed` → verificar el Reel en el perfil correcto → validar y consumir la autorización server-signed, humana, de un solo uso y scopeada → eliminar mediante cleanup explícito → confirmar baseline restaurado.

Antes de cada video se debe comprobar que no hay un post temporal previo ni un job `review_required`. Si la publicación, verificación o eliminación no queda inequívoca, se detiene el rollout, no se crea otra publicación y se deja el caso para revisión humana. En esta sesión no se selecciona, publica ni limpia en `santilorennzo`, aunque aparezca en el selector; esa exclusión no se implementa como política permanente.

## Self-review de la spec

Se revisó este documento después de redactarlo:

- No contiene `TBD`, `TODO`, placeholders, nombres de archivo sin resolver ni pasos abiertos disfrazados de requisitos.
- Se separó el estado actual observado del diseño objetivo: hoy el parser es plano y TikTok aún tiene un swipe fijo; el diseño exige jerarquía y deja el cleanup TikTok bloqueado hasta obtener su selector live, sin bloquear Instagram.
- Se resolvió la posible contradicción entre identidad pasiva y acción: una etiqueta puede ser `clickable=false` para validación, pero cualquier tap requiere un único ancestro enabled/clickable o un control accionable directo.
- Se resolvió la posible contradicción entre “dump fresco antes de cada acción” y espera/polling: cada poll captura otro snapshot, y ningún nodo viejo se reutiliza.
- Se fijó la excepción única de launch: `monkey` puede ejecutarse con otro package en foreground, pero el package exacto se verifica inmediatamente antes del primer dump, tap o push.
- Se fijó evidencia positiva posterior a cada acción y se enumeraron las únicas excepciones; desaparición sola no marca éxito. También se exige `visible_to_user`, screen size y bounds válidos antes de cualquier gesto.
- Se fijó una sola salida para incertidumbre final: finish existente con `review_required`, `FINAL_ACTION_UNCERTAIN` y datos compactos; no se añade un campo ni un endpoint nuevo.
- Se distinguió el estado actual del runner de su delta objetivo: hoy no se afirma que ya envíe `error_message`/`result` compactos; la spec exige implementarlo.
- Se eliminó la política global de `santilorennzo` del producto; sólo queda documentada como exclusión temporal del rollout y pruebas de esta sesión.
- Se dejó como delta explícito retirar `forbidden_accounts`/`FORBIDDEN_ACCOUNT`, las dos variables env/config y su wiring, y reemplazar sus tests por regresiones de camino común para varios usernames; sólo el orquestador selecciona `@growtech.news` en esta sesión.
- Se exigió en `cleanup_cli.execute_cleanup` el orden validación de firma/scope/cuenta/post/expiración/no-consumido sin ADB → open/preflight → consumo atómico one-use inmediatamente antes de delete, y cero delete ante cualquier fallo.
- Se corrigió la referencia de autorización de publicaciones reales para apuntar al criterio 16; TikTok/YouTube siguen requiriendo aprobación adicional.
- Se resolvió la frontera web/móvil: sólo ADB y apps móviles usan `input tap`; React web conserva `onClick`.
- Se limitó explícitamente la autorización live a dos pruebas Instagram en `@growtech.news` con los dos videos indicados; no se asumió autorización para TikTok, YouTube ni Santiago.
- El alcance es una sola spec de refactor semántico del worker y su rollout; los cambios de código, tests y despliegue se ejecutarán en un plan posterior y no están incluidos en este commit documental.
