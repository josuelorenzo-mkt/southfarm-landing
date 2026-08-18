# SouthFarm iOS — Plan de Implementación

**Fecha:** 2026-05-21
**Dispositivo:** iPhone 14 Pro
**Estado:** Pendiente acceso a Mac (amigo developer)

---

## Resumen

Adaptar SouthFarm para que funcione en iPhone usando **WebDriverAgent (WDA)** — un server HTTP que corre dentro del iPhone y permite controlarlo remotamente (tap, swipe, screenshot, leer UI).

**Stack:**
- **WebDriverAgent** → Corre en el iPhone (server HTTP)
- **tidevice** → Arranca WDA desde Tomillo (Python, ya instalado)
- **facebook-wda** → Python client para mandar comandos (ya instalado)
- **usbmuxd** → Comunicación USB con iPhone (ya instalado)

---

## Hardware necesario

- [ ] Adaptador USB-C a USB-A (para conectar iPhone a Tomillo)
- [ ] Acceso a Mac con Xcode (amigo developer)

---

## Fase 0: Setup en la Mac (tu amigo, ~20 min)

### Requisitos en la Mac
- macOS con Xcode instalado
- Apple ID (sirve cuenta gratuita)

### Pasos

```bash
# 1. Clonar WebDriverAgent
git clone https://github.com/appium/WebDriverAgent.git
cd WebDriverAgent

# 2. Abrir en Xcode
open WebDriverAgent.xcodeproj
```

### En Xcode (configurar firma)
1. Seleccionar el proyecto **WebDriverAgent** en el sidebar
2. En **Signing & Capabilities**:
   - Team: seleccionar tu Apple ID (o "Add Account" para agregarlo)
   - Marcar "Automatically manage signing"
3. Repetir para **WebDriverAgentLib** y **WebDriverAgentRunner** (targets en el sidebar izquierdo)
4. Cambiar el **Bundle Identifier** si hay conflicto (ej: agregar tu inicial al final)
5. Conectar el iPhone 14 Pro por USB a la Mac
6. Seleccionar el iPhone como destino (barra superior: "WebDriverAgentRunner > iPhone 14 Pro")
7. **Product → Build** (o Cmd+B)

### Si falla el signing
- Probar con un Bundle ID único: `com.tuAmigo.WebDriverAgent` 
- Asegurarse de que el iPhone tenga "Confiar en esta computadora" activado

### Verificar que funciona
```bash
# En la Mac, desde terminal:
xcodebuild -project WebDriverAgent.xcodeproj \
  -scheme WebDriverAgentRunner \
  -destination 'id=UDID_DEL_IPHONE' \
  test
```

El UDID se obtiene con:
```bash
# En la Mac:
idevice_id -l
# O: Xcode → Window → Devices and Simulators → ver el Identifier
```

Si todo sale bien, va a aparecer un ícono gris de WebDriverAgent en el iPhone.

### Guardar el UDID del iPhone
```bash
# Anotar el UDID (lo vamos a necesitar en Tomillo)
idevice_id -l
```

**Anotar y mandar a Tomi:** UDID del iPhone, Bundle ID usado, y si usaron Apple ID gratis o Developer.

---

## Fase 1: Conexión desde Tomillo (~30 min)

### 1.1 Adaptador USB
Conseguir un adaptador USB-C (hembra) a USB-A (macho) para conectar el iPhone a Tomillo.

### 1.2 Verificar detección
```bash
# Con iPhone conectado por USB
tidevice list
# Debería mostrar: UDID | ... | iPhone 14 Pro | ...
```

### 1.3 Arrancar WDA
```bash
# Forward del puerto 8100 (donde WDA escucha)
tidevice wdaproxy -B com.tuAmigo.WebDriverAgent --port 8100 &
```

### 1.4 Test básico
```python
import wda
c = wda.Client('http://localhost:8100')
print(c.info())           # Info del device
c.screenshot('test.png')  # Screenshot
```

Si funciona, pasamos a la siguiente fase.

---

## Fase 2: Warmup iOS Básico (2-3 días)

### 2.1 Script de navegación Instagram

```python
import wda
import time
import random

c = wda.Client('http://localhost:8100')

def warmup_ios(account, duration_minutes=2):
    # Abrir Instagram
    c.app_launch("com.burbn.instagram")
    time.sleep(3)
    
    # Navegar a Reels (tap en el ícono del medio-abajo)
    # Requiere ajustar coordenadas según pantalla del iPhone 14 Pro
    c.tap(200, 800)  # Placeholder - ajustar
    
    end_time = time.time() + duration_minutes * 60
    scrolls = 0
    likes = 0
    
    while time.time() < end_time:
        # Scroll up (siguiente reel)
        c.swipe_up()
        scrolls += 1
        
        # Random like (35% probabilidad)
        if random.random() < 0.35:
            c.tap(340, 1200)  # Placeholder - posición del like
            likes += 1
        
        # Espera humana
        time.sleep(random.uniform(3, 8))
    
    return {"scrolls": scrolls, "likes": likes}
```

