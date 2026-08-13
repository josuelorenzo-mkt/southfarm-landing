import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { PublicationStore } from './publications-domain.js';
type SqliteDatabase = Database.Database;
export declare function registerPublicationWorkerRoutes({ app, db, store, mediaRoot, workerTokenHash }: {
    app: Express;
    db: SqliteDatabase;
    store: PublicationStore;
    mediaRoot: string;
    workerTokenHash: Buffer | string;
}): void;
export {};
