#!/usr/bin/env node
/**
 * SouthFarm Screen Bridge — vista en vivo de la flota Android para Device Fleet.
 *
 * Arquitectura (protocolo scrcpy-server v4.x verificado empíricamente):
 *   1. `adb push` del binario scrcpy-server al teléfono.
 *   2. Listener TCP local + `adb reverse localabstract:scrcpy tcp:<puerto>`
 *      (en scrcpy v4 el server conecta HACIA la PC, no al revés).
 *   3. Se lanza el server vía `app_process`; por el socket llega:
 *        - 64 bytes: nombre del dispositivo (se descarta)
 *        - 4 bytes : códec en ASCII, ej "h264"
 *        - paquetes: [header 12B][payload] donde bytes 8..11 = u32 BE longitud
 *          y el payload es H.264 Annex B (SPS/PPS sueltos + frames).
 *   4. Se re-empaquetan los chunks por WebSocket:
 *        - primer mensaje TEXTO: {"codec":"h264"}
 *        - luego BINARIOS Annex B (config SPS/PPS pegado al primer keyframe,
 *          y caché de GOP para que quien se conecte a mitad vea imagen al toque).
 *
 * El navegador decodifica con WebCodecs (ver fleet-live-view.tsx en webapp).
 * 100% opt-in: no hay ningún proceso ni conexión hasta que alguien abre la vista.
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SCREEN_BRIDGE_PORT || 8100);
// Auth: si SCREEN_AUTH_TOKEN está definido, HTTP exige Authorization Bearer y el
// WebSocket exige un ticket de un solo uso (o Bearer para clientes no-navegador).
// El token NUNCA viaja en la query: queda en logs del túnel. Sin la variable el
// bridge se niega a arrancar, salvo que SCREEN_ALLOW_OPEN=1 (solo LAN confiable).
const AUTH_TOKEN = process.env.SCREEN_AUTH_TOKEN || "";
const ALLOW_OPEN = process.env.SCREEN_ALLOW_OPEN === "1";
if (!AUTH_TOKEN && !ALLOW_OPEN) {
  console.error(
    "[auth] SCREEN_AUTH_TOKEN no está definido: el bridge se niega a arrancar abierto aInternet. " +
      "Definí SCREEN_AUTH_TOKEN, o SCREEN_ALLOW_OPEN=1 si esto es una LAN confiable.",
  );
  process.exit(1);
}

/** Chequeo en tiempo constante para no filtrar el token por timing. */
function tokenMatches(candidate) {
  if (!AUTH_TOKEN || typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerAuthorized(req) {
  const header = req.headers.authorization || "";
  return tokenMatches(header.startsWith("Bearer ") ? header.slice(7) : null);
}

// HTTP (health/devices/stream-ticket): solo header. El navegador puede mandar
// headers en fetch; el token en query quedaba registrado por el túnel.
function isAuthorizedRequest(req) {
  if (!AUTH_TOKEN) return true;
  return bearerAuthorized(req);
}

// Tickets de un solo uso para abrir el WebSocket desde el navegador (que no
// puede mandar headers en un WS). Viven 30s, se consumen al primer uso y
// quedan atados al serial pedido para que no se redirijan a otro teléfono.
const STREAM_TICKET_TTL_MS = 30_000;
const streamTickets = new Map();
const randomHex = () => randomBytes(24).toString("hex");

function issueStreamTicket(serial) {
  const ticket = randomHex();
  streamTickets.set(ticket, { serial: serial || null, expiresAt: Date.now() + STREAM_TICKET_TTL_MS });
  return ticket;
}

function consumeStreamTicket(ticket, serial) {
  const entry = typeof ticket === "string" ? streamTickets.get(ticket) : undefined;
  if (!entry) return false;
  streamTickets.delete(ticket);
  if (Date.now() > entry.expiresAt) return false;
  if (entry.serial && serial && entry.serial !== serial) return false;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ticket, entry] of streamTickets) {
    if (now > entry.expiresAt) streamTickets.delete(ticket);
  }
}, 30_000).unref();

