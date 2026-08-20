type SqliteDatabase = {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: unknown[]): {
            changes?: number;
        };
    };
};
/**
 * Authentication schema is additive so it can be introduced to the existing
 * SQLite database without changing devices, pairings, or task history.
 */
export declare function applyAuthMigrations(db: SqliteDatabase): void;
export declare function cleanupRefreshSessions(db: SqliteDatabase, nowIso: string): void;
export {};
