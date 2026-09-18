# Activity Planner — Rediseño de la planificación de tareas

- **Fecha:** 2026-08-19
- **Estado:** Brainstorming consolidado → fase de diseño visual (mockups HTML)
- **Rama:** `feature/ui-redesign-granja-tecnologica`
- **Fuente:** brainstorming con el dueño del producto (transcript de sesión ZCode)

## 1. Visión

Southfarm debe ser la **central operativa de la agencia de distribución por redes sociales**. El trabajo core: las cuentas de las marcas **publican contenido con regularidad en automático**, además de hacer **warmups** y **escanear cuentas** cuando se necesita.

La nueva sección **"Activity Planner"** reemplaza al actual "Warmup planner" y pasa a ser **el corazón de la herramienta**: el lugar único donde se planifica el funcionamiento de todas las marcas y todas las tareas que se van a ejecutar durante la semana actual y las siguientes.

## 2. Contexto y alcance

- **Dentro de alcance:** nueva página "Activity Planner" que sustituye a la actual "Warmup planner" (`webapp/src/app/scheduler-panel.tsx`). Unifica **warmups + scans + publicaciones** en una sola agenda.
- **Fuera de alcance (por ahora):**
  - Rediseño del Command center (más adelante pasará a ser solo "monitoreo general" / home, sin lanzar ni planificar tareas).
  - Los launchers "one shot" de Fleet/Overview se mantienen como están (fueron pensados para eso: envío puntual).
  - Views trackeadas (funcionalidad futura, solo reservar lugar en UI).
  - Plataformas Facebook/Twitter (futuro; el diseño debe permitir crecer).

## 3. Concepto nuevo: Cluster (marca)

Un **cluster** agrupa las cuentas de una misma marca en distintas plataformas.

- Ejemplo: "Marczell Clips" = 1 cuenta de Instagram + 1 de TikTok + 1 de YouTube (+ Facebook/Twitter a futuro).
- **Auto-detección:** el planner reconoce automáticamente clusters a partir de las cuentas escaneadas y reconocidas en los celulares (heurística inicial: usernames iguales/similares entre plataformas). La detección es una **sugerencia** que el usuario confirma.
- **Gestión manual:** el usuario puede crear clusters explícitamente, editarlos y corregirlos (agregar/quitar cuentas, renombrar) en todo momento.

## 4. Requerimientos funcionales

### 4.1 Vista principal (plan semanal)

- Clusters apilados verticalmente (uno abajo del otro, en columna).
- Cada card de cluster muestra:
  - Nombre del cluster (marca).
  - **Burbujas con las cuentas** de cada plataforma de esa marca (ig, tt, yt).
  - **Chart histórico** corriendo de izquierda a derecha: muestra las actividades de cada día y el progreso histórico del cluster (combina pasado ejecutado + plan futuro).
  - **Selector de tipo de vista/métrica** del chart: views del cluster, posts del cluster, warmup realizado por el cluster, etc.
- **Interacción del chart:** en reposo es transparente/limpio; al pasar el mouse se visualizan las divisiones entre días (columnas), con efecto tipo **Apple liquid glass**.
- Vista de calendario por día: ver gráficamente las tareas del día, a qué hora es cada una, cuántas hay y a qué cuentas refieren.
- **Monitoreo en vivo:** ver lo que está sucediendo y lo que está por suceder.

### 4.2 Vista expandida de cluster

- Al hacer click en un cluster, su card **se expande a un elemento grande** que ocupa la pantalla.
- Contenido:
  - Actividad de publicaciones a nivel histórico.
  - Actividad de warmup histórica.
  - Estadísticas (views trackeadas → funcionalidad futura, reservar lugar).
- **Edición:** nombre del cluster, agregar/quitar cuentas que lo componen.
- **Navegación propia:** cerrar, avanzar al cluster siguiente, volver al anterior.

### 4.3 Rutinas semanales (por cluster)

Planificables de manera manual o automática por el sistema:

- **Warmup diario:** mínimo 40 min por cada cuenta dentro del cluster.
- **Escaneo automático:** 2 veces por día con mínimo 9 horas de separación.
- **Publicaciones:** mínimo 2 videos por semana en cada cuenta de red social cargada en los celulares.
- **Publicación de cluster:** crear una publicación que sale en todas las cuentas del cluster con el mismo video y título.

