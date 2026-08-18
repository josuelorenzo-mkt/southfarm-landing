import type Database from 'better-sqlite3';
import type { Express, NextFunction, Request, Response } from 'express';
import { PublicationStore } from './publications-domain.js';
import { inspectPublicationVideo } from './publication-media-inspector.js';
type SqliteDatabase = Database.Database;
type Middleware = (req: Request, res: Response, next: NextFunction) => void;
export type PlatformMediaRules = {
    maxWidth: number;
    maxHeight: number;
    allowedVideoCodecs: readonly string[];
};
export declare const PLATFORM_MEDIA_RULES: Record<string, PlatformMediaRules>;
export declare function mediaSupportedForPlatform(platform: string, metadata: {
    width: number | null;
    height: number | null;
    video_codec: string | null;
}): {
    supported: boolean;
    reason?: 'dimensions' | 'codec' | 'metadata';
};
export declare function registerPublicationRoutes({ app, db, store, auth, requireRole, mediaRoot, workerTokenHash, testHooks, inspectVideo, }: {
    app: Express;
    db: SqliteDatabase;
    store: PublicationStore;
    auth: Middleware;
    requireRole: (...roles: any[]) => Middleware;
    mediaRoot: string;
    workerTokenHash?: Buffer | string;
    inspectVideo?: typeof inspectPublicationVideo;
    testHooks?: {
        afterRename?: (req: any, res: Response) => Promise<void> | void;
        beforeReschedule?: () => void;
        beforeCancel?: () => void;
    };
}): void;
export {};
