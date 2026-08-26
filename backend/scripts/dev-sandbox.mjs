#!/usr/bin/env node
// Sandbox local para probar el panel web SIN tocar producción.
//
// 1. Toma un snapshot consistente de la DB productiva (backup API de
//    better-sqlite3, WAL-safe) en backend/data/sandbox/southfarm-sandbox.db.
// 2. Arranca la API compilada (dist/) en http://127.0.0.1:3002 contra ESA copia.
//    - El planner y el scheduler corren solo sobre la copia.
//    - Los teléfonos siguen hablando con producción (3001); acá nadie los molesta.
// 3. Crea (o repara) el usuario QA dentro de la COPIA con membership owner al
//    workspace real (default 6), para que el panel muestre los datos conocidos.
//
// Uso:   node scripts/dev-sandbox.mjs [--keep] [--ws <workspaceId>]
//   --keep  reutiliza la copia anterior en vez de re-snapshotear
// Env:    SOUTHFARM_SANDBOX_PORT (default 3002), SOUTHFARM_PROD_DB
//
// Después, en otra terminal, la webapp:
//   cd webapp && NEXT_PUBLIC_API_URL=http://127.0.0.1:3002 npm run dev
// y entrá a http://localhost:3000 con las credenciales QA que imprime acá.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_DIR = path.join(BACKEND_ROOT, 'data', 'sandbox');
const DB_PATH = path.join(SANDBOX_DIR, 'southfarm-sandbox.db');
const PORT = Number(process.env.SOUTHFARM_SANDBOX_PORT || 3002);
const BASE = `http://127.0.0.1:${PORT}`;
const PROD_DB = process.env.SOUTHFARM_PROD_DB
  || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\josu_\\AppData\\Local', 'SouthFarm', 'data', 'southfarm.db');
const WS_ID = (() => {
  const flagIdx = process.argv.indexOf('--ws');
  return flagIdx >= 0 ? Number(process.argv[flagIdx + 1]) : 6;
})();
const KEEP = process.argv.includes('--keep');

const QA_EMAIL = 'qa-sandbox@test.local';
const QA_PASSWORD = 'southfarm-qa-123';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runNode(modulePath, args) {
  const res = spawnSync(process.execPath, [modulePath, ...args], { cwd: BACKEND_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`falló ${path.basename(modulePath)}:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const json = await res.json();
        if (json.uptime_seconds !== undefined) return json;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error('La API del sandbox no respondió health rico');
}

if (!KEEP || !fs.existsSync(DB_PATH)) {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_PATH + suffix); } catch {}
  }
  console.log(`[sandbox] Snapshot de ${PROD_DB} …`);
  runNode(path.join(BACKEND_ROOT, 'scripts', 'copy-db.mjs'), [PROD_DB, DB_PATH]);
} else {
  console.log('[sandbox] Reusando la copia existente (--keep).');
}

console.log(`[sandbox] Levantando API en ${BASE} (solo localhost, DB: ${DB_PATH})`);
const server = spawn(process.execPath, [path.join(BACKEND_ROOT, 'dist', 'index.js')], {
  env: {
    ...process.env,
    SOUTHFARM_DB_PATH: DB_PATH,
    PORT: String(PORT),
    SOUTHFARM_SCHEDULER_TICK_SECONDS: '3600',
    SOUTHFARM_PUBLICATION_MEDIA_ROOT: path.join(SANDBOX_DIR, 'publish-media'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => process.stdout.write('[api] ' + chunk));
server.stderr.on('data', (chunk) => process.stderr.write('[api!] ' + chunk));
server.on('exit', (code) => console.log(`[sandbox] API terminó con código ${code}`));

try {
  const health = await waitForHealth();
  console.log(`[sandbox] API arriba (uptime ${health.uptime_seconds}s, node ${health.node_version})`);

  // Usuario QA dentro de la COPIA: registro + membership owner al workspace real.
  let registerStatus = 0;
  try {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: QA_EMAIL, password: QA_PASSWORD, name: 'QA Sandbox' }),
    });
    registerStatus = res.status;
  } catch {}
  if (registerStatus === 201 || registerStatus === 409) {
    const fixScript = `
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(process.argv[2]).id;
      db.prepare("DELETE FROM workspace_members WHERE user_id = ? AND workspace_id != ?").run(userId, Number(process.argv[3]));
      db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')").run(Number(process.argv[3]), userId);
      const m = db.prepare('SELECT workspace_id, role FROM workspace_members WHERE user_id = ?').all(userId);
      console.log(JSON.stringify(m));
    `;
    const res = spawnSync(process.execPath, ['-e', fixScript, DB_PATH, QA_EMAIL, String(WS_ID)], { cwd: BACKEND_ROOT, encoding: 'utf8' });
    if (res.status !== 0) throw new Error('No pude reparar la membresía QA: ' + res.stderr);
    console.log(`[sandbox] Usuario QA listo, memberships: ${res.stdout.trim()}`);
  } else {
    throw new Error(`Registro QA inesperado: HTTP ${registerStatus}`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log(' SANDBOX LISTO — nada de esto toca producción');
  console.log('──────────────────────────────────────────────────────────');
  console.log(` API local : ${BASE}  (health: ${BASE}/api/health)`);
  console.log(` Webapp    : cd webapp && NEXT_PUBLIC_API_URL=${BASE} npm run dev`);
  console.log('            → abrir http://localhost:3000');
  console.log(` Login QA  : ${QA_EMAIL} / ${QA_PASSWORD}  (owner del workspace ${WS_ID})`);
  console.log(' Parar     : Ctrl+C acá (mata la API del sandbox)');
  console.log(' Reset     : borrá backend/data/sandbox/ o no pases --keep');
  console.log('──────────────────────────────────────────────────────────\n');
} catch (error) {
  console.error('[sandbox] ERROR:', error.message);
  server.kill();
  process.exit(1);
}

process.on('SIGINT', () => {
  console.log('\n[sandbox] Cortando API del sandbox…');
  server.kill();
  process.exit(0);
});
