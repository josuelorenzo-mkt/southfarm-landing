// Activity Planner — backend module for the SouthFarm API.
//
// Implements the binding API contract from
// docs/plans/2026-08-19-activity-planner-api.md on top of the existing
// Express + better-sqlite3 stack. It is intentionally self-contained: all
// shared helpers (auth middleware, date/time conversions, task event
// recording, workspace scoping) are injected via `deps` at registration time
// so index.ts only grows by an import + one call.
//
// The generated tasks are regular `task_runs` rows (source='automatic') so
// the existing claim/lease/checkpoint protocol keeps working untouched.

import type { Express } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import {
  BUENOS_AIRES_TIMEZONE,
  localDateTimeToIso,
  overdueAtIso,
  expiresAtIso,
  splitWarmupDurationSeconds,
} from './scheduler.js';

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
  scopedUsers: (userId: number) => { ids: number[]; placeholders: string };
  dateKeyInTimezone: (value: unknown, timezone?: string) => string | null;
  taskView: (task: any, includeClaimToken?: boolean) => any;
  recordTaskEvent: (task: any, eventType: string, payload?: Record<string, unknown>) => void;
  ensureWorkspaceControl: (workspaceId: number) => any;
  workspaceControlBlocksAutomatic: (control: any) => boolean;
  normalizePlatform: (value: unknown, fallback?: any) => string;
  accountKeyFor: (
    userId: number,
    deviceId: number | null,
    platformValue: unknown,
    accountValue: unknown,
  ) => string | null;
  deviceIsOnline: (lastSeenAt: unknown) => boolean;
  plannerDateKey: (value: unknown) => string;
};

const ROUTINE_TYPES = ['warmup_daily', 'scan_auto', 'publishing'] as const;
type RoutineType = typeof ROUTINE_TYPES[number];

const DEFAULT_ROUTINE_CONFIGS: Record<RoutineType, Record<string, number>> = {
  warmup_daily: { minMinutes: 40 },
  scan_auto: { timesPerDay: 2, minGapHours: 9 },
  publishing: { postsPerWeek: 2 },
};

const ROUTINE_CONFIG_LIMITS: Record<RoutineType, Record<string, [number, number]>> = {
  warmup_daily: { minMinutes: [10, 480] },
  scan_auto: { timesPerDay: [1, 6], minGapHours: [1, 23] },
  publishing: { postsPerWeek: [1, 14] },
};

// ─── Small date helpers (all wall-clock dates are America/Argentina/Buenos_Aires) ───

function todayKeyBA(deps: PlannerDeps): string {
  return deps.dateKeyInTimezone(deps.nowIso()) || '1970-01-01';
}

function weekdayIndex(isoInstant: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: BUENOS_AIRES_TIMEZONE,
    weekday: 'short',
  }).formatToParts(new Date(isoInstant)).find((part) => part.type === 'weekday')?.value;
  return Math.max(0, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd || ''));
}

function mondayOfWeek(deps: PlannerDeps, dateKey: string): string {
  const instant = localDateTimeToIso(dateKey, '12:00', BUENOS_AIRES_TIMEZONE);
  const offsetDays = weekdayIndex(instant);
  const monday = new Date(Date.parse(instant) - offsetDays * 86400000).toISOString();
  return deps.dateKeyInTimezone(monday) || dateKey;
}

function addDaysToKey(deps: PlannerDeps, dateKey: string, days: number): string {
  const instant = localDateTimeToIso(dateKey, '12:00', BUENOS_AIRES_TIMEZONE);
  return deps.dateKeyInTimezone(
    new Date(Date.parse(instant) + days * 86400000).toISOString(),
  ) || dateKey;
}

function dayIndexOf(deps: PlannerDeps, weekStart: string, dateKey: string | null): number {
  if (!dateKey) return -1;
  for (let i = 0; i < 7; i += 1) {
    if (addDaysToKey(deps, weekStart, i) === dateKey) return i;
  }
  return -1;
}

function baHourOfDay(iso: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUENOS_AIRES_TIMEZONE,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  return Number(parts.find((part) => part.type === 'hour')?.value || -1);
}

// ─── Cluster naming / username normalization ───

function normalizeUsername(raw: unknown): string {
  return String(raw || '').replace(/^@+/, '').toLowerCase().replace(/[._-]/g, '').trim();
}

function prettifyClusterName(username: string): string {
  return username
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ─── Routine config helpers ───

function parseRoutineConfig(routineType: RoutineType, raw: unknown): Record<string, number> {
  const limits = ROUTINE_CONFIG_LIMITS[routineType];
  const config: Record<string, number> = { ...DEFAULT_ROUTINE_CONFIGS[routineType] };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(limits)) {
      const value = (raw as Record<string, unknown>)[key];
      if (value === undefined || value === null) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) throw new Error('Config inválida para ' + key);
      const [min, max] = limits[key];
      config[key] = Math.min(max, Math.max(min, Math.round(num)));
    }
  }
  return config;
}

function insertDefaultRoutines(deps: PlannerDeps, clusterId: number): void {
  const now = deps.nowIso();
  const insert = deps.db.prepare(`
    INSERT OR IGNORE INTO cluster_routines (cluster_id, routine_type, config, status, created_at, updated_at)
    VALUES (?, ?, ?, 'approved', ?, ?)
  `);
  for (const type of ROUTINE_TYPES) {
    insert.run(clusterId, type, deps.jsonValue(DEFAULT_ROUTINE_CONFIGS[type]), now, now);
  }
}

// ─── Accounts / tasks queries ───

function clusterAccounts(deps: PlannerDeps, clusterId: number): any[] {
  const rows = deps.db.prepare(`
    SELECT sa.*, d.device_id AS device_key, d.device_name, d.device_alias
    FROM account_cluster_members m
    JOIN social_accounts sa ON sa.id = m.social_account_id
    LEFT JOIN devices d ON d.id = sa.device_id
    WHERE m.cluster_id = ?
    ORDER BY sa.platform, sa.username, sa.id
  `).all(clusterId) as any[];
  return rows.map((row) => {
    const accountKey = row.account_key
      || deps.accountKeyFor(
        Number(row.user_id),
        row.device_id === null || row.device_id === undefined ? null : Number(row.device_id),
        row.platform,
        row.username,
      );
    if (!row.account_key && accountKey && row.id) {
      deps.db.prepare('UPDATE social_accounts SET account_key = ? WHERE id = ?').run(accountKey, row.id);
    }
    return { ...row, account_key: accountKey };
  });
}

function policyStatusFor(deps: PlannerDeps, accountKey: string | null): string {
  if (!accountKey) return 'automatic';
  const policy = deps.db.prepare('SELECT status FROM warmup_policies WHERE account_key = ?').get(accountKey) as any;
  return policy?.status || 'automatic';
}

function workspaceOwnerId(deps: PlannerDeps, workspaceId: number): number | null {
  const workspace = deps.db.prepare('SELECT owner_user_id FROM workspaces WHERE id = ?').get(workspaceId) as any;
  return workspace ? Number(workspace.owner_user_id) : null;
}

function taskTypeForPlatform(platform: string): string {
  return platform === 'tiktok'
    ? 'warmup_tiktok'
    : platform === 'youtube'
    ? 'warmup_youtube'
    : 'warmup_ig';
}

