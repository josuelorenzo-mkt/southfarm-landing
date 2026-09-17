import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import { existsSync, statSync } from 'fs';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { applyAuthMigrations, cleanupRefreshSessions } from './auth-migrations.js';
import { applySchedulerMigrations } from './scheduler-migrations.js';
import { applyPublicationMigrations } from './publications-migrations.js';
import { PublicationStore } from './publications-domain.js';
import { registerPublicationRoutes } from './publications-routes.js';
import { registerPublicationWorkerRoutes } from './publication-worker-routes.js';
import { ensureAvatarStored, fetchInstagramProfilePicUrl, registerAvatarRoutes } from './avatars.js';
import { applyClusterMigrations } from './cluster-migrations.js';
import { registerActivityPlanner, runActivityPlannerStartup } from './activity-planner.js';
import { signSouthFarmJwt, verifySouthFarmJwt, JWT_SECRET } from './jwt-config.js';
import { BUENOS_AIRES_TIMEZONE, DAILY_MAX_WARMUP_SECONDS, DAILY_MIN_WARMUP_SECONDS, DEFAULT_FIXED_WARMUP_SECONDS, chooseDailyTargetSeconds, chooseSessionCount, expiresAtIso, isTaskExpired, isTaskOverdue, localDateTimeToIso, overdueAtIso, splitWarmupDurationSeconds, } from './scheduler.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3001;
const PUBLICATION_MEDIA_ROOT = path.resolve(String(process.env.SOUTHFARM_PUBLICATION_MEDIA_ROOT || path.join(process.env.ProgramData || 'C:\\ProgramData', 'SouthFarm', 'publish-media')));
const APP_APK_PATH = path.resolve(String(process.env.SOUTHFARM_APP_APK_PATH || path.join(process.env.ProgramData || 'C:\\ProgramData', 'SouthFarm', 'app', 'southfarm.apk')));
const APP_LINK_TTL_SECONDS = Math.min(3600, Math.max(60, Number(process.env.SOUTHFARM_APP_LINK_TTL_SECONDS || 900)));
const PUBLISHER_WORKER_TOKEN = String(process.env.SOUTHFARM_PUBLISHER_WORKER_TOKEN || '').trim();
const PUBLISHER_WORKER_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.SOUTHFARM_PUBLISHER_WORKER_ENABLED || 'false'));
if (PUBLISHER_WORKER_ENABLED && !PUBLISHER_WORKER_TOKEN) {
    throw new Error('SOUTHFARM_PUBLISHER_WORKER_TOKEN is required when the publisher worker is enabled');
}
const PUBLISHER_WORKER_TOKEN_HASH = PUBLISHER_WORKER_TOKEN
    ? createHash('sha256').update(PUBLISHER_WORKER_TOKEN).digest()
    : null;
const TASK_LEASE_SECONDS = Math.max(30, Number(process.env.SOUTHFARM_TASK_LEASE_SECONDS || 45));
const LEGACY_WARMUP_DEDUPE_WINDOW_MS = Math.max(60000, Number(process.env.SOUTHFARM_LEGACY_WARMUP_DEDUPE_WINDOW_MS || 10 * 60 * 1000));
const DEVICE_ONLINE_WINDOW_SECONDS = Math.max(30, Number(process.env.SOUTHFARM_DEVICE_ONLINE_WINDOW_SECONDS || 90));
const DEVICE_PAIRING_WINDOW_MINUTES = Math.min(60, Math.max(2, Number(process.env.SOUTHFARM_DEVICE_PAIRING_WINDOW_MINUTES || 10)));
const SCHEDULER_MODE = process.env.SOUTHFARM_SCHEDULER_MODE === 'random' ? 'random' : 'fixed';
const FIXED_WARMUP_SECONDS = Math.min(DAILY_MAX_WARMUP_SECONDS, Math.max(DAILY_MIN_WARMUP_SECONDS, Number(process.env.SOUTHFARM_FIXED_WARMUP_SECONDS || DEFAULT_FIXED_WARMUP_SECONDS)));
const AUTO_PLANNER_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.SOUTHFARM_AUTO_PLANNER_ENABLED || 'false'));
const AUTO_PLANNER_TICK_MS = Math.max(15000, Number(process.env.SOUTHFARM_AUTO_PLANNER_TICK_SECONDS || 60) * 1000);
const AUTO_PLANNER_WORKSPACE_ID = Math.max(0, Number(process.env.SOUTHFARM_AUTO_PLANNER_WORKSPACE_ID || 0));
const REFRESH_TOKEN_DAYS = Math.min(3650, Math.max(7, Number(process.env.SOUTHFARM_REFRESH_TOKEN_DAYS || 90)));
const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000;
const SUPPORTED_TASK_TYPES = new Set([
    'warmup_ig',
    'warmup_tiktok',
    'warmup_youtube',
    'publish_reel',
    'scan_instagram',
    'scan_tiktok',
    'scan_youtube',
]);
// FIX 1 [CRÍTICO] — Task types the Android accessibility service can actually
// execute (SouthFarmAccessibilityService.kt handles exactly these 6). The
// claim endpoint only hands out these types: anything else (currently
// publish_reel, which requires the web panel to upload the video first, and
// any future type) stays pending/overdue in the queue instead of entering the
// claim → silent discard → lease-expire → re-claim loop that inflated
// attempt_count and left phantom "running" tasks.
export const EXECUTABLE_TASK_TYPES = [
    'warmup_ig',
    'warmup_tiktok',
    'warmup_youtube',
    'scan_instagram',
    'scan_tiktok',
    'scan_youtube',
];
const EXTRA_EXECUTABLE_TASK_TYPES_ENV = 'SOUTHFARM_EXTRA_EXECUTABLE_TYPES';
/**
 * Task types the claim endpoint may hand out: the base EXECUTABLE_TASK_TYPES
 * plus any extra types enabled at runtime via SOUTHFARM_EXTRA_EXECUTABLE_TYPES
 * (comma-separated, trimmed, empty entries dropped, deduplicated against the
 * base). The env var is read on every call, so a process restart with a new
 * value takes effect without code changes. This is how new types (currently
 * publish_reel, which the Android app cannot execute yet) are staged on STAGING
 * while production keeps the base list.
 */
export function executableTaskTypes() {
    const extra = String(process.env[EXTRA_EXECUTABLE_TASK_TYPES_ENV] || '')
        .split(',')
        .map((type) => type.trim())
        .filter((type) => type.length > 0);
    const seen = new Set(EXECUTABLE_TASK_TYPES);
    const merged = [...EXECUTABLE_TASK_TYPES];
    for (const type of extra) {
        if (!seen.has(type)) {
            seen.add(type);
            merged.push(type);
        }
    }
    return merged;
}
const configuredExtraExecutableTaskTypes = executableTaskTypes();
if (configuredExtraExecutableTaskTypes.length > EXECUTABLE_TASK_TYPES.length) {
    console.log(`[Config] Extra executable task types: ${configuredExtraExecutableTaskTypes.slice(EXECUTABLE_TASK_TYPES.length).join(', ')}`);
}
// Middleware
app.use(cors());
app.use(express.json());
// DB
const configuredDbPath = String(process.env.SOUTHFARM_DB_PATH || '').trim();
const dbPath = configuredDbPath
    ? path.resolve(configuredDbPath)
    : path.join(__dirname, '..', 'data', 'southfarm.db');
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
  CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS workspace_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    status TEXT NOT NULL DEFAULT 'active',
    invited_by_user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id),
    UNIQUE (workspace_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    invited_by_user_id INTEGER NOT NULL,
    accepted_by_user_id INTEGER,
    accepted_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id),
    FOREIGN KEY (accepted_by_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS device_pairings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    created_by_user_id INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    access_key_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by_user_id INTEGER,
    consumed_device_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (created_by_user_id) REFERENCES users(id),
    FOREIGN KEY (consumed_by_user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    device_name TEXT,
    device_alias TEXT,
    android_version TEXT,
    app_version TEXT,
    last_seen_at TEXT,
    workspace_id INTEGER,
    installation_id TEXT,
    lifecycle_status TEXT DEFAULT 'enrolled',
    paired_at TEXT,
    revoked_at TEXT,
    last_auth_at TEXT,
    device_token_hash TEXT,
    agent_token_version INTEGER NOT NULL DEFAULT 1,
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
    updated_at TEXT,
    claim_token TEXT,
    claimed_at TEXT,
    lease_expires_at TEXT,
    last_heartbeat_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );

  CREATE TABLE IF NOT EXISTS warmup_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER,
    task_run_id INTEGER,
    account TEXT,
    platform TEXT DEFAULT 'instagram',
    duration_minutes INTEGER DEFAULT 2,
    reels_viewed INTEGER DEFAULT 0,
    videos_viewed INTEGER DEFAULT 0,
    shorts_viewed INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    saves INTEGER DEFAULT 0,
    elapsed_sec INTEGER DEFAULT 0,
    status TEXT DEFAULT 'completed',
    timestamp TEXT,
    metadata TEXT,
    updated_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id),
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id)
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
  CREATE TABLE IF NOT EXISTS social_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    profile_pic_url TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    source_account_name TEXT DEFAULT '',
    source_account_email TEXT DEFAULT '',
    byline TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id),
    UNIQUE(user_id, device_id, platform, username)
  );

  CREATE TABLE IF NOT EXISTS scan_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    device_id INTEGER,
    task_run_id INTEGER,
    platform TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    accounts_found INTEGER DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (device_id) REFERENCES devices(id)
  );
`);
;
// Existing installations already have social_accounts without the YouTube
// metadata columns. CREATE TABLE IF NOT EXISTS does not alter those tables,
// so apply the additive migration at startup as well.
const socialAccountColumns = new Set(db.prepare('PRAGMA table_info(social_accounts)').all()
    .map((column) => column.name));
for (const [name, type] of [
    ['display_name', 'TEXT DEFAULT \'\''],
    ['source_account_name', 'TEXT DEFAULT \'\''],
    ['source_account_email', 'TEXT DEFAULT \'\''],
    ['byline', 'TEXT DEFAULT \'\''],
]) {
    if (!socialAccountColumns.has(name)) {
        db.exec(`ALTER TABLE social_accounts ADD COLUMN ${name} ${type}`);
    }
}
const warmupSessionColumns = new Set(db.prepare('PRAGMA table_info(warmup_sessions)').all()
    .map((column) => column.name));
for (const [name, type] of [
    ['device_id', 'INTEGER'],
    ['task_run_id', 'INTEGER'],
    ['platform', "TEXT DEFAULT 'instagram'"],
    ['videos_viewed', 'INTEGER DEFAULT 0'],
    ['shorts_viewed', 'INTEGER DEFAULT 0'],
    ['metadata', 'TEXT'],
    ['updated_at', 'TEXT'],
]) {
    if (!warmupSessionColumns.has(name)) {
        db.exec(`ALTER TABLE warmup_sessions ADD COLUMN ${name} ${type}`);
    }
}
const scanSessionColumns = new Set(db.prepare('PRAGMA table_info(scan_sessions)').all()
    .map((column) => column.name));
if (!scanSessionColumns.has('task_run_id')) {
    db.exec('ALTER TABLE scan_sessions ADD COLUMN task_run_id INTEGER');
}
const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all()
    .map((column) => column.name));
for (const [name, type] of [
    ['device_alias', 'TEXT'],
    ['app_version', 'TEXT'],
    ['last_seen_at', 'TEXT'],
    ['workspace_id', 'INTEGER'],
    ['installation_id', 'TEXT'],
    ['lifecycle_status', "TEXT DEFAULT 'enrolled'"],
    ['paired_at', 'TEXT'],
    ['revoked_at', 'TEXT'],
    ['last_auth_at', 'TEXT'],
    ['device_token_hash', 'TEXT'],
    ['agent_token_version', 'INTEGER NOT NULL DEFAULT 1'],
]) {
    if (!deviceColumns.has(name)) {
        db.exec(`ALTER TABLE devices ADD COLUMN ${name} ${type}`);
    }
}
// Ciclo de vida explícito de un dispositivo:
//   pending  → reservado, aún sin enrolamiento completo (Fase 2)
//   enrolled → vinculado y autorizado al workspace
//   revoked  → desvinculado; solo claim vuelve a enrolar
// 'active' era el valor legado de enrolled: se normaliza (idempotente).
db.exec(`
  UPDATE devices
  SET lifecycle_status = 'enrolled'
  WHERE lifecycle_status IS NULL
     OR TRIM(lifecycle_status) = ''
     OR lifecycle_status = 'active'
