import BetterSqlite3 from 'better-sqlite3';
const Database = BetterSqlite3;
import path from 'path';
const DB_PATH = path.join(__dirname, '..', 'data', 'southfarm.db');
const db = new Database(DB_PATH);
// Enable WAL mode for better concurrent reads
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// Create tables
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
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS task_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    params_schema TEXT
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,
    task_type TEXT NOT NULL,
    params TEXT DEFAULT '{}',
    status TEXT DEFAULT 'pending',
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  -- Seed task templates
  INSERT OR IGNORE INTO task_templates (task_type, name, description) VALUES
    ('warmup_ig', 'Warmup Instagram', 'Warmup de cuenta de Instagram: scroll, likes, explorar'),
    ('warmup_tiktok', 'Warmup TikTok', 'Warmup de cuenta de TikTok: scroll, likes, explorar'),
    ('publish_reel', 'Publicar Reel', 'Publicar un reel/video en Instagram o TikTok');
`);
export default db;