function insertRoutineTask(
  deps: PlannerDeps,
  opts: {
    workspaceId: number;
    userId: number;
    deviceId: number | null;
    taskType: string;
    platform: string;
    account: any;
    params: Record<string, unknown>;
    scheduledFor: string;
    plannedDurationSec: number | null;
    clusterId: number;
    routineId: number | null;
    clusterName: string;
    priority: number;
  },
): any {
  const createdAt = deps.nowIso();
  const params = {
    ...opts.params,
    cluster_id: opts.clusterId,
    routine_id: opts.routineId === null || opts.routineId === undefined ? null : opts.routineId,
    cluster_name: opts.clusterName,
    ...(opts.account
      ? {
          account: String(opts.account.username || '').replace(/^@+/, ''),
          platform: opts.account.platform,
          social_account_id: opts.account.id,
          account_key: opts.account.account_key,
        }
      : {}),
  };
  const result = deps.db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, workspace_id, task_type, platform, source, params,
       status, scheduled_for, overdue_at, expires_at, planned_duration_sec,
       actual_duration_sec, social_account_id, account_key, cluster_id, routine_id,
       manual_override, priority, attempt_count, account_snapshot,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'automatic', ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)
  `).run(
    opts.userId,
    opts.deviceId,
    opts.workspaceId,
    opts.taskType,
    opts.platform,
    deps.jsonValue(params),
    opts.scheduledFor,
    overdueAtIso(opts.scheduledFor),
    expiresAtIso(opts.scheduledFor),
    opts.plannedDurationSec,
    opts.account?.id ?? null,
    opts.account?.account_key ?? null,
    opts.clusterId,
    opts.routineId,
    opts.priority,
    deps.jsonValue(opts.account
      ? {
          account: opts.account.username,
          platform: opts.account.platform,
          device_id: opts.account.device_key,
          social_account_id: opts.account.id,
        }
      : {}),
    createdAt,
    createdAt,
  );
  const task = deps.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(result.lastInsertRowid);
  deps.recordTaskEvent(task, 'created_automatic', {
    cluster_id: opts.clusterId,
    routine_id: opts.routineId,
    scheduled_for: opts.scheduledFor,
    planned_duration_sec: opts.plannedDurationSec,
  });
  return task;
}

function existingNonCancelledForDay(
  deps: PlannerDeps,
  clusterId: number,
  routineId: number,
  dateKey: string,
): any[] {
  const rows = deps.db.prepare(`
    SELECT * FROM task_runs
    WHERE cluster_id = ? AND routine_id = ? AND status != 'cancelled'
  `).all(clusterId, routineId) as any[];
  return rows.filter((row) => deps.dateKeyInTimezone(row.scheduled_for || row.created_at) === dateKey);
}

function cancelRoutineFutureTasks(
  deps: PlannerDeps,
  clusterId: number,
  routineId: number,
  reason: string,
): number {
  const rows = deps.db.prepare(`
    SELECT * FROM task_runs
    WHERE cluster_id = ? AND routine_id = ?
      AND source = 'automatic'
      AND status IN ('pending', 'overdue')
      AND started_at IS NULL
  `).all(clusterId, routineId) as any[];
  let cancelled = 0;
  for (const row of rows) {
    const now = deps.nowIso();
    const update = deps.db.prepare(`
      UPDATE task_runs
      SET status = 'cancelled', completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL, cancel_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'overdue') AND started_at IS NULL
    `).run(now, reason, now, row.id);
    if (update.changes !== 1) continue;
    const updated = deps.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
    deps.recordTaskEvent(updated, 'auto_cancelled_routine', {
      cluster_id: clusterId,
      routine_id: routineId,
      reason,
    });
    cancelled += 1;
  }
  return cancelled;
}

function cancelClusterFutureTasks(
  deps: PlannerDeps,
  clusterId: number,
  reason: string,
): number {
  const rows = deps.db.prepare(`
    SELECT * FROM task_runs
    WHERE cluster_id = ?
      AND source = 'automatic'
      AND status IN ('pending', 'overdue')
      AND started_at IS NULL
  `).all(clusterId) as any[];
  let cancelled = 0;
  for (const row of rows) {
    const now = deps.nowIso();
    const update = deps.db.prepare(`
      UPDATE task_runs
      SET status = 'cancelled', completed_at = COALESCE(completed_at, ?),
          lease_expires_at = NULL, cancel_reason = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'overdue') AND started_at IS NULL
    `).run(now, reason, now, row.id);
    if (update.changes !== 1) continue;
    const updated = deps.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(row.id);
    deps.recordTaskEvent(updated, 'auto_cancelled_cluster', { cluster_id: clusterId, reason });
    cancelled += 1;
  }
  return cancelled;
}

// ─── Generation engine ───

function scanHoursForTimes(timesPerDay: number): string[] {
  const preferred = [11, 21, 16, 9, 14, 19, 8, 13, 18, 22];
  return preferred
    .slice(0, Math.max(1, Math.min(6, timesPerDay)))
    .sort((a, b) => a - b)
    .map((hour) => String(hour).padStart(2, '0') + ':00');
}

function publishingDaysFor(clusterId: number, postsPerWeek: number): number[] {
  // Weekday indexes (Mon=0): Tue=1, Thu=3, Wed=2, Fri=4, Mon=0, Sat=5.
  // Default = mar y jue; the cluster id parity shifts the fixed days.
  const base = [1, 3, 2, 4, 0, 5];
  const offset = Number(clusterId) % 2;
  return base
    .slice(0, Math.max(1, Math.min(6, postsPerWeek)))
    .map((day) => (day + offset) % 7);
}

function generateWarmupDay(
  deps: PlannerDeps,
  workspaceId: number,
  ownerId: number,
  cluster: any,
  routine: any,
  accounts: any[],
  dateKey: string,
  todayKey: string,
): number {
  if (dateKey < todayKey) return 0;
  const config = parseRoutineConfig('warmup_daily', deps.parseParams(routine.config));
  const minMinutes = config.minMinutes;
  if (existingNonCancelledForDay(deps, cluster.id, routine.id, dateKey).length > 0) return 0;
  let created = 0;
  for (const account of accounts) {
    if (!account.device_id) continue;
    const sessionCount = minMinutes >= 45 ? 3 : 2;
    const durations = splitWarmupDurationSeconds(minMinutes * 60, sessionCount as 2 | 3, Math.random);
    const usableWindowMinutes = 10 * 60 - (durations.length - 1) * 120;
    const startOffset = Math.floor(Math.random() * Math.max(1, usableWindowMinutes));
    for (let i = 0; i < durations.length; i += 1) {
      const localMinutes = 12 * 60 + startOffset + i * 120;
      const hour = Math.floor(localMinutes / 60);
      const minute = localMinutes % 60;
      const localTime = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
      const scheduledFor = localDateTimeToIso(dateKey, localTime, BUENOS_AIRES_TIMEZONE);
      insertRoutineTask(deps, {
        workspaceId,
        userId: ownerId,
        deviceId: account.device_id,
        taskType: taskTypeForPlatform(account.platform),
        platform: account.platform,
        account,
        params: { duration_minutes: Math.max(1, Math.round(durations[i] / 60)) },
        scheduledFor,
        plannedDurationSec: durations[i],
        clusterId: cluster.id,
        routineId: routine.id,
        clusterName: cluster.name,
        priority: 0,
      });
      created += 1;
    }
  }
  return created;
}

function generateScanDay(
  deps: PlannerDeps,
  workspaceId: number,
  ownerId: number,
  cluster: any,
  routine: any,
  accounts: any[],
  dateKey: string,
  todayKey: string,
): number {
  if (dateKey < todayKey) return 0;
  const config = parseRoutineConfig('scan_auto', deps.parseParams(routine.config));
  if (existingNonCancelledForDay(deps, cluster.id, routine.id, dateKey).length > 0) return 0;
  const hours = scanHoursForTimes(config.timesPerDay);
  let created = 0;
  for (const account of accounts) {
    if (!account.device_id) continue;
    for (const time of hours) {
      const scheduledFor = localDateTimeToIso(dateKey, time, BUENOS_AIRES_TIMEZONE);
      insertRoutineTask(deps, {
        workspaceId,
        userId: ownerId,
        deviceId: account.device_id,
        taskType: 'scan_' + account.platform,
        platform: account.platform,
        account,
        params: { duration_minutes: 10, times_per_day: config.timesPerDay },
        scheduledFor,
        plannedDurationSec: 600,
        clusterId: cluster.id,
        routineId: routine.id,
        clusterName: cluster.name,
        priority: 100,
      });
      created += 1;
    }
  }
  return created;
}

function generatePublishingWeek(
  deps: PlannerDeps,
  workspaceId: number,
  ownerId: number,
  cluster: any,
  routine: any,
  accounts: any[],
  weekStart: string,
  todayKey: string,
): number {
  const config = parseRoutineConfig('publishing', deps.parseParams(routine.config));
  const days = publishingDaysFor(cluster.id, config.postsPerWeek);
  let created = 0;
  for (const dayIndex of days) {
    const dateKey = addDaysToKey(deps, weekStart, dayIndex);
    if (dateKey < todayKey) continue;
    if (existingNonCancelledForDay(deps, cluster.id, routine.id, dateKey).length > 0) continue;
    for (const account of accounts) {
      if (!account.device_id) continue;
      const scheduledFor = localDateTimeToIso(dateKey, '16:00', BUENOS_AIRES_TIMEZONE);
      insertRoutineTask(deps, {
        workspaceId,
        userId: ownerId,
        deviceId: account.device_id,
        taskType: 'publish_reel',
        platform: account.platform,
        account,
        params: { duration_minutes: 1, title: '— definir contenido —', video_url: '' },
        scheduledFor,
        plannedDurationSec: 60,
        clusterId: cluster.id,
        routineId: routine.id,
        clusterName: cluster.name,
        priority: 200,
      });
      created += 1;
    }
  }
  return created;
}

function generateClusterWeek(
  deps: PlannerDeps,
  workspaceId: number,
  cluster: any,
  weekStart: string,
  todayKey: string,
): number {
  const ownerId = workspaceOwnerId(deps, workspaceId);
  if (!ownerId) return 0;
  const accounts = clusterAccounts(deps, cluster.id);
  const routines = deps.db.prepare(
    'SELECT * FROM cluster_routines WHERE cluster_id = ?',
  ).all(cluster.id) as any[];
  let created = 0;
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dateKey = addDaysToKey(deps, weekStart, dayIndex);
    if (dateKey < todayKey) continue;
    for (const routine of routines) {
      if (routine.status !== 'approved') continue;
      if (routine.routine_type === 'warmup_daily') {
        created += generateWarmupDay(deps, workspaceId, ownerId, cluster, routine, accounts, dateKey, todayKey);
      } else if (routine.routine_type === 'scan_auto') {
        created += generateScanDay(deps, workspaceId, ownerId, cluster, routine, accounts, dateKey, todayKey);
      }
    }
  }
  for (const routine of routines) {
    if (routine.status !== 'approved' || routine.routine_type !== 'publishing') continue;
    created += generatePublishingWeek(deps, workspaceId, ownerId, cluster, routine, accounts, weekStart, todayKey);
  }
  return created;
}

/**
 * Materializes one week (Monday..Sunday in BA) for every confirmed cluster
 * of the workspace. Idempotent per (cluster, routine, day). Also cleans up
 * unstarted automatic tasks of routines that are no longer approved.
 */
function generatePlannerWeek(
  deps: PlannerDeps,
  workspaceId: number,
  weekStart: string,
): { created: number; cancelled: number } {
  const todayKey = todayKeyBA(deps);
  const clusters = deps.db.prepare(`
    SELECT * FROM account_clusters
    WHERE workspace_id = ? AND status = 'confirmed'
    ORDER BY id
  `).all(workspaceId) as any[];
  let created = 0;
  let cancelled = 0;
  for (const cluster of clusters) {
    const routines = deps.db.prepare(
      'SELECT * FROM cluster_routines WHERE cluster_id = ?',
    ).all(cluster.id) as any[];
    for (const routine of routines) {
      if (routine.status !== 'approved') {
        cancelled += cancelRoutineFutureTasks(deps, cluster.id, routine.id, 'routine_not_approved');
      }
    }
    created += generateClusterWeek(deps, workspaceId, cluster, weekStart, todayKey);
  }
  return { created, cancelled };
}

function generateForCurrentAndNext(deps: PlannerDeps, workspaceId: number): { created: number; cancelled: number } {
  const todayKey = todayKeyBA(deps);
  const current = mondayOfWeek(deps, todayKey);
  const next = mondayOfWeek(deps, addDaysToKey(deps, todayKey, 7));
  const a = generatePlannerWeek(deps, workspaceId, current);
  const b = generatePlannerWeek(deps, workspaceId, next);
  return { created: a.created + b.created, cancelled: a.cancelled + b.cancelled };
}

// ─── Views (week item, list item, history) ───

function weekTasks(
  deps: PlannerDeps,
  workspaceId: number,
  clusterId: number,
  weekStart: string,
  weekEnd: string,
): any[] {
  const rows = deps.db.prepare(`
    SELECT tr.*, sa.username AS account_username, d.device_id AS device_key, d.device_alias
    FROM task_runs tr
    LEFT JOIN social_accounts sa ON sa.id = tr.social_account_id
    LEFT JOIN devices d ON d.id = tr.device_id
    WHERE tr.workspace_id = ? AND tr.cluster_id = ? AND tr.scheduled_for IS NOT NULL
    ORDER BY COALESCE(tr.scheduled_for, tr.created_at) ASC, tr.id ASC
  `).all(workspaceId, clusterId) as any[];
  return rows.filter((row) => {
    const dk = deps.dateKeyInTimezone(row.scheduled_for);
    return dk !== null && dk >= weekStart && dk <= weekEnd;
  });
}

function plannerTaskView(deps: PlannerDeps, task: any, clusterNameOverride?: string | null): any {
  const params = deps.parseParams(task.params);
  const durationMin = deps.numberValue(task.planned_duration_sec)
    ? Math.max(1, Math.round(Number(task.planned_duration_sec || 0) / 60))
    : deps.numberValue(params.duration_minutes);
  return {
    id: task.id,
    taskType: task.task_type,
    status: task.status,
    scheduledFor: task.scheduled_for,
    durationMin,
    clusterId: task.cluster_id === null || task.cluster_id === undefined ? null : Number(task.cluster_id),
    clusterName: clusterNameOverride !== undefined
      ? clusterNameOverride
      : (params.cluster_name || null),
    username: task.account_username || params.account || '',
    platform: task.platform || params.platform || '',
    deviceAlias: task.device_alias || null,
    source: task.source || 'manual',
  };
}

function computeClusterSeries(
  deps: PlannerDeps,
  workspaceId: number,
  cluster: any,
  accounts: any[],
  routines: any[],
  tasks: any[],
  weekStart: string,
): {
  warmup: number[];
  posts: number[];
  views: number[];
  health: string;
} {
  const todayKey = todayKeyBA(deps);
  const accountKeys = accounts.map((a) => a.account_key).filter(Boolean) as string[];
  const warmupExecuted = new Array<number>(7).fill(0);
  const warmupPlanned = new Array<number>(7).fill(0);
  const postsExecuted = new Array<number>(7).fill(0);
  const postsPlanned = new Array<number>(7).fill(0);
  const scansExecuted = new Array<number>(7).fill(0);

  const sessions = accountKeys.length
    ? deps.db.prepare(`
        SELECT timestamp, elapsed_sec FROM warmup_sessions
        WHERE status = 'completed' AND account_key IN (${accountKeys.map(() => '?').join(',')})
      `).all(...accountKeys) as any[]
    : [];
  for (const session of sessions) {
    const idx = dayIndexOf(deps, weekStart, deps.dateKeyInTimezone(session.timestamp));
    if (idx >= 0) warmupExecuted[idx] += deps.numberValue(session.elapsed_sec) / 60;
  }

  const completed = deps.db.prepare(`
    SELECT task_type, completed_at, scheduled_for FROM task_runs
    WHERE workspace_id = ? AND cluster_id = ? AND status = 'completed'
  `).all(workspaceId, cluster.id) as any[];
  for (const row of completed) {
    const idx = dayIndexOf(deps, weekStart, deps.dateKeyInTimezone(row.completed_at || row.scheduled_for));
    if (idx < 0) continue;
    if (row.task_type === 'publish_reel') postsExecuted[idx] += 1;
    else if (String(row.task_type).startsWith('scan_')) scansExecuted[idx] += 1;
  }

  for (const task of tasks) {
    const idx = dayIndexOf(deps, weekStart, deps.dateKeyInTimezone(task.scheduled_for));
    if (idx < 0) continue;
    if (['completed', 'cancelled', 'expired', 'error'].includes(task.status)) continue;
    if (String(task.task_type).startsWith('warmup_')) {
      warmupPlanned[idx] += deps.numberValue(task.planned_duration_sec) / 60;
    } else if (task.task_type === 'publish_reel') {
      postsPlanned[idx] += 1;
    }
  }

  const todayIdx = dayIndexOf(deps, weekStart, todayKey);
  const warmup = warmupExecuted.map((executed, idx) =>
    Math.round(executed + (idx === todayIdx ? 0 : warmupPlanned[idx])),
  );
  const posts = postsExecuted.map((executed, idx) =>
    executed + (idx === todayIdx ? 0 : postsPlanned[idx]),
  );

  // health: paused si todas las rutinas paused; deficit si algún día pasado
  // quedó debajo de lo exigido por una rutina aprobada; ok el resto.
  let health = 'ok';
  if (routines.length > 0 && routines.every((routine) => routine.status === 'paused')) {
    health = 'paused';
  } else if (todayIdx >= 0) {
    const approvedWarmup = routines.find((r) => r.routineType === 'warmup_daily' && r.status === 'approved');
    const approvedScan = routines.find((r) => r.routineType === 'scan_auto' && r.status === 'approved');
    const approvedPublish = routines.find((r) => r.routineType === 'publishing' && r.status === 'approved');
    for (let i = 0; i < todayIdx; i += 1) {
      if (approvedWarmup) {
        const config = parseRoutineConfig('warmup_daily', approvedWarmup.config);
        if (warmupExecuted[i] < config.minMinutes * accounts.length) {
          health = 'deficit';
          break;
        }
      }
      if (approvedScan) {
        const config = parseRoutineConfig('scan_auto', approvedScan.config);
        if (scansExecuted[i] < config.timesPerDay * accounts.length) {
          health = 'deficit';
          break;
        }
      }
      if (approvedPublish) {
        const config = parseRoutineConfig('publishing', approvedPublish.config);
        if (
          publishingDaysFor(cluster.id, config.postsPerWeek).includes(i)
          && postsExecuted[i] < accounts.length
        ) {
          health = 'deficit';
          break;
        }
      }
    }
  }

  return { warmup, posts, views: [0, 0, 0, 0, 0, 0, 0], health };
}

function buildWeekClusterItem(
  deps: PlannerDeps,
  workspaceId: number,
  cluster: any,
  weekStart: string,
  weekEnd: string,
): any {
  const rawAccounts = clusterAccounts(deps, cluster.id);
  const accounts = rawAccounts.map((account) => ({
    ...account,
    policy_status: policyStatusFor(deps, account.account_key),
  }));
  const routines = (deps.db.prepare(
    'SELECT * FROM cluster_routines WHERE cluster_id = ?',
  ).all(cluster.id) as any[]).map((routine) => ({
    id: routine.id,
    routineType: routine.routine_type,
    status: routine.status,
    config: deps.parseParams(routine.config),
  }));
  const tasks = weekTasks(deps, workspaceId, cluster.id, weekStart, weekEnd);
  const series = computeClusterSeries(deps, workspaceId, cluster, accounts, routines, tasks, weekStart);
  return {
    id: cluster.id,
    name: cluster.name,
    status: cluster.status,
    health: series.health,
    accounts: accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      username: account.username,
      deviceAlias: account.device_alias || null,
      policyStatus: account.policy_status,
    })),
    routines,
    metricSeries: {
      warmup: series.warmup,
      posts: series.posts,
      views: series.views,
    },
    tasks: tasks.map((task) => plannerTaskView(deps, task)),
  };
}

function computeSummary(deps: PlannerDeps, items: any[]): any {
  let tasksTotal = 0;
  let tasksRunning = 0;
  let tasksQueued = 0;
  let publishTotal = 0;
  let warmupMinutesPlanned = 0;
  for (const item of items) {
    for (const task of item.tasks) {
      tasksTotal += 1;
      if (task.status === 'running') tasksRunning += 1;
      if (task.status === 'pending' || task.status === 'overdue') tasksQueued += 1;
      if (task.taskType === 'publish_reel') publishTotal += 1;
      if (
        String(task.taskType).startsWith('warmup_')
        && ['pending', 'overdue', 'running', 'paused'].includes(task.status)
      ) {
        warmupMinutesPlanned += deps.numberValue(task.durationMin);
      }
    }
  }
  return { tasksTotal, tasksRunning, tasksQueued, publishTotal, warmupMinutesPlanned };
}

// ─── History / detail ───

function buildClusterHistory(deps: PlannerDeps, workspaceId: number, cluster: any): any {
  const accounts = clusterAccounts(deps, cluster.id);
  const accountKeys = accounts.map((a) => a.account_key).filter(Boolean) as string[];
  const todayKey = todayKeyBA(deps);

  const publications = deps.db.prepare(`
    SELECT tr.*, sa.username AS account_username
    FROM task_runs tr
    LEFT JOIN social_accounts sa ON sa.id = tr.social_account_id
    WHERE tr.workspace_id = ? AND tr.cluster_id = ? AND tr.task_type = 'publish_reel'
    ORDER BY COALESCE(tr.scheduled_for, tr.created_at) DESC, tr.id DESC
    LIMIT 10
  `).all(workspaceId, cluster.id) as any[];

  const sessions = accountKeys.length
    ? deps.db.prepare(`
        SELECT timestamp, elapsed_sec FROM warmup_sessions
        WHERE status = 'completed' AND account_key IN (${accountKeys.map(() => '?').join(',')})
      `).all(...accountKeys) as any[]
    : [];
  const completedPosts = deps.db.prepare(`
    SELECT completed_at, scheduled_for FROM task_runs
    WHERE workspace_id = ? AND cluster_id = ? AND task_type = 'publish_reel' AND status = 'completed'
  `).all(workspaceId, cluster.id) as any[];

  const warmupByDay: number[] = [];
  const postsByDay: number[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const dayKey = addDaysToKey(deps, todayKey, -i);
    let warmupMin = 0;
    for (const session of sessions) {
      if (deps.dateKeyInTimezone(session.timestamp) === dayKey) {
        warmupMin += deps.numberValue(session.elapsed_sec) / 60;
      }
    }
    let posts = 0;
    for (const post of completedPosts) {
      if (deps.dateKeyInTimezone(post.completed_at || post.scheduled_for) === dayKey) posts += 1;
    }
    warmupByDay.push(Math.round(warmupMin));
    postsByDay.push(posts);
  }

  const cutoff = addDaysToKey(deps, todayKey, -30);
  let warmupMinutes30d = 0;
  for (const session of sessions) {
    const dk = deps.dateKeyInTimezone(session.timestamp);
    if (dk && dk >= cutoff) warmupMinutes30d += deps.numberValue(session.elapsed_sec) / 60;
  }
  const posts30d = completedPosts.filter((post) => {
    const dk = deps.dateKeyInTimezone(post.completed_at || post.scheduled_for);
    return dk !== null && dk >= cutoff;
  }).length;
  // Stats del hero del detalle: publicaciones totales (histórico completo) y posts de esta semana.
  const publicationsTotal = completedPosts.length;
  const weekStartKey = mondayOfWeek(deps, todayKey);
  const postsThisWeek = completedPosts.filter((post) => {
    const dk = deps.dateKeyInTimezone(post.completed_at || post.scheduled_for);
    return dk !== null && dk >= weekStartKey;
  }).length;

  return {
    publications: publications.map((publication) => {
      const params = deps.parseParams(publication.params);
      return {
        id: publication.id,
        taskType: publication.task_type,
        status: publication.status,
        scheduledFor: publication.scheduled_for,
        username: publication.account_username || params.account || '',
        platform: publication.platform || params.platform || '',
        title: params.title || '',
      };
    }),
    warmupByDay,
    postsByDay,
    stats: { warmupMinutes30d: Math.round(warmupMinutes30d), posts30d, publicationsTotal, postsThisWeek, views: null },
  };
}

// ─── Auto-detection ───

function detectGroups(
  deps: PlannerDeps,
  workspaceId: number,
  accountsOverride?: any[],
): Array<{ username: string; name: string; accounts: any[] }> {
  const rows = accountsOverride || deps.db.prepare(`
    SELECT sa.* FROM social_accounts sa
    JOIN workspace_members wm ON wm.user_id = sa.user_id
    WHERE wm.workspace_id = ? AND wm.status = 'active'
    ORDER BY sa.platform, sa.username, sa.id
  `).all(workspaceId) as any[];
  const byNormalized = new Map<string, any[]>();
  for (const row of rows) {
    const normalized = normalizeUsername(row.username);
    if (!normalized) continue;
    const list = byNormalized.get(normalized) || [];
    list.push(row);
    byNormalized.set(normalized, list);
  }
  const clustered = new Set<number>();
  for (const member of deps.db.prepare('SELECT social_account_id FROM account_cluster_members').all() as any[]) {
    clustered.add(Number(member.social_account_id));
  }
  const groups: Array<{ username: string; name: string; accounts: any[] }> = [];
  for (const [normalized, groupAccounts] of byNormalized) {
    const platforms = new Set(groupAccounts.map((account) => account.platform));
    if (groupAccounts.length < 2 || platforms.size < 2) continue;
    if (groupAccounts.some((account) => clustered.has(Number(account.id)))) continue;
    groups.push({
      username: normalized,
      name: prettifyClusterName(String(groupAccounts[0].username || normalized)),
      accounts: groupAccounts,
    });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

function createClusterFromGroup(
  deps: PlannerDeps,
  workspaceId: number,
  group: { name: string; accounts: any[] },
  status: 'confirmed' | 'suggested',
): any {
  const now = deps.nowIso();
  const result = deps.db.prepare(`
    INSERT INTO account_clusters (workspace_id, name, status, detection_method, created_at, updated_at)
    VALUES (?, ?, ?, 'auto', ?, ?)
  `).run(workspaceId, group.name, status, now, now);
  const clusterId = Number(result.lastInsertRowid);
  const insertMember = deps.db.prepare(
    'INSERT OR IGNORE INTO account_cluster_members (cluster_id, social_account_id) VALUES (?, ?)',
  );
  for (const account of group.accounts) insertMember.run(clusterId, Number(account.id));
  if (status === 'confirmed') insertDefaultRoutines(deps, clusterId);
  return deps.db.prepare('SELECT * FROM account_clusters WHERE id = ?').get(clusterId);
}

// ─── Seed / demo (idempotent) ───

function seedEnabled(): boolean {
  const env = String(process.env.SOUTHFARM_SEED_DEMO || '').trim().toLowerCase();
  if (process.env.NODE_ENV === 'production') return env === 'true';
  return env === '' || ['1', 'true', 'yes', 'on'].includes(env);
}

function seedCompletedWarmup(
  deps: PlannerDeps,
  opts: {
    workspaceId: number;
    ownerId: number;
    cluster: any;
    routineId: number | null;
    account: any;
    dayKey: string;
    elapsedSec: number;
  },
): void {
  const scheduledFor = localDateTimeToIso(opts.dayKey, '15:00', BUENOS_AIRES_TIMEZONE);
  const completedAt = new Date(Date.parse(scheduledFor) + 25 * 60000).toISOString();
  const createdAt = new Date(Date.parse(scheduledFor) - 3600000).toISOString();
  const minutes = Math.max(1, Math.round(opts.elapsedSec / 60));
  const params = {
    account: opts.account.username,
    platform: opts.account.platform,
    duration_minutes: minutes,
    social_account_id: opts.account.id,
    account_key: opts.account.account_key,
    cluster_id: opts.cluster.id,
    routine_id: opts.routineId,
    cluster_name: opts.cluster.name,
  };
  const result = {
    elapsed_sec: opts.elapsedSec,
    platform: opts.account.platform,
    account: opts.account.username,
    timestamp: completedAt,
  };
  const r = deps.db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, workspace_id, task_type, platform, source, params, result,
       status, scheduled_for, overdue_at, expires_at, planned_duration_sec,
       actual_duration_sec, social_account_id, account_key, cluster_id, routine_id,
       manual_override, priority, attempt_count, created_at, started_at, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'automatic', ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?)
  `).run(
    opts.ownerId,
    opts.account.device_id,
    opts.workspaceId,
    taskTypeForPlatform(opts.account.platform),
    opts.account.platform,
    deps.jsonValue(params),
    deps.jsonValue(result),
    scheduledFor,
    overdueAtIso(scheduledFor),
    expiresAtIso(scheduledFor),
    opts.elapsedSec,
    opts.elapsedSec,
    opts.account.id,
    opts.account.account_key,
    opts.cluster.id,
    opts.routineId,
    createdAt,
    new Date(Date.parse(scheduledFor) + 600000).toISOString(),
    completedAt,
    deps.nowIso(),
  );
  const taskId = Number(r.lastInsertRowid);
  deps.db.prepare(`
    INSERT INTO warmup_sessions
      (user_id, device_id, task_run_id, account_key, account, platform,
       duration_minutes, elapsed_sec, status, timestamp, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
  `).run(
    opts.ownerId,
    opts.account.device_id,
    taskId,
    opts.account.account_key,
    opts.account.username,
    opts.account.platform,
    minutes,
    opts.elapsedSec,
    completedAt,
    deps.nowIso(),
    deps.nowIso(),
  );
}

