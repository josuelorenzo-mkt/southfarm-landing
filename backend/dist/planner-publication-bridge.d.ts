import type { Database as SqliteDatabase } from 'better-sqlite3';
export declare const PLANNER_VIDEO_MIME_EXTENSIONS: Record<string, string>;
export interface PlannerPublicationAccountInput {
    account: {
        id: number;
        username: string;
        display_name?: string | null;
        platform: string;
        device_id: number;
    };
    device: {
        id: number;
        device_id: string;
    } | null;
}
export interface PlannerPublicationResult {
    publicationIds: number[];
    skipped: Array<{
        account: string;
        reason: string;
    }>;
}
export declare function createPlannerPublicationJobs(opts: {
    db: SqliteDatabase;
    mediaRoot: string;
    workspaceId: number;
    userId: number;
    videoPath: string;
    originalFilename: string;
    mimeType: string;
    title: string;
    scheduledFor: string;
    clusterId: number;
    clusterName: string;
    clusterAssetId: string;
    accounts: PlannerPublicationAccountInput[];
}): Promise<PlannerPublicationResult>;
