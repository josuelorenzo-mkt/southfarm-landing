export declare const BUENOS_AIRES_TIMEZONE = "America/Argentina/Buenos_Aires";
export declare const DAILY_MIN_WARMUP_SECONDS: number;
export declare const DAILY_MAX_WARMUP_SECONDS: number;
export declare const DEFAULT_FIXED_WARMUP_SECONDS: number;
export declare const MIN_WARMUP_SESSIONS = 2;
export declare const MAX_WARMUP_SESSIONS = 3;
export declare const OVERDUE_AFTER_MS: number;
export declare const EXPIRES_AFTER_MS: number;
export type SchedulerMode = 'fixed' | 'random';
/**
 * Generates the daily target in whole minutes. The skew keeps the normal
 * result close to forty minutes while still allowing the configured 39–48
 * minute range. This is scheduling variability, not a platform-evasion rule.
 */
export declare function chooseDailyTargetSeconds(mode?: SchedulerMode, random?: () => number, fixedSeconds?: number): number;
export declare function chooseSessionCount(random?: () => number, fixedCount?: number): 2 | 3;
/**
 * Splits a daily target into two or three practical sessions while preserving
 * the exact total. The returned values are whole minutes, so the mobile app
 * can continue receiving its existing duration_minutes parameter.
 */
export declare function splitWarmupDurationSeconds(totalSeconds: number, sessionCount: 2 | 3, random?: () => number): number[];
export declare function addHoursIso(value: string, hours: number): string;
export declare function overdueAtIso(scheduledFor: string): string;
export declare function expiresAtIso(scheduledFor: string): string;
export declare function localDateTimeToIso(dateKey: string, timeValue: string, timezone?: string): string;
export declare function isTaskDue(scheduledFor: unknown, now?: Date): boolean;
export declare function isTaskOverdue(scheduledFor: unknown, now?: Date): boolean;
export declare function isTaskExpired(scheduledFor: unknown, now?: Date): boolean;