function seedCompletedPublish(
  deps: PlannerDeps,
  opts: {
    workspaceId: number;
    ownerId: number;
    cluster: any;
    routineId: number | null;
    account: any;
    dayKey: string;
    title: string;
  },
): void {
  const scheduledFor = localDateTimeToIso(opts.dayKey, '16:00', BUENOS_AIRES_TIMEZONE);
  const completedAt = new Date(Date.parse(scheduledFor) + 30 * 60000).toISOString();
  const createdAt = new Date(Date.parse(scheduledFor) - 3600000).toISOString();
  const params = {
    account: opts.account.username,
    platform: opts.account.platform,
    duration_minutes: 1,
    social_account_id: opts.account.id,
    account_key: opts.account.account_key,
    cluster_id: opts.cluster.id,
    routine_id: opts.routineId,
    cluster_name: opts.cluster.name,
    title: opts.title,
    video_url: 'https://example.com/demo/' + opts.cluster.id + '-' + opts.dayKey + '.mp4',
  };
  const result = {
    status: 'published',
    platform: opts.account.platform,
    account: opts.account.username,
    timestamp: completedAt,
    url: params.video_url,
  };
  deps.db.prepare(`
    INSERT INTO task_runs
      (user_id, device_id, workspace_id, task_type, platform, source, params, result,
       status, scheduled_for, overdue_at, expires_at, planned_duration_sec,
       actual_duration_sec, social_account_id, account_key, cluster_id, routine_id,
       manual_override, priority, attempt_count, created_at, started_at, completed_at, updated_at)
    VALUES (?, ?, ?, 'publish_reel', ?, 'automatic', ?, ?, 'completed', ?, ?, ?, 60, 60, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?)
  `).run(
    opts.ownerId,
    opts.account.device_id,
    opts.workspaceId,
    opts.account.platform,
    deps.jsonValue(params),
    deps.jsonValue(result),
    scheduledFor,
    overdueAtIso(scheduledFor),
    expiresAtIso(scheduledFor),
    opts.account.id,
    opts.account.account_key,
    opts.cluster.id,
    opts.routineId,
    createdAt,
    new Date(Date.parse(scheduledFor) + 120000).toISOString(),
    completedAt,
    deps.nowIso(),
  );
}