// Orígenes del navegador autorizados a llamar al bridge (CORS). Sin la variable
// se mantiene el comportamiento amplio previo, con aviso en el log.
const ALLOWED_ORIGINS = (process.env.SCREEN_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (AUTH_TOKEN && ALLOWED_ORIGINS.length === 0) {
  console.warn("[cors] SCREEN_ALLOWED_ORIGINS sin definir: cualquier origen web podrá llamar al bridge.");
}

// ─── Registro en el backend (Fase 2) + capabilities firmadas ───
// SCREEN_BACKEND_URL + SCREEN_BRIDGE_TOKEN (token sfb_ emitido por la web)
// habilitan: (a) reporte periódico de seriales attached, (b) validación
// offline de capabilities HMAC y (c) corte de sesiones revocadas.
// SCREEN_REQUIRE_CAPABILITY=1 = modo estricto: el WS solo acepta capabilities.
const BACKEND_URL = (process.env.SCREEN_BACKEND_URL || "").replace(/\/$/, "");
const BRIDGE_REGISTERED_TOKEN = process.env.SCREEN_BRIDGE_TOKEN || "";
const REQUIRE_CAPABILITY = process.env.SCREEN_REQUIRE_CAPABILITY === "1";
// Rechazos de autenticación observados (WS con cap/ticket inválidos) desde el
// último heartbeat exitoso: el reconciliador del backend los convierte en alerta.
let wsAuthFailures = 0;
// Umbrales del watchdog, configurables con defaults conservadores: nunca se
// reinicia la captura por "pantalla estática" (el encoder emite cuadros de
// repetición); solo por falla real de entrega de datos.
const WD_NET_STALL_MS = Math.max(10_000, Number(process.env.SCREEN_WD_NET_STALL_MS || 30_000));
const WD_STALL_TICKS = Math.max(2, Number(process.env.SCREEN_WD_STALL_TICKS || 5));
const WD_TICK_MS = Math.max(1_000, Number(process.env.SCREEN_WD_TICK_MS || 2_000));

const BRIDGE_TOKEN_PATTERN = /^sfb_[A-Za-z0-9_-]{20,}$/;

/** Estado de pantalla del teléfono: 'ON' | 'OFF' | null (desconocido). */
async function getPhoneScreenState(serial) {
  try {
    const r = await adb(["-s", serial, "shell", "dumpsys display"], 6000);
    const match = String(r.stdout || "").match(/mScreenState=(\w+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function validateConfiguration() {
  const problems = [];
  if (REQUIRE_CAPABILITY && !BRIDGE_TOKEN_PATTERN.test(BRIDGE_REGISTERED_TOKEN)) {
    problems.push("SCREEN_REQUIRE_CAPABILITY=1 exige SCREEN_BRIDGE_TOKEN con formato sfb_ (emitido por el panel). El valor actual está vacío, es un placeholder o tiene formato inválido; el bridge se niega a arrancar en modo estricto.");
  }
  if (BRIDGE_REGISTERED_TOKEN && !BRIDGE_TOKEN_PATTERN.test(BRIDGE_REGISTERED_TOKEN)) {
    problems.push("SCREEN_BRIDGE_TOKEN no cumple el formato sfb_<secreto>: se rechaza por seguridad (los placeholders del paquete no son credenciales válidas).");
  }
  if (BACKEND_URL && !/^https?:\/\//.test(BACKEND_URL)) {
    problems.push("SCREEN_BACKEND_URL debe ser una URL http(s).");
  }
  ALLOWED_ORIGINS.forEach((origin, index) => {
    if (!/^https?:\/\//.test(origin)) problems.push(`SCREEN_ALLOWED_ORIGINS[${index}] no es una URL http(s) válida.`);
  });
  return problems;
}

// Modo de validación: no inicia listener, ADB ni heartbeat; imprime un
// resumen REDACTADO (nunca los valores de los secretos) y sale 0/1.
if (process.argv.includes("--validate-config") || process.env.SCREEN_VALIDATE === "1") {
  const problems = validateConfiguration();
  console.log(`[validate] auth compartido: ${AUTH_TOKEN ? "definido" : "AUSENTE"} (valor no impreso)`);
  console.log(`[validate] backend: ${BACKEND_URL ? "configurado" : "no configurado"}; bridge_token: ${BRIDGE_REGISTERED_TOKEN ? "definido" : "no configurado"}; modo estricto: ${REQUIRE_CAPABILITY ? "ON" : "OFF"}`);
  console.log(`[validate] orígenes web permitidos: ${ALLOWED_ORIGINS.length}`);
  console.log(`[validate] watchdog: net_stall=${WD_NET_STALL_MS}ms; frame_stall=${WD_STALL_TICKS} ticks`);
  if (problems.length) {
    for (const problem of problems) console.error(`[validate] ERROR: ${problem}`);
    process.exit(1);
  }
  console.log("[validate] configuración OK (ningún servicio fue iniciado).");
  process.exit(0);
}

// Arranque en modo estricto sin credencial válida: fail-closed.
if (REQUIRE_CAPABILITY) {
  const problems = validateConfiguration();
  if (problems.length) {
    for (const problem of problems) console.error("[arranque] " + problem);
    process.exit(1);
  }
}
const usedNonces = new Map(); // nonce → expMs (capabilities de un solo uso)

function verifyCapability(raw, serial) {
  if (typeof raw !== "string" || !raw.includes(".")) return null;
  const cut = raw.lastIndexOf(".");
  const body = raw.slice(0, cut);
  const sig = raw.slice(cut + 1);
  const expected = createHmac("sha256", BRIDGE_REGISTERED_TOKEN).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.aud !== "screen-bridge" || !Number.isInteger(payload?.exp)) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (serial && payload.serial && payload.serial !== serial) return null;
  if (!Number.isInteger(payload.session)) return null;
  return payload;
}

function consumeCapabilityNonce(payload) {
  if (!payload?.nonce) return true;
  if (usedNonces.has(payload.nonce)) return false;
  usedNonces.set(payload.nonce, payload.exp * 1000);
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) if (exp < now) usedNonces.delete(nonce);
  return true;
}

function backendRequest(method, path, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(BACKEND_URL + path);
      const isHttps = u.protocol === "https:";
      const req = (isHttps ? https : http).request(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${BRIDGE_REGISTERED_TOKEN}`,
          },
          timeout: 8000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end(body ? JSON.stringify(body) : undefined);
    } catch {
      resolve(null);
    }
  });
}

async function reportAttachments() {
  if (!BACKEND_URL || !BRIDGE_REGISTERED_TOKEN) return;
  try {
    const serials = await listDeviceSerials();
    const res = await backendRequest("POST", "/api/bridges/heartbeat", {
      serials,
      version: `screen-bridge/${SERVER_VERSION}`,
      auth_failures: wsAuthFailures,
    });
    if (res && res.status === 200) {
      wsAuthFailures = 0; // reportado: el backend hace el seguimiento
    } else {
      console.warn(`[report] heartbeat con backend falló: ${res ? `HTTP ${res.status}` : "sin conexión"}`);
    }
  } catch (cause) {
    console.warn(`[report] error: ${cause?.message || cause}`);
  }
}

async function checkActiveSessions() {
  if (!BACKEND_URL || !BRIDGE_REGISTERED_TOKEN) return;
  for (const [, src] of sources) {
    if (!src.sessionId || src.status !== "live") continue;
    const res = await backendRequest("GET", `/api/bridges/session-check?session_id=${src.sessionId}`);
    let status = null;
    try {
      status = res?.body ? JSON.parse(res.body).status : null;
    } catch {
      status = null;
    }
    if (status && status !== "live") src.stop(`sesión ${status}`);
  }
}

setInterval(reportAttachments, 45_000).unref();
if (BACKEND_URL && BRIDGE_REGISTERED_TOKEN) {
  setTimeout(reportAttachments, 4_000).unref();
  console.log(`[report] registrando attachments en ${BACKEND_URL}`);
}
setInterval(checkActiveSessions, 30_000).unref();
const ADB = process.env.SCREEN_ADB || pickDefaultAdb();
const SCRCPY_JAR =
  process.env.SCREEN_SCRCPY_JAR ||
  "C:\\Users\\josu_\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.1\\scrcpy-server";
const SERVER_VERSION = "4.1";
const DEVICE_JAR_PATH = "/data/local/tmp/sf_scrcpy_server.jar";
const REVERSE_SOCKET = "localabstract:scrcpy"; // nombre default del socket en v4
const MAX_SIZE = Number(process.env.SCREEN_MAX_SIZE || 1024);
const MAX_FPS = Number(process.env.SCREEN_MAX_FPS || 30);
const VIDEO_BIT_RATE = process.env.SCREEN_VIDEO_BITRATE || "4000000"; // bits/s (8M×N teléfonos colapsa el WiFi)
// repeat-previous-frame-after: re-emite el último cuadro (µs) aunque la pantalla
// no cambie → fps estable incluso con pantalla estática. i-frame-interval (s):
// GOP corto para resyncs rápidos. Vacío para desactivar ambas.
const CODEC_OPTIONS =
  process.env.SCREEN_CODEC_OPTIONS ?? "repeat-previous-frame-after=33333,i-frame-interval=2";
const WS_SOFT_LIMIT = 2 * 1024 * 1024; // cliente lento: descartar deltas
const WS_HARD_LIMIT = 8 * 1024 * 1024; // cliente muerto: cortar
const SEND_OPTS = { binary: true };
const START_CODE = Buffer.from([0x00, 0x00, 0x01]);
const IDLE_STOP_MS = 3000;
const START_TIMEOUT_MS = 9000;

function pickDefaultAdb() {
  const candidates = [
    "C:\\SouthFarm\\toolchain\\android-sdk\\platform-tools\\adb.exe",
    "adb",
  ];
  return candidates.find((p) => p === "adb" || existsSync(p)) || "adb";
}

// ---------------------------------------------------------------- adb utils

function adb(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`adb ${args[0]} timeout`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function listDeviceSerials() {
  const { stdout } = await adb(["devices"]);
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"))
    .map((line) => line.slice(0, -"\tdevice".length));
}

function killTreeWindows(pid) {
  // adb.exe no siempre propaga el kill al shell remoto; igualmente el server
  // del teléfono corta solo cuando el socket se cierra.
  try {
    // Sin handler de 'error', un ENOENT de taskkill salta como uncaughtException.
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true })
      .on("error", () => {}); /* best effort */
  } catch {
    /* best effort */
  }
}

// ------------------------------------------------------------- config alias

function loadAliases() {
  try {
    const raw = JSON.parse(readFileSync(path.join(__dirname, "devices.json"), "utf8"));
    return raw.aliasBySerial || {};
  } catch {
    return {};
  }
}
const modelCache = new Map();

// ------------------------------------------------------------ video source

class ScreenSource {
  constructor(serial) {
    this.serial = serial;
    this.codecName = "h264";
    this.clients = new Set();
    this.status = "idle"; // idle | starting | live | error
    this.error = null;
    this.tcpServer = null;
    this.port = 0;
    this.proc = null;
    this.gopCache = []; // GOP completo (IDR inclusive) para replay instantáneo de joins
    this.pendingConfig = null;
    this.buffer = Buffer.alloc(0);
    this.codecSent = false;
    this.metaSent = false;
    this.idleTimer = null;
    this.startTimeout = null;
    this.lastActivity = 0;
    this.logTail = [];
    this.failureCount = 0;
    this.gen = 0; // token de generación: invalida un start() en vuelo cuando llega stop()/fail()
    this.tearingDown = false; // teardown intencional: los 'close' posteriores no son fallas
  }

  log(line) {
    const entry = `[${this.serial}] ${line}`;
    console.log(entry);
    this.logTail.push(entry);
    if (this.logTail.length > 12) this.logTail.shift();
  }

  async ensureJarPushed() {
    if (!existsSync(SCRCPY_JAR)) throw new Error(`No se encontró scrcpy-server en ${SCRCPY_JAR}`);
    // Recuperación rápida: si el jar ya está en el teléfono con el tamaño correcto,
    // nos ahorramos el push de ~11MB por WiFi en cada reintento.
    const localSize = statSync(SCRCPY_JAR).size;
    const probe = await adb(["-s", this.serial, "shell", `ls -l ${DEVICE_JAR_PATH}`], 8000).catch(() => null);
    if (probe && probe.code === 0) {
      const digits = probe.stdout.split(/\s+/).filter((token) => /^\d+$/.test(token)).map(Number);
      if (digits.length && Math.max(...digits) === localSize) {
        this.log(`jar ya presente (${localSize}B): push omitido`);
        return;
      }
    }
    const res = await adb(["-s", this.serial, "push", SCRCPY_JAR, DEVICE_JAR_PATH], 30000);
    if (!res.stdout.includes("file pushed") && res.code !== 0) {
      throw new Error(`push falló: ${res.stderr || res.stdout}`);
    }
  }

  async start() {
    if (this.status === "live" || this.status === "starting") return;
    const gen = ++this.gen; // si llega stop()/fail() durante los await, este intento queda invalidado
    this.status = "starting";
    this.tearingDown = false; // arranque nuevo: los cierres vuelven a contar como fallas
    this.error = null;
    this.gopCache = [];
    this.pendingConfig = null;
    this.buffer = Buffer.alloc(0);
    this.codecSent = false;
    this.metaSent = false;
    try {
      // Solo capturar si el serial sigue presente y en estado device; un
      // teléfono que se desconectó no recibe push/reverse/wake.
      const state = await adb(["-s", this.serial, "get-state"], 8000).catch(() => ({ code: -1, stdout: "" }));
      if (gen !== this.gen) return;
      if (String(state.stdout || "").trim() !== "device") {
        throw new Error(`el serial ${this.serial} no está en estado ADB 'device' (get-state falló); no se inicia captura`);
      }
      // Limpiar capturadores huérfanos de sesiones anteriores en ESTE teléfono
      // (nunca toca procesos de otras herramientas). Dos patrones: el nombre del
      // jar propio, y la clase real del server (el jar va por CLASSPATH, así que
      // el cmdline del huérfano contiene com.genymobile.scrcpy.Server).
      await adb(["-s", this.serial, "shell", "pkill -f sf_scrcpy_server || true"], 8000).catch(() => {});
      if (gen !== this.gen) return;
      await adb(["-s", this.serial, "shell", "pkill -f com.genymobile.scrcpy.Server || true"], 8000).catch(() => {});
      if (gen !== this.gen) return;
      await this.ensureJarPushed();
      if (gen !== this.gen) return;
      if (this.tcpServer && this.tcpServer.listening) {
        // Recuperación rápida: reuso el listener y el puerto del intento anterior
        // (solo hace falta respawnear el capturador dentro del teléfono).
        this.log(`reuso túnel en puerto ${this.port}`);
      } else {
        this.port = await listenOnFreePort(this.tcpServer = net.createServer((sock) => this.onConnection(sock)));
      }
      if (gen !== this.gen) return;
      const rev = await adb(["-s", this.serial, "reverse", `${REVERSE_SOCKET}`, `tcp:${this.port}`]);
      if (gen !== this.gen) return;
      this.log(`reverse code=${rev.code} out=${rev.stdout.trim().slice(0, 80)} err=${rev.stderr.trim().slice(0, 80)}`);
      if (rev.code !== 0) throw new Error(`adb reverse falló: ${rev.stderr || rev.stdout}`);
      // El bridge NO altera el estado del teléfono: nada de wake, gestos ni
      // ajustes para forzar frames. Un teléfono bloqueado transmite negro (con
      // repeat-previous-frame el encoder igual emite cuadros); SCRN_STAY_AWAKE=1
      // permite optar por mantener la pantalla encendida MIENTRAS hay captura
      // (flag de scrcpy, pasivo, nunca un keyevent).
      const stayAwake = process.env.SCREEN_STAY_AWAKE === "1" ? " stay_awake=true" : "";
      const shellArgs = [
        "-s", this.serial, "shell",
        `CLASSPATH=${DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server ` +
          `${SERVER_VERSION} log_level=info max_size=${MAX_SIZE} max_fps=${MAX_FPS} ` +
          `video_bit_rate=${VIDEO_BIT_RATE} video_codec=h264 video=true audio=false ` +
          `send_frame_meta=true control=false cleanup=false${stayAwake}` +
          (CODEC_OPTIONS ? ` video_codec_options=${CODEC_OPTIONS}` : ""),
      ];
      const proc = (this.proc = spawn(ADB, shellArgs, { windowsHide: true }));
      proc.stdout?.on("data", (d) => this.log(`server: ${String(d).trim().slice(0, 160)}`));
      proc.stderr?.on("data", (d) => this.log(`server: ${String(d).trim().slice(0, 160)}`));
      proc.on("close", (code) => {
        this.log(`server exited (${code})`);
        // Cierre intencional (teardown) o de una sesión vieja: no cuenta como falla.
        if (this.tearingDown || this.proc !== proc || this.status === "idle") return;
        this.fail(`El capturador del teléfono se cerró (código ${code}).`, false); // recuperable: respawn silencioso
      });
      proc.on("error", (err) => {
        this.log(`error lanzando adb: ${err.message}`);
        if (this.tearingDown || this.proc !== proc || this.status === "idle") return;
        this.fail(`No se pudo lanzar adb: ${err.message}`, false);
      });

      this.startTimeout = setTimeout(() => {
        if (this.status === "starting") {
          this.fail("El teléfono no empezó a enviar video a tiempo. ¿Está con la pantalla encendida?", false);
        }
      }, START_TIMEOUT_MS);
      this.status = "awaiting"; // esperando la conexión TCP del server
      this.log(`esperando conexión del server en puerto ${this.port}`);
    } catch (cause) {
      if (gen !== this.gen) return; // el incidente ya lo resolvió stop()/fail()
      this.fail(cause instanceof Error ? cause.message : String(cause), false);
    }
  }

  onConnection(sock) {
    if (this.status === "live" || this.mediaSock) {
      // Solo esperamos un socket (video). Conexiones extra: descartar.
      sock.end();
      return;
    }
    this.mediaSock = sock;
    sock.setNoDelay(true); // sin Nagle: cada frame sale inmediatamente
    sock.setKeepAlive(true, 10000);
    this.status = "live";
    this.failureCount = 0; // la sesión arrancó bien: limpiar historial de fallos
    this.frameCount = 0; // sesión nueva: contadores del watchdog en cero, sin herencia
    this.lastStallFrameCount = -1; // de la sesión anterior (si no, stallTicks espurios → refail)
    this.stallTicks = 0; // ticks del watchdog sin frames nuevos (solo si hubo actividad)
    clearTimeout(this.startTimeout);
    this.startTimeout = null;
    this.lastActivity = Date.now();
    this.totalBytes = 0;
    this.stallRestarts = 0; // reinicios de stall consecutivos que no restauraron el flujo
    this.darkNotified = false; // ya avisamos "waiting" por pantalla apagada
    this.wdBusy = false; // un tick del watchdog pendiente a la vez
    this.watchdog = setInterval(() => {
      if (this.wdBusy || this.status !== "live") return;
      this.wdBusy = true;
      void this.watchdogTick().finally(() => { this.wdBusy = false; });
    }, WD_TICK_MS);
    this.log("server conectado, transmitiendo");
    sock.on("data", (chunk) => this.consume(chunk));
    sock.on("error", (e) => this.fail(`socket: ${e.message}`, false));
    sock.on("close", () => {
      // Cierre intencional (teardown) o de un socket reemplazado: no cuenta como falla.
      if (this.tearingDown || this.mediaSock !== sock || this.status === "idle") return;
      this.fail("El teléfono dejó de enviar video.", false); // recuperable: respawn silencioso
    });
  }

  /** Tick del watchdog: distingue pantalla estática / apagada de falla real. */
  async watchdogTick() {
    const now = Date.now();
    const elapsedSec = Math.max(0.001, (now - (this.lastWdTick || now - 2000)) / 1000);
    this.fpsMeasured = Math.round(((this.frameCount || 0) - ((this.lastWdFrames ?? this.frameCount) || 0)) / elapsedSec);
    this.lastWdTick = now;
    this.lastWdFrames = this.frameCount || 0;
    if (this.status !== "live") return;

    // Red absoluta: muchos segundos sin UN byte. Puede ser túnel muerto o
    // teléfono con pantalla apagada: handleStall lo distingue antes de restart.
    const sinceLastByte = now - this.lastActivity;
    if (sinceLastByte > WD_NET_STALL_MS && this.clients.size > 0) {
      await this.handleStall("stall de red: túnel mudo >" + Math.round(WD_NET_STALL_MS / 1000) + "s");
      return;
    }

    // Stream ACTIVO (ya emitió >50 frames) sin frames NUEVOS durante el límite
    // de ticks (con backoff progresivo si los reinicios no restauran el flujo).
    if (this.frameCount > 50 && this.frameCount === (this.lastStallFrameCount ?? -1)) {
      this.stallTicks += 1;
    } else {
      this.stallTicks = 0;
      this.stallRestarts = 0; // frames fluyendo otra vez: backoff a cero
      this.darkNotified = false;
    }
    this.lastStallFrameCount = this.frameCount;
    const limit = WD_STALL_TICKS * Math.min(4, 2 ** (this.stallRestarts || 0));
    if (this.stallTicks >= limit && this.clients.size > 0) {
      await this.handleStall("stall: sin frames nuevos");
      return;
    }
    if (!this.metaSent && this.buffer.length > 4096) {
      this.fail(`stall: protocolo desincronizado (bufLen=${this.buffer.length} sin metadata)`);
      return;
    }
    this.log(`wd fps=${this.fpsMeasured} bytes=${this.totalBytes} bufLen=${this.buffer.length} clients=${this.clients.size}`);
  }

  /**
   * Ciclo de recuperación de un stall. REGLA: si la pantalla del teléfono está
   * apagada NO se reinicia la captura (no hay nada que capturar y reiniciar
   * sería tocar el teléfono en vano): se marca "waiting" y se espera a que
   * despierte, momento en que el encoder retoma solo. Con pantalla encendida,
   * se reinicia; si varios reinicios no restauran el flujo (pantalla estática
   * que el encoder no repite), el backoff progresivo espacia los reinicios
   * en lugar de martillar el teléfono cada pocos segundos.
   */
  async handleStall(reason) {
    this.broadcastText(JSON.stringify({ type: "waiting" })); // señal explícita ANTES de cualquier restart
    const screen = await getPhoneScreenState(this.serial);
    if (screen === "OFF") {
      if (!this.darkNotified) {
        this.log("pantalla del teléfono apagada con espectadores: en espera, sin reiniciar captura");
        this.darkNotified = true;
      }
      this.stallTicks = 0;
      this.lastStallFrameCount = this.frameCount;
      return;
    }
    this.darkNotified = false;
    if (this.totalBytesAtLastStallRestart !== undefined && this.totalBytes === this.totalBytesAtLastStallRestart) {
      this.stallRestarts = Math.min(3, (this.stallRestarts || 0) + 1);
      this.log(`stall persistente tras reinicio (${reason}); backoff a ${WD_STALL_TICKS * Math.min(4, 2 ** this.stallRestarts)} ticks`);
    }
    this.totalBytesAtLastStallRestart = this.totalBytes;
    this.fail(`${reason}; reconectando`, false); // silencioso: se recupera solo
  }

  /** Parser: [64B name][4B codec][12B metadata][paquetes de 12B header + payload Annex B] */
  consume(chunk) {
    if (process.env.SCREEN_DEBUG_RAW && !this.rawDone) {
      this.rawAcc = Buffer.concat([this.rawAcc || Buffer.alloc(0), chunk]);
      if (this.rawAcc.length >= 160) {
        this.rawDone = true;
        console.log(`RAW ${this.rawAcc.length}B:`, this.rawAcc.subarray(0, 200).toString("hex").replace(/(..)/g, "$1 ").trim());
      }
    }
    this.totalBytes += chunk.length;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.lastActivity = Date.now();

    if (!this.codecSent) {
      if (this.buffer.length < 68) return; // esperar el bloque completo 64+4
      this.deviceLabel = this.buffer.subarray(0, 64).toString("ascii").replace(/\0+$/, "").trim();
      this.codecName = this.buffer.subarray(64, 68).toString("ascii").trim().toLowerCase() || "h264";
      this.codecSent = true;
      this.log(`device="${this.deviceLabel}" codec=${this.codecName}`);
      this.buffer = this.buffer.subarray(68);
    }

    if (!this.metaSent) {
      if (this.buffer.length < 12) return;
      const flags = this.buffer.readUInt32BE(0);
      const width = this.buffer.readUInt32BE(4);
      const height = this.buffer.readUInt32BE(8);
      const plausible = width >= 16 && width <= 8192 && height >= 16 && height <= 8192;
      if (!plausible) return; // aún no hay 12B de metadatos coherentes: seguir esperando
      this.metaSent = true;
      this.log(`metadata ${width}x${height} flags=0x${flags.toString(16)}`);
      this.buffer = this.buffer.subarray(12);
    }

    while (this.buffer.length >= 12) {
      const len = this.buffer.readUInt32BE(8);
      if (len <= 0 || len > 8 * 1024 * 1024) {
        this.log(`frame inválido (len=${len}) bufferHead=${this.buffer.subarray(0, 48).toString("hex")} offset=${this.buffer.length}`);
        this.fail(`frame inválido (len=${len}), reiniciando`, false);
        return;
      }
      if (this.buffer.length < 12 + len) break;
      // Vista zero-copy: el buffer base nunca se muta in-place, solo se reasigna.
      // Todo lo que se retiene entre chunks (GOP cache) se copia antes de guardarse.
      const payload = this.buffer.subarray(12, 12 + len);
      this.buffer = this.buffer.subarray(12 + len);
      this.dispatchPayload(payload);
    }
  }

  dispatchPayload(payload) {
    this.frameCount = (this.frameCount || 0) + 1;
    const kinds = classifyAnnexB(payload); // {sps,pps,idr}
    if ((kinds.sps || kinds.pps) && !kinds.idr) {
      this.pendingConfig = Buffer.from(payload); // SPS/PPS suelto: copiado, se retiene
      return;
    }
    let out = payload;
    if (kinds.idr) {
      // Pegar SPS/PPS a TODOS los IDR, no solo al primero: el codificador los
      // emite una sola vez por sesión, y un cliente que entra (o reconecta)
      // después necesita parameter sets in-band para inicializar su decoder
      // (WebCodecs sin description espera SPS/PPS eternamente sin dar error).
      if (this.pendingConfig) {
        out = Buffer.concat([this.pendingConfig, payload]);
      }
      this.gopCache = [Buffer.from(out)]; // nuevo GOP: copia única por IDR
    } else if (this.gopCache.length) {
      // Copia obligatoria: el subarray retendría el chunk TCP completo en memoria.
      this.gopCache.push(Buffer.from(payload));
      if (this.gopCache.length > 120) this.gopCache.shift(); // techo de seguridad
    }
    const isKey = kinds.idr;
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > WS_HARD_LIMIT) {
        // Cliente muerto: cortar. El navegador reconecta y entra por el replay del GOP.
        this.log(`cliente lento (${ws.bufferedAmount}B en buffer): terminate`);
        this.clients.delete(ws);
        ws.terminate();
        continue;
      }
      // Cliente lento pero vivo: descartar deltas; se re-sincroniza con el próximo IDR.
      if (!isKey && ws.bufferedAmount > WS_SOFT_LIMIT) continue;
      ws.send(out, SEND_OPTS);
    }
  }

  broadcastText(text) {
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(text, { binary: false });
    }
  }

  addClient(ws) {
    this.clients.add(ws);
    clearTimeout(this.idleTimer);
    ws.send(JSON.stringify({ codec: this.codecName || "h264" }), { binary: false });
    for (const chunk of this.gopCache) ws.send(chunk, SEND_OPTS); // replay del GOP: imagen al toque
    // Espectador nuevo sin GOP cacheado: el capturador actual no está emitiendo
    // frames (encoder silencioso con pantalla estática — pasa en algunos
    // Motorola — o teléfono dormido). Respawn: el arranque despierta el
    // teléfono y el primer GOP siempre se produce.
    if (this.gopCache.length === 0 && this.status === "live" && !this.tearingDown) {
      this.log("espectador sin GOP cacheado; respawn del capturador");
      this.fail("sin GOP cacheado para espectador nuevo", false);
      return;
    }
    if (this.status === "idle" || this.status === "error") void this.start();
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => this.stop("sin espectadores"), IDLE_STOP_MS);
    }
  }

  fail(message, notify = true) {
    // Un solo fail efectivo por incidente: los 'close' derivados del teardown
    // llegan después y no deben re-contar fallos ni mandar otro {type:"error"}
    // (el navegador cerraba el WS y cancelaba la auto-recuperación).
    if (this.status === "idle" || this.status === "error") return;
    this.gen++; // invalida cualquier start() en vuelo de la sesión que se cae
    this.log(`FAIL: ${message}`);
    this.error = message;
    this.status = "error";
    this.failureCount = (this.failureCount || 0) + 1;
    clearTimeout(this.startTimeout);
    this.startTimeout = null;
    if (notify) {
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message }), { binary: false });
      }
    }
    this.teardownProc(true); // recuperación: conserva listener + reverse para reintentar rápido
    // Auto-reinicio indefinido mientras haya espectadores: bajo stalls crónicos
    // (WiFi saturado) un tope duro dejaba la vista muerta para siempre, con el
    // WS abierto mostrando el último frame congelado. Backoff creciente con
    // jitter ±25% acota el martilleo sin rendirse (y desfasa los reintentos de
    // N dispositivos que sufrieron el mismo blip del AP).
    if (this.clients.size > 0) {
      const baseMs = Math.min(3000 * this.failureCount, 15000);
      const delayMs = Math.round(baseMs * (0.75 + Math.random() * 0.5)); // jitter ±25%
      setTimeout(() => {
        if (this.clients.size > 0 && this.status === "error") {
          this.log(`auto-reintento #${this.failureCount}`);
          this.status = "idle";
          void this.start();
        }
      }, delayMs);
    }
  }

  stop(reason = "manual") {
    this.log(`stop (${reason})`);
    this.gen++; // cancela un start() en curso si lo hubiera
    this.status = "idle";
    this.teardownProc();
  }

  /**
   * keepTunnel: en la recuperación automática (fail → reintento) conservamos el
   * listener TCP y el `adb reverse`: solo hace falta respawnear el capturador.
   * stop() definitivo sí desarma todo.
   */
  teardownProc(keepTunnel = false) {
    this.tearingDown = true; // los 'close' de socket/proceso que llegan después no son fallas
    clearInterval(this.watchdog);
    this.watchdog = null;
    clearTimeout(this.startTimeout);
    this.startTimeout = null;
    if (this.mediaSock) {
      this.mediaSock.destroy();
      this.mediaSock = null;
    }
    if (this.proc) {
      const pid = this.proc.pid;
      try { this.proc.kill(); } catch {}
      if (pid) killTreeWindows(pid);
      this.proc = null;
    }
    if (!keepTunnel) {
      if (this.tcpServer) {
        this.tcpServer.close();
        this.tcpServer = null;
      }
      adb(["-s", this.serial, "reverse", "--remove", REVERSE_SOCKET]).catch(() => {});
    }
    this.buffer = Buffer.alloc(0);
    this.gopCache = [];
    this.pendingConfig = null;
  }
}

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** Detecta NAL types H264 en un buffer Annex B. 5=IDR 7=SPS 8=PPS */
function classifyAnnexB(buf) {
  const kinds = { sps: false, pps: false, idr: false };
  let sc = buf.indexOf(START_CODE);
  while (sc !== -1) {
    const nalStart = sc + 3;
    if (nalStart < buf.length) {
      const t = buf[nalStart] & 0x1f;
      if (t === 5) kinds.idr = true;
      else if (t === 7) kinds.sps = true;
      else if (t === 8) kinds.pps = true;
    }
    if (kinds.idr && kinds.sps && kinds.pps) break; // early-exit
    sc = buf.indexOf(START_CODE, nalStart);
  }
  return kinds;
}

// ------------------------------------------------------------- source mgr

const sources = new Map();

function getSource(serial) {
  let src = sources.get(serial);
  if (!src) {
    src = new ScreenSource(serial);
    sources.set(serial, src);
  }
  return src;
}

setInterval(() => {
  for (const [serial, src] of sources) {
    if (
      src.clients.size === 0 &&
      (src.status === "idle" || src.status === "error") && // un source muerto en error también se recolecta
      !src.proc &&
      !src.watchdog &&
      Date.now() - (src.lastActivity || 0) > 60000
    ) {
      src.stop("recolector"); // cierra túnel conservado de una recuperación, si lo hay
      sources.delete(serial);
    }
  }
}, 30000);

// ------------------------------------------------------------------- http

/** Lee un body JSON acotado (los tickets no necesitan más que unos bytes). */
function readJsonBody(req, limitBytes = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("body demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length > 0) {
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    // Origen no permitido: sin header CORS, el navegador bloquea la respuesta.
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function serialTransport(serial) {
  return /:\d+$/.test(serial) ? "wifi" : "usb";
}

async function buildDeviceInfo(serial, aliases) {
  let model = modelCache.get(serial);
  if (!model) {
    const r = await adb(["-s", serial, "shell", "getprop ro.product.model"], 8000).catch(() => null);
    model = r ? r.stdout.trim() : "";
    if (model) modelCache.set(serial, model);
  }
  return {
    serial,
    alias: aliases[serial] || (serialTransport(serial) === "wifi" ? serial.split(":")[0] : serial),
    model,
    online: true,
    transport: serialTransport(serial),
  };
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!isAuthorizedRequest(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "token requerido" }));
  }
  try {
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        service: "southfarm-screen-bridge",
        uptimeSeconds: Math.round(process.uptime()),
        activeStreams: [...sources.values()].filter((s) => s.status === "live").length,
        streams: [...sources.values()]
          .filter((s) => s.status !== "idle")
          .map((s) => ({ serial: s.serial, status: s.status, clients: s.clients.size, fps: s.fpsMeasured || 0 })),
      }));
    }
    if (url.pathname === "/api/devices") {
      const aliases = loadAliases();
      const serials = await listDeviceSerials();
      // Paralelo: con 10 teléfonos el getprop secuencial sería lento al primer pedido.
      const devices = await Promise.all(serials.map((serial) => buildDeviceInfo(serial, aliases)));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ devices }));
    }
    if (url.pathname === "/api/stream-ticket" && req.method === "POST") {
      const body = await readJsonBody(req);
      // Si vienen un serial, el ticket queda atado a él; si no, sirve para cualquier serial.
      const ticket = issueStreamTicket(typeof body?.serial === "string" ? body.serial : null);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ticket, expires_in: Math.round(STREAM_TICKET_TTL_MS / 1000) }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (cause) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
  }
});

