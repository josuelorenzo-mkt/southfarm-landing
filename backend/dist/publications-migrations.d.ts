import type Database from 'better-sqlite3';
type SqliteDatabase = Database.Database;
/** Additive schema for publication scheduling; legacy task runs remain unchanged. */
export declare function applyPublicationMigrations(db: SqliteDatabase): void;
export {};
