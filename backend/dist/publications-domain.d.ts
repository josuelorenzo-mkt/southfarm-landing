import type Database from 'better-sqlite3';
export declare const PUBLICATION_TERMINAL_STATES: Set<string>;
export declare const PUBLICATION_STATE_TRANSITIONS: {
    readonly queued: readonly ["claimed", "cancelled"];
    readonly claimed: readonly ["preparing", "cancellation_requested", "failed", "review_required"];
    readonly preparing: readonly ["transferring", "cancellation_requested", "failed", "review_required"];
    readonly transferring: readonly ["selecting_media", "cancellation_requested", "failed", "review_required"];
    readonly selecting_media: readonly ["editing", "cancellation_requested", "failed", "review_required"];
    readonly editing: readonly ["captioning", "cancellation_requested", "failed", "review_required"];
    readonly captioning: readonly ["ready_to_publish", "cancellation_requested", "failed", "review_required"];
    readonly ready_to_publish: readonly ["publishing", "cancellation_requested", "failed", "review_required"];
    readonly publishing: readonly ["verifying", "review_required"];
    readonly verifying: readonly ["completed", "review_required"];
    readonly cancellation_requested: readonly ["cancelled"];
    readonly completed: readonly [];
    readonly cancelled: readonly [];
    readonly failed: readonly [];
    readonly review_required: readonly [];
};
export declare class PublicationTransitionError extends Error {
    constructor(message: string);
}
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
export type PublicationClaimWorker = {
    id: string;
    deviceId: number;
    leaseSeconds: number;
};
export type PublicationWorker = PublicationClaimWorker & {
    claimToken: string;
};
export type PublicationFinishMetadata = {
    result?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    remotePostIdentity?: string | null;
    publishedAt?: string | null;
    verifiedAt?: string | null;
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
type PublicationRow = Record<string, unknown> & {
    id: number;
    device_id: number;
    social_account_id: number;
    status: PublicationStatus;
    claimed_by: string | null;
    final_action_at: string | null;
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
    private requireLiveWorkerLock;
    createJob(input: CreatePublicationJobInput, actor: PublicationActor): PublicationJobView;
    listJobs(workspaceId?: number): PublicationJobView[];
    getJob(id: number): PublicationJobView;
    rescheduleJob(id: number, scheduledFor: string, actor: PublicationActor): PublicationJobView;
    requestCancellation(id: number, actor: PublicationActor, at?: string): PublicationJobView;
    claimDueJob(worker: PublicationClaimWorker, now: string): {
        claimed: boolean;
        job: PublicationJobView | null;
    };
    heartbeat(id: number, worker: PublicationWorker, now: string): PublicationJobView;
    checkpoint(id: number, worker: PublicationWorker, now: string, options: {
        step: PublicationStatus;
        progressPercent: number;
        finalAction?: boolean;
        evidence?: unknown;
    }): PublicationJobView;
    finish(id: number, worker: PublicationWorker, target: Extract<PublicationStatus, 'completed' | 'cancelled' | 'failed' | 'review_required'>, now: string, metadata?: PublicationFinishMetadata, actor?: PublicationActor): PublicationJobView;
}
export {};
