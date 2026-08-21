function columnNames(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}
function addColumnIfMissing(db, table, name, definition) {
    if (!columnNames(db, table).has(name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
/** Additive private-media and durable publication-queue schema. */
export function applyPublicationMigrations(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS publication_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      original_filename TEXT NOT NULL,
      private_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_extension TEXT,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      duration_seconds REAL,
      width INTEGER,
      height INTEGER,
      video_codec TEXT,
      audio_codec TEXT,
      upload_status TEXT NOT NULL DEFAULT 'stored',
      retention_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );

    CREATE TABLE IF NOT EXISTS publication_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL,
      created_by_user_id INTEGER,
      device_id INTEGER NOT NULL,
      social_account_id INTEGER NOT NULL,
      media_id INTEGER,
      platform TEXT NOT NULL,
      caption TEXT NOT NULL,
      word_count INTEGER NOT NULL,
      test_mode INTEGER NOT NULL DEFAULT 0,
      scheduled_for TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step TEXT,
      progress_percent INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      last_heartbeat_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      final_action_at TEXT,
      published_at TEXT,
      verified_at TEXT,
      remote_post_identity TEXT,
      result TEXT,
      error_code TEXT,
      error_message TEXT,
      cancel_requested_at TEXT,
      completed_at TEXT,
      account_snapshot TEXT,
      device_snapshot TEXT,
      created_by_type TEXT,
      created_by_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (social_account_id) REFERENCES social_accounts(id),
      FOREIGN KEY (media_id) REFERENCES publication_media(id)
    );

    CREATE TABLE IF NOT EXISTS publication_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_job_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      current_step TEXT,
      message TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_publication_jobs_status_schedule ON publication_jobs(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_device_status ON publication_jobs(device_id, status);
    CREATE INDEX IF NOT EXISTS idx_publication_jobs_account_status ON publication_jobs(social_account_id, status);
    CREATE INDEX IF NOT EXISTS idx_publication_events_job_time ON publication_events(publication_job_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_device_automation_locks_expiry ON device_automation_locks(expires_at);
  `);
    for (const [name, definition] of [
        ['created_by_user_id', 'INTEGER'], ['media_id', 'INTEGER'], ['priority', 'INTEGER NOT NULL DEFAULT 0'], ['test_mode', 'INTEGER NOT NULL DEFAULT 0'],
        ['current_step', 'TEXT'], ['progress_percent', 'INTEGER NOT NULL DEFAULT 0'], ['claim_token', 'TEXT'],
        ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'], ['published_at', 'TEXT'], ['verified_at', 'TEXT'],
        ['remote_post_identity', 'TEXT'], ['result', 'TEXT'], ['error_code', 'TEXT'], ['error_message', 'TEXT'],
        ['cancel_requested_at', 'TEXT'], ['completed_at', 'TEXT'], ['account_snapshot', 'TEXT'], ['device_snapshot', 'TEXT'],
        // Planner bridge: cluster provenance for jobs created by the activity
        // planner's cluster publish (single publication queue, owner 2026-08-21).
        ['cluster_id', 'INTEGER'], ['cluster_name', 'TEXT'], ['cluster_asset_id', 'TEXT'],
    ])
        addColumnIfMissing(db, 'publication_jobs', name, definition);
    for (const [name, definition] of [
        ['created_by_user_id', 'INTEGER'], ['original_filename', 'TEXT'], ['private_path', 'TEXT'], ['mime_type', 'TEXT'],
        ['file_extension', 'TEXT'], ['size_bytes', 'INTEGER'], ['sha256', 'TEXT'], ['duration_seconds', 'REAL'],
        ['width', 'INTEGER'], ['height', 'INTEGER'], ['video_codec', 'TEXT'], ['audio_codec', 'TEXT'],
        ['upload_status', "TEXT NOT NULL DEFAULT 'stored'"], ['retention_until', 'TEXT'], ['updated_at', 'TEXT'],
    ])
        addColumnIfMissing(db, 'publication_media', name, definition);
    db.exec(`CREATE TABLE IF NOT EXISTS publication_cleanup_authorizations (
    nonce TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES publication_jobs(id)
  );
  CREATE INDEX IF NOT EXISTS idx_publication_cleanup_authorizations_expiry ON publication_cleanup_authorizations(expires_at);`);
    for (const [name, definition] of [
        ['workspace_id', 'INTEGER'], ['device_id', 'INTEGER'], ['social_account_id', 'INTEGER'],
        ['worker_id', 'TEXT'], ['issued_by_user_id', 'INTEGER'],
    ])
        addColumnIfMissing(db, 'publication_cleanup_authorizations', name, definition);
}
