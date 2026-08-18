# Diseño: publicación semiorgánica de videos en SouthFarm

## Objetivo

Agregar al Command Center de SouthFarm una sección `Crear publicación` que permita a un operador seleccionar una cuenta social escaneada en un teléfono de la flota, cargar un video, escribir un caption breve y publicarlo inmediatamente o programarlo para una fecha y hora. La primera versión publicará Instagram Reels, TikTok y YouTube Shorts mediante un worker Windows separado que controla los teléfonos por ADB.

La capacidad debe integrarse con la autenticación, los workspaces, la flota, las cuentas sociales y la infraestructura Windows existentes sin habilitar el planificador automático de warmups ni modificar el APK móvil instalado.

## Alcance del MVP

El MVP incluye:

- Instagram Reels, TikTok y YouTube Shorts.
- Selección de plataforma, dispositivo y cuenta social exacta.
- Carga de un único archivo de video por publicación.
- Caption de 1 a 10 palabras; YouTube además admite como máximo 100 caracteres.
- Ejecución inmediata o programada.
- Cola, detalle, progreso, cancelación segura, reprogramación e historial.
- Transferencia por ADB, navegación por UIAutomator, publicación y verificación posterior.
- Evidencia técnica y auditoría de estados sin almacenar credenciales sociales.
- Un worker Windows que funciona como proceso separado del backend HTTP.

Quedan fuera del MVP: carruseles, fotografías, Stories, música añadida desde la plataforma, edición avanzada, hashtags sugeridos por IA, publicación simultánea en varias cuentas y ejecución remota sin ADB.

## Restricciones operativas aprobadas

- Las pruebas pueden crear publicaciones reales.
- Toda publicación de prueba debe verificarse y luego eliminarse.
- Nunca puede haber más de dos publicaciones temporales nuevas simultáneamente por cuenta.
- Si la eliminación no queda confirmada, no se crean más publicaciones en esa cuenta.
- La cuenta de Instagram de Santiago queda excluida de todas las pruebas.
- Los captions de prueba y los creados desde el MVP admiten como máximo 10 palabras.
- Una ejecución ADB aceptada no demuestra éxito; la publicación debe observarse en el perfil o canal.
- No se solicitan, guardan ni registran contraseñas, PIN, códigos 2FA, cookies ni tokens de las redes sociales.

## Fuentes de verdad

- Fuente de desarrollo: `C:\SouthFarm\source`.
- Backend productivo: runtime publicado en `%LOCALAPPDATA%\SouthFarm\runtime\backend` con base activa `%LOCALAPPDATA%\SouthFarm\data\southfarm.db`.
- Frontend productivo: `C:\SouthFarm\source\webapp`, desplegado en `https://southfarm-webapp.vercel.app/`.
- Automatizaciones ADB validadas: `C:\Users\josu_\Ubuntu-Migration\upload-work\southfarm-legacy`.
- Videos de prueba: `C:\Users\josu_\Downloads\Videos to test`.

La copia de OneDrive no es fuente autoritativa. Los cambios locales preexistentes de `C:\SouthFarm\source` pertenecen al proyecto y deben conservarse.

## Arquitectura elegida

La arquitectura es híbrida:

1. La web crea y administra publicaciones.
2. El backend valida autorización, persiste metadata, almacena el archivo de forma privada y ofrece una cola durable.
3. Un `Publisher Worker` Windows reclama trabajos vencidos, mantiene un lease y ejecuta el adaptador ADB correspondiente.
4. El worker informa checkpoints, evidencia, resultado y errores al backend.
5. La web presenta el estado actualizado al operador.

El worker no corre dentro del proceso Express. Un bloqueo de ADB, UIAutomator o una aplicación social no debe bloquear la API, Cloudflare Tunnel ni otras tareas de SouthFarm.

La API y el worker comparten un contrato independiente de ADB. Esto permite incorporar en el futuro un ejecutor Android que descargue el archivo y use AccessibilityService sin cambiar la experiencia web ni el modelo de publicación.

