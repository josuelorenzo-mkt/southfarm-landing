import type Database from 'better-sqlite3';

export const PUBLICATION_TERMINAL_STATES = new Set([
  'completed', 'cancelled', 'failed', 'review_required',
]);

export const PUBLICATION_STATE_TRANSITIONS = {
  queued: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'cancellation_requested', 'failed', 'review_required'],
  in_progress: ['completed', 'cancellation_requested', 'failed', 'review_required'],
  cancellation_requested: ['cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
  review_required: [],
} as const;

type PublicationStatus = keyof typeof PUBLICATION_STATE_TRANSITIONS;
type SqliteDatabase = Database.Database;

export type ValidatedPublicationInput = {
  platform: 'instagram' | 'tiktok' | 'youtube';
  caption: string;
  wordCount: number;
};

export type PublicationActor = { type: string; id: string };
export type PublicationWorker = { id: string; deviceId: number; leaseSeconds: number };
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

function isoAfter(now: string, seconds: number): string {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

function requireIso(value: string, label: string): void {
  if (Number.isNaN(new Date(value).getTime())) throw new Error(`${label} must be an ISO timestamp`);
}

function canTransition(from: PublicationStatus, to: PublicationStatus): boolean {
  return (PUBLICATION_STATE_TRANSITIONS[from] as readonly string[]).includes(to);
}

export function validatePublicationInput(input: { caption: unknown; platform: unknown }): ValidatedPublicationInput {
  const caption = typeof input.caption === 'string' ? input.caption.trim().replace(/\s+/g, ' ') : '';
  const platform = String(input.platform || '').toLowerCase();
  if (!['instagram', 'tiktok', 'youtube'].includes(platform)) throw new Error('platform must be instagram, tiktok, or youtube');
  const words = caption ? caption.split(' ') : [];
  if (words.length < 1 || words.length > 10) throw new Error('caption must contain between 1 and 10 words');
  if (caption.length > 100) throw new Error('caption must be at most 100 characters');
  return { caption, platform: platform as ValidatedPublicationInput['platform'], wordCount: words.length };
}

export function publicationJobView(row: PublicationRow, db: SqliteDatabase): PublicationJobView {
  const mediaCount = (db.prepare('SELECT COUNT(*) AS count FROM publication_media WHERE publication_job_id = ?').get(row.id) as { count: number }).count;
  return { ...row, media_count: mediaCount };
}

export class PublicationStore {
  constructor(private readonly db: SqliteDatabase) {}

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private row(id: number): PublicationRow {
    const row = this.db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(id) as PublicationRow | undefined;
    if (!row) throw new Error(`Publication job ${id} not found`);
    return row;
  }

  private event(id: number, from: string | null, to: string | null, actor: PublicationActor, at: string, payload?: unknown): void {
    this.db.prepare(`INSERT INTO publication_events
      (publication_job_id, from_status, to_status, actor_type, actor_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, from, to, actor.type, actor.id, payload === undefined ? null : JSON.stringify(payload), at);
  }

  private transition(row: PublicationRow, to: PublicationStatus, actor: PublicationActor, at: string, payload?: unknown): PublicationRow {
    if (!canTransition(row.status, to)) throw new Error(`Cannot transition publication job from ${row.status} to ${to}`);
    this.db.prepare('UPDATE publication_jobs SET status = ?, updated_at = ? WHERE id = ?').run(to, at, row.id);
    this.event(row.id, row.status, to, actor, at, payload);
    return this.row(row.id);
  }

  createJob(input: CreatePublicationJobInput, actor: PublicationActor): PublicationJobView {
    const validated = validatePublicationInput(input);
    requireIso(input.scheduledFor, 'scheduledFor');
    const createdAt = new Date().toISOString();
    return this.transaction(() => {
      const result = this.db.prepare(`INSERT INTO publication_jobs
        (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, created_by_type, created_by_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`)
        .run(input.workspaceId, input.deviceId, input.socialAccountId, validated.platform, validated.caption, validated.wordCount, input.scheduledFor, actor.type, actor.id, createdAt, createdAt);
      const row = this.row(Number(result.lastInsertRowid));
      this.event(row.id, null, 'queued', actor, createdAt);
      return publicationJobView(row, this.db);
    });
  }

  listJobs(workspaceId?: number): PublicationJobView[] {
    const rows = workspaceId === undefined
      ? this.db.prepare('SELECT * FROM publication_jobs ORDER BY scheduled_for, id').all()
      : this.db.prepare('SELECT * FROM publication_jobs WHERE workspace_id = ? ORDER BY scheduled_for, id').all(workspaceId);
    return (rows as PublicationRow[]).map((row) => publicationJobView(row, this.db));
  }

  getJob(id: number): PublicationJobView { return publicationJobView(this.row(id), this.db); }

  rescheduleJob(id: number, scheduledFor: string, actor: PublicationActor): PublicationJobView {
    requireIso(scheduledFor, 'scheduledFor');
    return this.transaction(() => {
      const row = this.row(id);
      if (row.status !== 'queued') throw new Error('Only queued publication jobs can be rescheduled');
      this.db.prepare('UPDATE publication_jobs SET scheduled_for = ?, updated_at = ? WHERE id = ?').run(scheduledFor, scheduledFor, id);
      this.event(id, 'queued', 'queued', actor, scheduledFor, { scheduled_for: scheduledFor });
      return this.getJob(id);
    });
  }

  requestCancellation(id: number, actor: PublicationActor, at = new Date().toISOString()): PublicationJobView {
    return this.transaction(() => {
      const row = this.row(id);
      if (row.status === 'queued') return publicationJobView(this.transition(row, 'cancelled', actor, at), this.db);
      if (!['claimed', 'in_progress'].includes(row.status)) throw new Error(`Cannot cancel publication job in ${row.status}`);
      this.db.prepare('UPDATE publication_jobs SET cancellation_requested_at = ? WHERE id = ?').run(at, id);
      return publicationJobView(this.transition(row, 'cancellation_requested', actor, at), this.db);
    });
  }

  claimDueJob(worker: PublicationWorker, now: string): { claimed: boolean; job: PublicationJobView | null } {
    requireIso(now, 'now');
    return this.transaction(() => {
      this.db.prepare('DELETE FROM device_automation_locks WHERE expires_at <= ?').run(now);
      const candidate = this.db.prepare(`SELECT job.* FROM publication_jobs job
        WHERE job.device_id = ? AND job.status = 'queued' AND job.scheduled_for <= ?
          AND NOT EXISTS (SELECT 1 FROM publication_jobs review WHERE review.social_account_id = job.social_account_id AND review.status = 'review_required')
          AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.device_id = job.device_id AND run.status IN ('pending', 'running', 'claimed', 'in_progress'))
          AND NOT EXISTS (SELECT 1 FROM device_automation_locks lock WHERE lock.device_id = job.device_id AND lock.expires_at > ?)
        ORDER BY job.scheduled_for, job.id LIMIT 1`).get(worker.deviceId, now, now) as PublicationRow | undefined;
      if (!candidate) return { claimed: false, job: null };
      const expiresAt = isoAfter(now, Math.max(1, worker.leaseSeconds));
      this.db.prepare(`UPDATE publication_jobs SET status = 'claimed', claimed_by = ?, claimed_at = ?, lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`)
        .run(worker.id, now, expiresAt, now, now, candidate.id);
      this.db.prepare(`INSERT INTO device_automation_locks (device_id, publication_job_id, worker_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET publication_job_id = excluded.publication_job_id, worker_id = excluded.worker_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
        .run(candidate.device_id, candidate.id, worker.id, expiresAt, now, now);
      this.event(candidate.id, 'queued', 'claimed', { type: 'worker', id: worker.id }, now);
      return { claimed: true, job: this.getJob(candidate.id) };
    });
  }

  heartbeat(id: number, worker: PublicationWorker, now: string): PublicationJobView {
    return this.transaction(() => {
      const row = this.row(id);
      if (row.claimed_by !== worker.id || !['claimed', 'in_progress'].includes(row.status)) throw new Error('Worker does not hold an active publication job');
      const expiresAt = isoAfter(now, Math.max(1, worker.leaseSeconds));
      this.db.prepare('UPDATE publication_jobs SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, now, now, id);
      this.db.prepare('UPDATE device_automation_locks SET expires_at = ?, updated_at = ? WHERE device_id = ? AND publication_job_id = ? AND worker_id = ?').run(expiresAt, now, row.device_id, id, worker.id);
      return this.getJob(id);
    });
  }

  checkpoint(id: number, worker: PublicationWorker, now: string, options: { finalAction?: boolean } = {}): PublicationJobView {
    return this.transaction(() => {
      let row = this.row(id);
      if (row.claimed_by !== worker.id) throw new Error('Worker does not hold this publication job');
      if (row.status === 'claimed') row = this.transition(row, 'in_progress', { type: 'worker', id: worker.id }, now);
      if (row.status !== 'in_progress') throw new Error(`Cannot checkpoint publication job in ${row.status}`);
      if (options.finalAction && !row.final_action_at) {
        this.db.prepare('UPDATE publication_jobs SET final_action_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      }
      return this.getJob(id);
    });
  }

  finish(id: number, worker: PublicationWorker, target: Extract<PublicationStatus, 'completed' | 'cancelled' | 'failed' | 'review_required'>, now: string, actor: PublicationActor = { type: 'worker', id: worker.id }): PublicationJobView {
    return this.transaction(() => {
      let row = this.row(id);
      if (row.claimed_by !== worker.id) throw new Error('Worker does not hold this publication job');
      if (target === 'failed' && row.final_action_at) throw new Error('Cannot mark publication failed after final action');
      row = this.transition(row, target, actor, now);
      if (PUBLICATION_TERMINAL_STATES.has(target)) {
        this.db.prepare('DELETE FROM device_automation_locks WHERE device_id = ? AND publication_job_id = ?').run(row.device_id, id);
      }
      return publicationJobView(row, this.db);
    });
  }
}