#### Ciclo de vida de una rutina (feedback del dueño, 2026-08-19)

Cada card de rutina ("Warmup diario", "Scan automático", "Publicaciones") tiene un **toggle de estado con tres posiciones: `Aprobado` / `Editando` / `Pausado`**:

- **Edición → estado cambia solo:** al editar cualquier parámetro de la rutina (ej. cambiar los minutos mínimos del warmup), el toggle pasa automáticamente a `Editando`. La regla nueva **todavía no aplica** al plan.
- **Aprobado = aplicar:** para que el cambio quede aplicado, el usuario debe pasar el toggle a `Aprobado`. Recién ahí la nueva regla se vuelve **la nueva realidad para ese cluster** y el sistema **reajusta la actividad semanal/futura** con esos parámetros (cancela tareas automáticas futuras no iniciadas y regenera el plan).
- **Pausado:** la rutina no genera tareas; las tareas automáticas futuras no iniciadas de esa rutina se cancelan.

### 4.4 Autonomía + control manual

- El sistema **organiza la semana automáticamente** (a partir de las rutinas), de forma que el trabajo no se detenga y sea óptimo.
- **Todo lo automático es editable** por el usuario (mover, cancelar, reprogramar).
- El usuario también puede **crear manualmente las tareas que quiera**.
- Siempre disponible la edición a mano, con una experiencia clara de **cómo se va a ejecutar** lo planificado.

## 5. Dirección visual

- **Continuar la línea actual** de la página: design system "Granja Sur" (dark zinc `#09090b`, accent verde `#22c55e`, glass, tipografía Inter, clases `cc-*` en `webapp/src/app/globals.css`).
- Efectos "liquid glass" en los charts (hover con columnas por día).
- No retomar por ahora la dirección emerald de los mockups viejos de `docs/mockups/propuesta-*.html` (solo referencia).

## 6. Supuestos y decisiones (confirmados o a confirmar)

- Timezone única: **America/Argentina/Buenos_Aires** (igual que hoy).
- La auto-detección de clusters **sugiere**; el usuario confirma/corrige.
- Métricas iniciales de los charts: warmup (minutos) y posts; views después.
- Infraestructura actual (backend Express + SQLite local en Windows) se mantiene; los cambios de modelo se hacen con migraciones aditivas como las existentes.
- Vocabulario de dominio existente que se conserva: task types `warmup_ig/tiktok/youtube`, `scan_*`, `publish_reel`; estados de política de cuenta `automatic/cold/warming/warm`; dispositivos = "celulares"/flota con alias.

## 7. Plan de trabajo

| Fase | Qué | Quién |
|---|---|---|
| 1 (actual) | Mockups HTML del Activity Planner + feedback del dueño + iteración | designer-senior-CCGOAT (dirigido por orquestador) |
| 2 | Diseño técnico: modelo de clusters, rutinas, generación semanal, agenda unificada | architect-luna-CCGOAT + backend agents |
| 3 | Implementación backend: migraciones, endpoints, generación automática | backend agents |
| 4 | Implementación frontend: nueva sección Activity Planner | frontend agents |
| 5 | Revisión integral + pruebas | reviewer agents |

## 8. Referencias

- **Boceto original del dueño (layout de la vista principal):** `docs/mockups/activity-planner/boceto-original.jpeg` — sidebar Southfarm a la izquierda; sección "Activity Planner" con clusters apilados en filas; cada fila = card del cluster (burbujas de cuentas por plataforma) + chart histórico hacia la derecha + selector de métrica (views / posts / warmup).

## 9. Referencias técnicas del estado actual

- Frontend activo: `webapp/` (SPA Next.js 16, una sola `page.tsx`; planner actual en `scheduler-panel.tsx`).
- Backend: `backend/src/index.ts` (endpoints `/api/planner/*`, `/api/tasks/*` con claim/lease), `scheduler.ts`, `scheduler-migrations.ts`.
- Modelo actual de plan: `warmup_plan_days` → `warmup_plan_items` → `task_runs` (generación diaria, ventana 12:00–22:00 BA).
- Dolores conocidos a resolver: solo se planifica de a un día; sin vista semanal; reglas rígidas hardcodeadas; auto-planner desactivado; warmups/scans/publicaciones en lugares separados.
