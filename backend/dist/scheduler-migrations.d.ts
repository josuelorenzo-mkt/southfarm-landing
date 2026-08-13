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
 * Scheduler schema is intentionally additive. The existing mobile protocol
 * keeps using task_runs and its claim/heartbeat/update endpoints; these
 * tables and columns add durable planning metadata around that protocol.
 */
export declare function applySchedulerMigrations(db: SqliteDatabase): void;
export {};
