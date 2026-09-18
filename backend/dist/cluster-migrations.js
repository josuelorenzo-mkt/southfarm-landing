// Cluster schema for the Activity Planner (migration v3).
// Follows the versioned, additive pattern of scheduler-migrations.ts:
// - New tables for clusters, members and per-cluster routines.
// - task_runs only gains two nullable columns (cluster_id, routine_id).
// Nothing existing is altered or dropped, so the mobile protocol keeps
// working untouched.
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
 * v3 — Activity Planner clusters:
 * account_clusters / account_cluster_members / cluster_routines plus the
 * additive task_runs columns that link generated tasks back to their
 * cluster/routine. Idempotent and safe to run on every boot.
 */
export function applyClusterMigrations(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
    if (migrationAlreadyApplied(db, 3))
        return;
    db.transaction(() => {
        addColumnIfMissing(db, 'task_runs', 'cluster_id', 'INTEGER');
        addColumnIfMissing(db, 'task_runs', 'routine_id', 'INTEGER');
        db.exec(`
      CREATE TABLE IF NOT EXISTS account_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',   -- 'confirmed' | 'suggested' | 'rejected'
        detection_method TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_cluster_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER NOT NULL,
        social_account_id INTEGER NOT NULL,
        UNIQUE(cluster_id, social_account_id),
        FOREIGN KEY (cluster_id) REFERENCES account_clusters(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS cluster_routines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER NOT NULL,
        routine_type TEXT NOT NULL,   -- 'warmup_daily' | 'scan_auto' | 'publishing'
        config TEXT NOT NULL,         -- JSON según routine_type
        status TEXT NOT NULL DEFAULT 'approved', -- 'approved' | 'editing' | 'paused'
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(cluster_id, routine_type),
        FOREIGN KEY (cluster_id) REFERENCES account_clusters(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_account_clusters_workspace
        ON account_clusters(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster
        ON account_cluster_members(cluster_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_members_account
        ON account_cluster_members(social_account_id);
      CREATE INDEX IF NOT EXISTS idx_cluster_routines_cluster
        ON cluster_routines(cluster_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_cluster
        ON task_runs(cluster_id, status, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_task_runs_routine
        ON task_runs(routine_id, status, scheduled_for);
    `);
        markMigrationApplied(db, 3);
    })();
}