// -------------------------------------------------------------- websocket

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false }); // comprimir video es CPU y latencia regalados

server.on("upgrade", (req, socket, head) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const match = parsed.pathname.match(/^\/ws\/stream\/(.+)$/); // pathname: sin query (la credencial va aparte)
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  const serial = decodeURIComponent(match[1]);
  let sessionMeta = null;
  // Modo estricto (SCREEN_REQUIRE_CAPABILITY=1): solo capabilities HMAC
  // emitidas por el backend para esta sesión, atadas a este serial y de un
  // solo uso. Fuera del modo estricto se mantiene el flujo legado
  // (ticket de /api/stream-ticket o Bearer) para no romper el corte.
  const authorized = (() => {
    if (REQUIRE_CAPABILITY) {
      const payload = verifyCapability(parsed.searchParams.get("cap"), serial);
      if (!payload || !consumeCapabilityNonce(payload)) return false;
      sessionMeta = payload;
      return true;
    }
    if (!AUTH_TOKEN) return true;
    // El navegador no puede mandar headers en un WebSocket: usa un ticket de
    // un solo uso emitido por /api/stream-ticket. Clientes no-navegador pueden
    // usar Authorization Bearer. El token compartido nunca viaja en la query.
    return parsed.searchParams.has("ticket")
      ? consumeStreamTicket(parsed.searchParams.get("ticket"), serial)
      : bearerAuthorized(req);
  })();
  if (!authorized) {
    wsAuthFailures += 1; // el reconciliador lo reporta como alerta
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const src = getSource(serial);
    if (sessionMeta?.session) src.sessionId = sessionMeta.session;
    src.addClient(ws);
    ws.on("close", () => src.removeClient(ws));
    ws.on("error", () => src.removeClient(ws));
  });
});

process.on("uncaughtException", (err) => console.log("uncaught:", err?.stack || err));
process.on("unhandledRejection", (err) => console.log("unhandledRejection:", err));

server.listen(PORT, () => {
  console.log(`southfarm-screen-bridge escuchando en http://localhost:${PORT}`);
  console.log(`adb: ${ADB}`);
  console.log(`scrcpy-server: ${SCRCPY_JAR}`);
});