`);
const workspaceColumns = new Set(db.prepare('PRAGMA table_info(workspaces)').all()
    .map((column) => column.name));
if (!workspaceColumns.has('bridge_url')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN bridge_url TEXT');
}
if (!workspaceColumns.has('strict_bridge_mode')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN strict_bridge_mode INTEGER NOT NULL DEFAULT 0');
}
// ─── Screen streaming (Fase 2): registro de bridges, attachments y sesiones ───
db.exec(`
  CREATE TABLE IF NOT EXISTS screen_bridges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    public_url TEXT,
    last_seen_at TEXT,
    version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );
  CREATE TABLE IF NOT EXISTS bridge_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bridge_id INTEGER NOT NULL,
    adb_serial TEXT NOT NULL,
    device_id INTEGER,
    status TEXT NOT NULL DEFAULT 'unassigned',
    last_seen_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bridge_id) REFERENCES screen_bridges(id),
    FOREIGN KEY (device_id) REFERENCES devices(id),
    UNIQUE (bridge_id, adb_serial)
  );
  CREATE TABLE IF NOT EXISTS screen_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    device_id INTEGER NOT NULL,
    bridge_id INTEGER NOT NULL,
    adb_serial TEXT,
    nonce TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    expires_at TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
    FOREIGN KEY (device_id) REFERENCES devices(id),
    FOREIGN KEY (bridge_id) REFERENCES screen_bridges(id)
  );
  CREATE INDEX IF NOT EXISTS idx_screen_bridges_workspace ON screen_bridges(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_bridge_attachments_bridge ON bridge_attachments(bridge_id, adb_serial);
  CREATE INDEX IF NOT EXISTS idx_bridge_attachments_device ON bridge_attachments(device_id);
  CREATE INDEX IF NOT EXISTS idx_screen_sessions_device ON screen_sessions(device_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_screen_sessions_nonce ON screen_sessions(nonce);
`);
// Migración aditiva para bases ya creadas con la versión previa de Fase 2.
const screenBridgeColumns = new Set(db.prepare('PRAGMA table_info(screen_bridges)').all()
    .map((column) => column.name));
if (!screenBridgeColumns.has('public_url')) {
    db.exec('ALTER TABLE screen_bridges ADD COLUMN public_url TEXT');
}
// ─── Fase 5: reconciliación y alertas ───
db.exec(`
  CREATE TABLE IF NOT EXISTS reconciliation_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warn',
    device_id INTEGER,
    bridge_id INTEGER,
    adb_serial TEXT,
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
  );
  CREATE INDEX IF NOT EXISTS idx_recon_alerts_workspace ON reconciliation_alerts(workspace_id, status);
  CREATE INDEX IF NOT EXISTS idx_recon_alerts_key ON reconciliation_alerts(workspace_id, kind, device_id, adb_serial);
`);
// Contador de fallos de autenticación reportados por cada bridge (heartbeat).
const screenBridgeAuditColumns = new Set(db.prepare('PRAGMA table_info(screen_bridges)').all()
    .map((column) => column.name));
if (!screenBridgeAuditColumns.has('auth_failures')) {
    db.exec('ALTER TABLE screen_bridges ADD COLUMN auth_failures INTEGER NOT NULL DEFAULT 0');
}
const taskRunColumns = new Set(db.prepare('PRAGMA table_info(task_runs)').all()
    .map((column) => column.name));
for (const [name, type] of [
    ['updated_at', 'TEXT'],
    ['claim_token', 'TEXT'],
    ['claimed_at', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['last_heartbeat_at', 'TEXT'],
]) {
    if (!taskRunColumns.has(name)) {
        db.exec(`ALTER TABLE task_runs ADD COLUMN ${name} ${type}`);
    }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_devices_user_device ON devices(user_id, device_id);
  CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(user_id, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_devices_workspace_status ON devices(workspace_id, lifecycle_status, last_seen_at);
  CREATE INDEX IF NOT EXISTS idx_devices_installation ON devices(workspace_id, installation_id);
  CREATE INDEX IF NOT EXISTS idx_device_pairings_workspace ON device_pairings(workspace_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_device_pairings_expiry ON device_pairings(expires_at, consumed_at);
  CREATE INDEX IF NOT EXISTS idx_task_runs_device_status_created ON task_runs(device_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_task_runs_lease ON task_runs(device_id, status, lease_expires_at);
  CREATE INDEX IF NOT EXISTS idx_warmup_sessions_user_time ON warmup_sessions(user_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_warmup_sessions_platform ON warmup_sessions(user_id, platform, timestamp);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_warmup_sessions_task_run ON warmup_sessions(task_run_id) WHERE task_run_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_scan_sessions_user_time ON scan_sessions(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_scan_sessions_platform ON scan_sessions(user_id, platform, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_sessions_task_run ON scan_sessions(task_run_id) WHERE task_run_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id, status);
  CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites(workspace_id, created_at);
`);
applySchedulerMigrations(db);
applyAuthMigrations(db);
applyPublicationMigrations(db);
applyClusterMigrations(db);
cleanupRefreshSessions(db, new Date().toISOString());
const publicationStore = new PublicationStore(db);
function nowIso() {
    return new Date().toISOString();
}
function stringValue(value) {
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    const normalized = String(value).trim();
    return normalized || null;
}
function normalizeDeviceAlias(value) {
    if (value === null || value === undefined)
        return null;
    const normalized = stringValue(value);
    if (!normalized)
        return null;
    if (Array.from(normalized).length > 40) {
        throw new Error('Device alias must be 40 characters or fewer');
    }
    return normalized;
}
function deviceIsOnline(lastSeenAt) {
    if (typeof lastSeenAt !== 'string')
        return false;
    const timestamp = Date.parse(lastSeenAt);
    return Number.isFinite(timestamp)
        && Date.now() - timestamp <= DEVICE_ONLINE_WINDOW_SECONDS * 1000;
}
function activeTaskForDevice(deviceId) {
    const now = nowIso();
    return db.prepare(`
    SELECT id, task_type, status, params, created_at, started_at, lease_expires_at
    FROM task_runs
    WHERE device_id = ?
      AND (
        (
          status IN ('running', 'paused')
          AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
        OR (
          status IN ('pending', 'overdue')
          AND (scheduled_for IS NULL OR scheduled_for <= ?)
          AND (expires_at IS NULL OR expires_at > ?)
        )
      )
    ORDER BY CASE WHEN status IN ('running', 'paused') THEN 0 ELSE 1 END,
      updated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `).get(deviceId, now, now, now) || null;
}
function deviceView(device) {
    const online = deviceIsOnline(device.last_seen_at);
    const currentTask = Number.isInteger(Number(device.id))
        ? activeTaskForDevice(Number(device.id))
        : null;
    // Enrolamiento normalizado: 'active' (legado) se reporta como 'enrolled'.
    const enrollmentStatus = device.lifecycle_status === 'revoked'
        ? 'revoked'
        : device.lifecycle_status === 'pending'
            ? 'pending'
            : 'enrolled';
    const view = {
        ...device,
        alias: device.device_alias || null,
        display_name: device.device_alias || device.device_name || 'Android device',
        online,
        device_status: enrollmentStatus,
        connection_status: online ? 'online' : device.last_seen_at ? 'offline' : 'never_seen',
        // Señales separadas (cada una con su fuente de verdad y timestamp):
        // enrollment lo controla la API; agent es el heartbeat autenticado del
        // teléfono. attachment (USB) y screen (sesión) se suman en la Fase 2.
        enrollment: {
            status: enrollmentStatus,
            paired_at: device.paired_at || null,
            revoked_at: device.revoked_at || null,
        },
        agent: {
            last_seen_at: device.last_seen_at || null,
            last_auth_at: device.last_auth_at || null,
            online,
            app_version: device.app_version || null,
        },
        // Señal USB: el attachment vigente en algún bridge registrado del workspace.
        attachment: (() => {
            const att = db.prepare(`
        SELECT ba.adb_serial, ba.last_seen_at, sb.id AS bridge_id, sb.name AS bridge_name
        FROM bridge_attachments ba
        JOIN screen_bridges sb ON sb.id = ba.bridge_id
        WHERE ba.device_id = ? AND sb.workspace_id = ?
        ORDER BY ba.last_seen_at DESC LIMIT 1
      `).get(device.id, device.workspace_id);
            return att ? {
                bridge_id: att.bridge_id,
                bridge_name: att.bridge_name,
                adb_serial: att.adb_serial,
                last_seen_at: att.last_seen_at || null,
            } : null;
        })(),
        // Señal pantalla: sesión de visualización activa (requested/live) si la hay.
        screen: (() => {
            const session = db.prepare(`
        SELECT id, status, created_at FROM screen_sessions
        WHERE device_id = ? AND status IN ('requested', 'live')
        ORDER BY id DESC LIMIT 1
      `).get(device.id);
            return session ? {
                session_id: session.id,
                status: session.status,
                created_at: session.created_at,
            } : null;
        })(),
        current_task: currentTask ? {
            id: currentTask.id,
            task_type: currentTask.task_type,
            status: currentTask.status,
            params: parseParams(currentTask.params),
            created_at: currentTask.created_at,
            started_at: currentTask.started_at,
            lease_expires_at: currentTask.lease_expires_at,
        } : null,
    };
    delete view.device_token_hash;
    return view;
}
function workspaceIdForUser(userId) {
    const membership = workspaceMembership(userId);
    return membership ? Number(membership.workspace_id) : null;
}
function deviceNotPairedError() {
    const error = new Error('Device is not paired with this workspace');
    error.code = 'DEVICE_NOT_PAIRED';
    return error;
}
function deviceInstallationId(payload) {
    return stringValue(payload.installation_id) || stringValue(payload.device_id);
}
function findDeviceForUser(userId, rawDeviceId, preferStableId = false, rawInstallationId) {
    const deviceValue = stringValue(rawDeviceId);
    const installationId = stringValue(rawInstallationId);
    const workspaceId = workspaceIdForUser(userId);
    let device = null;
    if (workspaceId && installationId) {
        device = db.prepare(`
      SELECT * FROM devices
      WHERE workspace_id = ? AND installation_id = ? AND lifecycle_status != 'revoked'
      ORDER BY id DESC LIMIT 1
    `).get(workspaceId, installationId);
    }
    // A real Android ID can begin with digits. Resolve the stable ID first so
    // that a value such as "123abc" or even "123" cannot accidentally target
    // another database row when it is sent by the phone.
    if (!device && deviceValue && !installationId) {
        device = db.prepare(`
      SELECT * FROM devices
      WHERE user_id = ? AND device_id = ? AND lifecycle_status != 'revoked'
      ORDER BY id DESC LIMIT 1
    `).get(userId, deviceValue);
    }
    if (!device && !preferStableId && deviceValue && /^\d+$/.test(deviceValue)) {
        device = db.prepare(`
      SELECT * FROM devices
      WHERE user_id = ? AND id = ? AND lifecycle_status != 'revoked'
      ORDER BY id DESC LIMIT 1
    `).get(userId, Number(deviceValue));
    }
    return device || null;
}
function findDeviceFromPayload(userId, payload) {
    return findDeviceForUser(userId, payload.device_id, true, payload.installation_id);
}
function touchDevice(userId, payload, options = {}) {
    const mode = options.mode ?? (options.allowCreate ? 'enroll' : 'register');
    const stableDeviceId = stringValue(payload.device_id);
    if (!stableDeviceId)
        throw new Error('device_id required');
    const installationId = deviceInstallationId(payload);
    if (!installationId)
        throw new Error('installation_id required');
    const deviceName = stringValue(payload.device_name);
    const androidVersion = stringValue(payload.android_version);
    const appVersion = stringValue(payload.app_version);
    const seenAt = nowIso();
    const workspaceId = workspaceIdForUser(userId);
    if (!workspaceId)
        throw new Error('User is not assigned to a workspace');
    const existing = findDeviceFromPayload(userId, payload);
    if (existing) {
        if (mode === 'presence') {
            // Heartbeat: refresco de presencia únicamente. La identidad
            // (device_id/installation_id/workspace) y el ciclo de vida NO se tocan:
            // ni re-vincular ni reactivar live aquí, eso solo ocurre en claim.
            db.prepare(`
        UPDATE devices
        SET device_name = COALESCE(?, device_name),
            android_version = COALESCE(?, android_version),
            app_version = COALESCE(?, app_version),
            last_seen_at = ?, last_auth_at = ?
        WHERE id = ?
      `).run(deviceName, androidVersion, appVersion, seenAt, seenAt, existing.id);
        }
        else if (mode === 'enroll') {
            // Re-claim de una instalación existente: (re)enrola explícitamente.
            db.prepare(`
        UPDATE devices
        SET device_name = COALESCE(?, device_name),
            android_version = COALESCE(?, android_version),
            app_version = COALESCE(?, app_version),
            device_id = ?, installation_id = ?, workspace_id = ?,
            lifecycle_status = 'enrolled', revoked_at = NULL, paired_at = ?,
            last_seen_at = ?, last_auth_at = ?
        WHERE id = ?
      `).run(deviceName, androidVersion, appVersion, stableDeviceId, installationId, workspaceId, seenAt, seenAt, seenAt, existing.id);
        }
        else {
            // register: refresca identidad reportada por el teléfono, sin tocar
            // lifecycle ni tokens (la rotación vive únicamente en claim).
            db.prepare(`
        UPDATE devices
        SET device_name = COALESCE(?, device_name),
            android_version = COALESCE(?, android_version),
            app_version = COALESCE(?, app_version),
            device_id = ?, installation_id = ?, workspace_id = ?,
            last_seen_at = ?, last_auth_at = ?
        WHERE id = ?
      `).run(deviceName, androidVersion, appVersion, stableDeviceId, installationId, workspaceId, seenAt, seenAt, existing.id);
        }
    }
    else if (options.allowCreate) {
        db.prepare(`
      INSERT INTO devices
        (user_id, workspace_id, device_id, installation_id, device_name,
         android_version, app_version, lifecycle_status, paired_at,
         last_seen_at, last_auth_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'enrolled', ?, ?, ?)
    `).run(userId, workspaceId, stableDeviceId, installationId, deviceName, androidVersion, appVersion, seenAt, seenAt, seenAt);
    }
    else {
        throw deviceNotPairedError();
    }
    return db.prepare('SELECT * FROM devices WHERE workspace_id = ? AND installation_id = ? ORDER BY id DESC LIMIT 1')
        .get(workspaceId, installationId);
}
function issueDeviceToken(deviceId, options = {}) {
    // El token embebe la versión del agente: subir agent_token_version invalida
    // de golpe todos los tokens emitidos para la versión anterior, aun cuando el
    // hash en DB se restaurara de un backup. La rotación de versión se hace en
    // claim (re-enrolamiento) y al revocar.
    const device = db.prepare('SELECT agent_token_version FROM devices WHERE id = ?').get(deviceId);
    const nextVersion = Number(device?.agent_token_version || 1) + (options.rotateVersion ? 1 : 0);
    const rawToken = `sfd_v${nextVersion}_${randomBytes(32).toString('base64url')}`;
    db.prepare(`
    UPDATE devices
    SET device_token_hash = ?, agent_token_version = ?, last_auth_at = ?
    WHERE id = ?
  `).run(hashInviteToken(rawToken), nextVersion, nowIso(), deviceId);
    return rawToken;
}
function taskLeaseExpiresAt() {
    return new Date(Date.now() + TASK_LEASE_SECONDS * 1000).toISOString();
}
function parseParams(raw) {
    if (raw && typeof raw === 'object')
        return raw;
    if (typeof raw !== 'string' || !raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
const SOCIAL_PLATFORMS = ['instagram', 'tiktok', 'youtube'];
function normalizePlatform(value, fallback = 'instagram') {
    const platform = String(value || '').toLowerCase();
    return SOCIAL_PLATFORMS.includes(platform)
        ? platform
        : fallback;
}
function platformForWarmupTask(taskType) {
    switch (taskType) {
        case 'warmup_tiktok': return 'tiktok';
        case 'warmup_youtube': return 'youtube';
        default: return 'instagram';
    }
}
function numberValue(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}
function jsonValue(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return null;
    }
}
function accountKeyFor(userId, deviceId, platformValue, accountValue) {
    const account = stringValue(accountValue)?.replace(/^@+/, '').toLowerCase();
    if (!account)
        return null;
    const platform = normalizePlatform(platformValue);
    return [
        Number(userId),
        deviceId === null || deviceId === undefined ? '' : Number(deviceId),
        platform,
        account,
    ].join(':');
}
function taskAccountKey(task) {
    const params = parseParams(task?.params);
    const result = parseParams(task?.result);
    return stringValue(task?.account_key)
        || accountKeyFor(Number(task?.user_id), task?.device_id === null || task?.device_id === undefined ? null : Number(task.device_id), task?.platform || result.platform || params.platform || platformForWarmupTask(task?.task_type), task?.account || result.account || params.account);
}
function taskWorkspaceId(task) {
    const direct = Number(task?.workspace_id);
    if (Number.isInteger(direct) && direct > 0)
        return direct;
    const deviceId = Number(task?.device_id);
    if (Number.isInteger(deviceId) && deviceId > 0) {
        const device = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId);
        const workspaceId = Number(device?.workspace_id);
        if (Number.isInteger(workspaceId) && workspaceId > 0)
            return workspaceId;
    }
    const userId = Number(task?.user_id);
    return Number.isInteger(userId) && userId > 0 ? workspaceIdForUser(userId) : null;
}
function recordTaskEvent(task, eventType, payload = {}) {
    const userId = Number(task?.user_id);
    if (!Number.isInteger(userId) || userId <= 0)
        return;
    db.prepare(`
    INSERT INTO task_events
      (workspace_id, user_id, device_id, task_run_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(taskWorkspaceId(task), userId, task?.device_id ?? null, task?.id ?? null, eventType, jsonValue(payload), nowIso());
}
function createTaskNotification(task, type, severity, title, message, payload = {}) {
    const workspaceId = taskWorkspaceId(task);
    const userId = Number(task?.user_id);
    if (!workspaceId || !Number.isInteger(userId) || userId <= 0)
        return;
    db.prepare(`
    INSERT INTO notifications
      (workspace_id, user_id, type, severity, title, message,
       entity_type, entity_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'task_run', ?, ?, ?)
  `).run(workspaceId, userId, type, severity, title, message, task?.id ?? null, jsonValue(payload), nowIso());
}
function dateKeyInTimezone(value, timezone = BUENOS_AIRES_TIMEZONE) {
    if (!value)
        return null;
    const date = new Date(String(value));
    if (!Number.isFinite(date.getTime()))
        return null;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return year && month && day ? year + '-' + month + '-' + day : null;
}
function accountWarmupSecondsForDate(accountKey, dateKey) {
    const rows = db.prepare(`
    SELECT timestamp, elapsed_sec
    FROM warmup_sessions
    WHERE account_key = ?
  `).all(accountKey);
    return rows.reduce((total, row) => dateKeyInTimezone(row.timestamp) === dateKey
        ? total + numberValue(row.elapsed_sec)
        : total, 0);
}
function cancelUnstartedAutomaticWarmupsForTarget(accountKey, dateKey) {
    const rows = db.prepare(`
    SELECT * FROM task_runs
    WHERE account_key = ?
      AND source = 'automatic'
      AND status IN ('pending', 'overdue')
      AND started_at IS NULL
  `).all(accountKey);
    let cancelled = 0;
    for (const row of rows) {
        const scheduledDate = dateKeyInTimezone(row.scheduled_for || row.created_at);
        if (scheduledDate !== dateKey)
            continue;
        const now = nowIso();
        const update = db.prepare(`
      UPDATE task_runs
      SET status = 'cancelled',
          completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL,
          cancel_reason = 'target_reached',
          updated_at = ?
      WHERE id = ? AND status IN ('pending', 'overdue') AND started_at IS NULL
    `).run(now, now, row.id);
        if (update.changes !== 1)
            continue;
        const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
        recordTaskEvent(updated, 'auto_cancelled_target_reached', {
            account_key: accountKey,
            date: dateKey,
        });
        cancelled += 1;
    }
    return cancelled;
}
function updateWarmupAccounting(task) {
    if (!task || !String(task.task_type || '').startsWith('warmup_')) {
        return { actual_duration_sec: 0, account_key: null, daily_total_sec: null, cancelled_remaining: 0 };
    }
    const result = parseParams(task.result);
    const reportedElapsed = result.elapsed_sec === undefined
        ? Number(task.actual_duration_sec || 0)
        : numberValue(result.elapsed_sec);
    const actualDuration = Math.max(0, reportedElapsed);
    db.prepare(`
    UPDATE task_runs
    SET actual_duration_sec = ?, updated_at = ?
    WHERE id = ?
  `).run(actualDuration, nowIso(), task.id);
    const accountKey = taskAccountKey(task);
    if (!accountKey) {
        return { actual_duration_sec: actualDuration, account_key: null, daily_total_sec: null, cancelled_remaining: 0 };
    }
    const dateKey = dateKeyInTimezone(result.timestamp
        || task.started_at
        || task.completed_at
        || task.scheduled_for
        || task.created_at);
    if (!dateKey) {
        return { actual_duration_sec: actualDuration, account_key: accountKey, daily_total_sec: null, cancelled_remaining: 0 };
    }
    const dailyTotal = accountWarmupSecondsForDate(accountKey, dateKey);
    const cancelledRemaining = dailyTotal >= DAILY_MIN_WARMUP_SECONDS
        ? cancelUnstartedAutomaticWarmupsForTarget(accountKey, dateKey)
        : 0;
    return {
        actual_duration_sec: actualDuration,
        account_key: accountKey,
        daily_total_sec: dailyTotal,
        cancelled_remaining: cancelledRemaining,
    };
}
function refreshTaskLifecycle() {
    const now = new Date();
    const nowValue = now.toISOString();
    const rows = db.prepare(`
    SELECT * FROM task_runs
    WHERE status IN ('pending', 'overdue')
      AND scheduled_for IS NOT NULL
  `).all();
    let overdue = 0;
    let expired = 0;
    for (const row of rows) {
        if (isTaskExpired(row.scheduled_for, now)) {
            const update = db.prepare(`
        UPDATE task_runs
        SET status = 'expired',
            completed_at = COALESCE(completed_at, ?),
            lease_expires_at = NULL,
            cancel_reason = 'expired_36h',
            updated_at = ?
        WHERE id = ? AND status IN ('pending', 'overdue')
      `).run(nowValue, nowValue, row.id);
            if (update.changes === 1) {
                const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
                recordTaskEvent(updated, 'expired', { reason: 'scheduled_for_plus_36h' });
                createTaskNotification(updated, 'task_expired', 'warning', 'Tarea expirada', 'La tarea #' + row.id + ' expiró después de 36 horas sin comenzar.', { reason: 'expired_36h' });
                expired += 1;
            }
            continue;
        }
        if (row.status === 'pending' && isTaskOverdue(row.scheduled_for, now)) {
            const update = db.prepare(`
        UPDATE task_runs
        SET status = 'overdue',
            overdue_at = COALESCE(overdue_at, ?),
            updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(overdueAtIso(String(row.scheduled_for)), nowValue, row.id);
            if (update.changes === 1) {
                const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
                recordTaskEvent(updated, 'overdue', { reason: 'scheduled_for_plus_2h' });
                createTaskNotification(updated, 'task_overdue', 'warning', 'Tarea atrasada', 'La tarea #' + row.id + ' está atrasada, pero seguirá en cola hasta cancelarse o expirar.', { reason: 'overdue_2h' });
                overdue += 1;
            }
        }
    }
    return { overdue, expired };
}
function warmupSessionView(row) {
    const metadata = parseParams(row.metadata);
    return {
        id: row.id,
        task_run_id: row.task_run_id ?? null,
        user_id: row.user_id,
        device_id: row.device_id ?? null,
        device_key: row.device_key ?? null,
        device_name: row.device_name ?? null,
        account: String(row.account || '').replace(/^@+/, ''),
        platform: normalizePlatform(row.platform),
        duration_minutes: numberValue(row.duration_minutes),
        reels_viewed: numberValue(row.reels_viewed),
        videos_viewed: numberValue(row.videos_viewed ?? row.reels_viewed),
        shorts_viewed: numberValue(row.shorts_viewed ?? row.videos_viewed ?? row.reels_viewed),
        likes: numberValue(row.likes),
        saves: numberValue(row.saves),
        elapsed_sec: numberValue(row.elapsed_sec),
        status: row.status || 'completed',
        timestamp: row.timestamp || row.created_at,
        created_at: row.created_at,
        updated_at: row.updated_at || row.created_at,
        metadata,
        ...metadata,
    };
}
function taskMatchesLegacyWarmupInput(task, input) {
    const params = parseParams(task?.params);
    const result = parseParams(task?.result);
    const taskPlatform = normalizePlatform(task?.platform || result.platform || params.platform || platformForWarmupTask(task?.task_type));
    const taskAccount = String(result.account || params.account || '').replace(/^@+/, '').trim().toLowerCase();
    const inputAccount = input.account.replace(/^@+/, '').trim().toLowerCase();
    const taskElapsedSeconds = numberValue(result.elapsed_sec ?? task?.actual_duration_sec);
    const taskReelsViewed = numberValue(result.reels_viewed ?? result.videos_viewed);
    return Number(task?.user_id) === input.userId
        && Number(task?.device_id) === input.deviceId
        && taskPlatform === input.platform
        && taskAccount === inputAccount
        && taskElapsedSeconds === input.elapsedSeconds
        && taskReelsViewed === input.reelsViewed
        && numberValue(result.likes) === input.likes
        && numberValue(result.saves) === input.saves;
}
function findRecentCanonicalWarmupTask(input) {
    // Legacy sync payloads without a device cannot be safely deduplicated: the
    // same account may exist on more than one phone in an agency workspace.
    if (input.deviceId === null || input.elapsedSeconds <= 0)
        return null;
    const lowerBound = new Date(Date.now() - LEGACY_WARMUP_DEDUPE_WINDOW_MS).toISOString();
    const candidates = db.prepare(`
    SELECT * FROM task_runs
    WHERE user_id = ?
      AND device_id = ?
      AND task_type = ?
      AND status = 'completed'
      AND completed_at >= ?
    ORDER BY completed_at DESC, id DESC
    LIMIT 50
  `).all(input.userId, input.deviceId, input.taskType, lowerBound);
    return candidates.find((candidate) => taskMatchesLegacyWarmupInput(candidate, input)) || null;
}
function findLegacyWarmupSessionForTask(task, accountKey, result) {
    if (!task?.id || task.status !== 'completed' || !task.device_id || !accountKey)
        return null;
    const elapsedSeconds = numberValue(result.elapsed_sec);
    if (elapsedSeconds <= 0)
        return null;
    const completedAt = Date.parse(String(task.completed_at || ''));
    if (!Number.isFinite(completedAt))
        return null;
    const lowerBound = new Date(completedAt - LEGACY_WARMUP_DEDUPE_WINDOW_MS).toISOString();
    const upperBound = new Date(completedAt + LEGACY_WARMUP_DEDUPE_WINDOW_MS).toISOString();
    return db.prepare(`
    SELECT ws.id AS session_id, ws.task_run_id AS legacy_task_run_id
    FROM warmup_sessions ws
    JOIN task_runs legacy ON legacy.id = ws.task_run_id
    WHERE ws.user_id = ?
      AND ws.device_id = ?
      AND ws.task_run_id IS NOT NULL
      AND ws.task_run_id <> ?
      AND ws.account_key = ?
      AND ws.platform = ?
      AND ws.elapsed_sec = ?
      AND ws.reels_viewed = ?
      AND ws.likes = ?
      AND ws.saves = ?
      AND ws.updated_at >= ?
      AND ws.updated_at <= ?
      AND legacy.status = 'completed'
      AND legacy.started_at IS NULL
      AND legacy.claim_token IS NULL
      AND legacy.planned_duration_sec IS NULL
    ORDER BY ws.updated_at DESC, ws.id DESC
    LIMIT 1
  `).get(task.user_id, task.device_id, task.id, accountKey, normalizePlatform(result.platform || task.platform || platformForWarmupTask(task.task_type)), elapsedSeconds, numberValue(result.reels_viewed ?? result.videos_viewed), numberValue(result.likes), numberValue(result.saves), lowerBound, upperBound) || null;
}
function upsertWarmupSessionFromTask(task) {
    if (!task || !String(task.task_type || '').startsWith('warmup_'))
        return null;
    const params = parseParams(task.params);
    const result = parseParams(task.result);
    const platform = normalizePlatform(result.platform || params.platform, platformForWarmupTask(task.task_type));
    const account = String(result.account || params.account || '').replace(/^@+/, '');
    const status = String(task.status || 'completed');
    const timestamp = String(result.timestamp
        || result.started_at
        || task.started_at
        || task.completed_at
        || task.created_at
        || nowIso());
    const updatedAt = nowIso();
    const accountKey = taskAccountKey(task);
    const elapsedSeconds = numberValue(result.elapsed_sec);
    if (task.id) {
        db.prepare('UPDATE task_runs SET account_key = COALESCE(account_key, ?), platform = COALESCE(platform, ?), actual_duration_sec = ? WHERE id = ?').run(accountKey, platform, elapsedSeconds, task.id);
    }
    const metadata = {
        channel_display_name: String(result.channel_display_name || params.channel_display_name || ''),
        source_account_name: String(result.source_account_name || params.source_account_name || ''),
        source_account_email: String(result.source_account_email || params.source_account_email || ''),
        byline: String(result.byline || params.byline || ''),
    };
    const values = [
        task.user_id,
        task.device_id ?? null,
        task.id ?? null,
        accountKey,
        account,
        platform,
        numberValue(params.duration_minutes),
        numberValue(result.reels_viewed ?? result.videos_viewed),
        numberValue(result.videos_viewed ?? result.reels_viewed),
        numberValue(result.shorts_viewed ?? result.videos_viewed ?? result.reels_viewed),
        numberValue(result.likes),
        numberValue(result.saves),
        numberValue(result.elapsed_sec),
        status,
        timestamp,
        jsonValue(metadata),
        updatedAt,
    ];
    let existing = task.id
        ? db.prepare('SELECT id FROM warmup_sessions WHERE task_run_id = ?').get(task.id)
        : undefined;
    if (!existing) {
        const legacySession = findLegacyWarmupSessionForTask(task, accountKey, result);
        if (legacySession) {
            db.prepare(`
        UPDATE warmup_sessions
        SET task_run_id = ?
        WHERE id = ? AND user_id = ? AND task_run_id = ?
      `).run(task.id, legacySession.session_id, task.user_id, legacySession.legacy_task_run_id);
            existing = { id: Number(legacySession.session_id) };
            recordTaskEvent(task, 'legacy_session_reconciled', {
                legacy_task_run_id: legacySession.legacy_task_run_id,
                session_id: legacySession.session_id,
            });
        }
    }
    if (existing) {
        db.prepare(`
      UPDATE warmup_sessions
      SET device_id = ?, account_key = ?, account = ?, platform = ?, duration_minutes = ?,
          reels_viewed = ?, videos_viewed = ?, shorts_viewed = ?, likes = ?,
          saves = ?, elapsed_sec = ?, status = ?, timestamp = ?, metadata = ?,
          updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(task.device_id ?? null, accountKey, account, platform, numberValue(params.duration_minutes), numberValue(result.reels_viewed ?? result.videos_viewed), numberValue(result.videos_viewed ?? result.reels_viewed), numberValue(result.shorts_viewed ?? result.videos_viewed ?? result.reels_viewed), numberValue(result.likes), numberValue(result.saves), numberValue(result.elapsed_sec), status, timestamp, jsonValue(metadata), updatedAt, existing.id, task.user_id);
    }
    else {
        db.prepare(`
      INSERT INTO warmup_sessions
        (user_id, device_id, task_run_id, account_key, account, platform, duration_minutes,
         reels_viewed, videos_viewed, shorts_viewed, likes, saves, elapsed_sec,
         status, timestamp, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    }
    const row = db.prepare(`
    SELECT ws.*, d.device_id AS device_key, d.device_name
    FROM warmup_sessions ws
    LEFT JOIN devices d ON d.id = ws.device_id
    WHERE ws.user_id = ? AND ws.task_run_id = ?
  `).get(task.user_id, task.id);
    return row ? warmupSessionView(row) : null;
}
function scanSessionView(row) {
    return {
        ...row,
        platform: normalizePlatform(row.platform),
        accounts_found: numberValue(row.accounts_found),
        metadata: parseParams(row.metadata),
    };
}
function recordScanSession(userId, deviceId, platformValue, options = {}) {
    const platform = normalizePlatform(platformValue);
    const statusValue = String(options.status || 'completed').toLowerCase();
    const status = ['running', 'completed', 'error', 'cancelled'].includes(statusValue)
        ? statusValue
        : 'completed';
    const startedAt = stringValue(options.startedAt) || nowIso();
    const completedAt = stringValue(options.completedAt)
        || (['completed', 'error', 'cancelled'].includes(status) ? nowIso() : null);
    const metadata = jsonValue(options.metadata);
    const createdAt = nowIso();
    const taskRunId = options.taskRunId === undefined || options.taskRunId === null
        ? null
        : numberValue(options.taskRunId);
    const existing = taskRunId
        ? db.prepare('SELECT id FROM scan_sessions WHERE task_run_id = ? AND user_id = ?')
            .get(taskRunId, userId)
        : undefined;
    let row;
    if (existing) {
        db.prepare(`
      UPDATE scan_sessions
      SET device_id = ?, platform = ?, status = ?, accounts_found = ?,
          started_at = ?, completed_at = ?, metadata = ?
      WHERE id = ? AND user_id = ?
    `).run(deviceId, platform, status, numberValue(options.accountsFound), startedAt, completedAt, metadata, existing.id, userId);
        row = db.prepare('SELECT * FROM scan_sessions WHERE id = ? AND user_id = ?').get(existing.id, userId);
    }
    else {
        const result = db.prepare(`
      INSERT INTO scan_sessions
        (user_id, device_id, task_run_id, platform, status, accounts_found, started_at,
         completed_at, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, deviceId, taskRunId, platform, status, numberValue(options.accountsFound), startedAt, completedAt, metadata, createdAt);
        row = db.prepare('SELECT * FROM scan_sessions WHERE id = ? AND user_id = ?')
            .get(result.lastInsertRowid, userId);
    }
    return row ? scanSessionView(row) : null;
}
function upsertScanSessionFromTask(task) {
    if (!task || !String(task.task_type || '').startsWith('scan_'))
        return null;
    const params = parseParams(task.params);
    const result = parseParams(task.result);
    const taskType = String(task.task_type);
    const platform = normalizePlatform(result.platform || params.platform, taskType === 'scan_tiktok' ? 'tiktok' : taskType === 'scan_youtube' ? 'youtube' : 'instagram');
    return recordScanSession(task.user_id, task.device_id ?? null, platform, {
        taskRunId: task.id,
        status: task.status,
        accountsFound: result.accounts_found,
        startedAt: task.started_at || task.created_at,
        completedAt: task.completed_at,
        metadata: {
            source: 'scan_task',
            ...params,
            ...result,
        },
    });
}
// Backfill the canonical session projection for task history created before
// the multiplatform model existed. The task_runs table remains the execution
// log; warmup_sessions is now the reporting/read model.
const historicalWarmupRuns = db.prepare(`
  SELECT * FROM task_runs
  WHERE task_type IN ('warmup_ig', 'warmup_tiktok', 'warmup_youtube')
  ORDER BY id ASC
`).all();
for (const run of historicalWarmupRuns)
    upsertWarmupSessionFromTask(run);
// Preserve Instagram accounts recorded by the legacy endpoint in the unified
// provider table. This is idempotent and lets the command center use one API
// for all three platforms immediately after the migration.
db.prepare(`
  INSERT OR IGNORE INTO social_accounts
    (user_id, device_id, platform, username, profile_pic_url)
  SELECT user_id, device_id, 'instagram', username, profile_pic_url
  FROM ig_accounts
`).run();
const TEAM_ROLES = ['owner', 'admin', 'operator', 'viewer'];
function normalizeRole(value, fallback = 'viewer') {
    const role = String(value || '').toLowerCase();
    return TEAM_ROLES.includes(role) ? role : fallback;
}
function hashInviteToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
function requestUserAgent(req) {
    const value = typeof req?.get === 'function' ? req.get('user-agent') : req?.headers?.['user-agent'];
    return stringValue(value)?.slice(0, 500) || null;
}
function issueRefreshSession(userId, userAgent, familyId = randomUUID()) {
    const rawToken = `sfr_${randomBytes(48).toString('base64url')}`;
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
    db.prepare(`
    INSERT INTO refresh_sessions
      (user_id, family_id, token_hash, created_at, expires_at, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, familyId, hashInviteToken(rawToken), createdAt, expiresAt, userAgent);
    return rawToken;
}
function rotateRefreshSession(rawToken, userAgent) {
    const tokenHash = hashInviteToken(rawToken);
    const rotation = db.transaction(() => {
        const current = db.prepare(`
      SELECT id, user_id, family_id, token_hash, expires_at, revoked_at
      FROM refresh_sessions
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash);
        if (!current)
            return null;
        const now = nowIso();
        if (current.revoked_at) {
            // EXCEPCIÓN (carrera de refresh simultáneo): el cliente Flutter no tiene
            // single-flight en refreshSession; con varios flujos concurrentes el
            // mismo token vencido puede llegar dos veces: el primero rota, el resto
            // llega con el ya-revocado y antes se mataba la familia entera =
            // logout masivo en los teléfonos. Si la rotación es reciente (gracia) y
            // la familia conserva al menos una sesión activa, se emite una sesión
            // hermana nueva en vez de revocar todo. Fuera de gracia o sin hermana
            // activa sigue siendo tratarlo como robo y revocar la familia.
            const revokedAtMs = Date.parse(current.revoked_at);
            const graceMs = Number(process.env.SOUTHFARM_REFRESH_REUSE_GRACE_MS || '60000');
            if (Number.isFinite(revokedAtMs) && Date.now() - revokedAtMs <= graceMs) {
                const activeSibling = db.prepare(`
          SELECT id FROM refresh_sessions
          WHERE family_id = ? AND revoked_at IS NULL AND expires_at > ?
          LIMIT 1
        `).get(current.family_id, now);
                if (activeSibling) {
                    const graceRawToken = `sfr_${randomBytes(48).toString('base64url')}`;
                    const graceHash = hashInviteToken(graceRawToken);
                    const graceExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
                    db.prepare(`
            INSERT INTO refresh_sessions
              (user_id, family_id, token_hash, created_at, expires_at, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(current.user_id, current.family_id, graceHash, now, graceExpiresAt, userAgent);
                    return { userId: Number(current.user_id), refreshToken: graceRawToken };
                }
            }
            // A rotated token must never be accepted twice. Reuse revokes the
            // complete family so a stolen token cannot keep a session alive.
            db.prepare(`
        UPDATE refresh_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE family_id = ?
      `).run(now, current.family_id);
            return null;
        }
        if (!current.expires_at || Date.parse(current.expires_at) <= Date.now()) {
            db.prepare('UPDATE refresh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
                .run(now, current.id);
            return null;
        }
        const nextRawToken = `sfr_${randomBytes(48).toString('base64url')}`;
        const nextHash = hashInviteToken(nextRawToken);
        const nextExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
        db.prepare(`
      INSERT INTO refresh_sessions
        (user_id, family_id, token_hash, created_at, expires_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(current.user_id, current.family_id, nextHash, now, nextExpiresAt, userAgent);
        db.prepare(`
      UPDATE refresh_sessions
      SET revoked_at = ?, replaced_by_hash = ?, last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL
    `).run(now, nextHash, now, current.id);
        return { userId: Number(current.user_id), refreshToken: nextRawToken };
    })();
    return rotation;
}
function revokeRefreshToken(rawToken) {
    db.prepare(`
    UPDATE refresh_sessions
    SET revoked_at = COALESCE(revoked_at, ?)
    WHERE token_hash = ?
  `).run(nowIso(), hashInviteToken(rawToken));
}
function workspaceMembership(userId) {
    return db.prepare(`
    SELECT wm.*, w.name AS workspace_name, w.owner_user_id,
           w.bridge_url AS workspace_bridge_url,
           w.strict_bridge_mode AS workspace_strict_bridge_mode
    FROM workspace_members wm
    JOIN workspaces w ON w.id = wm.workspace_id
    WHERE wm.user_id = ? AND wm.status = 'active'
    ORDER BY wm.id ASC
    LIMIT 1
  `).get(userId) || null;
}
function workspaceUserIds(userId) {
    const membership = workspaceMembership(userId);
    if (!membership)
        return [userId];
    const members = db.prepare(`
    SELECT user_id FROM workspace_members
    WHERE workspace_id = ? AND status = 'active'
    ORDER BY user_id
  `).all(membership.workspace_id);
    return members.length ? members.map((member) => Number(member.user_id)) : [userId];
}
function scopedUsers(userId) {
    const ids = workspaceUserIds(userId);
    return { ids, placeholders: ids.map(() => '?').join(', ') };
}
// Un token de dispositivo (authType 'device') solo debe ver el historial que
// ESE teléfono generó en su workspace; los JWT de usuario (command center)
// siguen viendo todo el workspace. Devuelve el devices.id propio del token,
// o null si el llamante es un usuario.
function deviceScopedId(req) {
    return req.user?.authType === 'device' && Number.isInteger(Number(req.user.deviceId))
        ? Number(req.user.deviceId)
        : null;
}
function normalizeSchedulerControlMode(value) {
    const mode = String(value || '').toLowerCase();
    if (mode === 'manual_only' || mode === 'paused')
        return mode;
    return 'normal';
}
function ensureWorkspaceControl(workspaceId) {
    let control = db.prepare('SELECT * FROM workspace_controls WHERE workspace_id = ?').get(workspaceId);
    if (!control) {
        const now = nowIso();
        db.prepare(`
      INSERT OR IGNORE INTO workspace_controls
        (workspace_id, scheduler_mode, queue_paused,
         previous_scheduler_mode, previous_queue_paused,
         control_version, updated_at)
      VALUES (?, 'normal', 0, 'normal', 0, 0, ?)
    `).run(workspaceId, now);
        control = db.prepare('SELECT * FROM workspace_controls WHERE workspace_id = ?').get(workspaceId);
    }
    return control;
}
function workspaceControlView(workspaceId) {
    const control = ensureWorkspaceControl(workspaceId);
    const devices = db.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ? AND lifecycle_status != 'revoked'
    ORDER BY id ASC
  `).all(workspaceId);
    const version = Number(control?.control_version || 0);
    const paused = control?.scheduler_mode === 'paused';
    return {
        workspace_id: workspaceId,
        scheduler_mode: normalizeSchedulerControlMode(control?.scheduler_mode),
        queue_paused: Boolean(Number(control?.queue_paused || 0)),
        previous_scheduler_mode: normalizeSchedulerControlMode(control?.previous_scheduler_mode),
        previous_queue_paused: Boolean(Number(control?.previous_queue_paused || 0)),
        control_version: version,
        updated_at: control?.updated_at || null,
        devices: devices.map((device) => {
            const view = deviceView(device);
            const acknowledged = Number(device.control_version_ack || 0) >= version;
            let state = String(device.control_state || 'idle');
            if (paused && !acknowledged)
                state = 'requested';
            if (paused && acknowledged)
                state = 'paused';
            if (!paused && version > 0 && !acknowledged)
                state = 'requested';
            return {
                id: device.id,
                device_id: device.device_id,
                display_name: view.display_name,
                online: view.online,
                connection_status: view.connection_status,
                last_seen_at: device.last_seen_at || null,
                control_state: state,
                acknowledged,
                control_version_ack: Number(device.control_version_ack || 0),
                control_ack_at: device.control_ack_at || null,
                current_task: view.current_task || null,
            };
        }),
    };
}
function workspaceControlAllowsTask(control, task) {
    const mode = normalizeSchedulerControlMode(control?.scheduler_mode);
    if (mode === 'paused')
        return false;
    if (mode === 'manual_only' || Boolean(Number(control?.queue_paused || 0))) {
        return String(task?.source || '') === 'manual' || Number(task?.manual_override || 0) === 1;
    }
    return true;
}
function workspaceControlBlocksAutomatic(control) {
    return normalizeSchedulerControlMode(control?.scheduler_mode) !== 'normal'
        || Boolean(Number(control?.queue_paused || 0));
}
function acknowledgeDeviceControl(deviceId, controlVersion, state) {
    const now = nowIso();
    db.prepare(`
    UPDATE devices
    SET control_version_ack = ?, control_state = ?, control_ack_at = ?, last_seen_at = ?
    WHERE id = ? AND COALESCE(control_version_ack, 0) <= ?
  `).run(controlVersion, state, now, now, deviceId, controlVersion);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId);
}
function findDeviceForWorkspace(userId, rawDeviceId, preferStableId = false, rawInstallationId) {
    const deviceValue = stringValue(rawDeviceId);
    const installationId = stringValue(rawInstallationId);
    const workspaceId = workspaceIdForUser(userId);
    if (!workspaceId && !deviceValue)
        return null;
    if (workspaceId && installationId) {
        const byInstallation = db.prepare(`
      SELECT * FROM devices
      WHERE workspace_id = ? AND installation_id = ? AND lifecycle_status != 'revoked'
      ORDER BY id DESC LIMIT 1
    `).get(workspaceId, installationId);
        if (byInstallation)
            return byInstallation;
        // A new installation must be paired explicitly; do not silently bind it
        // to an older row just because Android reused the same identifier.
        return null;
    }
    if (workspaceId && deviceValue) {
        const byStableId = db.prepare(`
      SELECT * FROM devices
      WHERE workspace_id = ? AND device_id = ? AND lifecycle_status != 'revoked'
      ORDER BY id DESC LIMIT 1
    `).get(workspaceId, deviceValue);
        if (byStableId)
            return byStableId;
    }
    if (!deviceValue)
        return null;
    const { ids, placeholders } = scopedUsers(userId);
    let device = db.prepare(`
    SELECT * FROM devices
    WHERE user_id IN (${placeholders}) AND device_id = ? AND lifecycle_status != 'revoked'
    ORDER BY id DESC LIMIT 1
  `).get(...ids, deviceValue);
    if (!device && !preferStableId && /^\d+$/.test(deviceValue)) {
        device = db.prepare(`
      SELECT * FROM devices
      WHERE user_id IN (${placeholders}) AND id = ? AND lifecycle_status != 'revoked'
      LIMIT 1
    `).get(...ids, Number(deviceValue));
    }
    return device || null;
}
function memberUserView(member) {
    return {
        id: member.user_id,
        email: member.email,
        name: member.name,
        role: normalizeRole(member.role),
        status: member.status,
        joined_at: member.created_at,
    };
}
function ensureWorkspaceForExistingUsers() {
    const existingUsers = db.prepare('SELECT id, email, name FROM users ORDER BY id').all();
    const ensure = db.transaction(() => {
        for (const user of existingUsers) {
            const member = db.prepare('SELECT id FROM workspace_members WHERE user_id = ? LIMIT 1').get(user.id);
            if (member)
                continue;
            const workspace = db.prepare(`
        INSERT INTO workspaces (name, owner_user_id)
        VALUES (?, ?)
      `).run(`${user.name || user.email} workspace`, user.id);
            db.prepare(`
        INSERT INTO workspace_members
          (workspace_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).run(workspace.lastInsertRowid, user.id, nowIso(), nowIso());
        }
    });
    ensure();
}
ensureWorkspaceForExistingUsers();
// The first device registry was user-scoped and used the Android identifier as
// its only key.  Keep that data readable, but establish the workspace-scoped
// identity used by the command center and by the pairing flow.  Existing
// rows are intentionally preserved as active until the owner revokes stale
// installations from the fleet.
db.transaction(() => {
    db.prepare(`
    UPDATE devices
    SET workspace_id = COALESCE(
      workspace_id,
      (SELECT wm.workspace_id FROM workspace_members wm
       WHERE wm.user_id = devices.user_id AND wm.status = 'active'
       ORDER BY wm.id ASC LIMIT 1)
    )
    WHERE workspace_id IS NULL
  `).run();
    db.prepare(`
    UPDATE devices
    SET installation_id = device_id
    WHERE installation_id IS NULL OR TRIM(installation_id) = ''
  `).run();
    db.prepare(`
    UPDATE devices
    SET lifecycle_status = 'enrolled'
    WHERE lifecycle_status IS NULL OR TRIM(lifecycle_status) = ''
  `).run();
    db.prepare(`
    UPDATE devices
    SET paired_at = COALESCE(paired_at, created_at)
    WHERE paired_at IS NULL
  `).run();
})();
// A device installation is unique inside a workspace.  The current data set
// has no conflicting active rows, so this also protects future registrations
// from recreating the fleet ghost problem.
try {
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_workspace_installation_active
    ON devices(workspace_id, installation_id)
    WHERE workspace_id IS NOT NULL
      AND installation_id IS NOT NULL
      AND lifecycle_status != 'revoked'
  `);
}
catch (error) {
    console.warn('[Devices] Could not enforce installation uniqueness:', error);
}
function taskView(task, includeClaimToken = false) {
    const view = {
        ...task,
        params: parseParams(task.params),
    };
    if (!includeClaimToken)
        delete view.claim_token;
    return view;
}
function normalizeWarmupPolicyStatus(value) {
    const status = String(value || '').toLowerCase();
    return ['automatic', 'cold', 'warming', 'warm'].includes(status)
        ? status
        : 'automatic';
}
function plannerDateKey(value) {
    const candidate = stringValue(value) || dateKeyInTimezone(nowIso());
    if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        throw new Error('date must use YYYY-MM-DD');
    }
    const probe = Date.parse(candidate + 'T12:00:00Z');
    if (!Number.isFinite(probe))
        throw new Error('date must use YYYY-MM-DD');
    return candidate;
}
function ensureWarmupPolicy(account) {
    const accountKey = account.account_key
        || accountKeyFor(Number(account.user_id), account.device_id === null || account.device_id === undefined ? null : Number(account.device_id), account.platform, account.username || account.account);
    if (!accountKey)
        return null;
    if (!account.account_key && account.id) {
        db.prepare('UPDATE social_accounts SET account_key = ? WHERE id = ?').run(accountKey, account.id);
    }
    const now = nowIso();
    const existing = db.prepare('SELECT * FROM warmup_policies WHERE account_key = ?').get(accountKey);
    if (existing) {
        db.prepare(`
      UPDATE warmup_policies
      SET social_account_id = ?, user_id = ?, device_id = ?, platform = ?, account = ?, updated_at = ?
      WHERE account_key = ?
    `).run(account.id || existing.social_account_id || null, account.user_id, account.device_id || existing.device_id || null, normalizePlatform(account.platform), account.username || account.account, now, accountKey);
        return db.prepare('SELECT * FROM warmup_policies WHERE account_key = ?').get(accountKey);
    }
    db.prepare(`
    INSERT INTO warmup_policies
      (account_key, social_account_id, user_id, device_id, platform, account,
       status, enabled, daily_min_seconds, daily_max_seconds, min_sessions,
       max_sessions, window_start, window_end, timezone, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'automatic', 1, ?, ?, ?, ?, '12:00', '22:00', ?, ?, ?)
  `).run(accountKey, account.id || null, account.user_id, account.device_id || null, normalizePlatform(account.platform), account.username || account.account, DAILY_MIN_WARMUP_SECONDS, DAILY_MAX_WARMUP_SECONDS, 2, 3, BUENOS_AIRES_TIMEZONE, now, now);
    return db.prepare('SELECT * FROM warmup_policies WHERE account_key = ?').get(accountKey);
}
function accountWarmupMetrics(accountKey) {
    const rows = db.prepare(`
    SELECT timestamp, elapsed_sec
    FROM warmup_sessions
    WHERE account_key = ?
    ORDER BY timestamp DESC
  `).all(accountKey);
    const now = Date.now();
    const today = dateKeyInTimezone(new Date(now).toISOString());
    const windows = {
        today_sec: 0,
        last_24h_sec: 0,
        last_7d_sec: 0,
        last_30d_sec: 0,
        last_6m_sec: 0,
    };
    let lastWarmupAt = null;
    for (const row of rows) {
        const timestamp = Date.parse(String(row.timestamp || ''));
        if (!Number.isFinite(timestamp))
            continue;
        const elapsed = numberValue(row.elapsed_sec);
        if (!lastWarmupAt)
            lastWarmupAt = String(row.timestamp);
        const age = now - timestamp;
        if (dateKeyInTimezone(row.timestamp) === today)
            windows.today_sec += elapsed;
        if (age <= 24 * 60 * 60 * 1000)
            windows.last_24h_sec += elapsed;
        if (age <= 7 * 24 * 60 * 60 * 1000)
            windows.last_7d_sec += elapsed;
        if (age <= 30 * 24 * 60 * 60 * 1000)
            windows.last_30d_sec += elapsed;
        if (age <= 183 * 24 * 60 * 60 * 1000)
            windows.last_6m_sec += elapsed;
    }
    return {
        today_sec: windows.today_sec,
        last_24h_sec: windows.last_24h_sec,
        last_7d_sec: windows.last_7d_sec,
        last_30d_sec: windows.last_30d_sec,
        last_6m_sec: windows.last_6m_sec,
        last_warmup_at: lastWarmupAt,
    };
}
function plannerAccounts(userId, dateKey, planDayId) {
    const { ids, placeholders } = scopedUsers(userId);
    const currentRows = db.prepare(`
    SELECT sa.*, d.device_id AS device_key, d.device_name, d.workspace_id
    FROM social_accounts sa
    LEFT JOIN devices d ON d.id = sa.device_id
    WHERE sa.user_id IN (${placeholders})
      AND (d.id IS NULL OR d.lifecycle_status != 'revoked')
    ORDER BY sa.platform, sa.username
  `).all(...ids);
    const policyRows = db.prepare(`
    SELECT * FROM warmup_policies
    WHERE user_id IN (${placeholders})
    ORDER BY platform, account
  `).all(...ids);
    const byKey = new Map();
    for (const row of currentRows) {
        const key = row.account_key
            || accountKeyFor(Number(row.user_id), row.device_id === null ? null : Number(row.device_id), row.platform, row.username);
        if (!key)
            continue;
        const policy = ensureWarmupPolicy({ ...row, account_key: key });
        byKey.set(key, { ...row, account_key: key, policy });
    }
    for (const policy of policyRows) {
        if (byKey.has(policy.account_key))
            continue;
        const device = policy.device_id
            ? db.prepare('SELECT device_id AS device_key, device_name, workspace_id FROM devices WHERE id = ?').get(policy.device_id)
            : null;
        byKey.set(policy.account_key, {
            id: policy.social_account_id || null,
            social_account_id: policy.social_account_id || null,
            account_key: policy.account_key,
            user_id: policy.user_id,
            device_id: policy.device_id,
            device_key: device?.device_key || null,
            device_name: device?.device_name || null,
            workspace_id: device?.workspace_id || workspaceIdForUser(Number(policy.user_id)),
            platform: policy.platform,
            username: policy.account,
            policy,
        });
    }
    return [...byKey.values()].map((row) => {
        const policy = row.policy || ensureWarmupPolicy(row);
        const accountKey = row.account_key;
        const metrics = accountWarmupMetrics(accountKey);
        const planItem = planDayId
            ? db.prepare(`
          SELECT wpi.*, wpd.plan_date
          FROM warmup_plan_items wpi
          JOIN warmup_plan_days wpd ON wpd.id = wpi.plan_day_id
          WHERE wpi.plan_day_id = ? AND wpi.account_key = ?
        `).get(planDayId, accountKey)
            : null;
        const tasks = planItem
            ? db.prepare(`
          SELECT * FROM task_runs
          WHERE plan_item_id = ?
          ORDER BY scheduled_for ASC, id ASC
        `).all(planItem.id).map((task) => taskView(task))
            : [];
        const targetSeconds = Number(planItem?.target_seconds || policy?.daily_min_seconds || DAILY_MIN_WARMUP_SECONDS);
        return {
            id: row.id || row.social_account_id || null,
            social_account_id: row.id || row.social_account_id || null,
            account_key: accountKey,
            account: String(row.username || row.account || '').replace(/^@+/, ''),
            username: String(row.username || row.account || '').replace(/^@+/, ''),
            platform: normalizePlatform(row.platform),
            user_id: row.user_id,
            device_id: row.device_id || null,
            device_key: row.device_key || null,
            device_name: row.device_name || null,
            policy: policy ? {
                status: normalizeWarmupPolicyStatus(policy.status),
                enabled: Boolean(policy.enabled),
                daily_min_seconds: Number(policy.daily_min_seconds || DAILY_MIN_WARMUP_SECONDS),
                daily_max_seconds: Number(policy.daily_max_seconds || DAILY_MAX_WARMUP_SECONDS),
                min_sessions: Number(policy.min_sessions || 2),
                max_sessions: Number(policy.max_sessions || 3),
                window_start: policy.window_start || '12:00',
                window_end: policy.window_end || '22:00',
                timezone: policy.timezone || BUENOS_AIRES_TIMEZONE,
            } : null,
            plan_item: planItem ? {
                id: planItem.id,
                target_seconds: targetSeconds,
                planned_sessions: Number(planItem.planned_sessions),
                status: planItem.status,
                plan_date: planItem.plan_date,
            } : null,
            metrics,
            today_target_sec: targetSeconds,
            today_deficit_sec: Math.max(0, targetSeconds - metrics.today_sec),
            tasks,
        };
    }).filter((account) => account.policy);
}
function plannerPriority(account) {
    const status = normalizeWarmupPolicyStatus(account.policy?.status);
    if (status === 'warm')
        return -1;
    const last = account.metrics?.last_warmup_at ? Date.parse(account.metrics.last_warmup_at) : NaN;
    const daysWithout = Number.isFinite(last)
        ? Math.max(0, Math.floor((Date.now() - last) / (24 * 60 * 60 * 1000)))
        : 180;
    const statusBoost = status === 'cold' ? 600 : status === 'warming' ? 450 : 300;
    return statusBoost
        + Math.min(300, daysWithout * 10)
        + Math.min(300, Math.ceil(Number(account.today_deficit_sec || 0) / 60));
}
function taskTypeForPlatform(platform) {
    return platform === 'tiktok'
        ? 'warmup_tiktok'
        : platform === 'youtube'
            ? 'warmup_youtube'
            : 'warmup_ig';
}
function createAutomaticWarmupTask(planDay, planItem, account, durationSeconds, scheduledFor, priority) {
    const createdAt = nowIso();
    const durationMinutes = Math.max(1, Math.round(durationSeconds / 60));
    const params = {
        account: account.account,
        platform: account.platform,
        duration_minutes: durationMinutes,
        duration_seconds: durationMinutes * 60,
        social_account_id: account.social_account_id,
        account_key: account.account_key,
        plan_item_id: planItem.id,
        scheduler_mode: planDay.mode,
    };
    const r = db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, workspace_id, task_type, platform, source, params,
       status, scheduled_for, overdue_at, expires_at, planned_duration_sec,
       actual_duration_sec, social_account_id, account_key, plan_item_id,
       manual_override, priority, attempt_count, account_snapshot,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'automatic', ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, 0, ?, ?, ?)
  `).run(account.user_id, account.device_id, planDay.workspace_id, taskTypeForPlatform(account.platform), account.platform, JSON.stringify(params), scheduledFor, overdueAtIso(scheduledFor), expiresAtIso(scheduledFor), durationMinutes * 60, account.social_account_id, account.account_key, planItem.id, priority, jsonValue({
        account: account.account,
        platform: account.platform,
        device_id: account.device_key,
        social_account_id: account.social_account_id,
    }), createdAt, createdAt);
    const task = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(r.lastInsertRowid);
    recordTaskEvent(task, 'created_automatic', {
        plan_day_id: planDay.id,
        plan_item_id: planItem.id,
        scheduled_for: scheduledFor,
        planned_duration_sec: durationMinutes * 60,
    });
    return task;
}
function generatePlannerPlan(userId, dateKey, mode, fixedSeconds) {
    const membership = workspaceMembership(userId);
    if (!membership)
        throw new Error('User is not assigned to a workspace');
    const workspaceId = Number(membership.workspace_id);
    const now = nowIso();
    let planDay = db.prepare('SELECT * FROM warmup_plan_days WHERE workspace_id = ? AND plan_date = ?').get(workspaceId, dateKey);
    if (!planDay) {
        const result = db.prepare(`
      INSERT INTO warmup_plan_days
        (workspace_id, plan_date, timezone, mode, status, version, generated_at, updated_at)
      VALUES (?, ?, ?, ?, 'generated', 1, ?, ?)
    `).run(workspaceId, dateKey, BUENOS_AIRES_TIMEZONE, mode, now, now);
        planDay = db.prepare('SELECT * FROM warmup_plan_days WHERE id = ?').get(result.lastInsertRowid);
    }
    const accounts = plannerAccounts(userId, dateKey, Number(planDay.id));
    const eligible = accounts
        .filter((account) => account.policy?.enabled && normalizeWarmupPolicyStatus(account.policy.status) !== 'warm')
        .sort((left, right) => plannerPriority(right) - plannerPriority(left));
    const skippedWarm = accounts.length - eligible.length;
    const createdTasks = [];
    for (const account of eligible) {
        const existingItem = db.prepare(`
      SELECT * FROM warmup_plan_items
      WHERE plan_day_id = ? AND account_key = ?
    `).get(planDay.id, account.account_key);
        let planItem = existingItem;
        if (!planItem) {
            const targetSeconds = chooseDailyTargetSeconds(mode, Math.random, fixedSeconds);
            const sessionCount = chooseSessionCount(Math.random, mode === 'fixed' ? 2 : undefined);
            const result = db.prepare(`
        INSERT INTO warmup_plan_items
          (plan_day_id, account_key, social_account_id, user_id, device_id,
           platform, account, target_seconds, planned_sessions, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).run(planDay.id, account.account_key, account.social_account_id, account.user_id, account.device_id, account.platform, account.account, targetSeconds, sessionCount, now, now);
            planItem = db.prepare('SELECT * FROM warmup_plan_items WHERE id = ?').get(result.lastInsertRowid);
        }
        const existingTasks = db.prepare('SELECT * FROM task_runs WHERE plan_item_id = ? ORDER BY id ASC').all(planItem.id);
        if (existingTasks.length > 0)
            continue;
        if (!account.device_id)
            continue;
        const durations = splitWarmupDurationSeconds(Number(planItem.target_seconds), Number(planItem.planned_sessions) === 3 ? 3 : 2, Math.random);
        const usableWindowMinutes = 10 * 60 - (durations.length - 1) * 120;
        const startOffset = Math.floor(Math.random() * Math.max(1, usableWindowMinutes));
        const priority = plannerPriority(account);
        for (let sessionIndex = 0; sessionIndex < durations.length; sessionIndex += 1) {
            const localMinutes = 12 * 60 + startOffset + sessionIndex * 120;
            const hour = Math.floor(localMinutes / 60);
            const minute = localMinutes % 60;
            const localTime = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
            const scheduledFor = localDateTimeToIso(dateKey, localTime, BUENOS_AIRES_TIMEZONE);
            createdTasks.push(createAutomaticWarmupTask(planDay, planItem, account, durations[sessionIndex], scheduledFor, priority));
        }
    }
    db.prepare('UPDATE warmup_plan_days SET updated_at = ?, status = ? WHERE id = ?')
        .run(nowIso(), 'generated', planDay.id);
    planDay = db.prepare('SELECT * FROM warmup_plan_days WHERE id = ?').get(planDay.id);
    return {
        plan_day: planDay,
        accounts: plannerAccounts(userId, dateKey, Number(planDay.id)),
        created_tasks: createdTasks.map((task) => taskView(task)),
        skipped_warm: skippedWarm,
    };
}
function cancelAutomaticTasksForPolicy(accountKey, reason) {
    const rows = db.prepare(`
    SELECT * FROM task_runs
    WHERE account_key = ?
      AND source = 'automatic'
      AND status IN ('pending', 'overdue')
      AND started_at IS NULL
  `).all(accountKey);
    let cancelled = 0;
    for (const row of rows) {
        const now = nowIso();
        const update = db.prepare(`
      UPDATE task_runs
      SET status = 'cancelled',
          completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL,
          cancel_reason = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('pending', 'overdue') AND started_at IS NULL
    `).run(now, reason, now, row.id);
        if (update.changes !== 1)
            continue;
        const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
        recordTaskEvent(updated, 'auto_cancelled_policy', { reason });
        cancelled += 1;
    }
    return cancelled;
}
function recalculatePlannerDay(userId, dateKey) {
    const membership = workspaceMembership(userId);
    if (!membership)
        return { plan_day: null, created_tasks: [], cancelled_tasks: 0 };
    const planDay = db.prepare('SELECT * FROM warmup_plan_days WHERE workspace_id = ? AND plan_date = ?').get(membership.workspace_id, dateKey);
    if (!planDay)
        return { plan_day: null, created_tasks: [], cancelled_tasks: 0 };
    const accounts = plannerAccounts(userId, dateKey, Number(planDay.id));
    const createdTasks = [];
    let cancelledTasks = 0;
    for (const account of accounts) {
        const status = normalizeWarmupPolicyStatus(account.policy?.status);
        if (!account.policy?.enabled || status === 'warm') {
            cancelledTasks += cancelAutomaticTasksForPolicy(account.account_key, 'policy_excluded');
            continue;
        }
        const planItem = db.prepare(`
      SELECT * FROM warmup_plan_items
      WHERE plan_day_id = ? AND account_key = ?
    `).get(planDay.id, account.account_key);
        if (!planItem || !account.device_id)
            continue;
        const total = accountWarmupMetrics(account.account_key).today_sec;
        if (total >= Number(account.policy.daily_min_seconds || DAILY_MIN_WARMUP_SECONDS)) {
            cancelledTasks += cancelUnstartedAutomaticWarmupsForTarget(account.account_key, dateKey);
            continue;
        }
        const tasks = db.prepare('SELECT * FROM task_runs WHERE plan_item_id = ? ORDER BY id ASC').all(planItem.id);
        const pendingAutomatic = tasks.some((task) => task.source === 'automatic' && ['pending', 'overdue'].includes(task.status));
        const maxSessions = Number(account.policy.max_sessions || 3);
        if (pendingAutomatic || tasks.length >= maxSessions)
            continue;
        const deficit = Math.max(60, Number(account.policy.daily_min_seconds || DAILY_MIN_WARMUP_SECONDS) - total);
        const scheduledFor = Date.parse(localDateTimeToIso(dateKey, '21:00', BUENOS_AIRES_TIMEZONE)) > Date.now()
            ? localDateTimeToIso(dateKey, '21:00', BUENOS_AIRES_TIMEZONE)
            : new Date(Date.now() + 60 * 1000).toISOString();
        createdTasks.push(createAutomaticWarmupTask(planDay, planItem, account, deficit, scheduledFor, plannerPriority(account) + 50));
    }
    db.prepare('UPDATE warmup_plan_days SET updated_at = ?, status = ? WHERE id = ?')
        .run(nowIso(), 'recalculated', planDay.id);
    return {
        plan_day: db.prepare('SELECT * FROM warmup_plan_days WHERE id = ?').get(planDay.id),
        created_tasks: createdTasks.map((task) => taskView(task)),
        cancelled_tasks: cancelledTasks,
    };
}
let automaticPlannerTickRunning = false;
function automaticPlannerWorkspaces() {
    const workspaces = db.prepare(`
    SELECT workspace_id, MIN(user_id) AS user_id
    FROM workspace_members
    WHERE status = 'active'
    GROUP BY workspace_id
    ORDER BY workspace_id
  `).all();
    if (!AUTO_PLANNER_WORKSPACE_ID)
        return workspaces;
    return workspaces.filter((workspace) => Number(workspace.workspace_id) === AUTO_PLANNER_WORKSPACE_ID);
}
/**
 * Keeps today's automatic plan durable without requiring the web panel to be
 * open. Generation is idempotent because plan days, plan items, and task
 * counts are all checked before new rows are inserted.
 */
function runAutomaticPlannerTick() {
    const result = {
        date: dateKeyInTimezone(nowIso()),
        workspaces: 0,
        created_tasks: 0,
        cancelled_tasks: 0,
        errors: 0,
    };
    if (!AUTO_PLANNER_ENABLED || automaticPlannerTickRunning || !result.date)
        return result;
    automaticPlannerTickRunning = true;
    try {
        refreshTaskLifecycle();
        for (const workspace of automaticPlannerWorkspaces()) {
            result.workspaces += 1;
            const control = ensureWorkspaceControl(Number(workspace.workspace_id));
            if (workspaceControlBlocksAutomatic(control))
                continue;
            try {
                const tick = db.transaction(() => {
                    const generated = generatePlannerPlan(Number(workspace.user_id), result.date, SCHEDULER_MODE, FIXED_WARMUP_SECONDS);
                    const recalculated = recalculatePlannerDay(Number(workspace.user_id), result.date);
                    return { generated, recalculated };
                })();
                result.created_tasks += tick.generated.created_tasks.length;
                result.created_tasks += tick.recalculated.created_tasks.length;
                result.cancelled_tasks += tick.recalculated.cancelled_tasks;
            }
            catch (error) {
                result.errors += 1;
                console.error(`[Scheduler] Automatic planner failed for workspace ${workspace.workspace_id}:`, error);
            }
        }
    }
    finally {
        automaticPlannerTickRunning = false;
    }
    if (result.created_tasks || result.cancelled_tasks || result.errors) {
        console.log(`[Scheduler] Automatic planner ${result.date}: `
            + `${result.created_tasks} created, ${result.cancelled_tasks} cancelled, ${result.errors} errors.`);
    }
    return result;
}
// Auth middleware
function auth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return res.status(401).json({ error: 'No token' });
    const bearer = header.slice(7);
    try {
        const payload = verifySouthFarmJwt(bearer);
        const membership = workspaceMembership(Number(payload.userId));
        if (!membership)
            return res.status(403).json({ error: 'User is not a member of a workspace' });
        req.user = {
            ...payload,
            userId: Number(payload.userId),
            workspaceId: Number(membership.workspace_id),
            role: normalizeRole(membership.role),
            membershipId: Number(membership.id),
            authType: 'user',
        };
        return next();
    }
    catch {
        // Device tokens are intentionally opaque and scoped to one paired
        // installation. They let the mobile agent keep working after a user JWT
        // expires, without giving the phone a team-management role. Tokens embed
        // their agent_token_version (sfd_v<N>_...; sin prefijo = legado v1): una
        // fila cuya versión avanzó rechaza todo token emitido antes de la rotación.
        const versionMatch = /^sfd_v(\d+)_/.exec(bearer);
        const tokenVersion = versionMatch ? Number(versionMatch[1]) : 1;
        const device = db.prepare(`
      SELECT * FROM devices
      WHERE device_token_hash = ? AND lifecycle_status = 'enrolled' AND agent_token_version = ?
      LIMIT 1
    `).get(hashInviteToken(bearer), tokenVersion);
        if (!device || !device.workspace_id)
            return res.status(401).json({ error: 'Invalid token' });
        const membership = db.prepare(`
      SELECT wm.* FROM workspace_members wm
      WHERE wm.workspace_id = ? AND wm.user_id = ? AND wm.status = 'active'
      LIMIT 1
    `).get(device.workspace_id, device.user_id);
        if (!membership)
            return res.status(403).json({ error: 'Device owner is not an active workspace member' });
        db.prepare('UPDATE devices SET last_auth_at = ? WHERE id = ?').run(nowIso(), device.id);
        req.user = {
            userId: Number(device.user_id),
            workspaceId: Number(device.workspace_id),
            role: 'operator',
            membershipId: Number(membership.id),
            authType: 'device',
            deviceId: Number(device.id),
        };
        return next();
    }
}
function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(normalizeRole(req.user?.role))) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}
registerPublicationRoutes({
    app,
    db,
    store: publicationStore,
    auth,
    requireRole,
    mediaRoot: PUBLICATION_MEDIA_ROOT,
    workerTokenHash: PUBLISHER_WORKER_TOKEN_HASH || undefined,
});
if (PUBLISHER_WORKER_TOKEN_HASH) {
    registerPublicationWorkerRoutes({
        app,
        db,
        store: publicationStore,
        mediaRoot: PUBLICATION_MEDIA_ROOT,
        workerTokenHash: PUBLISHER_WORKER_TOKEN_HASH,
        onlineWindowSeconds: DEVICE_ONLINE_WINDOW_SECONDS,
    });
}
function authUserView(userId) {
    const user = db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(userId);
    const membership = workspaceMembership(userId);
    if (!user || !membership)
        return null;
    return {
        ...user,
        role: normalizeRole(membership.role),
        workspace: {
            id: membership.workspace_id,
            name: membership.workspace_name,
            owner_user_id: membership.owner_user_id,
            bridge_url: membership.workspace_bridge_url || null,
            strict_bridge_mode: !!membership.workspace_strict_bridge_mode,
        },
    };
}
// ─── Auth Routes ───
app.post('/api/auth/register', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const inviteToken = stringValue(req.body.invite_token);
    if (!email || !password || !name)
        return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 8)
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const invite = inviteToken
        ? db.prepare(`
        SELECT * FROM workspace_invites
        WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?
        LIMIT 1
      `).get(hashInviteToken(inviteToken), nowIso())
        : null;
    if (invite?.email && invite.email.toLowerCase() !== email) {
        return res.status(409).json({ error: 'Invite email does not match registration email' });
    }
    if (inviteToken && !invite)
        return res.status(400).json({ error: 'Invite token is invalid or expired' });
    const hash = bcrypt.hashSync(password, 10);
    try {
        const userId = db.transaction(() => {
            const r = db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)').run(email, hash, name);
            const createdUserId = Number(r.lastInsertRowid);
            if (invite) {
                db.prepare(`
          INSERT INTO workspace_members
            (workspace_id, user_id, role, status, invited_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, 'active', ?, ?, ?)
        `).run(invite.workspace_id, createdUserId, normalizeRole(invite.role), invite.invited_by_user_id, nowIso(), nowIso());
                db.prepare(`
          UPDATE workspace_invites
          SET accepted_by_user_id = ?, accepted_at = ?
          WHERE id = ? AND accepted_at IS NULL
        `).run(createdUserId, nowIso(), invite.id);
            }
            else {
                const workspace = db.prepare('INSERT INTO workspaces (name, owner_user_id) VALUES (?, ?)')
                    .run(`${name} workspace`, createdUserId);
                db.prepare(`
          INSERT INTO workspace_members
            (workspace_id, user_id, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)
        `).run(workspace.lastInsertRowid, createdUserId, nowIso(), nowIso());
            }
            return createdUserId;
        })();
        const token = signSouthFarmJwt(userId);
        const refreshToken = issueRefreshSession(userId, requestUserAgent(req));
        res.status(201).json({ token, refresh_token: refreshToken, user: authUserView(userId) });
    }
    catch (e) {
        e.message?.includes('UNIQUE') ? res.status(409).json({ error: 'Email ya registrado' }) : res.status(500).json({ error: 'Server error' });
    }
});
app.post('/api/auth/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password))
        return res.status(401).json({ error: 'Credenciales inválidas' });
    if (!workspaceMembership(user.id))
        return res.status(403).json({ error: 'User is not a member of a workspace' });
    const token = signSouthFarmJwt(user.id);
    const refreshToken = issueRefreshSession(user.id, requestUserAgent(req));
    res.json({ token, refresh_token: refreshToken, user: authUserView(user.id) });
});
app.post('/api/auth/refresh', (req, res) => {
    const rawRefreshToken = stringValue(req.body?.refresh_token);
    if (!rawRefreshToken)
        return res.status(400).json({ error: 'refresh_token is required' });
    const rotated = rotateRefreshSession(rawRefreshToken, requestUserAgent(req));
    if (!rotated) {
        return res.status(401).json({
            error: 'Refresh session invalid or expired',
            code: 'AUTH_REFRESH_REQUIRED',
        });
    }
    const user = authUserView(rotated.userId);
    if (!user) {
        revokeRefreshToken(rawRefreshToken);
        return res.status(403).json({ error: 'User is not a member of a workspace' });
    }
    res.json({
        token: signSouthFarmJwt(rotated.userId),
        refresh_token: rotated.refreshToken,
        user,
    });
});
app.post('/api/auth/logout', (req, res) => {
    const rawRefreshToken = stringValue(req.body?.refresh_token);
    if (rawRefreshToken)
        revokeRefreshToken(rawRefreshToken);
    res.json({ ok: true });
});
app.get('/api/auth/me', auth, (req, res) => {
    const user = authUserView(req.user.userId);
    user ? res.json({ user }) : res.status(404).json({ error: 'User not found' });
});
// ─── Workspace / team ───
app.get('/api/team/members', auth, (req, res) => {
    const members = db.prepare(`
    SELECT wm.user_id, wm.role, wm.status, wm.created_at,
           u.email, u.name
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
    ORDER BY CASE wm.role
      WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'operator' THEN 2 ELSE 3 END,
      u.name COLLATE NOCASE
  `).all(req.user.workspaceId);
    res.json({
        workspace: {
            id: req.user.workspaceId,
            name: workspaceMembership(req.user.userId)?.workspace_name || 'SouthFarm workspace',
            bridge_url: workspaceMembership(req.user.userId)?.workspace_bridge_url || null,
            strict_bridge_mode: !!workspaceMembership(req.user.userId)?.workspace_strict_bridge_mode,
        },
        members: members.map(memberUserView),
    });
});
app.patch('/api/team/workspace', auth, requireRole('owner', 'admin'), (req, res) => {
    const membership = workspaceMembership(req.user.userId);
    if (!membership)
        return res.status(403).json({ error: 'User is not a member of a workspace' });
    if ('bridge_url' in req.body) {
        const rawBridgeUrl = stringValue(req.body.bridge_url);
        let bridgeUrl = null;
        if (rawBridgeUrl) {
            try {
                const parsed = new URL(rawBridgeUrl);
                if (!['http:', 'https:'].includes(parsed.protocol))
                    throw new Error('bad protocol');
                bridgeUrl = parsed.toString().replace(/\/$/, '');
            }
            catch {
                return res.status(400).json({ error: 'bridge_url must be a valid http(s) URL' });
            }
        }
        db.prepare('UPDATE workspaces SET bridge_url = ? WHERE id = ?').run(bridgeUrl, membership.workspace_id);
    }
    if ('strict_bridge_mode' in req.body) {
        // Solo el owner enciende el modo estricto: exige bridges registrados y
        // capabilities firmadas; admins operan, el owner decide la política.
        if (normalizeRole(membership.role) !== 'owner') {
            return res.status(403).json({ error: 'Only the workspace owner can change strict_bridge_mode' });
        }
        db.prepare('UPDATE workspaces SET strict_bridge_mode = ? WHERE id = ?')
            .run(req.body.strict_bridge_mode ? 1 : 0, membership.workspace_id);
    }
    const updated = db.prepare('SELECT bridge_url, strict_bridge_mode FROM workspaces WHERE id = ?').get(membership.workspace_id);
    res.json({
        workspace: {
            id: membership.workspace_id,
            name: membership.workspace_name,
            bridge_url: updated?.bridge_url || null,
            strict_bridge_mode: !!updated?.strict_bridge_mode,
        },
    });
});
// ─── Screen bridges (Fase 2): registro, heartbeat, attachments y sesiones ───
// El token del bridge vive en DB (columna token) porque es la llave HMAC con
// la que la API firma capabilities de un solo uso que el bridge valida
// offline. Nunca se devuelve por ninguna ruta de lectura.
const BRIDGE_CAPABILITY_TTL_SECONDS = Math.min(300, Math.max(30, Number(process.env.SOUTHFARM_BRIDGE_CAPABILITY_TTL_SECONDS || 120)));
function screenBridgeAuth(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer '))
        return null;
    const bridge = db.prepare('SELECT * FROM screen_bridges WHERE token_hash = ? LIMIT 1').get(hashInviteToken(header.slice(7)));
    return bridge || null;
}
function bridgeView(bridge) {
    const online = typeof bridge.last_seen_at === 'string'
        && Date.now() - Date.parse(bridge.last_seen_at) <= 120000;
    const attachments = db.prepare(`
    SELECT ba.id, ba.adb_serial, ba.device_id, ba.status, ba.last_seen_at,
           COALESCE(d.device_alias, d.device_name) AS device_alias
    FROM bridge_attachments ba
    LEFT JOIN devices d ON d.id = ba.device_id
    WHERE ba.bridge_id = ?
    ORDER BY ba.adb_serial
  `).all(bridge.id);
    return {
        id: bridge.id,
        workspace_id: bridge.workspace_id,
        name: bridge.name,
        online,
        last_seen_at: bridge.last_seen_at || null,
        version: bridge.version || null,
        // URL pública por bridge (ej. screen-us.southfarm.tech): un workspace puede
        // tener varias computadoras con teléfonos y cada bridge sirve su propio
        // host de streaming.
        public_url: bridge.public_url || null,
        attachments,
    };
}
app.get('/api/bridges', auth, requireRole('owner', 'admin'), (req, res) => {
    const bridges = db.prepare('SELECT * FROM screen_bridges WHERE workspace_id = ? ORDER BY id').all(req.user.workspaceId);
    res.json({ bridges: bridges.map(bridgeView) });
});
app.post('/api/bridges', auth, requireRole('owner', 'admin'), (req, res) => {
    const name = stringValue(req.body.name)?.trim() || 'Screen Bridge';
    let publicUrl = null;
    if (stringValue(req.body.public_url)) {
        try {
            const parsed = new URL(String(req.body.public_url));
            if (!['http:', 'https:'].includes(parsed.protocol))
                throw new Error('bad protocol');
            publicUrl = parsed.toString().replace(/\/$/, '');
        }
        catch {
            return res.status(400).json({ error: 'public_url must be a valid http(s) URL' });
        }
    }
    const rawToken = `sfb_${randomBytes(32).toString('base64url')}`;
    const result = db.prepare('INSERT INTO screen_bridges (workspace_id, name, token, token_hash, public_url) VALUES (?, ?, ?, ?, ?)').run(req.user.workspaceId, name, rawToken, hashInviteToken(rawToken), publicUrl);
    res.status(201).json({
        bridge: { id: Number(result.lastInsertRowid), workspace_id: req.user.workspaceId, name, public_url: publicUrl },
        // El token se muestra UNA vez: se pega en la config del runtime del bridge.
        token: rawToken,
    });
});
app.patch('/api/bridges/:id', auth, requireRole('owner', 'admin'), (req, res) => {
    const bridge = db.prepare('SELECT * FROM screen_bridges WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId);
    if (!bridge)
        return res.status(404).json({ error: 'Bridge not found' });
    if ('name' in req.body) {
        const name = stringValue(req.body.name)?.trim();
        if (name)
            db.prepare('UPDATE screen_bridges SET name = ? WHERE id = ?').run(name, bridge.id);
    }
    if ('public_url' in req.body) {
        const raw = stringValue(req.body.public_url);
        let publicUrl = null;
        if (raw) {
            try {
                const parsed = new URL(raw);
                if (!['http:', 'https:'].includes(parsed.protocol))
                    throw new Error('bad protocol');
                publicUrl = parsed.toString().replace(/\/$/, '');
            }
            catch {
                return res.status(400).json({ error: 'public_url must be a valid http(s) URL' });
            }
        }
        db.prepare('UPDATE screen_bridges SET public_url = ? WHERE id = ?').run(publicUrl, bridge.id);
    }
    const updated = db.prepare('SELECT * FROM screen_bridges WHERE id = ?').get(bridge.id);
    res.json({ bridge: bridgeView(updated) });
});
app.delete('/api/bridges/:id', auth, requireRole('owner', 'admin'), (req, res) => {
    const bridge = db.prepare('SELECT * FROM screen_bridges WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId);
    if (!bridge)
        return res.status(404).json({ error: 'Bridge not found' });
    db.transaction(() => {
        db.prepare('DELETE FROM bridge_attachments WHERE bridge_id = ?').run(bridge.id);
        db.prepare(`
      UPDATE screen_sessions SET status = 'ended', ended_at = ?
      WHERE bridge_id = ? AND status IN ('requested', 'live')
    `).run(nowIso(), bridge.id);
        db.prepare('DELETE FROM screen_bridges WHERE id = ?').run(bridge.id);
    })();
    res.json({ ok: true });
});
app.post('/api/bridges/:id/rotate-token', auth, requireRole('owner', 'admin'), (req, res) => {
    const bridge = db.prepare('SELECT * FROM screen_bridges WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId);
    if (!bridge)
        return res.status(404).json({ error: 'Bridge not found' });
    const rawToken = `sfb_${randomBytes(32).toString('base64url')}`;
    db.prepare('UPDATE screen_bridges SET token = ?, token_hash = ? WHERE id = ?')
        .run(rawToken, hashInviteToken(rawToken), bridge.id);
    res.json({ token: rawToken });
});
app.patch('/api/bridges/:id/attachments', auth, requireRole('owner', 'admin'), (req, res) => {
    const bridge = db.prepare('SELECT * FROM screen_bridges WHERE id = ? AND workspace_id = ?').get(req.params.id, req.user.workspaceId);
    if (!bridge)
        return res.status(404).json({ error: 'Bridge not found' });
    const serial = stringValue(req.body.serial);
    if (!serial)
        return res.status(400).json({ error: 'serial is required' });
    const attachment = db.prepare('SELECT * FROM bridge_attachments WHERE bridge_id = ? AND adb_serial = ?').get(bridge.id, serial);
    if (!attachment)
        return res.status(404).json({ error: 'Attachment not reported by this bridge yet' });
    if (req.body.device_id === null || req.body.device_id === '') {
        db.prepare("UPDATE bridge_attachments SET device_id = NULL, status = 'unassigned' WHERE id = ?")
            .run(attachment.id);
        return res.json({ ok: true, attachment: bridgeView(bridge).attachments.find((a) => a.id === attachment.id) });
    }
    const device = db.prepare(`
    SELECT * FROM devices WHERE id = ? AND workspace_id = ? AND lifecycle_status != 'revoked'
  `).get(Number(req.body.device_id), req.user.workspaceId);
    if (!device)
        return res.status(404).json({ error: 'Device not found in this workspace' });
    // Un device solo puede estar pegado a un serial por bridge: despejo otros.
    db.prepare('UPDATE bridge_attachments SET device_id = NULL, status = ? WHERE bridge_id = ? AND device_id = ?')
        .run('unassigned', bridge.id, device.id);
    db.prepare("UPDATE bridge_attachments SET device_id = ?, status = 'assigned' WHERE id = ?")
        .run(device.id, attachment.id);
    res.json({ ok: true, attachment: bridgeView(bridge).attachments.find((a) => a.id === attachment.id) });
});
app.post('/api/bridges/heartbeat', (req, res) => {
    const bridge = screenBridgeAuth(req);
    if (!bridge)
        return res.status(401).json({ error: 'Invalid bridge token' });
    const now = nowIso();
    const serials = req.body?.serials;
    const list = Array.isArray(serials) ? serials.map(s => stringValue(s)).filter(Boolean) : [];
    db.transaction(() => {
        db.prepare('UPDATE screen_bridges SET last_seen_at = ?, version = ?, auth_failures = ? WHERE id = ?')
            .run(now, stringValue(req.body?.version), Math.max(0, Number(req.body?.auth_failures || 0)), bridge.id);
        const insert = db.prepare(`
      INSERT INTO bridge_attachments (bridge_id, adb_serial, status, last_seen_at)
      VALUES (?, ?, 'unassigned', ?)
      ON CONFLICT(bridge_id, adb_serial) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `);
        for (const serial of list)
            insert.run(bridge.id, serial, now);
        db.prepare(`
      UPDATE bridge_attachments SET status =
        CASE WHEN device_id IS NOT NULL THEN 'assigned' ELSE 'unassigned' END
      WHERE bridge_id = ? AND last_seen_at < ?
    `).run(bridge.id, now);
    })();
    res.json({ ok: true, now });
});
app.get('/api/bridges/session-check', (req, res) => {
    const bridge = screenBridgeAuth(req);
    if (!bridge)
        return res.status(401).json({ error: 'Invalid bridge token' });
    const sessionId = Number(req.query.session_id);
    const session = db.prepare('SELECT * FROM screen_sessions WHERE id = ? AND bridge_id = ?').get(sessionId, bridge.id);
    if (!session)
        return res.json({ status: 'unknown' });
    if (session.status === 'requested' && Date.parse(session.expires_at) > Date.now()) {
        db.prepare("UPDATE screen_sessions SET status = 'live' WHERE id = ?").run(session.id);
        return res.json({ status: 'live' });
    }
    res.json({ status: session.status });
});
function signScreenCapability(payload, bridgeToken) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', bridgeToken).update(body).digest('base64url');
    return `${body}.${sig}`;
}
app.post('/api/devices/:id/screen-session', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const device = db.prepare(`
    SELECT * FROM devices WHERE id = ? AND workspace_id = ? AND lifecycle_status != 'revoked'
  `).get(req.params.id, req.user.workspaceId);
    if (!device)
        return res.status(404).json({ error: 'Device not found' });
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.user.workspaceId);
    if (!workspace?.strict_bridge_mode) {
        return res.status(409).json({
            error: 'Strict bridge mode is disabled for this workspace',
            code: 'STRICT_MODE_DISABLED',
        });
    }
    const attachment = db.prepare(`
    SELECT ba.*, sb.token AS bridge_token, sb.public_url AS bridge_public_url
    FROM bridge_attachments ba
    JOIN screen_bridges sb ON sb.id = ba.bridge_id
    WHERE ba.device_id = ? AND sb.workspace_id = ?
    ORDER BY ba.last_seen_at DESC LIMIT 1
  `).get(device.id, req.user.workspaceId);
    if (!attachment) {
        return res.status(409).json({
            error: 'Device is not attached to any registered bridge',
            code: 'NO_ACTIVE_ATTACHMENT',
        });
    }
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + BRIDGE_CAPABILITY_TTL_SECONDS * 1000);
    const sessionResult = db.prepare(`
    INSERT INTO screen_sessions (workspace_id, device_id, bridge_id, adb_serial, nonce, status, expires_at)
    VALUES (?, ?, ?, ?, ?, 'requested', ?)
  `).run(req.user.workspaceId, device.id, attachment.bridge_id, attachment.adb_serial, nonce, expiresAt.toISOString());
    const sessionId = Number(sessionResult.lastInsertRowid);
    const capability = signScreenCapability({
        v: 1,
        aud: 'screen-bridge',
        session: sessionId,
        ws: req.user.workspaceId,
        dev: device.id,
        br: attachment.bridge_id,
        serial: attachment.adb_serial,
        exp: Math.floor(expiresAt.getTime() / 1000),
        nonce,
    }, attachment.bridge_token);
    // Host de streaming: primero la URL pública del bridge dueño del attachment
    // (soporta varias computadoras por workspace), con fallback al bridge_url
    // del workspace para el caso de un solo bridge.
    const bridgeHost = String(attachment.bridge_public_url || workspace.bridge_url || '')
        .replace(/\/$/, '')
        .replace(/^http/i, 'ws');
    if (!bridgeHost) {
        return res.status(409).json({
            error: 'Bridge has no public URL and workspace has no bridge_url configured',
            code: 'NO_BRIDGE_URL',
        });
    }
    res.status(201).json({
        session_id: sessionId,
        expires_at: expiresAt.toISOString(),
        stream_url: `${bridgeHost}/ws/stream/${encodeURIComponent(attachment.adb_serial)}?cap=${encodeURIComponent(capability)}`,
    });
});
// ─── App móvil: descarga autenticada (el APK NO es público) ───
function signAppDownloadLink(expiresAtEpoch) {
    const payload = String(expiresAtEpoch);
    const sig = createHmac('sha256', JWT_SECRET).update(`app-download:${payload}`).digest('hex').slice(0, 32);
    return `${payload}.${sig}`;
}
app.post('/api/devices/app/install-link', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    if (!existsSync(APP_APK_PATH))
        return res.status(404).json({ error: 'APK no desplegado en el servidor' });
    const expiresAt = Math.floor(Date.now() / 1000) + APP_LINK_TTL_SECONDS;
    res.json({
        path: `/api/devices/app/download/${signAppDownloadLink(expiresAt)}`,
        expires_at: new Date(expiresAt * 1000).toISOString(),
        size_bytes: statSync(APP_APK_PATH).size,
    });
});
app.get('/api/devices/app/download/:token', (req, res) => {
    const [payload, sig] = String(req.params.token || '').split('.');
    const expected = payload ? createHmac('sha256', JWT_SECRET).update(`app-download:${payload}`).digest('hex').slice(0, 32) : '';
    const sigBuf = Buffer.from(String(sig || ''), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (!payload || !sig || sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return res.status(403).json({ error: 'Invalid download link' });
    }
    if (Number(payload) * 1000 < Date.now())
        return res.status(410).json({ error: 'Download link expired' });
    if (!existsSync(APP_APK_PATH))
        return res.status(404).json({ error: 'APK no desplegado en el servidor' });
    res.download(APP_APK_PATH, 'southfarm.apk');
});
app.get('/api/team/invites', auth, requireRole('owner', 'admin'), (req, res) => {
    const invites = db.prepare(`
    SELECT id, email, role, expires_at, invited_by_user_id, accepted_by_user_id,
           accepted_at, created_at
    FROM workspace_invites
    WHERE workspace_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(req.user.workspaceId);
    res.json({ invites });
});
app.post('/api/team/invites', auth, requireRole('owner', 'admin'), (req, res) => {
    const requestedRole = normalizeRole(req.body.role, 'viewer');
    const email = stringValue(req.body.email)?.toLowerCase() || null;
    const expiresInDays = Math.min(30, Math.max(1, numberValue(req.body.expires_in_days, 7)));
    if (requestedRole === 'owner')
        return res.status(400).json({ error: 'Owner invitations are not supported' });
    if (requestedRole === 'admin' && req.user.role !== 'owner') {
        return res.status(403).json({ error: 'Only the owner can invite an admin' });
    }
    const rawToken = `${randomUUID()}${randomUUID()}`;
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(`
    INSERT INTO workspace_invites
      (workspace_id, email, role, token_hash, expires_at, invited_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.workspaceId, email, requestedRole, hashInviteToken(rawToken), expiresAt, req.user.userId);
    res.status(201).json({
        invite: {
            id: result.lastInsertRowid,
            email,
            role: requestedRole,
            expires_at: expiresAt,
            token: rawToken,
        },
    });
});
app.patch('/api/team/members/:userId', auth, requireRole('owner', 'admin'), (req, res) => {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0)
        return res.status(400).json({ error: 'Invalid user id' });
    const target = db.prepare(`
    SELECT wm.*, u.email, u.name
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND wm.user_id = ?
  `).get(req.user.workspaceId, targetUserId);
    if (!target)
        return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner')
        return res.status(409).json({ error: 'The workspace owner cannot be modified' });
    const nextRole = req.body.role === undefined ? normalizeRole(target.role) : normalizeRole(req.body.role);
    const nextStatus = req.body.status === undefined ? target.status : String(req.body.status).toLowerCase();
    if (nextRole === 'owner')
        return res.status(400).json({ error: 'Owner role cannot be assigned' });
    if (!['active', 'disabled'].includes(nextStatus))
        return res.status(400).json({ error: 'Unsupported member status' });
    if (req.user.role === 'admin' && nextRole === 'admin') {
        return res.status(403).json({ error: 'Only the owner can assign admin role' });
    }
    db.prepare(`
    UPDATE workspace_members
    SET role = ?, status = ?, updated_at = ?
    WHERE workspace_id = ? AND user_id = ?
  `).run(nextRole, nextStatus, nowIso(), req.user.workspaceId, targetUserId);
    const updated = db.prepare(`
    SELECT wm.user_id, wm.role, wm.status, wm.created_at, u.email, u.name
    FROM workspace_members wm JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ? AND wm.user_id = ?
  `).get(req.user.workspaceId, targetUserId);
    res.json({ member: memberUserView(updated) });
});
// ─── Devices ───
function pairingCode() {
    return randomBytes(4).toString('hex').toUpperCase();
}
function pairingAccessKey() {
    return `sfpk_${randomBytes(24).toString('base64url')}`;
}
app.post('/api/devices/pairing-codes', auth, requireRole('owner', 'admin'), (req, res) => {
    const code = pairingCode();
    const accessKey = pairingAccessKey();
    const expiresAt = new Date(Date.now() + DEVICE_PAIRING_WINDOW_MINUTES * 60 * 1000).toISOString();
    const result = db.prepare(`
    INSERT INTO device_pairings
      (workspace_id, created_by_user_id, code_hash, access_key_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.user.workspaceId, req.user.userId, hashInviteToken(code), hashInviteToken(accessKey), expiresAt);
    const qrPayload = JSON.stringify({
        v: 1,
        type: 'southfarm_device_pairing',
        api: process.env.SOUTHFARM_PUBLIC_API_BASE || 'https://api.southfarm.tech/api',
        code,
        access_key: accessKey,
        expires_at: expiresAt,
    });
    res.status(201).json({
        pairing: {
            id: result.lastInsertRowid,
            code,
            access_key: accessKey,
            qr_payload: qrPayload,
            expires_at: expiresAt,
        },
    });
});
app.post('/api/devices/claim', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    if (req.user.authType === 'device')
        return res.status(403).json({ error: 'A user session is required to claim a device' });
    const code = stringValue(req.body.code || req.body.pairing_code)?.toUpperCase();
    const accessKey = stringValue(req.body.access_key || req.body.key);
    const installationId = deviceInstallationId(req.body);
    if (!code || !accessKey || !installationId) {
        return res.status(400).json({ error: 'code, access_key and installation_id are required' });
    }
    const pairing = db.prepare(`
    SELECT * FROM device_pairings
    WHERE workspace_id = ?
      AND code_hash = ?
      AND access_key_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
    ORDER BY id DESC LIMIT 1
  `).get(req.user.workspaceId, hashInviteToken(code), hashInviteToken(accessKey), nowIso());
    if (!pairing)
        return res.status(400).json({ error: 'Pairing code or access key is invalid or expired' });
    const payload = {
        ...req.body,
        installation_id: installationId,
        device_id: stringValue(req.body.device_id) || installationId,
    };
    const seenAt = nowIso();
    let device;
    let deviceToken = '';
    try {
        device = db.transaction(() => {
            // Re-pairing the same Android installation replaces the previous
            // registration instead of leaving another visible fleet row behind.
            db.prepare(`
        UPDATE devices
        SET lifecycle_status = 'revoked', revoked_at = ?, device_token_hash = NULL
        WHERE workspace_id = ? AND device_id = ?
          AND lifecycle_status != 'revoked'
          AND (installation_id IS NULL OR installation_id != ?)
      `).run(seenAt, req.user.workspaceId, payload.device_id, installationId);
            const claimed = touchDevice(req.user.userId, payload, { allowCreate: true, mode: 'enroll' });
            deviceToken = issueDeviceToken(Number(claimed.id), { rotateVersion: true });
            db.prepare(`
        UPDATE device_pairings
        SET consumed_at = ?, consumed_by_user_id = ?, consumed_device_id = ?
        WHERE id = ? AND consumed_at IS NULL
      `).run(seenAt, req.user.userId, claimed.id, pairing.id);
            return db.prepare('SELECT * FROM devices WHERE id = ?').get(claimed.id);
        })();
    }
    catch (error) {
        if (String(error?.message || '').includes('UNIQUE')) {
            return res.status(409).json({ error: 'This installation is already paired with the workspace' });
        }
        return res.status(400).json({ error: error.message || 'Could not claim device' });
    }
    res.status(201).json({ ok: true, device_token: deviceToken, device: deviceView(device) });
});
app.post('/api/devices/register', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    try {
        const existing = findDeviceFromPayload(req.user.userId, req.body);
        if (!existing) {
            return res.status(409).json({
                error: 'Device is not paired with this workspace',
                code: 'DEVICE_NOT_PAIRED',
            });
        }
        const device = touchDevice(req.user.userId, req.body, { mode: 'register' });
        // Este endpoint SOLO re-registra dispositivos ya emparejados (si no existe
        // la fila responde 409 y el emparejamiento real ocurre en /devices/claim).
        //
        // Cuándo devolver device_token:
        // - JWT de USUARIO → SÍ: el teléfono puede haber perdido su device_token
        //   (reinstalación borra SharedPreferences) y necesita uno para que el
        //   servicio de accesibilidad pueda hacer heartbeat. Es seguro: el register
        //   corre al inicio de la app, no durante tareas.
        // - Token de DISPOSITIVO → NO: rotar invalidaría el token que la tarea
        //   remota capturó al reclamar, rompiendo tareas en curso.
        if (req.user.authType === 'user') {
            const deviceToken = issueDeviceToken(Number(device.id));
            return res.status(200).json({ device: deviceView(device), device_token: deviceToken });
        }
        // Llamada con token de dispositivo: solo refresh de presencia.
        res.status(200).json({ device: deviceView(device) });
    }
    catch (error) {
        res.status(error.code === 'DEVICE_NOT_PAIRED' ? 409 : 400).json({
            error: error.message || 'device_id required',
            ...(error.code ? { code: error.code } : {}),
        });
    }
});
app.post('/api/devices/heartbeat', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    // Presence comes from the paired device agent itself. A user JWT must not
    // be able to keep a device row "online" on the phone's behalf.
    if (req.user.authType !== 'device') {
        return res.status(403).json({ error: 'Device token required', code: 'DEVICE_TOKEN_REQUIRED' });
    }
    try {
        const device = touchDevice(req.user.userId, req.body, { mode: 'presence' });
        res.json({
            ok: true,
            server_time: nowIso(),
            device: deviceView(device),
        });
    }
    catch (error) {
        res.status(error.code === 'DEVICE_NOT_PAIRED' ? 409 : 400).json({
            error: error.message || 'device_id required',
            ...(error.code ? { code: error.code } : {}),
        });
    }
});
app.get('/api/devices', auth, (req, res) => {
    // Incluye revocados al final: la flota debe poder mostrarlos como estado
    // (Fase 4); los consumidores que ejecutan acciones ya filtran lifecycle.
    const devices = db.prepare(`
    SELECT * FROM devices
    WHERE workspace_id = ?
    ORDER BY (lifecycle_status = 'revoked') ASC, id
  `).all(req.user.workspaceId);
    res.json({ devices: devices.map(deviceView) });
});
// ─── Workspace execution controls ───
// These controls are durable workspace state. Phones poll the device-scoped
// endpoint below, while the command center uses the workspace endpoints.
app.get('/api/workspace/control', auth, (req, res) => {
    res.json({ control: workspaceControlView(req.user.workspaceId) });
});
app.patch('/api/workspace/control', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    if (req.user.authType === 'device')
        return res.status(403).json({ error: 'A user session is required to change workspace controls' });
    const current = ensureWorkspaceControl(req.user.workspaceId);
    if (normalizeSchedulerControlMode(current.scheduler_mode) === 'paused') {
        return res.status(409).json({ error: 'El workspace está en pausa general; usá Reanudar actividades primero' });
    }
    const requestedMode = req.body.scheduler_mode === undefined
        ? normalizeSchedulerControlMode(current.scheduler_mode)
        : normalizeSchedulerControlMode(req.body.scheduler_mode);
    if (requestedMode === 'paused') {
        return res.status(400).json({ error: 'La pausa general requiere el endpoint de pausa segura' });
    }
    const queuePaused = req.body.queue_paused === undefined
        ? Boolean(Number(current.queue_paused || 0))
        : Boolean(req.body.queue_paused);
    const now = nowIso();
    db.prepare(`
    UPDATE workspace_controls
    SET scheduler_mode = ?, queue_paused = ?, control_version = control_version + 1,
        updated_at = ?, updated_by_user_id = ?
    WHERE workspace_id = ?
  `).run(requestedMode, queuePaused ? 1 : 0, now, req.user.userId, req.user.workspaceId);
    res.json({ ok: true, control: workspaceControlView(req.user.workspaceId) });
});
app.post('/api/workspace/control/pause-general', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    if (req.user.authType === 'device')
        return res.status(403).json({ error: 'A user session is required to pause the workspace' });
    const workspaceId = Number(req.user.workspaceId);
    const now = nowIso();
    const result = db.transaction(() => {
        const current = ensureWorkspaceControl(workspaceId);
        const currentMode = normalizeSchedulerControlMode(current.scheduler_mode);
        let controlVersion = Number(current.control_version || 0);
        if (currentMode !== 'paused') {
            controlVersion += 1;
            db.prepare(`
        UPDATE workspace_controls
        SET scheduler_mode = 'paused',
            queue_paused = 1,
            previous_scheduler_mode = ?,
            previous_queue_paused = ?,
            control_version = ?,
            updated_at = ?,
            updated_by_user_id = ?
        WHERE workspace_id = ?
      `).run(currentMode, Number(current.queue_paused || 0), controlVersion, now, req.user.userId, workspaceId);
        }
        const activeTasks = db.prepare(`
      SELECT * FROM task_runs
      WHERE workspace_id = ? AND status = 'running'
      ORDER BY device_id ASC, id ASC
    `).all(workspaceId);
        for (const task of activeTasks) {
            const update = db.prepare(`
        UPDATE task_runs
        SET status = 'paused',
            lease_expires_at = NULL,
            pause_requested_at = COALESCE(pause_requested_at, ?),
            pause_acknowledged_at = NULL,
            pause_reason = 'general_pause',
            updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(now, now, task.id);
            if (update.changes !== 1)
                continue;
            const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(task.id);
            recordTaskEvent(updated, 'pause_requested_general', {
                control_version: controlVersion,
            });
            createTaskNotification(updated, 'task_paused_general', 'info', 'Actividad pausada', 'La pausa general detuvo la tarea #' + task.id + ' y espera reanudación.', { control_version: controlVersion, reason: 'general_pause' });
        }
        db.prepare(`
      UPDATE devices
      SET control_state = 'requested'
      WHERE workspace_id = ? AND lifecycle_status != 'revoked'
    `).run(workspaceId);
        return { active_tasks: activeTasks.length, control_version: controlVersion };
    })();
    res.json({
        ok: true,
        requested: true,
        active_tasks: result.active_tasks,
        control: workspaceControlView(workspaceId),
    });
});
app.post('/api/workspace/control/resume', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    if (req.user.authType === 'device')
        return res.status(403).json({ error: 'A user session is required to resume the workspace' });
    const workspaceId = Number(req.user.workspaceId);
    const now = nowIso();
    const result = db.transaction(() => {
        const current = ensureWorkspaceControl(workspaceId);
        if (normalizeSchedulerControlMode(current.scheduler_mode) !== 'paused') {
            return { resumed_tasks: 0, already_resumed: true };
        }
        const nextMode = normalizeSchedulerControlMode(current.previous_scheduler_mode);
        const nextQueuePaused = Boolean(Number(current.previous_queue_paused || 0));
        const nextVersion = Number(current.control_version || 0) + 1;
        db.prepare(`
      UPDATE workspace_controls
      SET scheduler_mode = ?, queue_paused = ?,
          previous_scheduler_mode = 'normal', previous_queue_paused = 0,
          control_version = ?, updated_at = ?, updated_by_user_id = ?
      WHERE workspace_id = ?
    `).run(nextMode, nextQueuePaused ? 1 : 0, nextVersion, now, req.user.userId, workspaceId);
        const pausedTasks = db.prepare(`
      SELECT * FROM task_runs
      WHERE workspace_id = ? AND status = 'paused' AND pause_reason = 'general_pause'
      ORDER BY device_id ASC, id ASC
    `).all(workspaceId);
        for (const task of pausedTasks) {
            const nextStatus = task.claim_token ? 'running' : 'pending';
            db.prepare(`
        UPDATE task_runs
        SET status = ?,
            lease_expires_at = ?,
            pause_requested_at = NULL,
            pause_acknowledged_at = NULL,
            pause_reason = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'paused' AND pause_reason = 'general_pause'
      `).run(nextStatus, nextStatus === 'running' ? taskLeaseExpiresAt() : null, now, task.id);
            const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(task.id);
            recordTaskEvent(updated, 'resumed_general', {
                control_version: nextVersion,
                status: nextStatus,
            });
        }
        db.prepare(`
      UPDATE devices
      SET control_state = 'requested'
      WHERE workspace_id = ? AND lifecycle_status != 'revoked'
    `).run(workspaceId);
        return { resumed_tasks: pausedTasks.length, already_resumed: false };
    })();
    res.json({
        ok: true,
        resumed_tasks: result.resumed_tasks,
        control: workspaceControlView(workspaceId),
    });
});
app.get('/api/devices/control', auth, (req, res) => {
    const device = findDeviceForWorkspace(req.user.userId, req.query.device_id, true, req.query.installation_id);
    if (!device)
        return res.status(404).json({ error: 'Device not found in workspace' });
    const control = workspaceControlView(Number(device.workspace_id || req.user.workspaceId));
    const deviceState = control.devices.find((item) => Number(item.id) === Number(device.id));
    const activeTask = activeTaskForDevice(Number(device.id));
    res.json({
        control: {
            workspace_id: control.workspace_id,
            scheduler_mode: control.scheduler_mode,
            queue_paused: control.queue_paused,
            control_version: control.control_version,
            updated_at: control.updated_at,
        },
        device: deviceState || null,
        active_task: activeTask ? taskView(activeTask) : null,
    });
});
app.post('/api/devices/control/ack', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const device = findDeviceForWorkspace(req.user.userId, req.body.device_id, true, req.body.installation_id);
    if (!device)
        return res.status(404).json({ error: 'Device not found in workspace' });
    const workspaceId = Number(device.workspace_id || req.user.workspaceId);
    const control = ensureWorkspaceControl(workspaceId);
    const requestedVersion = numberValue(req.body.control_version, Number(control.control_version || 0));
    if (requestedVersion > Number(control.control_version || 0)) {
        return res.status(409).json({ error: 'Control version is newer than the workspace state' });
    }
    const state = ['paused', 'resumed', 'idle', 'requested'].includes(String(req.body.state || ''))
        ? String(req.body.state)
        : 'idle';
    acknowledgeDeviceControl(Number(device.id), requestedVersion, state);
    res.json({ ok: true, control: workspaceControlView(workspaceId) });
});
app.patch('/api/devices/:id', auth, requireRole('owner', 'admin'), (req, res) => {
    const hasAlias = Object.prototype.hasOwnProperty.call(req.body || {}, 'alias')
        || Object.prototype.hasOwnProperty.call(req.body || {}, 'device_alias');
    if (!hasAlias)
        return res.status(400).json({ error: 'alias is required' });
    try {
        const rawAlias = Object.prototype.hasOwnProperty.call(req.body || {}, 'alias')
            ? req.body.alias
            : req.body.device_alias;
        const alias = normalizeDeviceAlias(rawAlias);
        const result = db.prepare(`
      UPDATE devices
      SET device_alias = ?
      WHERE id = ? AND workspace_id = ? AND lifecycle_status != 'revoked'
    `).run(alias, Number(req.params.id), req.user.workspaceId);
        if (!result.changes)
            return res.status(404).json({ error: 'Device not found' });
        const device = db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ?')
            .get(Number(req.params.id), req.user.workspaceId);
        res.json({ device: deviceView(device) });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Invalid device alias' });
    }
});
app.delete('/api/devices/:id', auth, requireRole('owner', 'admin'), (req, res) => {
    const now = nowIso();
    const r = db.transaction(() => {
        const update = db.prepare(`
      UPDATE devices
      SET lifecycle_status = 'revoked', revoked_at = ?, device_token_hash = NULL,
          agent_token_version = agent_token_version + 1
      WHERE id = ? AND workspace_id = ? AND lifecycle_status != 'revoked'
    `).run(now, req.params.id, req.user.workspaceId);
        if (update.changes > 0) {
            // Cascada de streaming: las sesiones activas pasan a 'revoked' (el bridge
            // las corta en su próximo session-check, ≤ 30 s) y el serial queda
            // desasignado hasta que un admin lo mapee de nuevo.
            db.prepare(`
        UPDATE screen_sessions SET status = 'revoked', ended_at = ?
        WHERE device_id = ? AND status IN ('requested', 'live')
      `).run(now, req.params.id);
            db.prepare(`
        UPDATE bridge_attachments SET device_id = NULL, status = 'unassigned'
        WHERE device_id = ?
      `).run(req.params.id);
        }
        return update;
    })();
    r.changes
        ? res.json({ ok: true, status: 'revoked' })
        : res.status(404).json({ error: 'Device not found' });
});
// ─── Fase 5: reconciliador de la flota (detección de contradicciones) ───
// Corre dentro del proceso del API: compara los tres planos (API, bridges,
// teléfonos) y levanta/resuelve alertas. Nunca borra ni corrige datos por su
// cuenta: las correcciones conflictivas quedan para resolución manual.
const RECONCILER_INTERVAL_MS = Math.max(1000, Number(process.env.SOUTHFARM_RECONCILER_INTERVAL_MS || 60000));
const RECON_BRIDGE_OFFLINE_MS = Math.max(5000, Number(process.env.SOUTHFARM_RECON_BRIDGE_OFFLINE_MS || 300000));
const RECON_ATTACHMENT_STALE_MS = Math.max(5000, Number(process.env.SOUTHFARM_RECON_ATTACHMENT_STALE_MS || 300000));
const RECON_REVOKED_ACTIVITY_MS = Math.max(5000, Number(process.env.SOUTHFARM_RECON_REVOKED_ACTIVITY_MS || 120000));
const reconKey = (refs) => `${refs.device_id ?? ''}|${refs.adb_serial ?? ''}|${refs.bridge_id ?? ''}`;
function raiseReconciliationAlert(workspaceId, kind, severity, detail, refs) {
    const now = nowIso();
    const existing = db.prepare(`
    SELECT id, occurrences FROM reconciliation_alerts
    WHERE workspace_id = ? AND kind = ? AND status = 'open'
      AND device_id IS ? AND bridge_id IS ? AND adb_serial IS ?
    LIMIT 1
  `).get(workspaceId, kind, refs.device_id ?? null, refs.bridge_id ?? null, refs.adb_serial ?? null);
    if (existing) {
        db.prepare(`
      UPDATE reconciliation_alerts
      SET occurrences = occurrences + 1, last_seen_at = ?, detail = ?, severity = ?
      WHERE id = ?
    `).run(now, detail, severity, existing.id);
    }
    else {
        db.prepare(`
      INSERT INTO reconciliation_alerts
        (workspace_id, kind, severity, device_id, bridge_id, adb_serial, detail, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(workspaceId, kind, severity, refs.device_id ?? null, refs.bridge_id ?? null, refs.adb_serial ?? null, detail, now, now);
        console.warn(`[Reconciler] alerta ${kind} (${severity}) ws=${workspaceId}: ${detail}`);
    }
}
function resolveStaleReconciliationAlerts(workspaceId, kind, keepKeys) {
    const open = db.prepare(`
    SELECT id, device_id, adb_serial, bridge_id FROM reconciliation_alerts
    WHERE workspace_id = ? AND kind = ? AND status = 'open'
  `).all(workspaceId, kind);
    for (const alert of open) {
        const key = reconKey({ device_id: alert.device_id, adb_serial: alert.adb_serial, bridge_id: alert.bridge_id });
        if (!keepKeys.has(key)) {
            db.prepare(`
        UPDATE reconciliation_alerts SET status = 'resolved', resolved_at = ?, resolved_by = 'reconciliador'
        WHERE id = ? AND status = 'open'
      `).run(nowIso(), alert.id);
        }
    }
}
function runReconciliation() {
    const now = nowIso();
    const workspaces = db.prepare('SELECT id FROM workspaces ORDER BY id').all();
    for (const ws of workspaces) {
        const wid = Number(ws.id);
        // Regla 1: un dispositivo mapeado en más de un bridge o con más de un serial.
        const conflicts = db.prepare(`
      SELECT ba.device_id,
             COUNT(DISTINCT ba.bridge_id) AS bridges,
             COUNT(DISTINCT ba.adb_serial) AS serials,
             GROUP_CONCAT(DISTINCT sb.name) AS bridge_names,
             GROUP_CONCAT(DISTINCT ba.adb_serial) AS serial_list
      FROM bridge_attachments ba
      JOIN screen_bridges sb ON sb.id = ba.bridge_id
      WHERE ba.device_id IS NOT NULL AND sb.workspace_id = ?
      GROUP BY ba.device_id
      HAVING COUNT(DISTINCT ba.bridge_id) > 1 OR COUNT(DISTINCT ba.adb_serial) > 1
    `).all(wid);
        const conflictKeys = new Set();
        for (const conflict of conflicts) {
            conflictKeys.add(reconKey({ device_id: Number(conflict.device_id) }));
            raiseReconciliationAlert(wid, 'serial_conflict', 'critical', `Dispositivo mapeado en ${conflict.bridges} bridge(s) (${conflict.bridge_names}) y ${conflict.serials} serial(es): ${conflict.serial_list}. Resolver manualmente desde el panel.`, { device_id: Number(conflict.device_id), adb_serial: conflict.serial_list });
        }
        resolveStaleReconciliationAlerts(wid, 'serial_conflict', conflictKeys);
        // Regla 2: bridge sin reportar dentro de la ventana (offline).
        const bridges = db.prepare(`
      SELECT id, name, last_seen_at, auth_failures FROM screen_bridges WHERE workspace_id = ?
    `).all(wid);
        const offlineKeys = new Set();
        for (const bridge of bridges) {
            const seenMs = bridge.last_seen_at ? Date.now() - Date.parse(bridge.last_seen_at) : Number.POSITIVE_INFINITY;
            if (seenMs > RECON_BRIDGE_OFFLINE_MS) {
                offlineKeys.add(reconKey({ bridge_id: Number(bridge.id) }));
                raiseReconciliationAlert(wid, 'bridge_offline', 'warn', `El bridge «${bridge.name}» no reporta desde ${bridge.last_seen_at || 'nunca'}.`, { bridge_id: Number(bridge.id) });
            }
        }
        resolveStaleReconciliationAlerts(wid, 'bridge_offline', offlineKeys);
        // Regla 3: attachment asignado cuyo bridge dejó de verlo (stale).
        const staleAttachments = db.prepare(`
      SELECT ba.id, ba.device_id, ba.adb_serial, ba.last_seen_at, sb.name AS bridge_name, sb.id AS bridge_id
      FROM bridge_attachments ba
      JOIN screen_bridges sb ON sb.id = ba.bridge_id
      WHERE sb.workspace_id = ? AND ba.device_id IS NOT NULL
    `).all(wid); // el filtro por antigüedad se hace en JS (compara timestamps ISO)
        const staleKeys = new Set();
        for (const att of staleAttachments) {
            const seenMs = att.last_seen_at ? Date.now() - Date.parse(att.last_seen_at) : Number.POSITIVE_INFINITY;
            if (seenMs <= RECON_ATTACHMENT_STALE_MS)
                continue;
            staleKeys.add(reconKey({ device_id: Number(att.device_id), adb_serial: att.adb_serial, bridge_id: Number(att.bridge_id) }));
            raiseReconciliationAlert(wid, 'attachment_stale', 'info', `El serial ${att.adb_serial} (asignado) no es visto por «${att.bridge_name}» desde ${att.last_seen_at || 'nunca'}.`, { device_id: Number(att.device_id), adb_serial: att.adb_serial, bridge_id: Number(att.bridge_id) });
        }
        resolveStaleReconciliationAlerts(wid, 'attachment_stale', staleKeys);
        // Regla 4: dispositivo revocado con señal reciente (anomalía de seguridad).
        const revokedCutoff = new Date(Date.now() - RECON_REVOKED_ACTIVITY_MS).toISOString();
        const revokedActive = db.prepare(`
      SELECT id, device_alias, device_name, last_seen_at FROM devices
      WHERE workspace_id = ? AND lifecycle_status = 'revoked'
        AND last_seen_at IS NOT NULL AND last_seen_at > ?
    `).all(wid, revokedCutoff);
        const revokedKeys = new Set();
        for (const device of revokedActive) {
            revokedKeys.add(reconKey({ device_id: Number(device.id) }));
            raiseReconciliationAlert(wid, 'revoked_activity', 'critical', `El dispositivo revocado «${device.device_alias || device.device_name || device.id}» tiene señal de heartbeat reciente (${device.last_seen_at}). Investigar.`, { device_id: Number(device.id) });
        }
        resolveStaleReconciliationAlerts(wid, 'revoked_activity', revokedKeys);
        // Regla 5: el bridge reportó rechazos de autenticación en su último ciclo.
        const authFailKeys = new Set();
        for (const bridge of bridges) {
            const failures = Number(bridge.auth_failures || 0);
            if (failures > 0) {
                authFailKeys.add(reconKey({ bridge_id: Number(bridge.id) }));
                raiseReconciliationAlert(wid, 'auth_failures', 'warn', `«${bridge.name}» reportó ${failures} rechazo(s) de autenticación desde su último reporte (token o capability inválidos).`, { bridge_id: Number(bridge.id) });
            }
        }
        resolveStaleReconciliationAlerts(wid, 'auth_failures', authFailKeys);
        // Limpieza silenciosa: sesiones de pantalla vencidas que quedaron abiertas.
        db.prepare(`
      UPDATE screen_sessions SET status = 'ended', ended_at = ?
      WHERE workspace_id = ? AND status IN ('requested', 'live') AND expires_at <= ?
    `).run(now, wid, now);
    }
}
app.get('/api/reconciliation/alerts', auth, requireRole('owner', 'admin'), (req, res) => {
    const alerts = db.prepare(`
    SELECT * FROM reconciliation_alerts
    WHERE workspace_id = ? AND status = 'open'
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, last_seen_at DESC
  `).all(req.user.workspaceId);
    res.json({ alerts });
});
app.post('/api/reconciliation/alerts/:id/resolve', auth, requireRole('owner', 'admin'), (req, res) => {
    const alert = db.prepare('SELECT * FROM reconciliation_alerts WHERE id = ? AND workspace_id = ? AND status = ?').get(req.params.id, req.user.workspaceId, 'open');
    if (!alert)
        return res.status(404).json({ error: 'Alert not found' });
    db.prepare(`
    UPDATE reconciliation_alerts SET status = 'resolved', resolved_at = ?, resolved_by = ?
    WHERE id = ?
  `).run(nowIso(), req.user.email || 'owner', alert.id);
    res.json({ ok: true });
});
app.get('/api/reconciliation/overview', auth, requireRole('owner', 'admin'), (req, res) => {
    const wid = req.user.workspaceId;
    const devices = db.prepare(`
    SELECT lifecycle_status, last_seen_at FROM devices WHERE workspace_id = ?
  `).all(wid);
    const onlineCutoff = new Date(Date.now() - DEVICE_ONLINE_WINDOW_SECONDS * 1000).toISOString();
    res.json({
        devices: {
            total: devices.length,
            enrolled: devices.filter(d => d.lifecycle_status === 'enrolled' || d.lifecycle_status === 'active').length,
            revoked: devices.filter(d => d.lifecycle_status === 'revoked').length,
            agents_online: devices.filter(d => d.lifecycle_status !== 'revoked' && d.last_seen_at && d.last_seen_at > onlineCutoff).length,
        },
        bridges: {
            total: Number(db.prepare('SELECT COUNT(*) AS n FROM screen_bridges WHERE workspace_id = ?').get(wid).n),
            online: Number(db.prepare(`
        SELECT COUNT(*) AS n FROM screen_bridges
        WHERE workspace_id = ? AND last_seen_at IS NOT NULL AND last_seen_at > ?
      `).get(wid, new Date(Date.now() - 120000).toISOString()).n),
            auth_failures_last_report: Number(db.prepare('SELECT COALESCE(SUM(auth_failures), 0) AS n FROM screen_bridges WHERE workspace_id = ?').get(wid).n),
        },
        attachments: {
            assigned: Number(db.prepare(`
        SELECT COUNT(*) AS n FROM bridge_attachments ba JOIN screen_bridges sb ON sb.id = ba.bridge_id
        WHERE sb.workspace_id = ? AND ba.device_id IS NOT NULL
      `).get(wid).n),
            unassigned: Number(db.prepare(`
        SELECT COUNT(*) AS n FROM bridge_attachments ba JOIN screen_bridges sb ON sb.id = ba.bridge_id
        WHERE sb.workspace_id = ? AND ba.device_id IS NULL
      `).get(wid).n),
        },
        sessions_live: Number(db.prepare(`
      SELECT COUNT(*) AS n FROM screen_sessions WHERE workspace_id = ? AND status = 'live'
    `).get(wid).n),
        open_alerts: db.prepare(`
      SELECT severity, COUNT(*) AS n FROM reconciliation_alerts
      WHERE workspace_id = ? AND status = 'open' GROUP BY severity
    `).all(wid),
    });
});
// Agenda el reconciliador: primera corrida temprana tras el arranque.
let reconciliationTimer = setInterval(() => {
    try {
        runReconciliation();
    }
    catch (error) {
        console.error('[Reconciler] corrida falló:', error instanceof Error ? error.message : error);
    }
}, RECONCILER_INTERVAL_MS);
if (typeof reconciliationTimer.unref === 'function')
    reconciliationTimer.unref();
setTimeout(() => {
    try {
        runReconciliation();
    }
    catch (error) {
        console.error('[Reconciler] corrida inicial falló:', error instanceof Error ? error.message : error);
    }
}, 8000).unref();
// ─── Tasks ───
app.get('/api/tasks', (_req, res) => {
    res.json({ tasks: [
            { id: 'warmup_ig', name: 'Warmup Instagram', description: 'Navega y simula actividad en IG' },
            { id: 'warmup_tiktok', name: 'Warmup TikTok', description: 'Navega y simula actividad en TikTok' },
            { id: 'warmup_youtube', name: 'Warmup YouTube Shorts', description: 'Navega, marca Me gusta y guarda Shorts' },
            { id: 'scan_instagram', name: 'Scan Instagram', description: 'Detecta las cuentas de Instagram del teléfono' },
            { id: 'scan_tiktok', name: 'Scan TikTok', description: 'Detecta las cuentas de TikTok del teléfono' },
            { id: 'scan_youtube', name: 'Scan YouTube', description: 'Detecta los canales de YouTube del teléfono' },
            { id: 'publish_reel', name: 'Publicar Reel', description: 'Publica un video como reel' },
        ] });
});
app.post('/api/tasks/run', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { task_type, device_id, params } = req.body;
    if (!task_type || typeof task_type !== 'string')
        return res.status(400).json({ error: 'task_type required' });
    if (!SUPPORTED_TASK_TYPES.has(task_type))
        return res.status(400).json({ error: 'Unsupported task_type' });
    // Un token de dispositivo solo puede crear runs para SU teléfono.
    const runCreateDeviceScope = deviceScopedId(req);
    let device;
    if (runCreateDeviceScope !== null) {
        device = db.prepare("SELECT * FROM devices WHERE id = ? AND lifecycle_status != 'revoked'").get(runCreateDeviceScope);
        if (device && device_id && stringValue(device_id) && String(device_id) !== String(device.device_id)) {
            return res.status(403).json({ error: 'A device token can only create runs for its own device' });
        }
    }
    else {
        device = findDeviceForWorkspace(req.user.userId, device_id);
    }
    if (!device)
        return res.status(404).json({ error: 'Assigned device not found' });
    // Normalize account in params: strip leading @
    let normalizedParams = params;
    if (params && typeof params === 'object' && params.account) {
        normalizedParams = { ...params, account: params.account.replace(/^@+/, '') };
    }
    const paramsObject = parseParams(normalizedParams);
    const platform = normalizePlatform(paramsObject.platform, platformForWarmupTask(task_type));
    const explicitAccountId = req.body.social_account_id ?? paramsObject.social_account_id;
    const socialAccountId = explicitAccountId === undefined || explicitAccountId === null || explicitAccountId === ''
        ? null
        : Number(explicitAccountId);
    let socialAccount = null;
    if (socialAccountId !== null) {
        if (!Number.isInteger(socialAccountId) || socialAccountId <= 0) {
            return res.status(400).json({ error: 'Invalid social_account_id' });
        }
        socialAccount = db.prepare(`
      SELECT * FROM social_accounts
      WHERE id = ? AND user_id = ? AND device_id = ?
      LIMIT 1
    `).get(socialAccountId, device.user_id, device.id);
        if (!socialAccount)
            return res.status(404).json({ error: 'Social account not found on assigned device' });
    }
    const account = String(socialAccount?.username || paramsObject.account || '').replace(/^@+/, '').trim();
    const accountKey = socialAccount?.account_key
        || accountKeyFor(device.user_id, Number(device.id), socialAccount?.platform || platform, account);
    const source = req.body.source === 'automatic' ? 'automatic' : 'manual';
    const durationFromBody = req.body.duration_seconds ?? paramsObject.duration_seconds;
    const durationFromMinutes = paramsObject.duration_minutes;
    const plannedDurationSeconds = durationFromBody !== undefined
        ? numberValue(durationFromBody)
        : durationFromMinutes !== undefined
            ? numberValue(durationFromMinutes) * 60
            : null;
    const scheduledInput = req.body.scheduled_for ?? req.body.schedule_at ?? req.body.run_at;
    const createdAt = nowIso();
    let scheduledFor = createdAt;
    if (scheduledInput !== undefined && scheduledInput !== null && String(scheduledInput).trim()) {
        const scheduledTimestamp = Date.parse(String(scheduledInput));
        if (!Number.isFinite(scheduledTimestamp)) {
            return res.status(400).json({ error: 'scheduled_for must be a valid ISO date' });
        }
        scheduledFor = new Date(scheduledTimestamp).toISOString();
    }
    const overdueAt = overdueAtIso(scheduledFor);
    const expiresAt = expiresAtIso(scheduledFor);
    const workspaceId = Number(device.workspace_id || req.user.workspaceId);
    const control = ensureWorkspaceControl(workspaceId);
    if (normalizeSchedulerControlMode(control.scheduler_mode) === 'paused') {
        return res.status(409).json({ error: 'El workspace está en pausa general; reanudá las actividades antes de agregar tareas' });
    }
    if (source === 'automatic' && workspaceControlBlocksAutomatic(control)) {
        return res.status(409).json({ error: 'La cola automática está pausada; reanudá la cola o usá una tarea manual' });
    }
    const priority = source === 'manual'
        ? 1000
        : Math.max(0, Math.min(500, numberValue(req.body.priority)));
    const planItemId = req.body.plan_item_id === undefined || req.body.plan_item_id === null
        ? null
        : numberValue(req.body.plan_item_id);
    const manualOverride = source === 'manual' ? 1 : 0;
    if (normalizedParams && typeof normalizedParams === 'object') {
        normalizedParams = {
            ...paramsObject,
            ...(account ? { account } : {}),
            platform,
            ...(socialAccountId !== null ? { social_account_id: socialAccountId } : {}),
            ...(accountKey ? { account_key: accountKey } : {}),
            ...(plannedDurationSeconds !== null && paramsObject.duration_minutes === undefined
                ? { duration_minutes: Math.max(1, Math.round(plannedDurationSeconds / 60)) }
                : {}),
        };
    }
    const serializedParams = typeof normalizedParams === 'string'
        ? normalizedParams
        : (normalizedParams ? JSON.stringify(normalizedParams) : null);
    const r = db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, workspace_id, task_type, platform, source, params,
       status, scheduled_for, overdue_at, expires_at, planned_duration_sec,
       actual_duration_sec, social_account_id, account_key, plan_item_id,
       manual_override, priority, attempt_count, account_snapshot,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(device.user_id, device.id, workspaceId, task_type, platform, source, serializedParams, scheduledFor, overdueAt, expiresAt, plannedDurationSeconds, socialAccount?.id || socialAccountId, accountKey, planItemId, manualOverride, priority, jsonValue({
        account: account || null,
        platform,
        device_id: device.device_id,
        social_account_id: socialAccount?.id || socialAccountId,
    }), createdAt, createdAt);
    const task = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(r.lastInsertRowid);
    recordTaskEvent(task, 'created', {
        source,
        scheduled_for: scheduledFor,
        device_online: deviceIsOnline(device.last_seen_at),
    });
    res.status(201).json({
        task_run: taskView(task),
        device_online: deviceIsOnline(device.last_seen_at),
        queued: true,
    });
});
app.get('/api/planner/accounts', auth, (req, res) => {
    try {
        refreshTaskLifecycle();
        const dateKey = plannerDateKey(req.query.date);
        const planDay = db.prepare('SELECT * FROM warmup_plan_days WHERE workspace_id = ? AND plan_date = ?').get(req.user.workspaceId, dateKey);
        res.json({
            date: dateKey,
            timezone: BUENOS_AIRES_TIMEZONE,
            plan_day: planDay || null,
            accounts: plannerAccounts(req.user.userId, dateKey, planDay?.id),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to load planner accounts' });
    }
});
app.get('/api/planner/tasks', auth, (req, res) => {
    try {
        refreshTaskLifecycle();
        const dateKey = plannerDateKey(req.query.date);
        const { ids, placeholders } = scopedUsers(req.user.userId);
        const rows = db.prepare(`
      SELECT tr.*, d.device_id AS device_key, d.device_name
      FROM task_runs tr
      LEFT JOIN devices d ON d.id = tr.device_id
      WHERE tr.user_id IN (${placeholders})
      ORDER BY COALESCE(tr.scheduled_for, tr.created_at) ASC, tr.priority DESC, tr.id ASC
    `).all(...ids);
        res.json({
            date: dateKey,
            timezone: BUENOS_AIRES_TIMEZONE,
            tasks: rows
                .filter((row) => dateKeyInTimezone(row.scheduled_for || row.created_at) === dateKey)
                .map((row) => ({
                ...taskView(row),
                device_key: row.device_key || null,
                device_name: row.device_name || null,
            })),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to load planner tasks' });
    }
});
app.post('/api/planner/generate', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    try {
        const dateKey = plannerDateKey(req.body.date);
        const requestedMode = String(req.body.mode || SCHEDULER_MODE).toLowerCase();
        const mode = requestedMode === 'random' ? 'random' : 'fixed';
        const requestedFixedSeconds = req.body.fixed_target_seconds === undefined
            ? FIXED_WARMUP_SECONDS
            : numberValue(req.body.fixed_target_seconds);
        const fixedSeconds = Math.min(DAILY_MAX_WARMUP_SECONDS, Math.max(DAILY_MIN_WARMUP_SECONDS, requestedFixedSeconds));
        refreshTaskLifecycle();
        const result = db.transaction(() => generatePlannerPlan(req.user.userId, dateKey, mode, fixedSeconds))();
        res.json({
            ok: true,
            date: dateKey,
            timezone: BUENOS_AIRES_TIMEZONE,
            mode,
            ...result,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to generate warmup plan' });
    }
});
app.post('/api/planner/recalculate', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    try {
        const dateKey = plannerDateKey(req.body.date);
        refreshTaskLifecycle();
        const result = db.transaction(() => recalculatePlannerDay(req.user.userId, dateKey))();
        res.json({
            ok: true,
            date: dateKey,
            timezone: BUENOS_AIRES_TIMEZONE,
            ...result,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to recalculate warmup plan' });
    }
});
app.patch('/api/social-accounts/:id/warmup-policy', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    try {
        const { ids, placeholders } = scopedUsers(req.user.userId);
        const account = db.prepare(`
      SELECT * FROM social_accounts
      WHERE id = ? AND user_id IN (${placeholders})
      LIMIT 1
    `).get(req.params.id, ...ids);
        let accountKey = account?.account_key
            || (account ? accountKeyFor(Number(account.user_id), account.device_id, account.platform, account.username) : null);
        if (!accountKey && stringValue(req.body.account_key)) {
            accountKey = stringValue(req.body.account_key);
        }
        if (!accountKey)
            return res.status(404).json({ error: 'Social account not found' });
        const existing = db.prepare(`
      SELECT * FROM warmup_policies
      WHERE account_key = ? AND user_id IN (${placeholders})
      LIMIT 1
    `).get(accountKey, ...ids);
        if (!existing && !account)
            return res.status(404).json({ error: 'Warmup policy not found' });
        const policy = existing || ensureWarmupPolicy({
            ...account,
            account_key: accountKey,
            account: account?.username,
        });
        const nextStatus = req.body.status === undefined
            ? normalizeWarmupPolicyStatus(policy?.status)
            : normalizeWarmupPolicyStatus(req.body.status);
        const nextEnabled = req.body.enabled === undefined
            ? Number(policy?.enabled ?? 1)
            : req.body.enabled ? 1 : 0;
        db.prepare(`
      UPDATE warmup_policies
      SET status = ?, enabled = ?, updated_at = ?
      WHERE account_key = ? AND user_id IN (${placeholders})
    `).run(nextStatus, nextEnabled, nowIso(), accountKey, ...ids);
        const cancelled = nextStatus === 'warm'
            ? cancelAutomaticTasksForPolicy(accountKey, 'policy_warm')
            : 0;
        const updated = db.prepare('SELECT * FROM warmup_policies WHERE account_key = ?').get(accountKey);
        res.json({
            ok: true,
            policy: updated,
            excluded_from_automatic_plan: nextStatus === 'warm' || nextEnabled !== 1,
            cancelled_tasks: cancelled,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to update warmup policy' });
    }
});
app.patch('/api/tasks/runs/:id/schedule', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    try {
        const { ids, placeholders } = scopedUsers(req.user.userId);
        const run = db.prepare(`
      SELECT * FROM task_runs
      WHERE id = ? AND user_id IN (${placeholders})
      LIMIT 1
    `).get(req.params.id, ...ids);
        if (!run)
            return res.status(404).json({ error: 'Run not found' });
        if (['running', 'completed', 'error', 'cancelled'].includes(run.status)) {
            return res.status(409).json({ error: 'Only queued, overdue or expired tasks can be rescheduled' });
        }
        const scheduledInput = req.body.scheduled_for ?? req.body.schedule_at;
        const scheduledTimestamp = Date.parse(String(scheduledInput || ''));
        if (!Number.isFinite(scheduledTimestamp)) {
            return res.status(400).json({ error: 'scheduled_for must be a valid ISO date' });
        }
        const scheduledFor = new Date(scheduledTimestamp).toISOString();
        let device = run.device_id
            ? db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ?').get(run.device_id, req.user.workspaceId)
            : null;
        if (req.body.device_id !== undefined && req.body.device_id !== null) {
            device = findDeviceForWorkspace(req.user.userId, req.body.device_id);
            if (!device)
                return res.status(404).json({ error: 'Assigned device not found' });
        }
        const nextDeviceId = Number(device?.id || run.device_id || 0) || null;
        const nextUserId = Number(device?.user_id || run.user_id);
        const nextParams = req.body.params === undefined
            ? parseParams(run.params)
            : req.body.params;
        const nextDuration = req.body.planned_duration_sec === undefined
            ? run.planned_duration_sec
            : numberValue(req.body.planned_duration_sec);
        const now = nowIso();
        db.prepare(`
      UPDATE task_runs
      SET user_id = ?, device_id = ?, workspace_id = ?, source = 'manual',
          manual_override = 1, priority = 1000, status = 'pending',
          params = ?, scheduled_for = ?, overdue_at = ?, expires_at = ?,
          planned_duration_sec = ?, claim_token = NULL, claimed_at = NULL,
          lease_expires_at = NULL, last_heartbeat_at = NULL, started_at = NULL,
          completed_at = NULL, cancel_reason = NULL, updated_at = ?
      WHERE id = ? AND user_id IN (${placeholders})
    `).run(nextUserId, nextDeviceId, req.user.workspaceId, typeof nextParams === 'string' ? nextParams : JSON.stringify(nextParams || {}), scheduledFor, overdueAtIso(scheduledFor), expiresAtIso(scheduledFor), nextDuration, now, run.id, ...ids);
        const updated = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
        recordTaskEvent(updated, 'rescheduled_manual', {
            previous_status: run.status,
            scheduled_for: scheduledFor,
        });
        const recalculated = recalculatePlannerDay(req.user.userId, plannerDateKey(req.body.date || dateKeyInTimezone(scheduledFor)));
        res.json({
            ok: true,
            task_run: taskView(updated),
            recalculated,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message || 'Unable to reschedule task' });
    }
});
app.get('/api/notifications', auth, (req, res) => {
    const limit = Math.min(200, Math.max(1, numberValue(req.query.limit, 50)));
    const unreadOnly = String(req.query.unread_only || '').toLowerCase() === 'true';
    const where = ['workspace_id = ?'];
    const values = [req.user.workspaceId];
    if (unreadOnly)
        where.push('read_at IS NULL');
    const rows = db.prepare('SELECT * FROM notifications WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC, id DESC LIMIT ?').all(...values, limit);
    const unread = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE workspace_id = ? AND read_at IS NULL').get(req.user.workspaceId);
    res.json({
        notifications: rows.map((row) => ({ ...row, payload: parseParams(row.payload) })),
        unread_count: Number(unread?.count || 0),
    });
});
app.patch('/api/notifications/:id/read', auth, (req, res) => {
    const result = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND workspace_id = ?').run(nowIso(), req.params.id, req.user.workspaceId);
    if (!result.changes)
        return res.status(404).json({ error: 'Notification not found' });
    const notification = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
    res.json({ ok: true, notification: { ...notification, payload: parseParams(notification.payload) } });
});
app.patch('/api/notifications/read-all', auth, (req, res) => {
    const result = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE workspace_id = ? AND read_at IS NULL').run(nowIso(), req.user.workspaceId);
    res.json({ ok: true, marked_read: Number(result.changes || 0) });
});
app.get('/api/tasks/runs', auth, (req, res) => {
    const status = req.query.status;
    const requestedLimit = parseInt(req.query.limit) || 100;
    const limit = Math.min(500, Math.max(1, requestedLimit));
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const where = [`user_id IN (${placeholders})`];
    const values = [...ids];
    const runDeviceScope = deviceScopedId(req);
    if (runDeviceScope !== null) {
        // Token de dispositivo: SOLO el historial de ese teléfono.
        where.push('device_id = ?');
        values.push(runDeviceScope);
    }
    if (status) {
        where.push('status = ?');
        values.push(status);
    }
    if (runDeviceScope === null && req.query.device_id !== undefined) {
        const device = findDeviceForWorkspace(req.user.userId, req.query.device_id, true, req.query.installation_id);
        if (!device)
            return res.json({ runs: [] });
        where.push('device_id = ?');
        values.push(device.id);
        if (status && ['pending', 'overdue'].includes(status)) {
            const now = nowIso();
            where.push('(scheduled_for IS NULL OR scheduled_for <= ?)');
            values.push(now);
            where.push('(expires_at IS NULL OR expires_at > ?)');
            values.push(now);
        }
    }
    const control = ensureWorkspaceControl(req.user.workspaceId);
    if (status && ['pending', 'overdue'].includes(status)) {
        const mode = normalizeSchedulerControlMode(control.scheduler_mode);
        if (mode === 'paused') {
            where.push('1 = 0');
        }
        else if (mode === 'manual_only' || Boolean(Number(control.queue_paused || 0))) {
            where.push("(source = 'manual' OR manual_override = 1)");
        }
    }
    const runs = db.prepare(`SELECT * FROM task_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).all(...values, limit);
    res.json({ runs: runs.map((run) => {
            const safeRun = { ...run };
            delete safeRun.claim_token;
            return safeRun;
        }) });
});
app.get('/api/tasks/runs/:id', auth, (req, res) => {
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const run = db.prepare(`SELECT * FROM task_runs WHERE id = ? AND user_id IN (${placeholders})`)
        .get(req.params.id, ...ids);
    if (!run)
        return res.status(404).json({ error: 'Run not found' });
    // Un token de dispositivo solo consulta runs de SU teléfono.
    const runDeviceScope = deviceScopedId(req);
    if (runDeviceScope !== null && Number(run.device_id) !== runDeviceScope) {
        return res.status(404).json({ error: 'Run not found' });
    }
    const safeRun = { ...run };
    delete safeRun.claim_token;
    res.json({ run: safeRun });
});
// POST /api/tasks/claim — device-scoped, atomic task claim with a renewable lease.
app.post('/api/tasks/claim', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const userId = req.user.userId;
    try {
        const executableTypes = executableTaskTypes();
        const result = db.transaction(() => {
            const device = touchDevice(userId, req.body);
            refreshTaskLifecycle();
            const now = nowIso();
            const publicationLock = db.prepare(`
        SELECT publication_job_id FROM device_automation_locks
        WHERE device_id = ? AND expires_at > ?
        LIMIT 1
      `).get(device.id, now);
            if (publicationLock)
                return { device, task: null, reused: false, reason: 'device_busy_publication' };
            const control = ensureWorkspaceControl(Number(device.workspace_id || req.user.workspaceId));
            const controlMode = normalizeSchedulerControlMode(control.scheduler_mode);
            if (controlMode === 'paused')
                return { device, task: null, reused: false };
            const queueFilter = controlMode === 'manual_only' || Boolean(Number(control.queue_paused || 0))
                ? "(source = 'manual' OR manual_override = 1)"
                : '1 = 1';
            const existing = db.prepare(`
        SELECT * FROM task_runs
        WHERE user_id = ? AND device_id = ?
          AND task_type IN (${executableTypes.map(() => '?').join(',')})
          AND status IN ('running', 'paused')
          AND claim_token IS NOT NULL
          AND lease_expires_at > ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1
      `).get(userId, device.id, ...executableTypes, now);
            if (existing) {
                const leaseExpiresAt = taskLeaseExpiresAt();
                db.prepare(`
          UPDATE task_runs
          SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND device_id = ? AND claim_token = ?
        `).run(leaseExpiresAt, now, now, existing.id, userId, device.id, existing.claim_token);
                return {
                    device,
                    task: db.prepare('SELECT * FROM task_runs WHERE id = ?').get(existing.id),
                    reused: true,
                };
            }
            const candidate = db.prepare(`
        SELECT * FROM task_runs
        WHERE user_id = ? AND device_id = ?
          AND task_type IN (${executableTypes.map(() => '?').join(',')})
          AND ${queueFilter}
          AND (
            (
              status IN ('pending', 'overdue')
              AND (scheduled_for IS NULL OR scheduled_for <= ?)
              AND (expires_at IS NULL OR expires_at > ?)
            )
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
        ORDER BY
          CASE
            WHEN source = 'manual' THEN 0
            WHEN status = 'running' THEN 1
            WHEN status = 'overdue' THEN 2
            ELSE 3
          END,
          priority DESC,
          COALESCE(scheduled_for, created_at) ASC,
          id ASC
        LIMIT 1
      `).get(userId, device.id, ...executableTypes, now, now, now);
            if (!candidate)
                return { device, task: null, reused: false };
            const claimToken = randomUUID();
            const leaseExpiresAt = taskLeaseExpiresAt();
            const update = db.prepare(`
        UPDATE task_runs
        SET status = 'running',
            claim_token = ?,
            claimed_at = COALESCE(claimed_at, ?),
            lease_expires_at = ?,
            last_heartbeat_at = ?,
            started_at = COALESCE(started_at, ?),
            attempt_count = COALESCE(attempt_count, 0) + 1,
            updated_at = ?
        WHERE id = ? AND user_id = ? AND device_id = ?
          AND task_type IN (${executableTypes.map(() => '?').join(',')})
          AND ${queueFilter}
          AND (
            (
              status IN ('pending', 'overdue')
              AND (scheduled_for IS NULL OR scheduled_for <= ?)
              AND (expires_at IS NULL OR expires_at > ?)
            )
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
      `).run(claimToken, now, leaseExpiresAt, now, now, now, candidate.id, userId, device.id, ...executableTypes, now, now, now);
            if (update.changes !== 1)
                return { device, task: null, reused: false };
            const claimed = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(candidate.id);
            recordTaskEvent(claimed, 'claimed', {
                attempt: Number(claimed?.attempt_count || 1),
            });
            return {
                device,
                task: claimed,
                reused: false,
            };
        })();
        if (!result.task) {
            return res.json({
                claimed: false,
                server_time: nowIso(),
                device: deviceView(result.device),
                ...(result.reason ? { reason: result.reason } : {}),
            });
        }
        const claimedTask = result.task;
        res.json({
            claimed: true,
            reused: result.reused,
            server_time: nowIso(),
            device: deviceView(result.device),
            claim_token: claimedTask.claim_token,
            task: claimedTask,
        });
    }
    catch (error) {
        res.status(error.code === 'DEVICE_NOT_PAIRED' ? 409 : 400).json({
            error: error.message || 'Unable to claim task',
            ...(error.code ? { code: error.code } : {}),
        });
    }
});
// POST /api/tasks/runs/:id/heartbeat — renew a device task lease and receive control changes.
app.post('/api/tasks/runs/:id/heartbeat', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const userId = req.user.userId;
    const claimToken = stringValue(req.body.claim_token);
    const device = findDeviceForUser(userId, req.body.device_id, true);
    if (!claimToken || !device)
        return res.status(400).json({ error: 'device_id and claim_token required' });
    const run = db.prepare(`
    SELECT * FROM task_runs
    WHERE id = ? AND user_id = ? AND device_id = ? AND claim_token = ?
  `).get(req.params.id, userId, device.id, claimToken);
    if (!run)
        return res.status(409).json({ error: 'Task claim is invalid or expired' });
    const now = nowIso();
    const isTerminal = ['completed', 'error', 'cancelled'].includes(run.status);
    if (isTerminal) {
        db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?').run(now, device.id, userId);
        return res.json({
            ok: true,
            server_time: now,
            task: { id: run.id, task_type: run.task_type, status: run.status, lease_expires_at: null },
        });
    }
    if (run.lease_expires_at && run.lease_expires_at <= now) {
        return res.status(409).json({ error: 'Task lease expired' });
    }
    const leaseExpiresAt = taskLeaseExpiresAt();
    db.prepare(`
    UPDATE task_runs
    SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND device_id = ? AND claim_token = ?
  `).run(leaseExpiresAt, now, now, run.id, userId, device.id, claimToken);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?').run(now, device.id, userId);
    const current = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
    res.json({
        ok: true,
        server_time: now,
        task: {
            id: current.id,
            task_type: current.task_type,
            status: current.status,
            params: parseParams(current.params),
            lease_expires_at: current.lease_expires_at,
        },
    });
});
// GET /api/tasks/active — active task for a device (non-claiming status read)
app.get('/api/tasks/active', auth, (req, res) => {
    const userId = req.user.userId;
    const device = findDeviceForUser(userId, req.query.device_id, true);
    if (!device)
        return res.status(400).json({ error: 'device_id required or device not registered' });
    refreshTaskLifecycle();
    const run = db.prepare(`
    SELECT tr.*, d.device_name, d.device_id as device_string
    FROM task_runs tr
    JOIN devices d ON tr.device_id = d.id
    WHERE tr.user_id = ? AND tr.device_id = ?
      AND (
        (
          tr.status IN ('running', 'paused')
          AND (tr.lease_expires_at IS NULL OR tr.lease_expires_at > ?)
        )
        OR (
          tr.status IN ('pending', 'overdue')
          AND (tr.scheduled_for IS NULL OR tr.scheduled_for <= ?)
          AND (tr.expires_at IS NULL OR tr.expires_at > ?)
        )
      )
    ORDER BY CASE WHEN tr.status IN ('running', 'paused') THEN 0 ELSE 1 END,
      tr.updated_at DESC, tr.created_at DESC LIMIT 1
  `).get(userId, device.id, nowIso(), nowIso(), nowIso());
    if (!run)
        return res.json({ active: false });
    res.json({
        active: true,
        task: {
            id: run.id,
            task_type: run.task_type,
            status: run.status,
            params: parseParams(run.params),
            created_at: run.created_at,
            device_name: run.device_name,
            lease_expires_at: run.lease_expires_at,
        },
    });
});
// PATCH /api/tasks/runs/:id/pause
app.patch('/api/tasks/runs/:id/pause', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const run = db.prepare(`SELECT * FROM task_runs WHERE id = ? AND user_id IN (${placeholders})`)
        .get(req.params.id, ...ids);
    if (!run)
        return res.status(404).json({ error: 'No encontrada' });
    if (['completed', 'error', 'cancelled'].includes(run.status))
        return res.status(409).json({ error: 'Task already finished' });
    const now = nowIso();
    db.prepare(`
    UPDATE task_runs
    SET status = 'paused', lease_expires_at = NULL,
        pause_requested_at = ?, pause_acknowledged_at = ?,
        pause_reason = 'manual', updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, now, now, run.id, run.user_id);
    const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
    const session = upsertWarmupSessionFromTask(updatedRun);
    const scanSession = upsertScanSessionFromTask(updatedRun);
    const accounting = updateWarmupAccounting(updatedRun);
    recordTaskEvent(updatedRun, 'paused', {});
    res.json({ ok: true, status: 'paused', session, scan_session: scanSession, accounting });
});
// PATCH /api/tasks/runs/:id/resume
app.patch('/api/tasks/runs/:id/resume', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const run = db.prepare(`SELECT * FROM task_runs WHERE id = ? AND user_id IN (${placeholders})`)
        .get(req.params.id, ...ids);
    if (!run)
        return res.status(404).json({ error: 'No encontrada' });
    if (['completed', 'error', 'cancelled'].includes(run.status))
        return res.status(409).json({ error: 'Task already finished' });
    const now = nowIso();
    const nextStatus = run.claim_token ? 'running' : 'pending';
    db.prepare(`
    UPDATE task_runs
    SET status = ?, lease_expires_at = ?,
        pause_requested_at = NULL, pause_acknowledged_at = NULL,
        pause_reason = NULL, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(nextStatus, nextStatus === 'running' ? taskLeaseExpiresAt() : null, now, run.id, run.user_id);
    const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
    const session = upsertWarmupSessionFromTask(updatedRun);
    const scanSession = upsertScanSessionFromTask(updatedRun);
    const accounting = updateWarmupAccounting(updatedRun);
    recordTaskEvent(updatedRun, 'resumed', { status: nextStatus });
    res.json({ ok: true, status: nextStatus, session, scan_session: scanSession, accounting });
});
// PATCH /api/tasks/runs/:id/stop
app.patch('/api/tasks/runs/:id/stop', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const run = db.prepare(`SELECT * FROM task_runs WHERE id = ? AND user_id IN (${placeholders})`)
        .get(req.params.id, ...ids);
    if (!run)
        return res.status(404).json({ error: 'No encontrada' });
    if (['completed', 'error', 'cancelled'].includes(run.status))
        return res.json({ ok: true, status: run.status });
    const now = nowIso();
    db.prepare(`
    UPDATE task_runs
    SET status = 'cancelled', completed_at = ?, lease_expires_at = NULL,
        cancel_reason = 'manual_cancel', updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(now, now, run.id, run.user_id);
    const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
    upsertWarmupSessionFromTask(updatedRun);
    upsertScanSessionFromTask(updatedRun);
    const accounting = updateWarmupAccounting(updatedRun);
    recordTaskEvent(updatedRun, 'cancelled_manual', {});
    res.json({ ok: true, status: 'cancelled', accounting });
});
function updateDeviceTaskStatus(req, res) {
    const device = findDeviceForWorkspace(req.user.userId, req.body.device_id, true, req.body.installation_id);
    if (!device) {
        res.status(400).json({ error: 'device_id required or device not registered' });
        return;
    }
    const status = String(req.body.status || '').toLowerCase();
    if (!['running', 'paused', 'completed', 'error', 'cancelled'].includes(status)) {
        res.status(400).json({ error: 'Unsupported status' });
        return;
    }
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const run = db.prepare(`
    SELECT * FROM task_runs
    WHERE id = ? AND user_id IN (${placeholders}) AND device_id = ?
    LIMIT 1
  `).get(req.params.id, ...ids, device.id);
    if (!run) {
        res.status(404).json({ error: 'Run not found for this device' });
        return;
    }
    if (['completed', 'error', 'cancelled'].includes(run.status)) {
        res.json({ ok: true, status: run.status, task: taskView(run) });
        return;
    }
    const incomingResult = parseParams(req.body.result);
    const previousResult = parseParams(run.result);
    const previousElapsed = Math.max(numberValue(previousResult.elapsed_sec), numberValue(run.actual_duration_sec));
    const incomingElapsed = numberValue(incomingResult.elapsed_sec);
    const elapsed = Math.max(previousElapsed, incomingElapsed);
    const mergedResult = {
        ...previousResult,
        ...incomingResult,
        ...(elapsed > 0 ? { elapsed_sec: elapsed } : {}),
        timestamp: incomingResult.timestamp || previousResult.timestamp || nowIso(),
    };
    const plannedDuration = numberValue(run.planned_duration_sec);
    const requestedRemaining = req.body.remaining_duration_sec === undefined
        ? null
        : numberValue(req.body.remaining_duration_sec);
    const remaining = status === 'completed'
        ? 0
        : requestedRemaining === null
            ? Math.max(0, plannedDuration - elapsed)
            : requestedRemaining;
    const now = nowIso();
    const terminal = ['completed', 'error', 'cancelled'].includes(status);
    const nextParams = parseParams(run.params);
    if (status === 'paused' || status === 'running') {
        nextParams.remaining_duration_sec = remaining;
    }
    const pauseReason = status === 'paused'
        ? stringValue(req.body.pause_reason) || run.pause_reason || 'device_pause'
        : null;
    const controlVersion = req.body.control_version === undefined
        ? null
        : numberValue(req.body.control_version);
    db.prepare(`
    UPDATE task_runs
    SET status = ?, result = ?, params = ?, actual_duration_sec = ?,
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END,
        lease_expires_at = NULL,
        last_heartbeat_at = ?, updated_at = ?,
        pause_requested_at = CASE WHEN ? = 'paused' THEN COALESCE(pause_requested_at, ?) ELSE NULL END,
        pause_acknowledged_at = CASE WHEN ? = 'paused' THEN ? ELSE NULL END,
        pause_reason = ?, remaining_duration_sec = ?
    WHERE id = ? AND device_id = ? AND status NOT IN ('completed', 'error', 'cancelled')
  `).run(status, JSON.stringify(mergedResult), JSON.stringify(nextParams), elapsed, status, now, terminal ? 1 : 0, now, now, now, status, now, status, now, pauseReason, remaining, run.id, device.id);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
    const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id);
    const session = upsertWarmupSessionFromTask(updatedRun);
    const scanSession = upsertScanSessionFromTask(updatedRun);
    const eventType = status === 'paused'
        ? 'paused_checkpoint'
        : status === 'completed'
            ? 'completed_device'
            : status === 'error'
                ? 'error_device'
                : status === 'cancelled'
                    ? 'cancelled_device'
                    : 'updated_device';
    recordTaskEvent(updatedRun, eventType, {
        elapsed_sec: elapsed,
        remaining_duration_sec: remaining,
        control_version: controlVersion,
    });
    const accounting = updateWarmupAccounting(updatedRun);
    if (controlVersion !== null && status === 'paused') {
        acknowledgeDeviceControl(Number(device.id), controlVersion, 'paused');
        db.prepare('UPDATE task_runs SET pause_acknowledged_at = ? WHERE id = ?').run(now, run.id);
    }
    else if (controlVersion !== null && status === 'running') {
        acknowledgeDeviceControl(Number(device.id), controlVersion, 'resumed');
    }
    else if (controlVersion !== null && terminal) {
        acknowledgeDeviceControl(Number(device.id), controlVersion, 'idle');
    }
    res.json({
        ok: true,
        status,
        task: taskView(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(run.id)),
        session,
        scan_session: scanSession,
        accounting,
    });
}
// Device-authenticated status updates are kept separate from the claim-token
// protocol so the current Android service can checkpoint a pause safely while
// the stricter claim/lease endpoint remains available for newer clients.
app.patch('/api/tasks/runs/:id/device-status', auth, requireRole('owner', 'admin', 'operator'), updateDeviceTaskStatus);
app.patch('/api/tasks/runs/:id/checkpoint', auth, requireRole('owner', 'admin', 'operator'), updateDeviceTaskStatus);
app.patch('/api/tasks/runs/:id', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { status, result } = req.body;
    const claimToken = stringValue(req.body.claim_token);
    const device = findDeviceForUser(req.user.userId, req.body.device_id, true);
    if (!claimToken || !device)
        return res.status(400).json({ error: 'device_id and claim_token required' });
    if (!['running', 'paused', 'completed', 'error', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Unsupported status' });
    }
    const r = db.prepare(`
    SELECT * FROM task_runs
    WHERE id = ? AND user_id = ? AND device_id = ? AND claim_token = ?
  `).get(req.params.id, req.user.userId, device.id, claimToken);
    if (!r)
        return res.status(409).json({ error: 'Task claim is invalid or expired' });
    if (['completed', 'error', 'cancelled'].includes(r.status))
        return res.status(409).json({ error: 'Task already finished' });
    const now = nowIso();
    if (r.lease_expires_at && r.lease_expires_at <= now)
        return res.status(409).json({ error: 'Task lease expired' });
    const startedAt = status === 'running' ? (r.started_at || now) : r.started_at;
    const completedAt = ['completed', 'error', 'cancelled'].includes(status) ? now : r.completed_at;
    const nextLease = ['completed', 'error', 'cancelled'].includes(status) ? null : taskLeaseExpiresAt();
    db.prepare(`
    UPDATE task_runs
    SET status = ?, result = ?, started_at = ?, completed_at = ?,
        lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND device_id = ? AND claim_token = ?
      AND status NOT IN ('completed', 'error', 'cancelled')
  `).run(status, result !== undefined ? JSON.stringify(result) : r.result, startedAt, completedAt, nextLease, now, now, r.id, req.user.userId, device.id, claimToken);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?').run(now, device.id, req.user.userId);
    const updatedRun = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(r.id);
    const session = upsertWarmupSessionFromTask(updatedRun);
    const scanSession = upsertScanSessionFromTask(updatedRun);
    recordTaskEvent(updatedRun, status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'updated', {
        status,
    });
    const accounting = updateWarmupAccounting(updatedRun);
    res.json({ ok: true, status, session, scan_session: scanSession, accounting });
});
// ─── IG Accounts (per device) ───
// ─── Avatar serving + profile-photo pipeline ───
// Local mirror of the scanned profile photos lives in backend/src/avatars.ts:
// GET /api/avatars/:filename serves data/avatars/ with a long cache, and
// ensureAvatarStored() scrapes + downloads a photo for any platform. Registered
// without auth because clients render these paths directly in <img> tags.
registerAvatarRoutes(app);
// Legacy Instagram-only scrape kept for the /api/ig-accounts endpoints, which
// continue to store the CDN URL exactly as before; the implementation now
// delegates to the shared avatar module so the og:image handling lives in one
// place.
function fetchProfilePicUrl(username) {
    return fetchInstagramProfilePicUrl(username);
}
app.post('/api/ig-accounts', auth, requireRole('owner', 'admin', 'operator'), async (req, res) => {
    const { device_id, usernames } = req.body;
    if (!usernames || !Array.isArray(usernames))
        return res.status(400).json({ error: 'usernames array required' });
    const numericDeviceId = resolveSocialDeviceId(req.user.userId, device_id);
    // Token de dispositivo: las cuentas se atribuyen SIEMPRE a ese teléfono;
    // si el payload apunta a otro dispositivo, se rechaza.
    const socialWriteScope = deviceScopedId(req);
    if (socialWriteScope !== null) {
        if (numericDeviceId !== null && numericDeviceId !== socialWriteScope) {
            return res.status(403).json({ error: 'A device token can only write accounts for its own device' });
        }
        if (!numericDeviceId && !db.prepare('SELECT id FROM devices WHERE id = ?').get(socialWriteScope)) {
            return res.status(403).json({ error: 'Device token has no valid device row' });
        }
    }
    const effectiveDeviceId = socialWriteScope !== null ? socialWriteScope : numericDeviceId;
    if (!effectiveDeviceId)
        return res.status(400).json({ error: 'device_id required' });
    const deviceOwner = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(effectiveDeviceId);
    const dataUserId = deviceOwner?.user_id ?? req.user.userId;
    // Replace all accounts for this user+device
    db.prepare('DELETE FROM ig_accounts WHERE user_id = ? AND device_id = ?').run(dataUserId, effectiveDeviceId);
    const insert = db.prepare('INSERT OR IGNORE INTO ig_accounts (user_id, device_id, username, profile_pic_url) VALUES (?, ?, ?, ?)');
    let insertedCount = 0;
    // Insert immediately so mobile clients do not wait on Instagram HTML.
    // Profile pictures are best-effort enrichment after the scan is recorded.
    for (const u of usernames) {
        const username = String(u || '').replace(/^@+/, '').trim();
        if (!username)
            continue;
        insertedCount += Number(insert.run(dataUserId, effectiveDeviceId, username, '').changes || 0);
        void fetchProfilePicUrl(username).then((picUrl) => {
            if (!picUrl)
                return;
            db.prepare('UPDATE ig_accounts SET profile_pic_url = ? WHERE user_id = ? AND device_id = ? AND username = ?')
                .run(picUrl, dataUserId, effectiveDeviceId, username);
        }).catch(() => { });
    }
    const scanSession = recordScanSession(dataUserId, Number(effectiveDeviceId), 'instagram', {
        accountsFound: insertedCount,
        status: req.body.scan_status,
        startedAt: req.body.scan_started_at,
        taskRunId: req.body.scan_task_id,
        metadata: req.body.scan_metadata || { source: 'legacy_ig_accounts_sync' },
    });
    res.status(201).json({ ok: true, count: insertedCount, platform: 'instagram', scan_session: scanSession });
});
app.get('/api/ig-accounts', auth, (req, res) => {
    const deviceStrId = req.query.device_id;
    let accounts;
    if (deviceStrId) {
        const device = findDeviceForWorkspace(req.user.userId, deviceStrId);
        const numericId = device ? device.id : null;
        if (numericId) {
            accounts = db.prepare('SELECT * FROM ig_accounts WHERE device_id = ? ORDER BY username').all(numericId);
        }
        else {
            accounts = [];
        }
    }
    else {
        const { ids, placeholders } = scopedUsers(req.user.userId);
        accounts = db.prepare(`SELECT * FROM ig_accounts WHERE user_id IN (${placeholders}) ORDER BY username`).all(...ids);
    }
    res.json({ accounts });
});
// ─── Cross-platform accounts (YouTube channels and future providers) ───
function resolveSocialDeviceId(userId, rawDeviceId) {
    if (typeof rawDeviceId !== 'string' && typeof rawDeviceId !== 'number')
        return null;
    const deviceValue = String(rawDeviceId);
    // Prefer the stable phone identifier before considering a numeric database
    // id. Android IDs are opaque strings and may also be all digits.
    let device = findDeviceForWorkspace(userId, deviceValue);
    return device ? Number(device.id) : null;
}
app.post('/api/social-accounts', auth, requireRole('owner', 'admin', 'operator'), async (req, res) => {
    const platform = String(req.body.platform || '').toLowerCase();
    const { device_id, usernames, accounts } = req.body;
    if (!SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be instagram, tiktok, or youtube' });
    }
    const rawAccounts = Array.isArray(accounts)
        ? accounts
        : Array.isArray(usernames)
            ? usernames
            : null;
    if (!rawAccounts) {
        return res.status(400).json({ error: 'accounts or usernames array required' });
    }
    const numericDeviceId = resolveSocialDeviceId(req.user.userId, device_id);
    // Token de dispositivo: las cuentas se atribuyen SIEMPRE a ese teléfono;
    // si el payload apunta a otro dispositivo, se rechaza.
    const socialWriteScope = deviceScopedId(req);
    if (socialWriteScope !== null) {
        if (numericDeviceId !== null && numericDeviceId !== socialWriteScope) {
            return res.status(403).json({ error: 'A device token can only write accounts for its own device' });
        }
        if (!numericDeviceId && !db.prepare('SELECT id FROM devices WHERE id = ?').get(socialWriteScope)) {
            return res.status(403).json({ error: 'Device token has no valid device row' });
        }
    }
    const effectiveDeviceId = socialWriteScope !== null ? socialWriteScope : numericDeviceId;
    if (!effectiveDeviceId)
        return res.status(400).json({ error: 'device_id required' });
    const deviceOwner = db.prepare('SELECT user_id FROM devices WHERE id = ?').get(effectiveDeviceId);
    const dataUserId = deviceOwner?.user_id ?? req.user.userId;
    // Snapshot the photo pointers of the rows about to be wiped by the DELETE
    // below, so a rescan never loses them. Values may be local /api/avatars/...
    // paths or absolute CDN URLs stored by older builds — both are used verbatim.
    const previousPicUrls = new Map();
    for (const row of db.prepare('SELECT username, profile_pic_url FROM social_accounts WHERE user_id = ? AND device_id = ? AND platform = ?').all(dataUserId, effectiveDeviceId, platform)) {
        if (row.profile_pic_url)
            previousPicUrls.set(String(row.username), row.profile_pic_url);
    }
    try {
        // Desvincular referencias ANTES del borrado: task_runs.social_account_id
        // apunta a social_accounts y, con foreign_keys=ON, borrar cuentas
        // referenciadas por tareas (warmups/scan) tira SQLITE_CONSTRAINT.
        db.prepare(`
      UPDATE task_runs SET social_account_id = NULL
      WHERE social_account_id IN (
        SELECT id FROM social_accounts WHERE user_id = ? AND device_id = ? AND platform = ?
      )
    `).run(dataUserId, effectiveDeviceId, platform);
        db.prepare('DELETE FROM social_accounts WHERE user_id = ? AND device_id = ? AND platform = ?')
            .run(dataUserId, effectiveDeviceId, platform);
    }
    catch (error) {
        console.error('[SocialAccounts] replace failed:', error?.code || error?.message);
        return res.status(500).json({ error: 'Could not replace scanned accounts' });
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO social_accounts
      (user_id, device_id, platform, username, profile_pic_url,
       display_name, source_account_name, source_account_email, byline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updatePicUrl = db.prepare('UPDATE social_accounts SET profile_pic_url = ? WHERE user_id = ? AND device_id = ? AND platform = ? AND username = ?');
    let insertedCount = 0;
    const accountsWithoutPic = new Set();
    for (const rawAccount of rawAccounts) {
        const account = rawAccount && typeof rawAccount === 'object'
            ? rawAccount
            : { username: rawAccount };
        const username = String(account.username || '').replace(/^@+/, '').trim();
        if (!username)
            continue;
        const picUrl = String(account.profile_pic_url || '');
        insertedCount += Number(insert.run(dataUserId, effectiveDeviceId, platform, username, picUrl, String(account.display_name || ''), String(account.source_account_name || ''), String(account.source_account_email || ''), String(account.byline || '')).changes || 0);
        if (!picUrl)
            accountsWithoutPic.add(username);
    }
    // Re-attach photos that survived a previous scan (local data only, no
    // network, so it happens before the response is sent); the accounts still
    // left without a photo go through the async avatar pipeline below.
    const accountsStillWithoutPic = [...accountsWithoutPic].filter((username) => {
        const previous = previousPicUrls.get(username);
        if (!previous)
            return true;
        updatePicUrl.run(previous, dataUserId, effectiveDeviceId, platform, username);
        return false;
    });
    // Best-effort avatar pipeline for everything still without a photo, now for
    // all platforms (Instagram, TikTok, YouTube) and not just Instagram: fetch
    // the profile page, download the image once into data/avatars/ and store the
    // local /api/avatars/... path. Runs after the inserts without blocking the
    // response, and skips the external scrape when the file already exists.
    void (async () => {
        for (const username of accountsStillWithoutPic) {
            try {
                const storedUrl = await ensureAvatarStored(platform, username);
                if (!storedUrl)
                    continue;
                updatePicUrl.run(storedUrl, dataUserId, effectiveDeviceId, platform, username);
            }
            catch {
                // Best-effort: leave profile_pic_url empty and move on.
            }
        }
    })();
    const scanSession = recordScanSession(dataUserId, Number(effectiveDeviceId), platform, {
        accountsFound: insertedCount,
        status: req.body.scan_status,
        startedAt: req.body.scan_started_at,
        taskRunId: req.body.scan_task_id,
        metadata: req.body.scan_metadata || { source: 'social_accounts_sync' },
    });
    res.status(201).json({ ok: true, count: insertedCount, platform, scan_session: scanSession });
});
app.get('/api/social-accounts', auth, (req, res) => {
    const platform = String(req.query.platform || 'all').toLowerCase();
    if (platform !== 'all' && !SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be all, instagram, tiktok, or youtube' });
    }
    const deviceStrId = req.query.device_id;
    const accountsDeviceScope = deviceScopedId(req);
    let accounts;
    if (accountsDeviceScope !== null) {
        // Token de dispositivo: solo las cuentas detectadas por ESE teléfono.
        accounts = platform === 'all'
            ? db.prepare('SELECT * FROM social_accounts WHERE device_id = ? ORDER BY platform, username').all(accountsDeviceScope)
            : db.prepare('SELECT * FROM social_accounts WHERE device_id = ? AND platform = ? ORDER BY username').all(accountsDeviceScope, platform);
    }
    else if (deviceStrId) {
        const device = findDeviceForWorkspace(req.user.userId, deviceStrId);
        if (!device) {
            accounts = [];
        }
        else if (platform === 'all') {
            accounts = db.prepare('SELECT * FROM social_accounts WHERE device_id = ? ORDER BY platform, username')
                .all(device.id);
        }
        else {
            accounts = db.prepare('SELECT * FROM social_accounts WHERE device_id = ? AND platform = ? ORDER BY username')
                .all(device.id, platform);
        }
    }
    else {
        const { ids, placeholders } = scopedUsers(req.user.userId);
        accounts = platform === 'all'
            ? db.prepare(`SELECT * FROM social_accounts WHERE user_id IN (${placeholders}) ORDER BY platform, username`).all(...ids)
            : db.prepare(`SELECT * FROM social_accounts WHERE user_id IN (${placeholders}) AND platform = ? ORDER BY username`).all(...ids, platform);
    }
    res.json({ accounts });
});
// Remove the scanned account inventory without touching scan history. The
// mobile client passes its own device_id; the command center can omit it to
// clean every device in the current workspace.
app.delete('/api/social-accounts', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const rawPlatforms = req.body?.platforms ?? req.body?.platform ?? req.query.platforms ?? req.query.platform ?? 'all';
    const requestedPlatforms = (Array.isArray(rawPlatforms) ? rawPlatforms : String(rawPlatforms).split(','))
        .flatMap((value) => String(value).split(','))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    const platforms = requestedPlatforms.includes('all') ? [...SOCIAL_PLATFORMS] : [...new Set(requestedPlatforms)];
    if (!platforms.length || platforms.some((platform) => !SOCIAL_PLATFORMS.includes(platform))) {
        return res.status(400).json({ error: 'platforms must contain instagram, tiktok, youtube, or all' });
    }
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const rawDeviceId = req.body?.device_id ?? req.query.device_id;
    let device = null;
    if (rawDeviceId !== undefined && rawDeviceId !== null && String(rawDeviceId).trim()) {
        device = findDeviceForWorkspace(req.user.userId, rawDeviceId);
        if (!device)
            return res.status(404).json({ error: 'device not found in this workspace' });
    }
    const deleted = db.transaction(() => {
        const counts = {};
        for (const platform of platforms) {
            const unified = device
                ? db.prepare(`DELETE FROM social_accounts WHERE user_id IN (${placeholders}) AND device_id = ? AND platform = ?`)
                    .run(...ids, device.id, platform)
                : db.prepare(`DELETE FROM social_accounts WHERE user_id IN (${placeholders}) AND platform = ?`)
                    .run(...ids, platform);
            // Keep the legacy Instagram table in sync so old mobile builds cannot
            // resurrect an account after the unified inventory was cleaned.
            const legacy = platform === 'instagram'
                ? device
                    ? db.prepare(`DELETE FROM ig_accounts WHERE user_id IN (${placeholders}) AND device_id = ?`)
                        .run(...ids, device.id)
                    : db.prepare(`DELETE FROM ig_accounts WHERE user_id IN (${placeholders})`)
                        .run(...ids)
                : { changes: 0 };
            counts[platform] = Number(unified.changes || 0) + Number(legacy.changes || 0);
        }
        return counts;
    })();
    const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
    res.json({
        ok: true,
        platforms,
        device_id: device?.device_id || null,
        deleted,
        total,
        history_preserved: true,
    });
});
// ─── Scan history ───
app.post('/api/scan-sessions', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const platform = String(req.body.platform || '').toLowerCase();
    if (!SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be instagram, tiktok, or youtube' });
    }
    let deviceId = null;
    let dataUserId = req.user.userId;
    const writeDeviceScope = deviceScopedId(req);
    if (writeDeviceScope !== null) {
        // Token de dispositivo: la sesión se atribuye SIEMPRE a ese teléfono,
        // aunque el payload no traiga device_id (sesiones generadas en la app).
        const own = db.prepare('SELECT * FROM devices WHERE id = ?').get(writeDeviceScope);
        if (!own)
            return res.status(403).json({ error: 'Device token has no valid device row' });
        if (req.body.device_id !== undefined && req.body.device_id !== null) {
            const claimed = findDeviceForWorkspace(req.user.userId, req.body.device_id);
            if (!claimed || Number(claimed.id) !== writeDeviceScope) {
                return res.status(403).json({ error: 'A device token can only write sessions for its own device' });
            }
        }
        deviceId = writeDeviceScope;
        dataUserId = Number(own.user_id);
    }
    else if (req.body.device_id !== undefined && req.body.device_id !== null) {
        const device = findDeviceForWorkspace(req.user.userId, req.body.device_id);
        if (!device)
            return res.status(404).json({ error: 'Device not found' });
        deviceId = Number(device.id);
        dataUserId = Number(device.user_id);
    }
    const session = recordScanSession(dataUserId, deviceId, platform, {
        status: req.body.status,
        accountsFound: req.body.accounts_found,
        startedAt: req.body.started_at,
        completedAt: req.body.completed_at,
        taskRunId: req.body.task_run_id,
        metadata: req.body.metadata,
    });
    res.status(201).json({ ok: true, scan_session: session });
});
app.get('/api/scan-sessions', auth, (req, res) => {
    const platform = String(req.query.platform || 'all').toLowerCase();
    if (platform !== 'all' && !SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be all, instagram, tiktok, or youtube' });
    }
    const requestedLimit = parseInt(req.query.limit) || 100;
    const limit = Math.min(500, Math.max(1, requestedLimit));
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const where = [`ss.user_id IN (${placeholders})`];
    const values = [...ids];
    const scanDeviceScope = deviceScopedId(req);
    if (scanDeviceScope !== null) {
        // Token de dispositivo: SOLO los scans de ese teléfono.
        where.push('ss.device_id = ?');
        values.push(scanDeviceScope);
    }
    if (platform !== 'all') {
        where.push('ss.platform = ?');
        values.push(platform);
    }
    if (req.query.status) {
        where.push('ss.status = ?');
        values.push(String(req.query.status));
    }
    if (scanDeviceScope === null && req.query.device_id !== undefined) {
        const device = findDeviceForWorkspace(req.user.userId, req.query.device_id);
        if (!device)
            return res.json({ sessions: [] });
        where.push('ss.device_id = ?');
        values.push(device.id);
    }
    const rows = db.prepare(`
    SELECT ss.*, d.device_id AS device_key, d.device_name
    FROM scan_sessions ss
    LEFT JOIN devices d ON d.id = ss.device_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(ss.completed_at, ss.started_at, ss.created_at) DESC, ss.id DESC
    LIMIT ?
  `).all(...values, limit);
    res.json({ sessions: rows.map(scanSessionView) });
});
// ─── Warmup Sessions (canonical reporting projection) ───
app.post('/api/warmup-sessions', auth, requireRole('owner', 'admin', 'operator'), (req, res) => {
    const { duration_minutes, reels_viewed, videos_viewed, shorts_viewed, likes, saves, elapsed_sec, status, timestamp } = req.body;
    const platform = normalizePlatform(req.body.platform);
    const taskType = platform === 'youtube' ? 'warmup_youtube' : platform === 'tiktok' ? 'warmup_tiktok' : 'warmup_ig';
    let account = stringValue(req.body.account);
    if (!account)
        return res.status(400).json({ error: 'account required' });
    account = account.replace(/^@+/, '');
    let deviceId = null;
    let dataUserId = req.user.userId;
    const writeDeviceScope = deviceScopedId(req);
    if (writeDeviceScope !== null) {
        // Token de dispositivo: la sesión se atribuye SIEMPRE a ese teléfono,
        // aunque el payload no traiga device_id (sesiones generadas en la app).
        const own = db.prepare('SELECT * FROM devices WHERE id = ?').get(writeDeviceScope);
        if (!own)
            return res.status(403).json({ error: 'Device token has no valid device row' });
        if (req.body.device_id !== undefined && req.body.device_id !== null) {
            const claimed = findDeviceForWorkspace(req.user.userId, req.body.device_id);
            if (!claimed || Number(claimed.id) !== writeDeviceScope) {
                return res.status(403).json({ error: 'A device token can only write sessions for its own device' });
            }
        }
        deviceId = writeDeviceScope;
        dataUserId = Number(own.user_id);
    }
    else if (req.body.device_id !== undefined && req.body.device_id !== null) {
        const device = findDeviceForWorkspace(req.user.userId, req.body.device_id);
        if (!device)
            return res.status(404).json({ error: 'Device not found' });
        deviceId = Number(device.id);
        dataUserId = Number(device.user_id);
    }
    const youtubeMetadata = platform === 'youtube'
        ? {
            channel_display_name: String(req.body.channel_display_name || ''),
            source_account_name: String(req.body.source_account_name || ''),
            source_account_email: String(req.body.source_account_email || ''),
            byline: String(req.body.byline || ''),
        }
        : {};
    const sessionStatus = String(status || 'completed');
    const createdAt = stringValue(timestamp) || nowIso();
    const completedAt = ['running', 'paused', 'pending'].includes(sessionStatus) ? null : nowIso();
    const result = {
        platform,
        timestamp: createdAt,
        reels_viewed: numberValue(reels_viewed ?? videos_viewed),
        videos_viewed: numberValue(videos_viewed ?? reels_viewed),
        shorts_viewed: numberValue(shorts_viewed ?? videos_viewed ?? reels_viewed),
        likes: numberValue(likes),
        saves: numberValue(saves),
        elapsed_sec: numberValue(elapsed_sec),
        ...youtubeMetadata,
    };
    const params = { account, duration_minutes: numberValue(duration_minutes), platform, ...youtubeMetadata };
    if (!['running', 'paused', 'pending'].includes(sessionStatus)) {
        const duplicateTask = findRecentCanonicalWarmupTask({
            userId: dataUserId,
            deviceId,
            taskType,
            platform,
            account,
            elapsedSeconds: numberValue(elapsed_sec),
            reelsViewed: numberValue(reels_viewed ?? videos_viewed),
            likes: numberValue(likes),
            saves: numberValue(saves),
        });
        if (duplicateTask) {
            const duplicateSessionRow = db.prepare(`
        SELECT ws.*, d.device_id AS device_key, d.device_name
        FROM warmup_sessions ws
        LEFT JOIN devices d ON d.id = ws.device_id
        WHERE ws.user_id = ? AND ws.task_run_id = ?
        LIMIT 1
      `).get(duplicateTask.user_id, duplicateTask.id);
            const session = duplicateSessionRow
                ? warmupSessionView(duplicateSessionRow)
                : upsertWarmupSessionFromTask(duplicateTask);
            recordTaskEvent(duplicateTask, 'legacy_session_deduplicated', {
                platform,
                account,
                elapsed_sec: numberValue(elapsed_sec),
            });
            const accounting = updateWarmupAccounting(duplicateTask);
            return res.status(201).json({
                ok: true,
                id: duplicateTask.id,
                deduplicated: true,
                session,
                accounting,
            });
        }
    }
    const r = db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, task_type, status, params, result, created_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(dataUserId, deviceId, taskType, sessionStatus, JSON.stringify(params), JSON.stringify(result), createdAt, completedAt, nowIso());
    const task = db.prepare('SELECT * FROM task_runs WHERE id = ?').get(r.lastInsertRowid);
    const session = upsertWarmupSessionFromTask(task);
    const accounting = updateWarmupAccounting(task);
    recordTaskEvent(task, 'manual_session_recorded', {
        platform,
        account,
        elapsed_sec: numberValue(elapsed_sec),
    });
    res.status(201).json({ ok: true, id: r.lastInsertRowid, session, accounting });
});
app.get('/api/warmup-sessions', auth, (req, res) => {
    const platform = String(req.query.platform || 'all').toLowerCase();
    if (platform !== 'all' && !SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be all, instagram, tiktok, or youtube' });
    }
    const requestedLimit = parseInt(req.query.limit) || 100;
    const limit = Math.min(500, Math.max(1, requestedLimit));
    const { ids, placeholders } = scopedUsers(req.user.userId);
    const where = [`ws.user_id IN (${placeholders})`];
    const values = [...ids];
    const warmupDeviceScope = deviceScopedId(req);
    if (warmupDeviceScope !== null) {
        // Token de dispositivo: SOLO las sesiones de ese teléfono.
        where.push('ws.device_id = ?');
        values.push(warmupDeviceScope);
    }
    if (platform !== 'all') {
        where.push('ws.platform = ?');
        values.push(platform);
    }
    if (req.query.status) {
        where.push('ws.status = ?');
        values.push(String(req.query.status));
    }
    if (warmupDeviceScope === null && req.query.device_id !== undefined) {
        const device = findDeviceForWorkspace(req.user.userId, req.query.device_id);
        if (!device)
            return res.json({ sessions: [] });
        where.push('ws.device_id = ?');
        values.push(device.id);
    }
    const rows = db.prepare(`
    SELECT ws.*, d.device_id AS device_key, d.device_name
    FROM warmup_sessions ws
    LEFT JOIN devices d ON d.id = ws.device_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(ws.timestamp, ws.created_at) DESC, ws.id DESC
    LIMIT ?
  `).all(...values, limit);
    res.json({ sessions: rows.map(warmupSessionView) });
});
app.get('/api/stats/overview', auth, (req, res) => {
    const platform = String(req.query.platform || 'all').toLowerCase();
    if (platform !== 'all' && !SOCIAL_PLATFORMS.includes(platform)) {
        return res.status(400).json({ error: 'platform must be all, instagram, tiktok, or youtube' });
    }
    const { ids, placeholders } = scopedUsers(req.user.userId);
    // Token de dispositivo: las estadísticas cubren SOLO ese teléfono.
    const statsDeviceScope = deviceScopedId(req);
    const deviceFilter = statsDeviceScope !== null ? ' AND device_id = ?' : '';
    const platformFilter = platform === 'all' ? '' : ' AND platform = ?';
    const filterArgs = statsDeviceScope !== null
        ? (platform === 'all' ? [...ids, statsDeviceScope] : [...ids, platform, statsDeviceScope])
        : (platform === 'all' ? [...ids] : [...ids, platform]);
    const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_sessions,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_sessions,
      COALESCE(SUM(reels_viewed), 0) AS reels_viewed,
      COALESCE(SUM(videos_viewed), 0) AS videos_viewed,
      COALESCE(SUM(shorts_viewed), 0) AS shorts_viewed,
      COALESCE(SUM(likes), 0) AS likes,
      COALESCE(SUM(saves), 0) AS saves,
      COALESCE(SUM(elapsed_sec), 0) AS elapsed_sec
    FROM warmup_sessions
    WHERE user_id IN (${placeholders})${deviceFilter}${platformFilter}
  `).get(...filterArgs);
    const byPlatform = db.prepare(`
    SELECT platform, COUNT(*) AS sessions,
      COALESCE(SUM(reels_viewed), 0) AS reels_viewed,
      COALESCE(SUM(videos_viewed), 0) AS videos_viewed,
      COALESCE(SUM(shorts_viewed), 0) AS shorts_viewed,
      COALESCE(SUM(likes), 0) AS likes,
      COALESCE(SUM(saves), 0) AS saves
    FROM warmup_sessions
    WHERE user_id IN (${placeholders})${deviceFilter}${platformFilter}
    GROUP BY platform
    ORDER BY platform
  `).all(...filterArgs);
    const scans = db.prepare(`
    SELECT platform, COUNT(*) AS scans,
      COALESCE(SUM(accounts_found), 0) AS accounts_found,
      MAX(completed_at) AS last_completed_at
    FROM scan_sessions
    WHERE user_id IN (${placeholders})${deviceFilter}${platformFilter}
    GROUP BY platform
    ORDER BY platform
  `).all(...filterArgs);
    res.json({
        platform,
        totals: Object.fromEntries(Object.entries(totals || {}).map(([key, value]) => [key, numberValue(value)])),
        by_platform: byPlatform,
        scans,
    });
});
// Public health endpoint. It intentionally exposes operational facts only:
// the command center uses it to distinguish a healthy API from an unreachable
// tunnel/backend without requiring a user session or exposing database paths.
app.get('/api/health', (_req, res) => {
    const checkedAt = new Date().toISOString();
    let databaseStatus = 'ok';
    try {
        const result = db.pragma('quick_check(1)');
        if (!Array.isArray(result) || result[0]?.quick_check !== 'ok')
            databaseStatus = 'error';
    }
    catch (error) {
        databaseStatus = 'error';
        console.error('[Health] Database quick check failed:', error);
    }
    const status = databaseStatus === 'ok' ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
        status,
        service: 'southfarm-api',
        timestamp: checkedAt,
        started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        database: databaseStatus,
        planner_process: AUTO_PLANNER_ENABLED ? 'enabled' : 'disabled',
    });
});
const SCHEDULER_LIFECYCLE_TICK_MS = Math.max(15000, Number(process.env.SOUTHFARM_SCHEDULER_TICK_SECONDS || 60) * 1000);
const schedulerLifecycleTicker = setInterval(() => {
    try {
        refreshTaskLifecycle();
    }
    catch (error) {
        console.error('[Scheduler] Lifecycle tick failed:', error);
    }
}, SCHEDULER_LIFECYCLE_TICK_MS);
schedulerLifecycleTicker.unref?.();
if (AUTO_PLANNER_ENABLED) {
    const automaticPlannerStartup = setTimeout(() => {
        runAutomaticPlannerTick();
    }, 1000);
    automaticPlannerStartup.unref?.();
    const automaticPlannerTicker = setInterval(() => {
        runAutomaticPlannerTick();
    }, AUTO_PLANNER_TICK_MS);
    automaticPlannerTicker.unref?.();
    console.log(`[Scheduler] Automatic planner enabled in ${SCHEDULER_MODE} mode; `
        + `tick every ${Math.round(AUTO_PLANNER_TICK_MS / 1000)}s`
        + (AUTO_PLANNER_WORKSPACE_ID ? ` for workspace ${AUTO_PLANNER_WORKSPACE_ID}.` : '.'));
}
// ─── Activity Planner (clusters + routines + weekly generation) ───
registerActivityPlanner(app, {
    db,
    mediaRoot: PUBLICATION_MEDIA_ROOT,
    auth,
    requireRole,
    nowIso,
    parseParams,
    stringValue,
    numberValue,
    jsonValue,
    workspaceMembership,
    scopedUsers,
    dateKeyInTimezone,
    taskView,
    recordTaskEvent,
    ensureWorkspaceControl,
    workspaceControlBlocksAutomatic,
    normalizePlatform,
    accountKeyFor,
    deviceIsOnline,
    plannerDateKey,
});
runActivityPlannerStartup({
    db,
    auth,
    requireRole,
    nowIso,
    parseParams,
    stringValue,
    numberValue,
    jsonValue,
    workspaceMembership,
    scopedUsers,
    dateKeyInTimezone,
    taskView,
    recordTaskEvent,
    ensureWorkspaceControl,
    workspaceControlBlocksAutomatic,
    normalizePlatform,
    accountKeyFor,
    deviceIsOnline,
    plannerDateKey,
});
// Red de seguridad: un rechazo no manejado en un handler async (Express 4 no
// los captura) NO debe tumbar la API entera con toda la flota colgando de
// ella. Se registra con stack en stderr y el proceso sigue vivo.
process.on('unhandledRejection', (reason) => {
    console.error('[Fatal-guard] unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('[Fatal-guard] uncaughtException:', error);
});
app.listen(PORT, () => console.log(`🚀 SouthFarm API on :${PORT}`));
