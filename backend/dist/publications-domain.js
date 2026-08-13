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
};
function isoAfter(now, seconds) {
    return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}
function requireIso(value, label) {
    if (Number.isNaN(new Date(value).getTime()))
        throw new Error(`${label} must be an ISO timestamp`);
}
function canTransition(from, to) {
    return PUBLICATION_STATE_TRANSITIONS[from].includes(to);
}
export function validatePublicationInput(input) {
    const caption = typeof input.caption === 'string' ? input.caption.trim().replace(/\s+/g, ' ') : '';
    const platform = String(input.platform || '').toLowerCase();
    if (!['instagram', 'tiktok', 'youtube'].includes(platform))
        throw new Error('platform must be instagram, tiktok, or youtube');
    const words = caption ? caption.split(' ') : [];
    if (words.length < 1 || words.length > 10)
        throw new Error('caption must contain between 1 and 10 words');
    if (caption.length > 100)
        throw new Error('caption must be at most 100 characters');
    return { caption, platform: platform, wordCount: words.length };
}
export function publicationJobView(row, db) {
    const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM publication_media WHERE publication_job_id = ?').get(row.id).count;
    return { ...row, media_count: mediaCount };
}
export class PublicationStore {
    constructor(db) {
        this.db = db;
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    row(id) {
        const row = this.db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(id);
        if (!row)
            throw new Error(`Publication job ${id} not found`);
        return row;
    }
    event(id, from, to, actor, at, payload) {
        this.db.prepare(`INSERT INTO publication_events
      (publication_job_id, from_status, to_status, actor_type, actor_id, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, from, to, actor.type, actor.id, payload === undefined ? null : JSON.stringify(payload), at);
    }
    transition(row, to, actor, at, payload) {
        if (!canTransition(row.status, to))
            throw new Error(`Cannot transition publication job from ${row.status} to ${to}`);
        this.db.prepare('UPDATE publication_jobs SET status = ?, updated_at = ? WHERE id = ?').run(to, at, row.id);
        this.event(row.id, row.status, to, actor, at, payload);
        return this.row(row.id);
    }
    createJob(input, actor) {
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
    listJobs(workspaceId) {
        const rows = workspaceId === undefined
            ? this.db.prepare('SELECT * FROM publication_jobs ORDER BY scheduled_for, id').all()
            : this.db.prepare('SELECT * FROM publication_jobs WHERE workspace_id = ? ORDER BY scheduled_for, id').all(workspaceId);
        return rows.map((row) => publicationJobView(row, this.db));
    }
    getJob(id) { return publicationJobView(this.row(id), this.db); }
    rescheduleJob(id, scheduledFor, actor) {
        requireIso(scheduledFor, 'scheduledFor');
        return this.transaction(() => {
            const row = this.row(id);
            if (row.status !== 'queued')
                throw new Error('Only queued publication jobs can be rescheduled');
            this.db.prepare('UPDATE publication_jobs SET scheduled_for = ?, updated_at = ? WHERE id = ?').run(scheduledFor, scheduledFor, id);
            this.event(id, 'queued', 'queued', actor, scheduledFor, { scheduled_for: scheduledFor });
            return this.getJob(id);
        });
    }
    requestCancellation(id, actor, at = new Date().toISOString()) {
        return this.transaction(() => {
            const row = this.row(id);
            if (row.status === 'queued')
                return publicationJobView(this.transition(row, 'cancelled', actor, at), this.db);
            if (!['claimed', 'in_progress'].includes(row.status))
                throw new Error(`Cannot cancel publication job in ${row.status}`);
            this.db.prepare('UPDATE publication_jobs SET cancellation_requested_at = ? WHERE id = ?').run(at, id);
            return publicationJobView(this.transition(row, 'cancellation_requested', actor, at), this.db);
        });
    }
    claimDueJob(worker, now) {
        requireIso(now, 'now');
        return this.transaction(() => {
            this.db.prepare('DELETE FROM device_automation_locks WHERE expires_at <= ?').run(now);
            const candidate = this.db.prepare(`SELECT job.* FROM publication_jobs job
        WHERE job.device_id = ? AND job.status = 'queued' AND job.scheduled_for <= ?
          AND NOT EXISTS (SELECT 1 FROM publication_jobs review WHERE review.social_account_id = job.social_account_id AND review.status = 'review_required')
          AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.device_id = job.device_id AND run.status IN ('pending', 'running', 'claimed', 'in_progress'))
          AND NOT EXISTS (SELECT 1 FROM device_automation_locks lock WHERE lock.device_id = job.device_id AND lock.expires_at > ?)
        ORDER BY job.scheduled_for, job.id LIMIT 1`).get(worker.deviceId, now, now);
            if (!candidate)
                return { claimed: false, job: null };
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
    heartbeat(id, worker, now) {
        return this.transaction(() => {
            const row = this.row(id);
            if (row.claimed_by !== worker.id || !['claimed', 'in_progress'].includes(row.status))
                throw new Error('Worker does not hold an active publication job');
            const expiresAt = isoAfter(now, Math.max(1, worker.leaseSeconds));
            this.db.prepare('UPDATE publication_jobs SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, now, now, id);
            this.db.prepare('UPDATE device_automation_locks SET expires_at = ?, updated_at = ? WHERE device_id = ? AND publication_job_id = ? AND worker_id = ?').run(expiresAt, now, row.device_id, id, worker.id);
            return this.getJob(id);
        });
    }
    checkpoint(id, worker, now, options = {}) {
        return this.transaction(() => {
            let row = this.row(id);
            if (row.claimed_by !== worker.id)
                throw new Error('Worker does not hold this publication job');
            if (row.status === 'claimed')
                row = this.transition(row, 'in_progress', { type: 'worker', id: worker.id }, now);
            if (row.status !== 'in_progress')
                throw new Error(`Cannot checkpoint publication job in ${row.status}`);
            if (options.finalAction && !row.final_action_at) {
                this.db.prepare('UPDATE publication_jobs SET final_action_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
            }
            return this.getJob(id);
        });
    }
    finish(id, worker, target, now, actor = { type: 'worker', id: worker.id }) {
        return this.transaction(() => {
            let row = this.row(id);
            if (row.claimed_by !== worker.id)
                throw new Error('Worker does not hold this publication job');
            if (target === 'failed' && row.final_action_at)
                throw new Error('Cannot mark publication failed after final action');
            row = this.transition(row, target, actor, now);
            if (PUBLICATION_TERMINAL_STATES.has(target)) {
                this.db.prepare('DELETE FROM device_automation_locks WHERE device_id = ? AND publication_job_id = ?').run(row.device_id, id);
            }
            return publicationJobView(row, this.db);
        });
    }
}