## Modelo de datos

### `publication_jobs`

Cada fila representa una intención única de publicación:

- `id`, `workspace_id`, `created_by_user_id`.
- `device_id`, `social_account_id`, `platform`.
- `caption`, `scheduled_for`, `priority`.
- `media_id` y snapshot de nombre de cuenta/dispositivo.
- `status`, `current_step`, `progress_percent`.
- `claim_token`, `claimed_at`, `lease_expires_at`, `last_heartbeat_at`.
- `attempt_count`, `final_action_at`, `published_at`, `verified_at`.
- `remote_post_identity`, `result`, `error_code`, `error_message`.
- `cancel_requested_at`, `created_at`, `updated_at`, `completed_at`.

Estados principales:

`queued -> claimed -> preparing -> transferring -> selecting_media -> editing -> captioning -> ready_to_publish -> publishing -> verifying -> completed`

Estados alternativos:

`cancelled`, `failed`, `review_required`.

Después de ejecutar el botón final, una pérdida de certeza nunca vuelve automáticamente a `queued`; pasa a `verifying` o `review_required` para impedir duplicados.

### `publication_media`

- Identidad, workspace, usuario creador y nombre original.
- Ruta privada, MIME, extensión, tamaño y SHA-256.
- Duración, ancho, alto y codecs cuando estén disponibles.
- Estado de carga, retención y timestamps.

El archivo vive fuera de cualquier directorio servido públicamente. El backend entrega contenido al worker únicamente mediante una ruta autenticada o acceso local controlado. El nombre remoto incluye el ID del trabajo y no depende del nombre original.

### `publication_events`

Registro append-only de transiciones y evidencia:

- `job_id`, estado, paso, timestamp y mensaje seguro.
- package/activity observada, selectores relevantes y metadata no sensible.
- referencias a screenshot o XML local, cuando corresponda.

No se guardan dumps o capturas de otras aplicaciones ni datos sensibles visibles.

## Contrato HTTP

Endpoints para operadores autenticados:

- `POST /api/publications`: multipart con video y campos; crea media y trabajo de forma atómica.
- `GET /api/publications`: lista paginada y filtrable por estado, plataforma, dispositivo y cuenta.
- `GET /api/publications/:id`: detalle y timeline.
- `PATCH /api/publications/:id/schedule`: reprograma trabajos todavía seguros.
- `POST /api/publications/:id/cancel`: solicita cancelación; se rechaza cuando la acción final ya pudo ejecutarse.

Endpoints del worker:

- `POST /api/publication-worker/claim`: reclama atómicamente un trabajo debido y devuelve un token de claim.
- `POST /api/publication-worker/jobs/:id/heartbeat`: renueva lease y recibe cancelación.
- `POST /api/publication-worker/jobs/:id/checkpoint`: persiste estado, progreso y evidencia.
- `POST /api/publication-worker/jobs/:id/finish`: completa, falla o requiere revisión.
- `GET /api/publication-worker/media/:id`: descarga autenticada del video si el worker no usa la ruta local.

El worker usa una credencial de servicio separada, almacenada con ACL de Windows y limitada a estos endpoints. Los roles `owner`, `admin` y `operator` pueden crear publicaciones; `viewer` solo puede consultar.

## Publisher Worker Windows

El worker se instala como tarea supervisada independiente y usa Python, la biblioteca estándar y el motor ADB existente. Debe:

