import type Database from 'better-sqlite3';
export declare const PUBLICATION_TERMINAL_STATES: Set<string>;
export declare const PUBLICATION_STATE_TRANSITIONS: {
    readonly queued: readonly ["claimed", "cancelled"];
    readonly claimed: readonly ["in_progress", "cancellation_requested", "failed", "review_required"];
    readonly in_progress: readonly ["completed", "cancellation_requested", "failed", "review_required"];
    readonly cancellation_requested: readonly ["cancelled"];
    readonly completed: readonly [];
    readonly cancelled: readonly [];
    readonly failed: readonly [];
    readonly review_required: readonly [];
};
type PublicationStatus = keyof typeof PUBLICATION_STATE_TRANSITIONS;
type SqliteDatabase = Database.Database;
export type ValidatedPublicationInput = {
    platform: 'instagram' | 'tiktok' | 'youtube';
    caption: string;
    wordCount: number;
};
export type PublicationActor = {
    type: string;
    id: string;
};
export type PublicationWorker = {
    id: string;
    deviceId: number;
    leaseSeconds: number;
};
export type CreatePublicationJobInput = ValidatedPublicationInput & {
    workspaceId: number;
    deviceId: number;
    socialAccountId: number;
    scheduledFor: string;
};
export type PublicationJobView = Record<string, unknown> & {
    id: number;
    status: PublicationStatus;
    final_action_at: string | null;
};
type PublicationRow = {
    id: number;
    workspace_id: number;
    device_id: number;
    social_account_id: number;
    platform: string;
    caption: string;
    word_count: number;
    scheduled_for: string;
    status: PublicationStatus;
    claimed_by: string | null;
    claimed_at: string | null;
    lease_expires_at: string | null;
    last_heartbeat_at: string | null;
    final_action_at: string | null;
    cancellation_requested_at: string | null;
    created_at: string;
    updated_at: string;
};
export declare function validatePublicationInput(input: {
    caption: unknown;
    platform: unknown;
}): ValidatedPublicationInput;
export declare function publicationJobView(row: PublicationRow, db: SqliteDatabase): PublicationJobView;
export declare class PublicationStore {
    private readonly db;
    constructor(db: SqliteDatabase);
    private transaction;
    private row;
    private event;
    private transition;
    createJob(input: CreatePublicationJobInput, actor: PublicationActor): PublicationJobView;
    listJobs(workspaceId?: number): PublicationJobView[];
    getJob(id: number): PublicationJobView;
    rescheduleJob(id: number, scheduledFor: string, actor: PublicationActor): PublicationJobView;
    requestCancellation(id: number, actor: PublicationActor, at?: string): PublicationJobView;
    claimDueJob(worker: PublicationWorker, now: string): {
        claimed: boolean;
        job: PublicationJobView | null;
    };
    heartbeat(id: number, worker: PublicationWorker, now: string): PublicationJobView;
    checkpoint(id: number, worker: PublicationWorker, now: string, options?: {
        finalAction?: boolean;
    }): PublicationJobView;
    finish(id: number, worker: PublicationWorker, target: Extract<PublicationStatus, 'completed' | 'cancelled' | 'failed' | 'review_required'>, now: string, actor?: PublicationActor): PublicationJobView;
}
export {};
