import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = 3317;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'southfarm-auth-'));
const dbPath = path.join(tempDir, 'southfarm.db');
const backendNodePath = process.env.SOUTHFARM_TEST_NODE_PATH || process.execPath;
const backend = spawn(backendNodePath, [path.resolve('dist/index.js')], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    SOUTHFARM_DB_PATH: dbPath,
    SOUTHFARM_JWT_SECRET: 'test-only-southfarm-secret',
    SOUTHFARM_AUTO_PLANNER_ENABLED: 'false',
    SOUTHFARM_ACCESS_TOKEN_TTL: '15m',
    SOUTHFARM_REFRESH_TOKEN_DAYS: '90',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
backend.stdout.on('data', (chunk) => { output += chunk.toString(); });
backend.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/api/health`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend did not become healthy.\n${output}`);
}

async function request(pathname, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

try {
  await waitForHealth();

  const registered = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `refresh-${Date.now()}@example.test`,
      password: 'test-password-123',
      name: 'Refresh Test',
    }),
  });
  assert.equal(registered.response.status, 201);
  assert.equal(typeof registered.body.token, 'string');
  assert.equal(typeof registered.body.refresh_token, 'string');

  const firstRefresh = registered.body.refresh_token;
  const me = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${registered.body.token}` },
  });
  assert.equal(me.response.status, 200);

  const rotated = await request('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: firstRefresh }),
  });
  assert.equal(rotated.response.status, 200);
  assert.notEqual(rotated.body.refresh_token, firstRefresh);

  const replay = await request('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: firstRefresh }),
  });
  assert.equal(replay.response.status, 401);

  const familyRevoked = await request('/api/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: rotated.body.refresh_token }),
  });
  assert.equal(familyRevoked.response.status, 401);

  console.log('refresh-auth test passed: issue, refresh, rotation, replay revocation');
} finally {
  if (backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        backend.kill('SIGKILL');
        resolve();
      }, 5000);
      backend.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
