# SouthFarm UI Redesign — Design Doc

**Fecha:** 2026-05-21
**Autor:** Tomi
**Skills:** Superpowers + taste-skill + impeccable

---

## Concepto: "Granja Tecnológica"

SouthFarm = el crecimiento lo producimos de manera digital. Unimos:
- **Tecnología** (automatización, fleet management, métricas)
- **Naturaleza/Granja** (plantas, crecimiento, siembra, cosecha)

### Metáforas visuales
- **Dispositivos = Plantas** en un invernadero digital
- **Warmup = Riego/Crecimiento** — el efecto de olas representa agua/nutrientes fluyendo
- **Cuentas = Semillas** que brotan y crecen
- **Métricas = Cosecha** — likes, reels, saves son frutos
- **Fleet = Invernadero** — todos los dispositivos creciendo juntos

### Paleta de colores
- **Fondo:** Off-black cálido `#0b0f0b` (verde-gris oscuro, tierra de noche)
- **Cards:** `#141a14` (sutil tinte verde)
- **Bordes:** `#1f2a1f` (verde-gris sutil)
- **Accent principal:** Emerald `#34d399` (verde planta, no saturado)
- **Accent secundario:** Amber `#f59e0b` (sol/cosecha, solo para métricas destacadas)
- **Texto primario:** `#e8ede8` (blanco verdoso)
- **Texto secundario:** `#6b7f6b` (gris con tinte verde)

### Tipografía
- **Headings:** `Geist` (moderno, tech)
- **Body:** `Geist Sans` / system-ui
- **Data/Mono:** `Geist Mono` o `JetBrains Mono`

### Principios de taste-skill aplicados
- DESIGN_VARIANCE: 7 (asimétrico pero no caótico)
- MOTION_INTENSITY: 6 (animaciones sutiles, olas mejoradas)
- VISUAL_DENSITY: 5 (datos presentes pero con espacio)
- NO emojis → iconos SVG/Phosphor
- NO purple/blue AI aesthetic
- Máximo 1 accent color (emerald)

---

## Secciones Webapp (Next.js)

### 1. Auth
- Split layout: left = ilustración abstracta de plantas digitales, right = form
- Fondo con gradient radial sutil emerald
- Sin emojis → logo SVG de hoja

### 2. Dashboard
- Bento grid asimétrico
- Stat cards con iconos Phosphor (no emojis)
- "Invernadero" visual: dispositivos como tarjetas con indicador de "salud" (verde pulsante)
- Actividad reciente como timeline con iconos

### 3. Fleet
- Grid de dispositivos como "macetas digitales"
- Cada device card muestra: nombre, Android version, status (online/offline)
- Indicador pulsante verde cuando activo
- Last seen timestamp

### 4. Warmup
- Selector de device como "elegir planta"
- Cuentas como dropdown limpio
- Duración con chips seleccionables
- Botón principal grande: "Iniciar riego" con icono Play
- NO emojis

### 5. Historial
- Stats totales arriba en fila (Reels, Likes, Saves, Tiempo)
- Lista de sesiones con iconos de status
- Filtros por cuenta como chips horizontales
- Relativo timestamps ("hace 2h", "ayer")

### 6. Settings
- Perfil minimal
- Logout limpio

---

## App Flutter — Cambios

### Mantener
- Overlay con olas (mejorar: más suaves, mejor glow)
- Estructura de navegación (tabs)
- Funcionalidad completa

### Cambiar
- Reemplazar emojis → iconos Material/SVG
- Misma paleta que webapp
- Misma tipografía (Geist si posible, sino Satoshi)
- Misma metáfora visual

---

## Bug Fix: Historial

### Problema
El backend `GET /api/warmup-sessions` mapea `task_runs` pero el frontend webapp espera campos `result` y `params` como JSON strings, mientras que el endpoint los mergea en un solo objeto. Además, la app Flutter sincroniza sesiones pero usa API URL hardcodeada al tunnel viejo.

### Fix
1. Backend: endpoint `/api/warmup-sessions` ya funciona bien, pero verificar que devuelve `created_at` correctamente
2. Webapp: el `HistoryPage` usa `parseResult(s)` y `parseParams(s)` pero el backend ya los mergea →fixear parsing
3. App Flutter: actualizar `API_BASE` a `https://api.southfarm.tech/api`
4. Verificar que los campos `timestamp` vs `created_at` estén consistentes

---

## Plan de Ejecución (Tareas)

### Tarea 1: Fix historial webapp (backend + frontend)
- Archivos: `backend/src/index.ts`, `webapp/src/app/page.tsx`
- Fix parsing de sesiones en HistoryPage
- Verificar consistencia de campos

### Tarea 2: Rediseño webapp completo
- `webapp/src/app/page.tsx` — reescritura completa
- `webapp/src/app/globals.css` — nuevo design system
- `webapp/src/app/layout.tsx` — fonts + meta
- Nuevos componentes con Phosphor icons

### Tarea 3: Mejorar overlay Kotlin (olas)
- `SouthFarmOverlayService.kt` — mejorar animación de olas
- Gradientes más suaves, glow mejorado
- Mantener funcionalidad completa

### Tarea 4: Rediseño app Flutter
- `lib/main.dart` — nuevo diseño sin emojis
- Misma paleta y tipografía
- Iconos Material en vez de emojis

### Tarea 5: Deploy y verificación
- Push a GitHub
- Verificar deploy Vercel
- Actualizar brain con resultados
