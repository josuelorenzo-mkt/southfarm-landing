function columnNames(db, table) {
    return new Set(db.prepare('PRAGMA table_info(' + table + ')').all()
        .map((column) => column.name));
}
function addColumnIfMissing(db, table, name, definition) {
    if (!columnNames(db, table).has(name)) {
        db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
    }
}
function migrationAlreadyApplied(db, version) {
    return Boolean(db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version));
}
function markMigrationApplied(db, version) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
}
/**
 * Scheduler schema is intentionally additive. The existing mobile protocol
 * keeps using task_runs and its claim/heartbeat/update endpoints; these
 * tables and columns add durable planning metadata around that protocol.
 */
export function applySchedulerMigrations(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
    if (!migrationAlreadyApplied(db, 1)) {
        db.transaction(() => {
            addColumnIfMissing(db, 'social_accounts', 'account_key', 'TEXT');
            addColumnIfMissing(db, 'warmup_sessions', 'account_key', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'workspace_id', 'INTEGER');
            addColumnIfMissing(db, 'task_runs', 'social_account_id', 'INTEGER');
            addColumnIfMissing(db, 'task_runs', 'account_key', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'platform', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'source', "TEXT DEFAULT 'manual'");
            addColumnIfMissing(db, 'task_runs', 'scheduled_for', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'overdue_at', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'expires_at', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'planned_duration_sec', 'INTEGER');
            addColumnIfMissing(db, 'task_runs', 'actual_duration_sec', 'INTEGER DEFAULT 0');
            addColumnIfMissing(db, 'task_runs', 'plan_item_id', 'INTEGER');
            addColumnIfMissing(db, 'task_runs', 'manual_override', 'INTEGER DEFAULT 0');
            addColumnIfMissing(db, 'task_runs', 'priority', 'INTEGER DEFAULT 0');
            addColumnIfMissing(db, 'task_runs', 'attempt_count', 'INTEGER DEFAULT 0');
            addColumnIfMissing(db, 'task_runs', 'cancel_reason', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'account_snapshot', 'TEXT');
            db.exec(`
        CREATE TABLE IF NOT EXISTS warmup_policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_key TEXT NOT NULL UNIQUE,
          social_account_id INTEGER,
          user_id INTEGER NOT NULL,
          device_id INTEGER,
          platform TEXT NOT NULL,
          account TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'automatic',
          enabled INTEGER NOT NULL DEFAULT 1,
          daily_min_seconds INTEGER NOT NULL DEFAULT 2340,
          daily_max_seconds INTEGER NOT NULL DEFAULT 2880,
          min_sessions INTEGER NOT NULL DEFAULT 2,
          max_sessions INTEGER NOT NULL DEFAULT 3,
          window_start TEXT NOT NULL DEFAULT '12:00',
          window_end TEXT NOT NULL DEFAULT '22:00',
          timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS warmup_plan_days (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          plan_date TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
          mode TEXT NOT NULL DEFAULT 'fixed',
          status TEXT NOT NULL DEFAULT 'generated',
          version INTEGER NOT NULL DEFAULT 1,
          generated_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, plan_date)
        );

        CREATE TABLE IF NOT EXISTS warmup_plan_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_day_id INTEGER NOT NULL,
          account_key TEXT NOT NULL,
          social_account_id INTEGER,
          user_id INTEGER NOT NULL,
          device_id INTEGER,
          platform TEXT NOT NULL,
          account TEXT NOT NULL,
          target_seconds INTEGER NOT NULL,
          planned_sessions INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'planned',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(plan_day_id, account_key),
          FOREIGN KEY (plan_day_id) REFERENCES warmup_plan_days(id)
        );

        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER,
          user_id INTEGER NOT NULL,
          device_id INTEGER,
          task_run_id INTEGER,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id INTEGER NOT NULL,
          user_id INTEGER,
          type TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info',
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          entity_type TEXT,
          entity_id INTEGER,
          payload TEXT,
          created_at TEXT NOT NULL,
          read_at TEXT
        );
      `);
            db.exec(`
        UPDATE social_accounts
        SET account_key = CAST(user_id AS TEXT) || ':' ||
          COALESCE(CAST(device_id AS TEXT), '') || ':' ||
          lower(platform) || ':' || lower(username)
        WHERE account_key IS NULL OR account_key = '';

        CREATE INDEX IF NOT EXISTS idx_social_accounts_account_key
          ON social_accounts(account_key);
        CREATE INDEX IF NOT EXISTS idx_task_runs_schedule
          ON task_runs(device_id, status, scheduled_for, priority, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_runs_account_schedule
          ON task_runs(account_key, scheduled_for, status);
        CREATE INDEX IF NOT EXISTS idx_task_runs_source_status
          ON task_runs(source, status, scheduled_for);
        CREATE INDEX IF NOT EXISTS idx_warmup_sessions_account_time
          ON warmup_sessions(account_key, timestamp);
        CREATE INDEX IF NOT EXISTS idx_warmup_policies_user_status
          ON warmup_policies(user_id, status, enabled);
        CREATE INDEX IF NOT EXISTS idx_warmup_plan_days_workspace_date
          ON warmup_plan_days(workspace_id, plan_date);
        CREATE INDEX IF NOT EXISTS idx_warmup_plan_items_account
          ON warmup_plan_items(account_key, plan_day_id);
        CREATE INDEX IF NOT EXISTS idx_task_events_task
          ON task_events(task_run_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_events_workspace
          ON task_events(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_notifications_workspace_unread
          ON notifications(workspace_id, read_at, created_at);
      `);
            db.prepare(`
        UPDATE task_runs
        SET source = COALESCE(NULLIF(source, ''), 'manual'),
            workspace_id = COALESCE(
              workspace_id,
              (SELECT workspace_id FROM devices WHERE devices.id = task_runs.device_id)
            ),
            platform = COALESCE(
              platform,
              CASE task_type
                WHEN 'warmup_tiktok' THEN 'tiktok'
                WHEN 'warmup_youtube' THEN 'youtube'
                WHEN 'warmup_ig' THEN 'instagram'
                ELSE NULL
              END
            )
        WHERE source IS NULL OR source = ''
           OR workspace_id IS NULL
           OR platform IS NULL
      `).run();
            markMigrationApplied(db, 1);
        })();
    }
    if (!migrationAlreadyApplied(db, 2)) {
        db.transaction(() => {
            addColumnIfMissing(db, 'task_runs', 'pause_requested_at', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'pause_acknowledged_at', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'pause_reason', 'TEXT');
            addColumnIfMissing(db, 'task_runs', 'remaining_duration_sec', 'INTEGER');
            addColumnIfMissing(db, 'devices', 'control_version_ack', 'INTEGER DEFAULT 0');
            addColumnIfMissing(db, 'devices', 'control_state', "TEXT DEFAULT 'idle'");
            addColumnIfMissing(db, 'devices', 'control_ack_at', 'TEXT');
            db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_controls (
          workspace_id INTEGER PRIMARY KEY,
          scheduler_mode TEXT NOT NULL DEFAULT 'normal',
          queue_paused INTEGER NOT NULL DEFAULT 0,
          previous_scheduler_mode TEXT NOT NULL DEFAULT 'normal',
          previous_queue_paused INTEGER NOT NULL DEFAULT 0,
          control_version INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          updated_by_user_id INTEGER,
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
          FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_task_runs_pause_state
          ON task_runs(workspace_id, status, pause_reason, pause_requested_at);
        CREATE INDEX IF NOT EXISTS idx_devices_control_ack
          ON devices(workspace_id, control_version_ack, control_state);
      `);
            db.prepare(`
        INSERT OR IGNORE INTO workspace_controls
          (workspace_id, scheduler_mode, queue_paused,
           previous_scheduler_mode, previous_queue_paused,
           control_version, updated_at)
        SELECT id, 'normal', 0, 'normal', 0, 0, CURRENT_TIMESTAMP
        FROM workspaces
      `).run();
            markMigrationApplied(db, 2);
        })();
    }
}
