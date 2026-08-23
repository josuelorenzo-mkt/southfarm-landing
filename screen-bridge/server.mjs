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
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SCREEN_BRIDGE_PORT || 8100);
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
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
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
  }

  log(line) {
    const entry = `[${this.serial}] ${line}`;
    console.log(entry);
    this.logTail.push(entry);
    if (this.logTail.length > 12) this.logTail.shift();
  }

  async ensureJarPushed() {
    if (!existsSync(SCRCPY_JAR)) throw new Error(`No se encontró scrcpy-server en ${SCRCPY_JAR}`);
    const res = await adb(["-s", this.serial, "push", SCRCPY_JAR, DEVICE_JAR_PATH], 30000);
    if (!res.stdout.includes("file pushed") && res.code !== 0) {
      throw new Error(`push falló: ${res.stderr || res.stdout}`);
    }
  }

  async start() {
    if (this.status === "live" || this.status === "starting") return;
    this.status = "starting";
    this.error = null;
    this.gopCache = [];
    this.pendingConfig = null;
    this.buffer = Buffer.alloc(0);
    this.codecSent = false;
    this.metaSent = false;
    try {
      // Limpiar capturadores huérfanos de sesiones anteriores en ESTE teléfono
      // (nombre de jar propio: nunca toca procesos de otras herramientas).
      await adb(["-s", this.serial, "shell", "pkill -f sf_scrcpy_server || true"], 8000).catch(() => {});
      await this.ensureJarPushed();
      this.port = await listenOnFreePort(this.tcpServer = net.createServer((sock) => this.onConnection(sock)));
      const rev = await adb(["-s", this.serial, "reverse", `${REVERSE_SOCKET}`, `tcp:${this.port}`]);
      this.log(`reverse code=${rev.code} out=${rev.stdout.trim().slice(0, 80)} err=${rev.stderr.trim().slice(0, 80)}`);
      if (rev.code !== 0) throw new Error(`adb reverse falló: ${rev.stderr || rev.stdout}`);
      const shellArgs = [
        "-s", this.serial, "shell",
        `CLASSPATH=${DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server ` +
          `${SERVER_VERSION} log_level=info max_size=${MAX_SIZE} max_fps=${MAX_FPS} ` +
          `video_bit_rate=${VIDEO_BIT_RATE} video_codec=h264 video=true audio=false ` +
          `send_frame_meta=true control=false cleanup=false` +
          (CODEC_OPTIONS ? ` video_codec_options=${CODEC_OPTIONS}` : ""),
      ];
      this.proc = spawn(ADB, shellArgs, { windowsHide: true });
      this.proc.stdout?.on("data", (d) => this.log(`server: ${String(d).trim().slice(0, 160)}`));
      this.proc.stderr.on("data", (d) => this.log(`server: ${String(d).trim().slice(0, 160)}`));
      this.proc.on("close", (code) => {
        this.log(`server exited (${code})`);
        if (this.status !== "idle") this.fail(`El capturador del teléfono se cerró (código ${code}).`);
      });

      this.startTimeout = setTimeout(() => {
        if (this.status === "starting") {
          this.fail("El teléfono no empezó a enviar video a tiempo. ¿Está con la pantalla encendida?");
        }
      }, START_TIMEOUT_MS);
      this.status = "awaiting"; // esperando la conexión TCP del server
      this.log(`esperando conexión del server en puerto ${this.port}`);
    } catch (cause) {
      this.fail(cause instanceof Error ? cause.message : String(cause));
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
    this.stallTicks = 0; // ticks del watchdog sin frames nuevos (solo si hubo actividad)
    clearTimeout(this.startTimeout);
    this.startTimeout = null;
    this.lastActivity = Date.now();
    this.totalBytes = 0;
    this.watchdog = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.max(0.001, (now - (this.lastWdTick || now - 2500)) / 1000);
      this.fpsMeasured = Math.round(((this.frameCount || 0) - ((this.lastWdFrames ?? this.frameCount) || 0)) / elapsedSec);
      this.lastWdTick = now;
      this.lastWdFrames = this.frameCount || 0;
      if (this.status !== "live") return;
      // Red absoluta: >30s sin UN byte con espectadores es un túnel muerto
      // (en pantalla estática el encoder igual emite IDRs periódicos).
      const sinceLastByte = now - this.lastActivity;
      if (sinceLastByte > 30000 && this.clients.size > 0) {
        this.fail("stall de red: túnel mudo >30s; reconectando", false);
        return;
      }
      // Stream ACTIVO (ya emitió >50 frames) sin frames nuevos ~7.5s: túnel colapsado.
      if (this.frameCount > 50 && this.frameCount === (this.lastStallFrameCount ?? -1)) {
        this.stallTicks += 1;
      } else {
        this.stallTicks = 0;
      }
      this.lastStallFrameCount = this.frameCount;
      if (this.stallTicks >= 3 && this.clients.size > 0) {
        this.fail("stall de red: el túnel dejó de entregar datos; reconectando", false); // silencioso: se recupera solo
        return;
      }
      if (!this.metaSent && this.buffer.length > 4096) {
        this.fail(`stall: protocolo desincronizado (bufLen=${this.buffer.length} sin metadata)`);
        return;
      }
      this.log(`wd fps=${this.fpsMeasured} bytes=${this.totalBytes} bufLen=${this.buffer.length} clients=${this.clients.size}`);
    }, 2500);
    this.log("server conectado, transmitiendo");
    sock.on("data", (chunk) => this.consume(chunk));
    sock.on("error", (e) => this.fail(`socket: ${e.message}`));
    sock.on("close", () => {
      if (this.status !== "idle") this.fail("El teléfono dejó de enviar video.");
    });
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
        this.fail(`frame inválido (len=${len}), reiniciando`);
        return;
      }
      if (this.buffer.length < 12 + len) break;
      // Vista zero-copy: el buffer base nunca se muta in-place, solo se reasigna.
      // Lo único que se retiene entre chunks (GOP cache) se copia una vez por IDR.
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
      if (this.pendingConfig) {
        out = Buffer.concat([this.pendingConfig, payload]);
        this.pendingConfig = null;
      }
      this.gopCache = [Buffer.from(out)]; // nuevo GOP: copia única por IDR
    } else if (this.gopCache.length) {
      this.gopCache.push(payload);
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
    if (this.status === "idle" || this.status === "error") void this.start();
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => this.stop("sin espectadores"), IDLE_STOP_MS);
    }
  }

  fail(message, notify = true) {
    if (this.status === "idle") return;
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
    this.teardownProc();
    // Auto-reinicio con espectadores conectados y backoff simple; tras 5 fallos
    // seguidos rendimos hasta que un cliente nuevo vuelva a intentar.
    if (this.clients.size > 0 && this.failureCount <= 5) {
      setTimeout(() => {
        if (this.clients.size > 0 && this.status === "error") {
          this.log(`auto-reintento #${this.failureCount}`);
          this.status = "idle";
          void this.start();
        }
      }, 3000);
    }
  }

  stop(reason = "manual") {
    this.log(`stop (${reason})`);
    this.status = "idle";
    this.teardownProc();
  }

  teardownProc() {
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
    if (this.tcpServer) {
      this.tcpServer.close();
      this.tcpServer = null;
    }
    adb(["-s", this.serial, "reverse", "--remove", REVERSE_SOCKET]).catch(() => {});
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
      src.status === "idle" &&
      !src.proc &&
      Date.now() - (src.lastActivity || 0) > 60000
    ) {
      sources.delete(serial);
    }
  }
}, 30000);

// ------------------------------------------------------------------- http

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);
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
  const match = req.url.match(/^\/ws\/stream\/(.+)$/);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  const serial = decodeURIComponent(match[1]);
  wss.handleUpgrade(req, socket, head, (ws) => {
    const src = getSource(serial);
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