function seedDemoData(deps: PlannerDeps): void {
  if (!seedEnabled()) return;
  // Elegir el workspace con más cuentas sociales (el operativo real), no el primero por id.
  const workspace = deps.db.prepare(`
    SELECT w.id, w.owner_user_id
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.status = 'active'
    LEFT JOIN social_accounts sa ON sa.user_id = wm.user_id
    GROUP BY w.id
    ORDER BY COUNT(sa.id) DESC, w.id ASC
    LIMIT 1
  `).get() as any;
  if (!workspace) return;
  const workspaceId = Number(workspace.id);
  const ownerId = Number(workspace.owner_user_id);
  const clusterCount = deps.db.prepare(
    'SELECT COUNT(*) AS count FROM account_clusters WHERE workspace_id = ?',
  ).get(workspaceId) as { count: number };
  if (Number(clusterCount.count) > 0) return; // solo si no hay clusters

  // 1. Sample accounts linked to existing devices (create a demo device if none).
  let accounts = deps.db.prepare(`
    SELECT sa.* FROM social_accounts sa
    JOIN workspace_members wm ON wm.user_id = sa.user_id
    WHERE wm.workspace_id = ? AND wm.status = 'active'
  `).all(workspaceId) as any[];
  let devices = deps.db.prepare(`
    SELECT * FROM devices WHERE workspace_id = ? AND lifecycle_status != 'revoked' ORDER BY id
  `).all(workspaceId) as any[];
  if (!devices.length) {
    const now = deps.nowIso();
    const r = deps.db.prepare(`
      INSERT INTO devices
        (user_id, workspace_id, device_id, installation_id, device_name,
         lifecycle_status, paired_at, last_seen_at, created_at)
      VALUES (?, ?, 'demo-phone-1', 'demo-phone-1', 'Demo phone', 'active', ?, NULL, ?)
    `).run(ownerId, workspaceId, now, now);
    devices = deps.db.prepare('SELECT * FROM devices WHERE id = ?').all(Number(r.lastInsertRowid));
  }
  // Remapear cuentas cuyo dispositivo fue eliminado a un celular activo del workspace,
  // para que la generación de tareas y los aliases se resuelvan correctamente.
  const activeDeviceId = Number(devices[0].id);
  const accountRefresh = () => deps.db.prepare(`
    SELECT sa.* FROM social_accounts sa
    JOIN workspace_members wm ON wm.user_id = sa.user_id
    WHERE wm.workspace_id = ? AND wm.status = 'active'
  `).all(workspaceId) as any[];
  deps.db.prepare(`
    UPDATE social_accounts SET device_id = ?
    WHERE user_id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active')
      AND device_id IS NOT NULL AND device_id NOT IN (SELECT id FROM devices)
  `).run(activeDeviceId, workspaceId);
  accounts = accountRefresh();
  const demoBrands: Array<{ base: string; platforms: string[] }> = [
    { base: 'marczell.clips', platforms: ['instagram', 'tiktok', 'youtube'] },
    { base: 'nova.gaming', platforms: ['instagram', 'tiktok'] },
    { base: 'cocina.sur', platforms: ['instagram', 'tiktok', 'youtube'] },
    { base: 'fitzone.ok', platforms: ['instagram', 'tiktok'] },
    { base: 'urbanstyle', platforms: ['instagram', 'youtube'] },
  ];
  let groups = detectGroups(deps, workspaceId, accounts);
  if (!accounts.length || !groups.length) {
    const insert = deps.db.prepare(`
      INSERT OR IGNORE INTO social_accounts (user_id, device_id, platform, username, display_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const setKey = deps.db.prepare(`
      UPDATE social_accounts SET account_key = ?
      WHERE user_id = ? AND device_id = ? AND platform = ? AND username = ?
    `);
    for (let b = 0; b < demoBrands.length; b += 1) {
      const brand = demoBrands[b];
      const device = devices[b % devices.length];
      if (!device) continue;
      for (const platform of brand.platforms) {
        const accountKey = deps.accountKeyFor(ownerId, Number(device.id), platform, brand.base);
        insert.run(ownerId, Number(device.id), platform, brand.base, brand.base, deps.nowIso());
        if (accountKey) setKey.run(accountKey, ownerId, Number(device.id), platform, brand.base);
      }
    }
    accounts = accountRefresh();
    groups = detectGroups(deps, workspaceId, accounts);
  }

  // 2. Auto-detect: confirm up to 4 groups, leave 1 as suggested.
  const confirmedClusters: any[] = [];
  let suggestedCreated = false;
  for (const group of groups) {
    if (confirmedClusters.length < 4) {
      confirmedClusters.push(createClusterFromGroup(deps, workspaceId, group, 'confirmed'));
    } else if (!suggestedCreated) {
      createClusterFromGroup(deps, workspaceId, group, 'suggested');
      suggestedCreated = true;
    }
  }

  // 3. Demo user (create-if-missing only; never touch existing passwords).
  const demoEmail = 'demo@southfarm.local';
  const existingUser = deps.db.prepare('SELECT id FROM users WHERE email = ?').get(demoEmail) as any;
  if (!existingUser) {
    const hash = bcrypt.hashSync('southfarm', 10);
    const r = deps.db.prepare('INSERT INTO users (email, password, name) VALUES (?, ?, ?)')
      .run(demoEmail, hash, 'Demo User');
    const demoUserId = Number(r.lastInsertRowid);
    const member = deps.db.prepare(
      'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, demoUserId) as any;
    if (!member) {
      const now = deps.nowIso();
      deps.db.prepare(`
        INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
        VALUES (?, ?, 'owner', 'active', ?, ?)
      `).run(workspaceId, demoUserId, now, now);
    }
    console.log(`[ActivityPlanner] Demo user created: ${demoEmail}`);
  }

  // 4. Realistic history so the charts have a past.
  const todayKey = todayKeyBA(deps);
  const publishTitles = ['Cómo editar en 30s', 'Detrás de cámaras', 'Top 5 trucos', 'Rutina completa'];
  for (const cluster of confirmedClusters) {
    const clusterAccountsList = clusterAccounts(deps, cluster.id);
    const warmupRoutine = deps.db.prepare(
      "SELECT id FROM cluster_routines WHERE cluster_id = ? AND routine_type = 'warmup_daily'",
    ).get(cluster.id) as any;
    const publishRoutine = deps.db.prepare(
      "SELECT id FROM cluster_routines WHERE cluster_id = ? AND routine_type = 'publishing'",
    ).get(cluster.id) as any;
    for (let daysAgo = 7; daysAgo >= 1; daysAgo -= 1) {
      const account = clusterAccountsList[(daysAgo * 2) % Math.max(1, clusterAccountsList.length)];
      if (!account || !account.device_id) continue;
      const elapsedSec = 1200 + ((daysAgo * 137) % 600);
      seedCompletedWarmup(deps, {
        workspaceId,
        ownerId,
        cluster,
        routineId: warmupRoutine ? Number(warmupRoutine.id) : null,
        account,
        dayKey: addDaysToKey(deps, todayKey, -daysAgo),
        elapsedSec,
      });
    }
    for (const daysAgo of [10, 4]) {
      const account = clusterAccountsList[daysAgo % Math.max(1, clusterAccountsList.length)];
      if (!account || !account.device_id) continue;
      seedCompletedPublish(deps, {
        workspaceId,
        ownerId,
        cluster,
        routineId: publishRoutine ? Number(publishRoutine.id) : null,
        account,
        dayKey: addDaysToKey(deps, todayKey, -daysAgo),
        title: publishTitles[daysAgo % publishTitles.length],
      });
    }
  }

  // 5. Generate current + next week.
  generateForCurrentAndNext(deps, workspaceId);

  // 6. Mark one task running if there is an online device (realistic state).
  const onlineDevice = devices.find((device) => deps.deviceIsOnline(device.last_seen_at));
  if (onlineDevice) {
    const task = deps.db.prepare(`
      SELECT * FROM task_runs
      WHERE workspace_id = ? AND device_id = ? AND status = 'pending'
        AND scheduled_for IS NOT NULL
      ORDER BY scheduled_for ASC LIMIT 1
    `).get(workspaceId, Number(onlineDevice.id)) as any;
    if (task) {
      const now = deps.nowIso();
      deps.db.prepare(`
        UPDATE task_runs
        SET status = 'running', claim_token = ?, claimed_at = ?, started_at = ?,
            lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE id = ?
      `).run(randomUUID(), now, now, new Date(Date.now() + 45000).toISOString(), now, now, task.id);
      deps.recordTaskEvent(
        deps.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(task.id),
        'claimed',
        { attempt: 1 },
      );
    }
  }

  console.log(
    `[ActivityPlanner] Seed complete: ${confirmedClusters.length} confirmed clusters, `
    + `${suggestedCreated ? '1 suggested' : '0 suggested'}, history + plan generated.`,
  );
}

function generateStartupPlans(deps: PlannerDeps): void {
  const workspaces = deps.db.prepare('SELECT id FROM workspaces ORDER BY id').all() as any[];
  for (const workspace of workspaces) {
    const workspaceId = Number(workspace.id);
    const count = deps.db.prepare(`
      SELECT COUNT(*) AS count FROM account_clusters
      WHERE workspace_id = ? AND status = 'confirmed'
    `).get(workspaceId) as { count: number };
    if (!Number(count.count)) continue;
    try {
      const result = generateForCurrentAndNext(deps, workspaceId);
      if (result.created || result.cancelled) {
        console.log(
          `[ActivityPlanner] Startup plan for workspace ${workspaceId}: `
          + `${result.created} created, ${result.cancelled} cancelled.`,
        );
      }
    } catch (error) {
      console.error(`[ActivityPlanner] Startup generation failed for workspace ${workspaceId}:`, error);
    }
  }
}

// ─── Routes ───

export function registerActivityPlanner(app: Express, deps: PlannerDeps): void {
  const { db } = deps;
  (globalThis as any).__plannerDeps = deps;

  const clusterById = (workspaceId: number, id: unknown): any | null => {
    const cluster = db.prepare(
      'SELECT * FROM account_clusters WHERE id = ? AND workspace_id = ?',
    ).get(Number(id), workspaceId) as any;
    return cluster || null;
  };

  const workspaceBlockedMessage = (workspaceId: number): string | null => {
    const control = deps.ensureWorkspaceControl(workspaceId);
    if (String(control?.scheduler_mode) === 'paused') {
      return 'El workspace está en pausa general; reanudá las actividades antes de generar';
    }
    if (deps.workspaceControlBlocksAutomatic(control)) {
      return 'La cola automática está pausada; reanudá la cola antes de generar';
    }
    return null;
  };

  // ── 1. Weekly view ──
  app.get('/api/planner/week', deps.auth, (req: any, res) => {
    try {
      const rawStart = req.query.start as string | undefined;
      let weekStart: string;
      if (rawStart) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rawStart)) {
          return res.status(400).json({ error: 'start must use YYYY-MM-DD' });
        }
        weekStart = mondayOfWeek(deps, rawStart);
      } else {
        weekStart = mondayOfWeek(deps, todayKeyBA(deps));
      }
      const weekEnd = addDaysToKey(deps, weekStart, 6);
      const clusters = db.prepare(`
        SELECT * FROM account_clusters
        WHERE workspace_id = ? AND status IN ('confirmed', 'suggested')
        ORDER BY id
      `).all(req.user.workspaceId) as any[];
      const items = clusters.map((cluster) =>
        buildWeekClusterItem(deps, req.user.workspaceId, cluster, weekStart, weekEnd),
      );
      res.json({
        weekStart,
        weekEnd,
        now: deps.nowIso(),
        summary: computeSummary(deps, items),
        clusters: items,
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Unable to load planner week' });
    }
  });

  // ── 2. Day timeline ──
  app.get('/api/planner/day', deps.auth, (req: any, res) => {
    try {
      const date = deps.plannerDateKey(req.query.date);
      const rows = db.prepare(`
        SELECT tr.*, sa.username AS account_username, d.device_id AS device_key, d.device_alias
        FROM task_runs tr
        LEFT JOIN social_accounts sa ON sa.id = tr.social_account_id
        LEFT JOIN devices d ON d.id = tr.device_id
        WHERE tr.workspace_id = ? AND tr.scheduled_for IS NOT NULL
        ORDER BY COALESCE(tr.scheduled_for, tr.created_at) ASC, tr.id ASC
      `).all(req.user.workspaceId) as any[];
      const clusterNames = new Map<number, string>();
      for (const cluster of db.prepare(
        'SELECT id, name FROM account_clusters WHERE workspace_id = ?',
      ).all(req.user.workspaceId) as any[]) {
        clusterNames.set(Number(cluster.id), String(cluster.name));
      }
      const tasks = rows
        .filter((row) => deps.dateKeyInTimezone(row.scheduled_for) === date)
        .map((row) => plannerTaskView(
          deps,
          row,
          row.cluster_id === null || row.cluster_id === undefined
            ? null
            : clusterNames.get(Number(row.cluster_id)) || null,
        ));
      const hourly: Array<{ hour: number; count: number }> = [];
      for (let hour = 12; hour <= 22; hour += 1) {
        hourly.push({ hour, count: tasks.filter((task) => baHourOfDay(task.scheduledFor) === hour).length });
      }
      res.json({ date, tasks, hourly });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Unable to load planner day' });
    }
  });

  // ── 3. Clusters CRUD ──
  app.get('/api/clusters', deps.auth, (req: any, res) => {
    const rows = db.prepare(`
      SELECT * FROM account_clusters
      WHERE workspace_id = ? AND status != 'rejected'
      ORDER BY id
    `).all(req.user.workspaceId) as any[];
    const items = rows.map((row) => {
      const members = db.prepare(
        'SELECT social_account_id FROM account_cluster_members WHERE cluster_id = ?',
      ).all(row.id) as any[];
      return {
        id: row.id,
        name: row.name,
        status: row.status,
        detectionMethod: row.detection_method,
        accountCount: members.length,
        memberAccountIds: members.map((member) => Number(member.social_account_id)),
      };
    });
    res.json({ clusters: items });
  });

  app.post('/api/clusters', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const name = deps.stringValue(req.body.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (Array.from(name).length > 80) {
      return res.status(400).json({ error: 'name must be 80 characters or fewer' });
    }
    const rawIds = Array.isArray(req.body.accountIds) ? req.body.accountIds : [];
    const accountIds = [...new Set(rawIds
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0))];
    if (accountIds.length) {
      const { ids, placeholders } = deps.scopedUsers(req.user.userId);
      const validAccounts = db.prepare(`
        SELECT id FROM social_accounts
        WHERE id IN (${accountIds.map(() => '?').join(',')}) AND user_id IN (${placeholders})
      `).all(...accountIds, ...ids) as any[];
      if (validAccounts.length !== accountIds.length) {
        return res.status(400).json({ error: 'All accountIds must belong to this workspace' });
      }
    }
    const cluster = db.transaction(() => {
      const now = deps.nowIso();
      const result = db.prepare(`
        INSERT INTO account_clusters (workspace_id, name, status, detection_method, created_at, updated_at)
        VALUES (?, ?, 'confirmed', 'manual', ?, ?)
      `).run(req.user.workspaceId, name, now, now);
      const clusterId = Number(result.lastInsertRowid);
      insertDefaultRoutines(deps, clusterId);
      const insertMember = db.prepare(
        'INSERT OR IGNORE INTO account_cluster_members (cluster_id, social_account_id) VALUES (?, ?)',
      );
      for (const accountId of accountIds) insertMember.run(clusterId, accountId);
      return db.prepare('SELECT * FROM account_clusters WHERE id = ?').get(clusterId);
    })();
    try {
      generateForCurrentAndNext(deps, req.user.workspaceId);
    } catch (error) {
      console.error('[ActivityPlanner] Generation after cluster creation failed:', error);
    }
    const weekStart = mondayOfWeek(deps, todayKeyBA(deps));
    res.status(201).json(buildWeekClusterItem(
      deps,
      req.user.workspaceId,
      cluster,
      weekStart,
      addDaysToKey(deps, weekStart, 6),
    ));
  });

  app.patch('/api/clusters/:id', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const name = deps.stringValue(req.body.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (Array.from(name).length > 80) {
      return res.status(400).json({ error: 'name must be 80 characters or fewer' });
    }
    db.prepare('UPDATE account_clusters SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, deps.nowIso(), cluster.id);
    const updated = db.prepare('SELECT * FROM account_clusters WHERE id = ?').get(cluster.id);
    const weekStart = mondayOfWeek(deps, todayKeyBA(deps));
    res.json({ ok: true, cluster: buildWeekClusterItem(
      deps,
      req.user.workspaceId,
      updated,
      weekStart,
      addDaysToKey(deps, weekStart, 6),
    ) });
  });

  app.post('/api/clusters/:id/confirm', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    if (cluster.status === 'rejected') {
      return res.status(409).json({ error: 'A rejected cluster cannot be confirmed; create a new one instead' });
    }
    db.transaction(() => {
      db.prepare('UPDATE account_clusters SET status = ?, updated_at = ? WHERE id = ?')
        .run('confirmed', deps.nowIso(), cluster.id);
      insertDefaultRoutines(deps, cluster.id);
    })();
    try {
      generateForCurrentAndNext(deps, req.user.workspaceId);
    } catch (error) {
      console.error('[ActivityPlanner] Generation after confirm failed:', error);
    }
    const updated = db.prepare('SELECT * FROM account_clusters WHERE id = ?').get(cluster.id);
    const weekStart = mondayOfWeek(deps, todayKeyBA(deps));
    res.json({ ok: true, cluster: buildWeekClusterItem(
      deps,
      req.user.workspaceId,
      updated,
      weekStart,
      addDaysToKey(deps, weekStart, 6),
    ) });
  });

  app.delete('/api/clusters/:id', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const mode = String(req.query.mode || 'delete');
    if (mode === 'reject') {
      if (cluster.status !== 'suggested') {
        return res.status(409).json({ error: 'Only suggested clusters can be rejected' });
      }
      db.prepare('UPDATE account_clusters SET status = ?, updated_at = ? WHERE id = ?')
        .run('rejected', deps.nowIso(), cluster.id);
      return res.json({ ok: true, status: 'rejected' });
    }
    if (mode !== 'delete') {
      return res.status(400).json({ error: 'mode must be reject or delete' });
    }
    const cancelled = db.transaction(() => {
      const cancelledCount = cancelClusterFutureTasks(deps, cluster.id, 'cluster_deleted');
      db.prepare('DELETE FROM account_cluster_members WHERE cluster_id = ?').run(cluster.id);
      db.prepare('DELETE FROM cluster_routines WHERE cluster_id = ?').run(cluster.id);
      db.prepare('DELETE FROM account_clusters WHERE id = ?').run(cluster.id);
      return cancelledCount;
    })();
    res.json({ ok: true, status: 'deleted', cancelled_tasks: cancelled });
  });

  app.post('/api/clusters/:id/members', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const rawIds = Array.isArray(req.body.accountIds) ? req.body.accountIds : [];
    const accountIds = [...new Set(rawIds
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value) && value > 0))];
    if (!accountIds.length) return res.status(400).json({ error: 'accountIds array required' });
    const { ids, placeholders } = deps.scopedUsers(req.user.userId);
    const validAccounts = db.prepare(`
      SELECT id FROM social_accounts
      WHERE id IN (${accountIds.map(() => '?').join(',')}) AND user_id IN (${placeholders})
    `).all(...accountIds, ...ids) as any[];
    if (validAccounts.length !== accountIds.length) {
      return res.status(400).json({ error: 'All accountIds must belong to this workspace' });
    }
    const insert = db.prepare(
      'INSERT OR IGNORE INTO account_cluster_members (cluster_id, social_account_id) VALUES (?, ?)',
    );
    let added = 0;
    for (const accountId of accountIds) added += Number(insert.run(cluster.id, accountId).changes || 0);
    const members = db.prepare(
      'SELECT social_account_id FROM account_cluster_members WHERE cluster_id = ?',
    ).all(cluster.id) as any[];
    res.json({
      ok: true,
      added,
      memberAccountIds: members.map((member) => Number(member.social_account_id)),
    });
  });

  app.delete('/api/clusters/:id/members/:accountId', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const result = db.prepare(
      'DELETE FROM account_cluster_members WHERE cluster_id = ? AND social_account_id = ?',
    ).run(cluster.id, Number(req.params.accountId));
    if (!result.changes) return res.status(404).json({ error: 'Account is not a member of this cluster' });
    res.json({ ok: true });
  });

  app.get('/api/clusters/suggestions/scan', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    try {
      const groups = detectGroups(deps, req.user.workspaceId);
      const created: any[] = [];
      for (const group of groups) {
        created.push(createClusterFromGroup(deps, req.user.workspaceId, group, 'suggested'));
      }
      const weekStart = mondayOfWeek(deps, todayKeyBA(deps));
      const weekEnd = addDaysToKey(deps, weekStart, 6);
      res.json({
        created: created.map((cluster) =>
          buildWeekClusterItem(deps, req.user.workspaceId, cluster, weekStart, weekEnd),
        ),
      });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Unable to scan suggestions' });
    }
  });

  // ── 4. Cluster detail ──
  app.get('/api/clusters/:id', deps.auth, (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const weekStart = mondayOfWeek(deps, todayKeyBA(deps));
    const weekEnd = addDaysToKey(deps, weekStart, 6);
    const clusters = db.prepare(`
      SELECT id FROM account_clusters
      WHERE workspace_id = ? AND status != 'rejected'
      ORDER BY id
    `).all(req.user.workspaceId) as any[];
    const index = clusters.findIndex((row) => Number(row.id) === Number(cluster.id));
    const nav = {
      prevClusterId: index > 0 ? Number(clusters[index - 1].id) : null,
      nextClusterId: index >= 0 && index < clusters.length - 1 ? Number(clusters[index + 1].id) : null,
    };
    res.json({
      cluster: buildWeekClusterItem(deps, req.user.workspaceId, cluster, weekStart, weekEnd),
      history: buildClusterHistory(deps, req.user.workspaceId, cluster),
      nav,
    });
  });

  // ── 5. Routines ──
  app.get('/api/clusters/:id/routines', deps.auth, (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const routines = (db.prepare(
      'SELECT * FROM cluster_routines WHERE cluster_id = ?',
    ).all(cluster.id) as any[]).map((routine) => ({
      id: routine.id,
      routineType: routine.routine_type,
      config: deps.parseParams(routine.config),
      status: routine.status,
    }));
    res.json({ routines });
  });

  app.put('/api/clusters/:id/routines/:routineId', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const routine = db.prepare(
      'SELECT * FROM cluster_routines WHERE id = ? AND cluster_id = ?',
    ).get(Number(req.params.routineId), cluster.id) as any;
    if (!routine) return res.status(404).json({ error: 'Routine not found' });
    const routineType = routine.routine_type as RoutineType;
    const hasConfig = req.body.config !== undefined && req.body.config !== null;
    const hasStatus = req.body.status !== undefined && req.body.status !== null;
    const requestedStatus = hasStatus ? String(req.body.status).toLowerCase() : null;
    if (hasStatus && !['approved', 'editing', 'paused'].includes(requestedStatus as string)) {
      return res.status(400).json({ error: 'status must be approved, editing or paused' });
    }
    let config: Record<string, number>;
    try {
      config = parseRoutineConfig(
        routineType,
        hasConfig ? req.body.config : deps.parseParams(routine.config),
      );
    } catch (error: any) {
      return res.status(400).json({ error: error.message || 'Invalid routine config' });
    }
    const now = deps.nowIso();
    let nextStatus = hasStatus ? (requestedStatus as string) : routine.status;
    db.transaction(() => {
      db.prepare('UPDATE cluster_routines SET config = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(deps.jsonValue(config), nextStatus, now, routine.id);
      if (hasStatus && requestedStatus === 'approved') {
        cancelRoutineFutureTasks(deps, cluster.id, routine.id, 'routine_reconfigured');
      } else if (hasStatus && requestedStatus === 'paused') {
        cancelRoutineFutureTasks(deps, cluster.id, routine.id, 'routine_paused');
      } else if (!hasStatus && hasConfig) {
        // Config-only edit: the new rule is NOT applied until the owner
        // approves; the toggle goes to "editing" and the plan stays intact.
        nextStatus = 'editing';
        db.prepare('UPDATE cluster_routines SET status = ? WHERE id = ?').run('editing', routine.id);
      }
    })();
    let regenerated = false;
    if (hasStatus && requestedStatus === 'approved') {
      const blocked = workspaceBlockedMessage(req.user.workspaceId);
      if (blocked) {
        return res.status(409).json({ error: blocked });
      }
      generateForCurrentAndNext(deps, req.user.workspaceId);
      regenerated = true;
    }
    const updated = db.prepare('SELECT * FROM cluster_routines WHERE id = ?').get(routine.id);
    res.json({
      routine: {
        id: updated.id,
        routineType: updated.routine_type,
        config: deps.parseParams(updated.config),
        status: updated.status,
      },
      regenerated,
    });
  });

  // ── 6. Regenerate week ──
  app.post('/api/planner/week/generate', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    try {
      const blocked = workspaceBlockedMessage(req.user.workspaceId);
      if (blocked) return res.status(409).json({ error: blocked });
      const rawStart = req.body.start;
      let weekStart: string;
      if (rawStart !== undefined && rawStart !== null && String(rawStart).trim()) {
        const value = String(rawStart).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          return res.status(400).json({ error: 'start must use YYYY-MM-DD' });
        }
        weekStart = mondayOfWeek(deps, value);
      } else {
        weekStart = mondayOfWeek(deps, todayKeyBA(deps));
      }
      const result = db.transaction(() => generatePlannerWeek(deps, req.user.workspaceId, weekStart))();
      res.json({ created: result.created, cancelled: result.cancelled, weekStart });
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Unable to generate planner week' });
    }
  });

  // ── 7. Cluster publish ──
  app.post('/api/clusters/:id/publish', deps.auth, deps.requireRole('owner', 'admin', 'operator'), (req: any, res) => {
    const cluster = clusterById(req.user.workspaceId, req.params.id);
    if (!cluster) return res.status(404).json({ error: 'Cluster not found' });
    const blocked = workspaceBlockedMessage(req.user.workspaceId);
    if (blocked) return res.status(409).json({ error: blocked });
    const videoUrl = deps.stringValue(req.body.videoUrl);
    if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });
    const title = deps.stringValue(req.body.title) || '— definir contenido —';
    let scheduledFor = deps.nowIso();
    if (req.body.scheduledFor !== undefined && req.body.scheduledFor !== null) {
      const timestamp = Date.parse(String(req.body.scheduledFor));
      if (!Number.isFinite(timestamp)) {
        return res.status(400).json({ error: 'scheduledFor must be a valid ISO date' });
      }
      scheduledFor = new Date(timestamp).toISOString();
    }
    const ownerId = workspaceOwnerId(deps, req.user.workspaceId) || req.user.userId;
    const accounts = clusterAccounts(deps, cluster.id);
    let created = 0;
    for (const account of accounts) {
      if (!account.device_id) continue;
      insertRoutineTask(deps, {
        workspaceId: req.user.workspaceId,
        userId: ownerId,
        deviceId: account.device_id,
        taskType: 'publish_reel',
        platform: account.platform,
        account,
        params: { duration_minutes: 1, title, video_url: videoUrl },
        scheduledFor,
        plannedDurationSec: 60,
        clusterId: cluster.id,
        routineId: null,
        clusterName: cluster.name,
        priority: 1000,
      });
      created += 1;
    }
    res.status(201).json({ created });
  });
}

// ─── Startup (seed + initial plan), non-blocking ───

export function runActivityPlannerStartup(deps: PlannerDeps): void {
  setTimeout(() => {
    try {
      seedDemoData(deps);
    } catch (error) {
      console.error('[ActivityPlanner] Seed failed:', error);
    }
    try {
      generateStartupPlans(deps);
    } catch (error) {
      console.error('[ActivityPlanner] Startup generation failed:', error);
    }
  }, 800);
}
