export declare const DEFAULT_SLOT_BUFFER_SEC = 300;
export declare const DEFAULT_PLANNED_DURATION_SEC = 600;
export declare function slotBufferSec(): number;
export declare function msUntilEndOfLocalDay(isoInstant: string): number;
export type SlotConflict = {
    task_id: number;
    task_type: string;
    status: string;
    scheduled_for: string | null;
    window_end: string;
};
export declare function findOverlappingTasks(db: any, opts: {
    deviceId: number;
    startMs: number;
    endMs: number;
    excludeTaskId?: number | null;
    nowMs?: number;
    bufferSec?: number;
}): SlotConflict[];
export type ReserveSlotInput = {
    db: any;
    deviceId: number;
    desiredStart: string;
    durationSec: number | null;
    policy: 'shift' | 'reject';
    shiftLimitMs?: number | null;
    excludeTaskId?: number | null;
    now?: Date;
    insert?: (scheduledFor: string, shiftedFrom: string | null) => any;
};
export type ReserveSlotResult = {
    ok: true;
    scheduledFor: string;
    shiftedFrom: string | null;
    result?: any;
} | {
    ok: false;
    reason: 'conflict' | 'no_slot_within_limit';
    conflicts: SlotConflict[];
};
export declare function reserveSlot(input: ReserveSlotInput): ReserveSlotResult;
export declare function nextFreeSlot(opts: {
    db: any;
    deviceId: number;
    from: string;
    durationSec: number | null;
    shiftLimitMs?: number | null;
}): string | null;
export declare function busyUntilForDevice(db: any, deviceId: number, opts?: {
    now?: Date;
    bufferSec?: number;
}): string | null;