### 2.2 Mapeo de coordenadas
Necesitamos mapear las coordenadas exactas del iPhone 14 Pro:
- Ícono de Reels en el tab bar
- Botón de Like
- Botón de Save
- Perfil / Switcher de cuentas

**Procedimiento:**
1. Abrir Instagram en el iPhone
2. Tomar screenshot con `c.screenshot()`
3. Mapear coordenadas con OCR o manualmente
4. Probar cada tap individualmente

### 2.3 Scanner de cuentas IG
```python
def scan_accounts_ios():
    # Abrir Instagram
    c.app_launch("com.burbn.instagram")
    time.sleep(2)
    
    # Ir a perfil
    c.tap(300, 1650)  # Tab de perfil
    
    # Tap en el header (username)
    c.tap(200, 100)
    time.sleep(1)
    
    # Screenshot y OCR del switcher
    c.screenshot('switcher.png')
    # Procesar con OCR para extraer usernames
```

---

## Fase 3: Integración con Backend (2-3 días)

### 3.1 Nuevo device type en backend
```sql
ALTER TABLE devices ADD COLUMN platform TEXT DEFAULT 'android';
```

### 3.2 Backend: polling para iOS
Misma API que Android:
- `GET /api/tasks/runs?status=pending&device_id=X` → El script iOS hace polling
- `PATCH /api/tasks/runs/:id` → Actualiza estado

### 3.3 Script iOS en Tomillo
```python
# southfarm/ios/warmup_worker.py
# Corre como servicio en Tomillo
# Hace polling al backend cada 5 seg
# Cuando detecta tarea pending para este device → ejecuta warmup
```

### 3.4 Webapp
- Fleet muestra iPhones con icono diferente
- Dropdown de cuentas IG funciona igual
- Mismos botones de launch warmup

---

## Fase 4: Polish y Producción (1-2 días)

### 4.1 Re-signa del certificado
Si usaron Apple ID **gratis**: el certificado expira cada 7 días.
- Automatizar re-signa con Sideloadly en Windows
- O usar Apple Developer ($99/año) para 1 año de validez

### 4.2 WiFi syncing (opcional)
Configurar una vez para que el iPhone no necesite USB siempre:
1. En la Mac: abrir Finder → iPhone → "Show this device when on WiFi"
2. Después tidevice puede conectarse por WiFi

### 4.3 Manejo de errores
- Instagram cerrado → reabrir
- Popup de login → notificar al backend
- WDA crasheó → reiniciar con tidevice
- iPhone desconectado → marcar device como offline

---

## Checklist Rápida

### Ahora (sin Mac)
- [x] tidevice instalado en Tomillo
- [x] facebook-wda instalado en Tomillo
- [x] usbmuxd instalado en Tomillo
- [ ] Conseguir adaptador USB-C a USB-A
- [ ] Leer este plan completo

### Con la Mac (~20 min)
- [ ] Clonar WebDriverAgent
- [ ] Configurar signing en Xcode
- [ ] Build + Deploy al iPhone
- [ ] Anotar UDID y Bundle ID

### De vuelta en Tomillo
- [ ] Conectar iPhone por USB
- [ ] `tidevice list` lo detecta
- [ ] `tidevice wdaproxy` arranca WDA
- [ ] Screenshot de prueba funciona
- [ ] Mapear coordenadas de Instagram
- [ ] Script warmup iOS básico
- [ ] Integrar con backend
- [ ] Testing end-to-end

---

## Comandos de Referencia

```bash
# Detectar iPhone
tidevice list

# Arrancar WDA (forward puerto 8100)
tidevice wdaproxy -B com.tuAmigo.WebDriverAgent --port 8100

# Info del device
tidevice info

# Screenshot
tidevice screenshot test.png

# Listar apps instaladas
tidevice applist

# Instalar app
tidevice install app.ipa

# Abrir app
tidevice launch com.burbn.instagram
```

```python
# Python - Control básico
import wda
c = wda.Client('http://localhost:8100')

c.tap(x, y)                    # Tap
c.swipe_up()                   # Swipe up (scroll)
c.swipe_down()                 # Swipe down
c.swipe_left()                 # Swipe left
c.swipe_right()                # Swipe right
c.screenshot('screen.png')     # Screenshot
c.app_launch('com.burbn.instagram')  # Abrir app
c.app_stop('com.burbn.instagram')    # Cerrar app
c.home()                       # Botón home / swipe up

# Leer UI tree (como AccessibilityService)
source = c.source()            # XML del UI tree
```

---

## Arquitectura Final

```
Webapp (Vercel)
    ↓ POST /api/tasks/run
Backend (Tomillo)
    ↓ task stored as "pending"
    
    ┌─────────────────┬──────────────────┐
    │                 │                  │
Android Phone     Tomillo (Python)   [Futuro: otro PC]
    │                 │                  │
Accessibility     tidevice +         tidevice +
Service (5s)      facebook-wda       facebook-wda
    │                 │                  │
    ↓                 ↓                  ↓
Instagram App     Instagram App      Instagram App
(on Android)      (on iPhone)        (on iPhone)
```

---

*Documento creado por Tomi 🌿 — 2026-05-21*
*Actualizar conforme avancemos las fases.*
