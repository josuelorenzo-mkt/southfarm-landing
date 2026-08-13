function columnNames(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all()
        .map((column) => column.name));
}
function addColumnIfMissing(db, table, name, definition) {
    if (!columnNames(db, table).has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
}
/** Additive schema for publication scheduling; legacy task runs remain unchanged. */
export function applyPublicationMigrations(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS publication_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      device_id INTEGER NOT NULL,
      social_account_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      caption TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      last_heartbeat_at TEXT,
      final_action_at TEXT,
      cancellation_requested_at TEXT,
      created_by_type TEXT,
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (social_account_id) REFERENCES social_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS publication_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_job_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      media_url TEXT NOT NULL,
      media_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (publication_job_id) REFERENCES publication_jobs(id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS publication_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_job_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      actor_type TEXT,
      actor_id TEXT,
      payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (publication_job_id) REFERENCES publication_jobs(id)
    );

    CREATE TABLE IF NOT EXISTS device_automation_locks (
      device_id INTEGER PRIMARY KEY,
      publication_job_id INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (publication_job_id) REFERENCES publication_jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_publication_jobs_status_schedule
      ON publication_jobs(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_device_status
      ON publication_jobs(device_id, status);
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_account_status
      ON publication_jobs(social_account_id, status);
    CREATE INDEX IF NOT EXISTS idx_publication_events_job_time
      ON publication_events(publication_job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_device_automation_locks_expiry
      ON device_automation_locks(expires_at);
  `);
    addColumnIfMissing(db, 'publication_jobs', 'final_action_at', 'TEXT');
    addColumnIfMissing(db, 'publication_jobs', 'cancellation_requested_at', 'TEXT');
}
