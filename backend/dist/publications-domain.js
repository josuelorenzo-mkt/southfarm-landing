import { randomUUID } from 'node:crypto';
export const PUBLICATION_TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'review_required']);
export const PUBLICATION_STATE_TRANSITIONS = {
    queued: ['claimed', 'cancelled'],
    claimed: ['preparing', 'cancellation_requested', 'failed', 'review_required'],
    preparing: ['transferring', 'cancellation_requested', 'failed', 'review_required'],
    transferring: ['selecting_media', 'cancellation_requested', 'failed', 'review_required'],
    selecting_media: ['editing', 'cancellation_requested', 'failed', 'review_required'],
    editing: ['captioning', 'cancellation_requested', 'failed', 'review_required'],
    captioning: ['ready_to_publish', 'cancellation_requested', 'failed', 'review_required'],
    ready_to_publish: ['publishing', 'cancellation_requested', 'failed', 'review_required'],
    publishing: ['verifying', 'review_required'],
    verifying: ['completed', 'review_required'],
    cancellation_requested: ['cancelled'],
    completed: [], cancelled: [], failed: [], review_required: [],
};
export class PublicationTransitionError extends Error {
    constructor(message) { super(message); this.name = 'PublicationTransitionError'; }
}
function isoAfter(now, seconds) { return new Date(new Date(now).getTime() + seconds * 1000).toISOString(); }
function requireIso(value, label) { if (Number.isNaN(new Date(value).getTime()))
    throw new Error(`${label} must be an ISO timestamp`); }
