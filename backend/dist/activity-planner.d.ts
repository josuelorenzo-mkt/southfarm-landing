import type { Express } from 'express';
export type PlannerDeps = {
    db: any;
    auth: (req: any, res: any, next: any) => void;
    requireRole: (...roles: any[]) => (req: any, res: any, next: any) => void;
    nowIso: () => string;
    parseParams: (raw: unknown) => Record<string, any>;
    stringValue: (value: unknown) => string | null;
    numberValue: (value: unknown, fallback?: number) => number;
    jsonValue: (value: unknown) => string | null;
    workspaceMembership: (userId: number) => any | null;
    scopedUsers: (userId: number) => {
        ids: number[];
        placeholders: string;
    };
    dateKeyInTimezone: (value: unknown, timezone?: string) => string | null;
    taskView: (task: any, includeClaimToken?: boolean) => any;
    recordTaskEvent: (task: any, eventType: string, payload?: Record<string, unknown>) => void;
    ensureWorkspaceControl: (workspaceId: number) => any;
    workspaceControlBlocksAutomatic: (control: any) => boolean;
    normalizePlatform: (value: unknown, fallback?: any) => string;
    accountKeyFor: (userId: number, deviceId: number | null, platformValue: unknown, accountValue: unknown) => string | null;
    deviceIsOnline: (lastSeenAt: unknown) => boolean;
    plannerDateKey: (value: unknown) => string;
    mediaRoot: string;
};
export declare function registerActivityPlanner(app: Express, deps: PlannerDeps): void;
export declare function runActivityPlannerStartup(deps: PlannerDeps): void;
