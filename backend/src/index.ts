import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import https from 'https';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'southfarm-secret-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());

// DB
const dbPath = path.join(__dirname, '..', 'data', 'southfarm.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    android_version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER,
    task_type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    params TEXT,
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS warmup_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account TEXT,
    duration_minutes INTEGER DEFAULT 2,
    reels_viewed INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    elapsed_sec INTEGER DEFAULT 0,
    status TEXT DEFAULT 'completed',
    timestamp TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS ig_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER,
    username TEXT NOT NULL,
    profile_pic_url TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id),
    UNIQUE(user_id, device_id, username)
  );
`);;

// Auth middleware
function auth(req: any, res: any, next: any) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET) as { userId: number };
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Auth Routes ───
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').run(email, hash, name);
    const token = jwt.sign({ userId: r.lastInsertRowid }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: r.lastInsertRowid, email, name } });
  } catch (e: any) { e.message?.includes('UNIQUE') ? res.status(409).json({ error: 'Email ya registrado' }) : res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Credenciales inválidas' });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', auth, (req: any, res) => {
  const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(req.user.userId) as any;
  user ? res.json({ user }) : res.status(404).json({ error: 'User not found' });
});

// ─── Devices ───
app.post('/api/devices/register', auth, (req: any, res) => {
  const { device_id, device_name, android_version } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  // UPSERT: update name/version if device already exists for this user
  const existing = db.prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ? ORDER BY id DESC LIMIT 1').get(req.user.userId, device_id) as any;
  if (existing) {
    db.prepare('UPDATE devices SET device_name = ?, android_version = ? WHERE id = ?').run(device_name || null, android_version || null, existing.id);
    res.json({ device: { id: existing.id, device_id, device_name, android_version } });
  } else {
    const r = db.prepare('INSERT INTO devices (user_id, device_id, device_name, android_version) VALUES (?, ?, ?, ?)')
      .run(req.user.userId, device_id, device_name || null, android_version || null);
    res.status(201).json({ device: { id: r.lastInsertRowid, device_id, device_name, android_version } });
  }
});

app.get('/api/devices', auth, (req: any, res) => {
  const devices = db.prepare('SELECT * FROM devices WHERE user_id = ?').all(req.user.userId);
  res.json({ devices });
});

app.delete('/api/devices/:id', auth, (req: any, res) => {
  const r = db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(req.params.id, req.user.userId);
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Device not found' });
});

// ─── Tasks ───
app.get('/api/tasks', (_req, res) => {
  res.json({ tasks: [
    { id: 'warmup_ig', name: 'Warmup Instagram', description: 'Navega y simula actividad en IG' },
    { id: 'warmup_tiktok', name: 'Warmup TikTok', description: 'Navega y simula actividad en TikTok' },
    { id: 'publish_reel', name: 'Publicar Reel', description: 'Publica un video como reel' },
  ]});
});

app.post('/api/tasks/run', auth, (req: any, res) => {
  const { task_type, device_id, params } = req.body;
  if (!task_type) return res.status(400).json({ error: 'task_type required' });
  // Normalize account in params: strip leading @
  let normalizedParams = params;
  if (params && typeof params === 'object' && params.account) {
    normalizedParams = { ...params, account: params.account.replace(/^@+/, '') };
  }
  const r = db.prepare('INSERT INTO task_runs (user_id, device_id, task_type, params, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.userId, device_id || null, task_type, typeof normalizedParams === 'string' ? normalizedParams : (normalizedParams ? JSON.stringify(normalizedParams) : null), 'pending', new Date().toISOString());
  res.status(201).json({ task_run: { id: r.lastInsertRowid, task_type, status: 'pending' } });
});

app.get('/api/tasks/runs', auth, (req: any, res) => {
  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string) || 100;
  let runs;
  if (status) {
    runs = db.prepare('SELECT * FROM task_runs WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(req.user.userId, status, limit);
  } else {
    runs = db.prepare('SELECT * FROM task_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.userId, limit);
  }
  res.json({ runs });
});

app.get('/api/tasks/runs/:id', auth, (req: any, res) => {
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  run ? res.json({ run }) : res.status(404).json({ error: 'Run not found' });
});

// GET /api/tasks/active — active task for a device (app polling)
app.get('/api/tasks/active', auth, (req: any, res) => {
  const userId = req.user.userId;
  const { device_id } = req.query;
  let query = `SELECT tr.*, d.device_name, d.device_id as device_string FROM task_runs tr JOIN devices d ON tr.device_id = d.id WHERE tr.user_id = ? AND tr.status IN ('pending', 'running', 'paused')`;
  const params: any[] = [userId];
  if (device_id) { query += ' AND d.device_id = ?'; params.push(device_id as string); }
  query += ' ORDER BY tr.created_at DESC LIMIT 1';
  const run: any = db.prepare(query).get(...params);
  if (!run) return res.json({ active: false });
  res.json({
    active: true,
    task: { id: run.id, task_type: run.task_type, status: run.status, params: JSON.parse(run.params || '{}'), created_at: run.created_at, device_name: run.device_name }
  });
});

// PATCH /api/tasks/runs/:id/pause
app.patch('/api/tasks/runs/:id/pause', auth, (req: any, res) => {
  const run: any = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!run) return res.status(404).json({ error: 'No encontrada' });
  db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('paused', run.id);
  res.json({ ok: true, status: 'paused' });
});

// PATCH /api/tasks/runs/:id/resume
app.patch('/api/tasks/runs/:id/resume', auth, (req: any, res) => {
  const run: any = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!run) return res.status(404).json({ error: 'No encontrada' });
  db.prepare('UPDATE task_runs SET status = ? WHERE id = ?').run('running', run.id);
  res.json({ ok: true, status: 'running' });
});

// PATCH /api/tasks/runs/:id/stop
app.patch('/api/tasks/runs/:id/stop', auth, (req: any, res) => {
  const run: any = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  if (!run) return res.status(404).json({ error: 'No encontrada' });
  db.prepare('UPDATE task_runs SET status = ?, completed_at = ? WHERE id = ?').run('cancelled', new Date().toISOString(), run.id);
  res.json({ ok: true, status: 'cancelled' });
});

app.patch('/api/tasks/runs/:id', auth, (req: any, res) => {
  const { status, result } = req.body;
  const r = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId) as any;
  if (!r) return res.status(404).json({ error: 'Run not found' });
  const startedAt = status === 'running' ? new Date().toISOString() : r.started_at;
  const completedAt = status === 'completed' || status === 'error' ? new Date().toISOString() : r.completed_at;
  db.prepare('UPDATE task_runs SET status = ?, result = ?, started_at = ?, completed_at = ? WHERE id = ?')
    .run(status || r.status, result ? JSON.stringify(result) : r.result, startedAt, completedAt, req.params.id);
  res.json({ ok: true });
});

// ─── IG Accounts (per device) ───
// ─── Scrape IG profile pic ───
function fetchProfilePicUrl(username: string): Promise<string> {
  return new Promise((resolve) => {
    const url = `https://www.instagram.com/${username}/`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36' } }, (res) => {
      let html = '';
      res.on('data', (chunk: Buffer) => { html += chunk.toString(); });
      res.on('end', () => {
        const match = html.match(/og:image[^>]*content="([^"]+)"/);
        const picUrl = match ? match[1].replace(/&amp;/g, '&') : '';
        resolve(picUrl);
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

app.post('/api/ig-accounts', auth, async (req: any, res) => {
  const { device_id, usernames } = req.body;
  if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ error: 'usernames array required' });
  // Find numeric device ID from string device_id (use latest if duplicates)
  let numericDeviceId = device_id;
  if (typeof device_id === 'string') {
    const device = db.prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ? ORDER BY id DESC LIMIT 1').get(req.user.userId, device_id) as any;
    numericDeviceId = device ? device.id : null;
  }
  if (!numericDeviceId) return res.status(404).json({ error: 'Device not found' });
  // Replace all accounts for this user+device
  db.prepare('DELETE FROM ig_accounts WHERE user_id = ? AND device_id = ?').run(req.user.userId, numericDeviceId);
  const insert = db.prepare('INSERT OR IGNORE INTO ig_accounts (user_id, device_id, username, profile_pic_url) VALUES (?, ?, ?, ?)');
  // Scrape profile pics and insert
  for (const u of usernames) {
    let picUrl = '';
    try { picUrl = await fetchProfilePicUrl(u); } catch (_) {}
    insert.run(req.user.userId, numericDeviceId, u, picUrl);
  }
  res.status(201).json({ ok: true, count: usernames.length });
});