1. Descubrir dispositivos ADB autorizados por USB o Wi-Fi.
2. Consultar `settings get secure android_id` y mapearlo al `devices.device_id` de SouthFarm; nunca decidir solo por posición o serial.
3. Adquirir un bloqueo de automatización exclusivo por dispositivo, compartido con warmups y scans, antes de controlar la pantalla.
4. Ejecutar como máximo un trabajo por dispositivo.
5. Reclamar únicamente trabajos cuyo horario ya llegó.
6. Mantener heartbeat y atender cancelación antes del punto de no retorno.
7. Transferir a una ruta remota única, emitir MediaStore scan y verificar presencia.
8. Confirmar package, pantalla y cuenta visible antes de continuar.
9. Ejecutar el adaptador de plataforma como máquina de estados observable.
10. Verificar la publicación en el perfil/canal.
11. Limpiar el archivo temporal del teléfono cuando sea seguro.

El worker tendrá backoff cuando no haya trabajo o ADB esté indisponible. Un fallo de un teléfono no bloquea otros dispositivos.

La tarea Windows del worker se ejecuta como una cuenta interactiva dedicada que posea la clave RSA de ADB autorizada por los teléfonos. No se ejecuta como `SYSTEM`, porque ese perfil tendría otra identidad ADB. Su configuración, credencial de servicio y logs viven bajo `C:\ProgramData\SouthFarm` con ACL limitada a esa cuenta, Administradores y SYSTEM. El binario ADB se configura explícitamente y usa por defecto `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe`.

El bloqueo de automatización por dispositivo también debe ser respetado por el claim de `task_runs`. Una publicación pendiente no interrumpe un warmup o scan ya iniciado; espera a que el dispositivo quede libre. Del mismo modo, una tarea móvil no puede comenzar mientras el worker mantiene el bloqueo de publicación.

## Adaptadores de plataforma

### Instagram Reels

- Verificar cuenta en Profile y rechazar cualquier discrepancia.
- `Create New -> Reel -> galería -> video -> editor -> Next -> caption -> Next -> About Reels -> Share`.
- Exigir el contexto `About Reels` y el selector de Share final para evitar compartir por mensaje.
- Verificar el Reel nuevo en el perfil antes de completar.
- Instagram parte de un runbook validado hasta pre-Share; su primera publicación real requiere supervisión reforzada y evidencia en cada transición.

### TikTok

- Registrar baseline del perfil antes de crear contenido.
- `Create` exacto, nunca coincidencia parcial con `Create a Story`.
- `Upload -> video -> Next -> editor -> caption -> visibilidad pública -> Post`.
- Escribir lentamente y verificar el texto durante la entrada.
- Verificar una baldosa nueva sin alterar el baseline anterior.

### YouTube Shorts

- `Create -> Short -> Import video -> archivo exacto -> Next -> Done -> Next`.
- Escribir en `Caption your Short`, máximo 10 palabras y 100 caracteres.
- Confirmar visibilidad pública y botón `Upload Short` habilitado.
- Verificar por caption exacto y tarjeta nueva en el canal.

## Idempotencia y recuperación

Cada trabajo tiene un único ID y un único claim activo. Antes del botón final, un lease vencido permite reanudar desde una fase segura o reiniciar el flujo después de limpiar el draft creado por ese trabajo.

Después de `Share`, `Post` o `Upload Short`:

- el worker registra `final_action_at` antes de enviar el gesto;
- no repite automáticamente el gesto final;
- intenta localizar la publicación por cuenta, caption, horario, miniatura y cambio respecto del baseline;
- si la encuentra, marca `completed`;
- si demuestra que no existe, un operador puede aprobar un nuevo intento;
- si no puede decidir, marca `review_required`.

Una cancelación recibida después de `final_action_at` no intenta borrar contenido real; deriva a revisión.

## Experiencia web

Se agrega `Crear publicación` a la navegación de escritorio y móvil conservando el lenguaje visual actual del Command Center.

La vista tiene dos áreas principales:

1. Composer:
   - selector visual de plataforma;
   - dispositivo y cuenta, mostrando estado online y disponibilidad ADB;
   - dropzone con preview, nombre, duración, resolución y tamaño;
   - campo de caption con contador de palabras y, para YouTube, caracteres;
   - selector `Ahora` o `Programar` en horario de Buenos Aires;
   - resumen y CTA `Publicar ahora` o `Programar publicación`.
