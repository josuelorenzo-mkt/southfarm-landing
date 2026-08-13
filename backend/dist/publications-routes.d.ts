import type Database from 'better-sqlite3';
import type { Express, NextFunction, Request, Response } from 'express';
import { PublicationStore } from './publications-domain.js';
type SqliteDatabase = Database.Database;
type Middleware = (req: Request, res: Response, next: NextFunction) => void;
export declare function registerPublicationRoutes({ app, db, store, auth, requireRole, mediaRoot, testHooks, }: {
    app: Express;
    db: SqliteDatabase;
    store: PublicationStore;
    auth: Middleware;
    requireRole: (...roles: any[]) => Middleware;
    mediaRoot: string;
    testHooks?: {
        afterRename?: (req: any, res: Response) => Promise<void> | void;
        beforeReschedule?: () => void;
        beforeCancel?: () => void;
    };
}): void;
export {};