function canTransition(from, to) { return PUBLICATION_STATE_TRANSITIONS[from].includes(to); }
function safeClaimMedia(row) {
    const media = row;
    if (!media || !Number.isInteger(media.id) || !Number.isInteger(media.size_bytes) || Number(media.size_bytes) <= 0 || typeof media.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(media.sha256) || typeof media.mime_type !== 'string' || typeof media.file_extension !== 'string')
        return null;
    const extensions = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
    if (extensions[media.mime_type] !== media.file_extension)
        return null;
    if (!Number.isInteger(media.duration_seconds) || Number(media.duration_seconds) <= 0 || !Number.isInteger(media.width) || Number(media.width) <= 0 || !Number.isInteger(media.height) || Number(media.height) <= 0 || typeof media.video_codec !== 'string' || !media.video_codec)
        return null;
    return { id: media.id, size_bytes: media.size_bytes, sha256: media.sha256, mime_type: media.mime_type, file_extension: media.file_extension, duration_seconds: media.duration_seconds, width: media.width, height: media.height, video_codec: media.video_codec, audio_codec: typeof media.audio_codec === 'string' ? media.audio_codec : null };
}
function safeClaimSnapshot(value, platform, socialAccountId, deviceId) {
    try {
        const row = value;
        const account = JSON.parse(String(row.account_snapshot || ''));
        const device = JSON.parse(String(row.device_snapshot || ''));
        if (!Number.isInteger(account.id) || account.id !== socialAccountId || typeof account.username !== 'string' || !account.username.trim() || typeof account.display_name !== 'string' || !account.display_name.trim() || account.platform !== platform || !['instagram', 'tiktok', 'youtube'].includes(String(account.platform)) || !Number.isInteger(device.id) || device.id !== deviceId || typeof device.device_id !== 'string' || !device.device_id.trim())
            return null;
        return { account: account, device: device };
    }
    catch {
        return null;
    }
}
export function validatePublicationInput(input) {
    const caption = typeof input.caption === 'string' ? input.caption.trim().replace(/\s+/g, ' ') : '';
    const platform = String(input.platform || '').toLowerCase();
    if (!['instagram', 'tiktok', 'youtube'].includes(platform))
        throw new Error('platform must be instagram, tiktok, or youtube');
    const words = caption ? caption.split(' ') : [];
    if (words.length < 1 || words.length > 10)
        throw new Error('caption must contain between 1 and 10 words');
    if (platform === 'youtube' && caption.length > 100)
        throw new Error('caption must be at most 100 characters');
    return { caption, platform: platform, wordCount: words.length };
}
export function publicationJobView(row, db) {
    const mediaCount = db.prepare('SELECT COUNT(*) AS count FROM publication_media WHERE id = (SELECT media_id FROM publication_jobs WHERE id = ?)').get(row.id).count;
    return { ...row, media_count: mediaCount };
}
export class PublicationStore {
    constructor(db) {
        this.db = db;
    }
    transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try {
        const value = fn();
        this.db.exec('COMMIT');
        return value;
    }
    catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
    } }
    row(id) { const row = this.db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(id); if (!row)
        throw new Error(`Publication job ${id} not found`); return row; }
    event(id, from, to, actor, at, payload) {
        return Number(this.db.prepare('INSERT INTO publication_events (publication_job_id, from_status, to_status, current_step, actor_type, actor_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, from, to, to, actor.type, actor.id, payload === undefined ? null : JSON.stringify(payload), at).lastInsertRowid);
    }
    transition(row, to, actor, at, payload) {
        if (row.final_action_at && !['publishing', 'verifying', 'completed', 'review_required'].includes(to))
            throw new PublicationTransitionError('Cannot transition publication job after final action');
        if (!canTransition(row.status, to))
            throw new PublicationTransitionError(`Cannot transition publication job from ${row.status} to ${to}`);
        this.db.prepare('UPDATE publication_jobs SET status = ?, current_step = ?, updated_at = ? WHERE id = ?').run(to, to, at, row.id);
        this.event(row.id, row.status, to, actor, at, payload);
        return this.row(row.id);
    }
    requireLiveWorkerLock(row, worker, now) {
        if (!worker.claimToken || row.claimed_by !== worker.id || row.claim_token !== worker.claimToken || !row.lease_expires_at || String(row.lease_expires_at) <= now)
            throw new Error('Worker does not hold an active publication job');
        const lock = this.db.prepare('SELECT 1 FROM device_automation_locks WHERE device_id = ? AND publication_job_id = ? AND worker_id = ? AND expires_at > ?')
            .get(row.device_id, row.id, worker.id, now);
        if (!lock)
            throw new Error('Worker does not hold a live device automation lock');
    }
    createJob(input, actor) {
        const valid = validatePublicationInput(input);
        requireIso(input.scheduledFor, 'scheduledFor');
        const createdAt = new Date().toISOString();
        return this.transaction(() => { const account = this.db.prepare("SELECT id, username, COALESCE(NULLIF(display_name, ''), username) AS display_name, platform FROM social_accounts WHERE id = ? AND device_id = ? AND platform = ?").get(input.socialAccountId, input.deviceId, valid.platform); const device = this.db.prepare('SELECT id, device_id FROM devices WHERE id = ? AND workspace_id = ?').get(input.deviceId, input.workspaceId); if (!account || !device || !Number.isInteger(account.id) || typeof account.username !== 'string' || typeof account.display_name !== 'string' || typeof device.device_id !== 'string')
            throw new Error('Publication account or device snapshot is unavailable'); const result = this.db.prepare(`INSERT INTO publication_jobs (workspace_id, device_id, social_account_id, platform, caption, word_count, scheduled_for, status, current_step, created_by_type, created_by_id, account_snapshot, device_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?)`).run(input.workspaceId, input.deviceId, input.socialAccountId, valid.platform, valid.caption, valid.wordCount, input.scheduledFor, actor.type, actor.id, JSON.stringify(account), JSON.stringify(device), createdAt, createdAt); const row = this.row(Number(result.lastInsertRowid)); this.event(row.id, null, 'queued', actor, createdAt); return publicationJobView(row, this.db); });
    }
    listJobs(workspaceId) { const rows = workspaceId === undefined ? this.db.prepare('SELECT * FROM publication_jobs ORDER BY scheduled_for, id').all() : this.db.prepare('SELECT * FROM publication_jobs WHERE workspace_id = ? ORDER BY scheduled_for, id').all(workspaceId); return rows.map((row) => publicationJobView(row, this.db)); }
    getJob(id) { return publicationJobView(this.row(id), this.db); }
    rescheduleJob(id, scheduledFor, actor) { requireIso(scheduledFor, 'scheduledFor'); return this.transaction(() => { const row = this.row(id); if (row.status !== 'queued')
        throw new PublicationTransitionError('Only queued publication jobs can be rescheduled'); this.db.prepare('UPDATE publication_jobs SET scheduled_for = ?, updated_at = ? WHERE id = ?').run(scheduledFor, scheduledFor, id); this.event(id, 'queued', 'queued', actor, scheduledFor, { scheduled_for: scheduledFor }); return this.getJob(id); }); }
    requestCancellation(id, actor, at = new Date().toISOString()) { return this.transaction(() => { const row = this.row(id); if (row.final_action_at)
        throw new PublicationTransitionError('Cannot cancel publication job after final action'); if (row.status === 'queued')
        return publicationJobView(this.transition(row, 'cancelled', actor, at), this.db); if (!Object.prototype.hasOwnProperty.call(PUBLICATION_STATE_TRANSITIONS, row.status) || row.status === 'cancellation_requested')
        throw new PublicationTransitionError(`Cannot cancel publication job in ${row.status}`); this.db.prepare('UPDATE publication_jobs SET cancel_requested_at = ? WHERE id = ?').run(at, id); return publicationJobView(this.transition(row, 'cancellation_requested', actor, at), this.db); }); }
    claimDueJob(worker, now) {
        requireIso(now, 'now');
        return this.transaction(() => {
            this.db.prepare('DELETE FROM device_automation_locks WHERE expires_at <= ?').run(now);
            const eligibility = `job.device_id = ? AND job.status = 'queued' AND job.scheduled_for <= ?
        AND NOT EXISTS (SELECT 1 FROM publication_jobs review WHERE review.social_account_id = job.social_account_id AND review.status = 'review_required')
        AND NOT EXISTS (SELECT 1 FROM task_runs run WHERE run.device_id = job.device_id AND ((run.status IN ('running', 'paused') AND (run.lease_expires_at IS NULL OR run.lease_expires_at > ?)) OR (run.status IN ('pending', 'overdue') AND (run.scheduled_for IS NULL OR run.scheduled_for <= ?) AND (run.expires_at IS NULL OR run.expires_at > ?))))
        AND NOT EXISTS (SELECT 1 FROM device_automation_locks lock WHERE lock.device_id = job.device_id AND lock.expires_at > ?)`;
            const args = [worker.deviceId, now, now, now, now, now];
            const invalid = this.db.prepare(`SELECT job.* FROM publication_jobs job LEFT JOIN publication_media media ON media.id = job.media_id WHERE ${eligibility} AND (media.id IS NULL OR media.workspace_id != job.workspace_id OR media.upload_status != 'stored') ORDER BY job.scheduled_for, job.id LIMIT 1`).get(...args);
            if (invalid) {
                const reason = 'MEDIA_UNAVAILABLE';
                this.db.prepare("UPDATE publication_jobs SET status = 'review_required', current_step = 'review_required', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(reason, 'Publication media is missing, not stored, or belongs to another workspace', now, now, invalid.id);
                this.event(invalid.id, 'queued', 'review_required', { type: 'system', id: 'publication-claim' }, now, { reason });
                return { claimed: false, job: null };
            }
            const candidate = this.db.prepare(`SELECT job.*, media.id AS claim_media_id, media.size_bytes AS claim_media_size_bytes, LOWER(media.sha256) AS claim_media_sha256, media.mime_type AS claim_media_mime_type, media.file_extension AS claim_media_file_extension, media.duration_seconds AS claim_media_duration_seconds, media.width AS claim_media_width, media.height AS claim_media_height, media.video_codec AS claim_media_video_codec, media.audio_codec AS claim_media_audio_codec, account.id AS live_account_id, account.username AS live_account_username, COALESCE(NULLIF(account.display_name, ''), account.username) AS live_account_display_name, account.platform AS live_account_platform, device.device_id AS live_device_id FROM publication_jobs job JOIN publication_media media ON media.id = job.media_id AND media.workspace_id = job.workspace_id AND media.upload_status = 'stored' JOIN social_accounts account ON account.id = job.social_account_id AND account.device_id = job.device_id JOIN devices device ON device.id = job.device_id AND device.workspace_id = job.workspace_id WHERE ${eligibility} ORDER BY job.scheduled_for, job.id LIMIT 1`).get(...args);
            if (!candidate)
                return { claimed: false, job: null };
            const media = safeClaimMedia({ id: candidate.claim_media_id, size_bytes: candidate.claim_media_size_bytes, sha256: candidate.claim_media_sha256, mime_type: candidate.claim_media_mime_type, file_extension: candidate.claim_media_file_extension, duration_seconds: candidate.claim_media_duration_seconds, width: candidate.claim_media_width, height: candidate.claim_media_height, video_codec: candidate.claim_media_video_codec, audio_codec: candidate.claim_media_audio_codec });
            const snapshots = safeClaimSnapshot(candidate, candidate.platform, candidate.social_account_id, candidate.device_id);
            const liveMatchesSnapshot = snapshots && candidate.live_account_id === snapshots.account.id && candidate.live_account_username === snapshots.account.username && candidate.live_account_display_name === snapshots.account.display_name && candidate.live_account_platform === snapshots.account.platform && candidate.live_device_id === snapshots.device.device_id;
            if (!media || !snapshots || !liveMatchesSnapshot) {
                const reason = 'MEDIA_UNAVAILABLE';
                this.db.prepare("UPDATE publication_jobs SET status = 'review_required', current_step = 'review_required', error_code = ?, error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(reason, !media ? 'Publication media metadata is invalid' : 'Publication account or device snapshot no longer matches live state', now, now, candidate.id);
                this.event(candidate.id, 'queued', 'review_required', { type: 'system', id: 'publication-claim' }, now, { reason });
                return { claimed: false, job: null };
            }
            const expiresAt = isoAfter(now, Math.max(1, worker.leaseSeconds));
            const claimToken = randomUUID();
            const claimed = this.db.prepare("UPDATE publication_jobs SET status = 'claimed', current_step = 'claimed', claimed_by = ?, claim_token = ?, claimed_at = ?, lease_expires_at = ?, last_heartbeat_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(worker.id, claimToken, now, expiresAt, now, now, candidate.id);
            if (claimed.changes !== 1)
                throw new Error('Publication job is no longer claimable');
            this.db.prepare('INSERT INTO device_automation_locks (device_id, publication_job_id, worker_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET publication_job_id = excluded.publication_job_id, worker_id = excluded.worker_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at').run(candidate.device_id, candidate.id, worker.id, expiresAt, now, now);
            this.event(candidate.id, 'queued', 'claimed', { type: 'worker', id: worker.id }, now);
            return { claimed: true, job: { ...this.getJob(candidate.id), media, ...snapshots } };
        });
    }
    heartbeat(id, worker, now) { return this.transaction(() => { const row = this.row(id); this.requireLiveWorkerLock(row, worker, now); const expiresAt = isoAfter(now, Math.max(1, worker.leaseSeconds)); const lockUpdate = this.db.prepare('UPDATE device_automation_locks SET expires_at = ?, updated_at = ? WHERE device_id = ? AND publication_job_id = ? AND worker_id = ? AND expires_at > ?').run(expiresAt, now, row.device_id, id, worker.id, now); if (lockUpdate.changes !== 1)
        throw new Error('Worker does not hold a live device automation lock'); const jobUpdate = this.db.prepare('UPDATE publication_jobs SET lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND claimed_by = ? AND claim_token = ? AND lease_expires_at > ?').run(expiresAt, now, now, id, worker.id, worker.claimToken, now); if (jobUpdate.changes !== 1)
        throw new Error('Worker no longer owns publication job'); return this.getJob(id); }); }
    checkpoint(id, worker, now, options) { return this.transaction(() => { let row = this.row(id); this.requireLiveWorkerLock(row, worker, now); if (!Number.isInteger(options.progressPercent) || options.progressPercent < 0 || options.progressPercent > 100)
        throw new Error('progressPercent must be between 0 and 100'); if ((options.step === 'publishing') !== (options.finalAction === true))
        throw new PublicationTransitionError('publishing requires finalAction and finalAction requires publishing'); row = this.transition(row, options.step, { type: 'worker', id: worker.id }, now, { progress_percent: options.progressPercent, evidence: options.evidence }); const update = this.db.prepare('UPDATE publication_jobs SET progress_percent = ?, final_action_at = CASE WHEN ? THEN COALESCE(final_action_at, ?) ELSE final_action_at END, updated_at = ? WHERE id = ? AND claimed_by = ? AND claim_token = ? AND lease_expires_at > ?').run(options.progressPercent, options.finalAction ? 1 : 0, now, now, id, worker.id, worker.claimToken, now); if (update.changes !== 1)
        throw new Error('Worker no longer owns publication job'); return this.getJob(id); }); }
    finish(id, worker, target, now, metadata = {}, actor = { type: 'worker', id: worker.id }) { return this.transaction(() => { let row = this.row(id); this.requireLiveWorkerLock(row, worker, now); if (row.final_action_at && !['completed', 'review_required'].includes(target))
        throw new Error('Cannot finish publication job that changed after final action'); row = this.transition(row, target, actor, now, metadata); const update = this.db.prepare('UPDATE publication_jobs SET completed_at = ?, result = ?, error_code = ?, error_message = ?, remote_post_identity = COALESCE(?, remote_post_identity), published_at = COALESCE(?, published_at), verified_at = COALESCE(?, verified_at), updated_at = ? WHERE id = ? AND claimed_by = ? AND claim_token = ? AND lease_expires_at > ?').run(now, metadata.result || null, metadata.errorCode || null, metadata.errorMessage || null, metadata.remotePostIdentity || null, metadata.publishedAt || null, metadata.verifiedAt || null, now, id, worker.id, worker.claimToken, now); if (update.changes !== 1)
        throw new Error('Worker no longer owns publication job'); const release = this.db.prepare('DELETE FROM device_automation_locks WHERE device_id = ? AND publication_job_id = ? AND worker_id = ? AND expires_at > ?').run(row.device_id, id, worker.id, now); if (release.changes !== 1)
        throw new Error('Worker does not hold a live device automation lock'); return publicationJobView(this.row(id), this.db); }); }
}
