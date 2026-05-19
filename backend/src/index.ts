import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
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
app.use(cors({
  origin: ['https://southfarm.tech', 'https://www.southfarm.tech', 'http://localhost:3000', 'http://localhost:3001'],
}));
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
`);

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
  const r = db.prepare('INSERT INTO devices (user_id, device_id, device_name, android_version) VALUES (?, ?, ?, ?)')
    .run(req.user.userId, device_id, device_name || null, android_version || null);
  res.status(201).json({ device: { id: r.lastInsertRowid, device_id, device_name, android_version } });
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
  const r = db.prepare('INSERT INTO task_runs (user_id, device_id, task_type, params) VALUES (?, ?, ?, ?)')
    .run(req.user.userId, device_id || null, task_type, params ? JSON.stringify(params) : null);
  res.status(201).json({ task_run: { id: r.lastInsertRowid, task_type, status: 'pending' } });
});

app.get('/api/tasks/runs', auth, (req: any, res) => {
  const runs = db.prepare('SELECT * FROM task_runs WHERE user_id = ? ORDER BY created_at DESC').all(req.user.userId);
  res.json({ runs });
});

app.get('/api/tasks/runs/:id', auth, (req: any, res) => {
  const run = db.prepare('SELECT * FROM task_runs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.userId);
  run ? res.json({ run }) : res.status(404).json({ error: 'Run not found' });
});

// Health
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => console.log(`🚀 SouthFarm API on :${PORT}`));