app.get('/api/ig-accounts', auth, (req: any, res) => {
  const deviceStrId = req.query.device_id as string;
  let accounts: any[];
  if (deviceStrId) {
    // Try as numeric device id first (from webapp), then as string device_id (from app)
    let numericId: any = parseInt(deviceStrId, 10);
    if (isNaN(numericId)) {
      const device = db.prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ? ORDER BY id DESC LIMIT 1').get(req.user.userId, deviceStrId) as any;
      numericId = device ? device.id : null;
    }
    if (numericId) {
      accounts = db.prepare('SELECT * FROM ig_accounts WHERE user_id = ? AND device_id = ? ORDER BY username').all(req.user.userId, numericId);
    } else {
      accounts = [];
    }
  } else {
    accounts = db.prepare('SELECT * FROM ig_accounts WHERE user_id = ? ORDER BY username').all(req.user.userId);
  }
  res.json({ accounts });
});

// ─── Warmup Sessions (from app) ───
app.post('/api/warmup-sessions', auth, (req: any, res) => {
  const { duration_minutes, reels_viewed, likes, saves, elapsed_sec, status, timestamp } = req.body;
  let account = req.body.account;
  if (!account) return res.status(400).json({ error: 'account required' });
  account = account.replace(/^@+/, ''); // normalize: strip leading @
  const r = db.prepare(`
    INSERT INTO task_runs (user_id, task_type, status, params, result, created_at, completed_at)
    VALUES (?, 'warmup_ig', ?, ?, ?, ?, ?)
  `).run(
    req.user.userId,
    status || 'completed',
    JSON.stringify({ account, duration_minutes }),
    JSON.stringify({ reels_viewed, likes, saves, elapsed_sec }),
    timestamp || new Date().toISOString(),
    new Date().toISOString()
  );
  res.status(201).json({ ok: true, id: r.lastInsertRowid });
});

app.get('/api/warmup-sessions', auth, (req: any, res) => {
  const runs = db.prepare(`
    SELECT * FROM task_runs 
    WHERE user_id = ? AND task_type = 'warmup_ig' 
    ORDER BY id DESC LIMIT 100
  `).all(req.user.userId);
  res.json({ sessions: runs.map((r: any) => {
    const params = JSON.parse(r.params || '{}');
    const result = JSON.parse(r.result || '{}');
    // Normalize account: strip leading @ for consistent storage
    if (params.account && params.account.startsWith('@')) {
      params.account = params.account.replace(/^@+/, '');
    }
    return {
      id: r.id,
      ...params,
      ...result,
      status: r.status,
      timestamp: r.created_at,
    };
  })});
});

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`🚀 SouthFarm API on :${PORT}`));
