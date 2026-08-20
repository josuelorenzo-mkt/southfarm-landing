# Activity Planner — Guía de prueba local

- **Fecha:** 2026-08-19 (noche) · **Ronda 2 de correcciones aplicada** (efectos premium + UX, ver abajo)
- **Estado:** todo funcionando en local para test. NADA lanzado a producción.

## Ronda 2 — correcciones del dueño (2026-08-19, 2ª revisión)

**Vista semana:**
- Liquid glass por **proximidad**: solo se enciende el día bajo el cursor (completo) y sus dos vecinos inmediatos (atenanuados ~42%); el glass "persigue" el mouse.
- Orden nuevo del resumen: **Publicaciones → Warmup → Tareas planificadas → Tareas en curso**.
- **Glow giratorio** en hover de la card del cluster (halo verde tenue que recorre el perímetro; ámbar en déficit, violeta en sugeridos, sin glow en pausados).
- Barras de **cumplimiento con pulso**: shimmer viajero + halo que respira en el color actual de la barra.

**Detalle de cluster:**
- Stats del hero nuevos: **Publicaciones totales · Vistos totales (— próximamente) · Posts esta semana** (backend agrega `publicationsTotal` y `postsThisWeek`).
- Chart de warmup con **animación tipo ECG** (redibujo continuo + latido en los últimos puntos). Estados: verde (activo), **ámbar** si no hay actividad en 2 días, **rojo** si no hay warmup en 5 días.
- Botón **"Publicar al cluster"** ahora navega al editor de rutinas y **scrollea centrando la sección "Publicación de Cluster"** (nueva: URL + título + fecha/hora para todas las cuentas del cluster).

**Editor de rutinas:**
- **"Editando" ahora es clickeable** desde Pausado o Aprobado (habilita la edición).
- Cartel **"Cambios aplicados"** (desaparece solo) al pasar de Editando→Aprobado y Editando→Pausado.

**Vista día:**
- **Drag & drop** de tareas entre horas (sin botón "Mover"): al soltar, cartel de confirmación "¿Estás seguro que querés mover la tarea de XX:XX a XX:XX?" — Aceptar guarda (reschedule real), Cancelar revierte.

Nota: los efectos visuales (glass, glow, pulso, ECG) se aprecian en vivo en http://localhost:3002; respetan `prefers-reduced-motion`.


## Acceso

| Qué | Dónde |
|---|---|
| **Web (ya corriendo)** | http://localhost:3002 |
| **Backend demo (ya corriendo)** | http://localhost:3101 |
| Login | Tu usuario real (la DB demo es copia de la real) **o** `demo@southfarm.local` / `southfarm` |
| Sección | Sidebar → **Activity Planner** (badge NEW; el "Warmup planner" viejo queda como legacy) |

**Producción intacta:** el servidor del puerto 3001 y la DB real (`backend/data/southfarm.db`) no se tocaron. El backend demo usa una copia: `backend/data/southfarm-planner-demo.db` (con seed: 3 clusters detectados de tus cuentas reales — Marczell Vibes, Marczell Wisdom, Marczellclips — rutinas aprobadas, semana generada con ~240 tareas e histórico de 7 días para los charts).

## Qué probar (checklist)

1. **Vista semanal** — filas por cluster con burbujas ig/tt/yt, chart histórico por fila, selector de métrica (Views deshabilitado "próximamente"), hover sobre el chart (columnas por día liquid glass), now line, resumen arriba, navegación de semana.
2. **Detalle de cluster** — click en la fila: nombre editable, cuentas (quitar con ‑, agregar desde dropdown), historial de publicaciones, chart warmup 14 días, stats, placeholder de Views, navegación ‹ › , botón "Publicar al cluster" (modal video+título).
3. **Rutinas (tu feedback del toggle)** — editar cualquier parámetro → salta solo a **Editando** con hint; click **Aprobado** → aplica y replanifica (verificado: 40→50 min regeneró 200 min/día por cluster y 150 tareas); **Pausado** → atenúa la card y cancela futuras.
4. **Vista día** — pestaña "Día" o click en columna del chart: timeline 12:00–22:00 BA, filtros por tipo, estados.
5. **"Regenerar semana"** — botón del header, idempotente.
6. **Sugeridos** — en esta DB no quedó ninguno pendiente (los 3 grupos detectados se confirmaron en el seed); podés probar la confirmación creando un cluster manual o borrando uno y re-escaneando (`GET /api/clusters/suggestions/scan`).

## Limitaciones conocidas de esta demo

- Las tareas `publish_reel` se **planifican** pero no ejecutan (el worker de publicación no está en esta rama): quedan pending.
- **Views** deshabilitado (tracking futuro).
- Los celulares no apuntan al backend demo (3101), así que no vas a ver tareas pasando a "running" en vivo — los estados históricos sí (seed).
- El planner viejo ("Warmup planner") sigue accesible; no se modificó.

## Cómo levantar los servers si se caen

```bash
# Backend demo (puerto 3101, DB copia):
cd /c/SouthFarm/source/backend
PORT=3101 SOUTHFARM_DB_PATH="C:\SouthFarm\source\backend\data\southfarm-planner-demo.db" SOUTHFARM_SEED_DEMO=true \
  /c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64/node.exe dist/index.js

# Web (puerto 3002; el build ya está hecho):
cd /c/SouthFarm/source/webapp && PORT=3002 npm run start
# Para iterar código: npm run dev (mismo puerto)

# Resetear la demo DB (vuelve al estado del seed):
cd /c/SouthFarm/source/backend/data
rm southfarm-planner-demo.db* && cp southfarm.db southfarm-planner-demo.db && cp southfarm.db-wal southfarm-planner-demo.db-wal && cp southfarm.db-shm southfarm-planner-demo.db-shm
# …y reiniciar el backend demo.
```

## Notas técnicas

- `webapp/.env.local` → `NEXT_PUBLIC_API_URL=http://localhost:3101` (solo afecta local; Vercel usa su propia env). Borrá el archivo para volver a apuntar a producción desde local.
- Fixes aplicados en integración (fuera de los agentes): seed elige el workspace con más cuentas + remapea cuentas con dispositivo borrado a un celular activo; bug de Rules of Hooks en `cluster-detail.tsx` (useMemo después de early returns — crasheaba el detalle); wiring de `onEditRoutines` en `planner-page.tsx`.
- Documentación: spec funcional `docs/plans/2026-08-19-activity-planner.md`, contrato de API `docs/plans/2026-08-19-activity-planner-api.md`, mockups aprobados + boceto en `docs/mockups/activity-planner/`.
- **Nada está commiteado todavía** (cambios en working tree del repo principal + webapp). Cuando des aprobación, sugiero commit separado por repo.
