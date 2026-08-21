import type Database from 'better-sqlite3';
type SqliteDatabase = Database.Database;
/** Additive private-media and durable publication-queue schema. */
export declare function applyPublicationMigrations(db: SqliteDatabase): void;
export {};
