/**
 * Authentication schema is additive so it can be introduced to the existing
 * SQLite database without changing devices, pairings, or task history.
 */
export function applyAuthMigrations(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      family_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      replaced_by_hash TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user
      ON refresh_sessions(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_sessions_family
      ON refresh_sessions(family_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expiry
      ON refresh_sessions(expires_at, revoked_at);
  `);
}
export function cleanupRefreshSessions(db, nowIso) {
    db.prepare(`
    DELETE FROM refresh_sessions
    WHERE (expires_at <= ? AND revoked_at IS NULL)
       OR (revoked_at IS NOT NULL AND revoked_at <= datetime(?, '-30 days'))
  `).run(nowIso, nowIso);
}
