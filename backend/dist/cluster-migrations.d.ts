type SqliteDatabase = {
    exec(sql: string): void;
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): {
            changes?: number;
            lastInsertRowid?: number | bigint;
        };
    };
    transaction<T>(fn: () => T): () => T;
};
/**
 * v3 — Activity Planner clusters:
 * account_clusters / account_cluster_members / cluster_routines plus the
 * additive task_runs columns that link generated tasks back to their
 * cluster/routine. Idempotent and safe to run on every boot.
 */
export declare function applyClusterMigrations(db: SqliteDatabase): void;
export {};