2. Cola e historial:
   - tabs `En cola`, `En progreso`, `Revisión` y `Finalizadas`;
   - tarjetas compactas con plataforma, cuenta, teléfono, horario y progreso;
   - timeline detallado al abrir un trabajo;
   - acciones contextuales de cancelar o reprogramar solo cuando sean seguras;
   - errores accionables, sin mensajes genéricos.

La cuenta se elige dentro del dispositivo y plataforma seleccionados; nunca se permite una combinación que no exista en `social_accounts`. La ausencia de ADB no impide programar, pero se muestra una advertencia clara y el trabajo queda en cola hasta que el dispositivo esté disponible.

El formulario evita doble envío, mantiene el progreso de carga, conserva los campos ante errores recuperables y muestra confirmación inequívoca después de crear el trabajo.

## Validaciones

- Video no vacío y tipo permitido; la extensión no basta para aceptar MIME.
- Límite inicial de 200 MiB por archivo.
- Resolución vertical recomendada, con advertencia no bloqueante si no es 9:16.
- Caption entre 1 y 10 palabras.
- YouTube: máximo 100 caracteres.
- Horario futuro válido para modo programado.
- Dispositivo y cuenta pertenecen al workspace y la cuenta pertenece al dispositivo/plataforma.
- No se permiten nuevos trabajos para una cuenta con una publicación en `review_required`.
- No se ejecutan dos trabajos simultáneos sobre el mismo dispositivo.
- No se ejecuta una publicación simultáneamente con un warmup o scan en el mismo dispositivo.

## Manejo de errores

Los errores se clasifican en: validación, archivo, ADB ausente/no autorizado, identidad de dispositivo, cuenta incorrecta, selector/UI cambiada, timeout, cancelación, publicación incierta y verificación fallida.

Cada error incluye un código estable para la UI, un mensaje para el operador, el paso exacto y evidencia segura. Errores de identidad, cuenta o incertidumbre posterior a la acción final nunca se reintentan automáticamente.

## Pruebas y aceptación

### Automatizadas

- Backend: migraciones, autorización, multipart, validaciones, horarios, claim atómico, leases, cancelación e idempotencia.
- Worker: selección semántica con fixtures XML, mapeo Android ID/ADB, estados, checkpoints, captions y recuperación.
- Web: validación del formulario, filtros cuenta/dispositivo, horario, estados, errores y accesibilidad.
- Regresión: build/lint web, build backend y suites existentes.

### Dispositivo físico

1. Revalidar versiones, resolución, apps, cuenta visible y selectores.
2. Ejecutar dry-run hasta el último botón para cada plataforma.
3. Ejecutar una publicación real con `MP-V-4` en cada plataforma.
4. Verificar en el perfil/canal y registrar evidencia.
5. Eliminar cada publicación de prueba y confirmar restauración del baseline.
6. Repetir solo si hace falta, sin superar dos publicaciones temporales por cuenta.
7. No utilizar Instagram de Santiago.

### Producción

- Publicar backend con el script Windows existente y comprobar runtime metadata, health local/público y DB.
- Instalar y supervisar el Publisher Worker; comprobar que una caída no afecta la API.
- Desplegar el frontend oficial a Vercel.
- Crear una publicación desde `https://southfarm-webapp.vercel.app/`, observar su timeline y verificar el resultado real.
- Confirmar que warmups, scans, scheduler, login/refresh, flota e historial siguen funcionando.

## Criterio de finalización

La funcionalidad queda terminada únicamente cuando un operador puede crear desde producción una publicación inmediata y una programada, seleccionar una cuenta real asociada a un dispositivo, subir un video, seguir el progreso, obtener verificación observable en Instagram, TikTok y YouTube Shorts, y los flujos existentes no presentan regresiones. Las publicaciones de prueba deben quedar eliminadas y no puede quedar ninguna cuenta en un estado de seguridad desconocido.
