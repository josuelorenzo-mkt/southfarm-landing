import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const LEASE_SECONDS = 45;
const CHECKPOINTS = new Set(['preparing', 'transferring', 'selecting_media', 'editing', 'captioning', 'ready_to_publish', 'publishing', 'verifying']);
const FINISH_STATES = new Set(['completed', 'cancelled', 'failed', 'review_required']);
function value(input) { return typeof input === 'string' && input.trim() ? input.trim() : null; }
function jobId(input) { const id = Number(input); return Number.isInteger(id) && id > 0 ? id : null; }
function safeJson(value) { if (value === undefined)
    return null; try {
    return JSON.stringify(value);
}
catch {
    return null;
} }
function workerFrom(req) {
    const id = value(req.body?.worker_id) || value(req.header('X-SouthFarm-Worker-Id'));
    const deviceId = Number(req.body?.device_id);
    return id && Number.isInteger(deviceId) && deviceId > 0 ? { id, deviceId, leaseSeconds: LEASE_SECONDS } : null;
}
export function registerPublicationWorkerRoutes({ app, db, store, mediaRoot, workerTokenHash, onlineWindowSeconds = 90 }) {
    const expectedHash = Buffer.isBuffer(workerTokenHash) ? workerTokenHash : Buffer.from(workerTokenHash, 'hex');
    if (expectedHash.length !== 32)
        throw new Error('Publisher worker token digest must be SHA-256');
    const authenticate = (req, res, next) => {
        const match = /^Bearer ([^\s]+)$/.exec(String(req.header('authorization') || ''));
        const receivedHash = createHash('sha256').update(match?.[1] || '').digest();
        if (!match || !timingSafeEqual(receivedHash, expectedHash))
            return res.status(401).json({ error_code: 'WORKER_UNAUTHORIZED', error: 'Worker authorization is required' });
        next();
    };
    const claimToken = (req) => value(req.body?.claim_token) || value(req.header('X-SouthFarm-Claim-Token'));
    const mutationWorker = (req) => {
        const workerId = value(req.body?.worker_id) || value(req.header('X-SouthFarm-Worker-Id'));
        const token = claimToken(req);
        return workerId && token ? { id: workerId, deviceId: 0, leaseSeconds: LEASE_SECONDS, claimToken: token } : null;
    };
    const conflict = (res, error) => res.status(409).json({ error_code: 'WORKER_CLAIM_INVALID', error: error instanceof Error ? error.message : 'Worker claim is invalid or expired' });
    const authorizationMac = (nonce) => createHmac('sha256', expectedHash).update(`southfarm-test-cleanup-v1.${nonce}`).digest('base64url');
    const authorizationPayload = (token, consume, workerId, deviceId) => {
        if (typeof token !== 'string')
            return null;
        const parts = token.split('.');
        const [nonce, signature] = parts;
        const expected = nonce ? Buffer.from(authorizationMac(nonce)) : Buffer.alloc(0);
        const received = Buffer.from(signature || '');
        if (!nonce || !signature || parts.length !== 2 || received.length !== expected.length || !timingSafeEqual(received, expected))
            return null;
        if (!workerId || !deviceId)
            return null;
        const row = db.prepare(`SELECT auth.payload, auth.expires_at, auth.consumed_at FROM publication_cleanup_authorizations auth
      JOIN publication_jobs job ON job.id = auth.job_id AND job.workspace_id = auth.workspace_id AND job.device_id = auth.device_id AND job.social_account_id = auth.social_account_id
      WHERE auth.nonce = ? AND auth.worker_id = ? AND auth.device_id = ? AND job.status = 'completed' AND job.test_mode = 1 AND job.verified_at IS NOT NULL AND job.remote_post_identity IS NOT NULL`).get(nonce, workerId, deviceId);
        if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now())
            return null;
        if (consume && db.prepare('UPDATE publication_cleanup_authorizations SET consumed_at = ? WHERE nonce = ? AND worker_id = ? AND device_id = ? AND consumed_at IS NULL AND expires_at > ?').run(new Date().toISOString(), nonce, workerId, deviceId, new Date().toISOString()).changes !== 1)
            return null;
        try {
            return { nonce, payload: JSON.parse(row.payload) };
        }
        catch {
            return null;
        }
    };
    app.post('/api/publication-worker/claim', authenticate, (req, res) => {
        const worker = workerFrom(req);
        if (!worker)
            return res.status(400).json({ error_code: 'WORKER_REQUEST_INVALID', error: 'worker_id and device_id are required' });
        try {
            const result = store.claimDueJob(worker, new Date().toISOString());
            if (!result.claimed || !result.job)
                return res.json({ claimed: false, server_time: new Date().toISOString() });
            const job = result.job;
            res.json({ claimed: true, worker_id: worker.id, claim_token: job.claim_token, job, server_time: new Date().toISOString() });
        }
        catch (error) {
            conflict(res, error);
        }
    });
    app.post('/api/publication-worker/jobs/:id/heartbeat', authenticate, (req, res) => {
        const id = jobId(req.params.id);
        const worker = mutationWorker(req);
        if (!id || !worker)
            return conflict(res, new Error('Worker claim is invalid or expired'));
        try {
            const job = store.heartbeat(id, worker, new Date().toISOString());
            res.json({ ok: true, job, cancel_requested: Boolean(job.cancel_requested_at), server_time: new Date().toISOString() });
        }
        catch (error) {
            conflict(res, error);
        }
    });
    app.post('/api/publication-worker/jobs/:id/checkpoint', authenticate, (req, res) => {
        const id = jobId(req.params.id);
        const worker = mutationWorker(req);
        const step = value(req.body?.step);
        const progress = Number(req.body?.progress_percent);
        const hasFinalAction = Object.prototype.hasOwnProperty.call(req.body || {}, 'final_action');
        const finalAction = req.body?.final_action;
        if (!id || !worker)
            return conflict(res, new Error('Worker claim is invalid or expired'));
        if (!step || !CHECKPOINTS.has(step) || !Number.isInteger(progress) || (hasFinalAction && typeof finalAction !== 'boolean'))
            return res.status(400).json({ error_code: 'CHECKPOINT_INVALID', error: 'step, progress_percent, and final_action are invalid' });
        try {
            const evidence = safeJson(req.body?.evidence);
            const job = store.checkpoint(id, worker, new Date().toISOString(), { step: step, progressPercent: progress, finalAction: finalAction === true, evidence: evidence ? JSON.parse(evidence) : undefined });
            res.json({ ok: true, job });
        }
        catch (error) {
            conflict(res, error);
        }
    });
    app.post('/api/publication-worker/jobs/:id/finish', authenticate, (req, res) => {
        const id = jobId(req.params.id);
        const worker = mutationWorker(req);
        const target = value(req.body?.status);
        if (!id || !worker)
            return conflict(res, new Error('Worker claim is invalid or expired'));
        if (!target || !FINISH_STATES.has(target))
            return res.status(400).json({ error_code: 'FINISH_INVALID', error: 'status is invalid' });
        try {
            if (target === 'failed' && Boolean(req.body?.final_action_uncertain))
                return res.status(400).json({ error_code: 'FINISH_INVALID', error: 'Uncertain final action must finish as review_required' });
            const timestamp = new Date().toISOString();
            const job = store.finish(id, worker, target, timestamp, { result: safeJson(req.body?.result), errorCode: value(req.body?.error_code), errorMessage: value(req.body?.error_message), remotePostIdentity: value(req.body?.remote_post_identity), publishedAt: target === 'completed' ? timestamp : null, verifiedAt: target === 'completed' ? timestamp : null });
            res.json({ ok: true, job });
        }
        catch (error) {
            conflict(res, error);
        }
    });
    for (const [suffix, consume] of [['validate', false], ['consume', true]])
        app.post(`/api/publication-worker/test-cleanup-authorizations/:authorization/${suffix}`, authenticate, (req, res) => {
            const authorized = authorizationPayload(req.params.authorization, consume, value(req.header('X-SouthFarm-Worker-Id')), jobId(req.body?.device_id));
            if (!authorized)
                return res.status(409).json({ error_code: 'CLEANUP_AUTH_INVALID', error: 'Cleanup authorization is invalid, expired, or already used' });
            res.json({ cleanup: authorized.payload });
        });
    app.get('/api/publication-worker/media/:id', authenticate, (req, res) => {
        const mediaId = jobId(req.params.id);
        const workerId = value(req.header('X-SouthFarm-Worker-Id'));
        const token = claimToken(req);
        if (!mediaId || !workerId || !token)
            return conflict(res, new Error('Worker claim is invalid or expired'));
        const row = db.prepare(`SELECT media.* FROM publication_media media JOIN publication_jobs job ON job.media_id = media.id WHERE media.id = ? AND job.claimed_by = ? AND job.claim_token = ? AND job.lease_expires_at > ? AND job.status NOT IN ('completed', 'cancelled', 'failed', 'review_required') AND media.upload_status = 'stored' AND EXISTS (SELECT 1 FROM device_automation_locks lock WHERE lock.device_id = job.device_id AND lock.publication_job_id = job.id AND lock.worker_id = job.claimed_by AND lock.expires_at > ?)`).get(mediaId, workerId, token, new Date().toISOString(), new Date().toISOString());
        if (!row)
            return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media is not available for this claim' });
        const root = path.resolve(mediaRoot);
        const filePath = path.resolve(root, String(row.private_path));
        if (path.relative(root, filePath).startsWith('..') || path.isAbsolute(path.relative(root, filePath)) || !fs.existsSync(filePath))
            return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media file is not available' });
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size !== Number(row.size_bytes))
            return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media file is not available' });
        res.setHeader('Content-Type', row.mime_type);
        res.setHeader('Content-Length', String(stat.size));
        res.setHeader('Content-Disposition', `attachment; filename="publication-${mediaId}.${String(row.file_extension || 'mp4').replace(/[^a-z0-9]/gi, '')}"`);
        fs.createReadStream(filePath).pipe(res);
    });
    app.get('/api/publication-worker/devices/:id/availability', authenticate, (req, res) => {
        const deviceId = jobId(req.params.id);
        if (!deviceId)
            return res.status(400).json({ error_code: 'DEVICE_INVALID', error: 'device id is invalid' });
        const now = new Date().toISOString();
        const device = db.prepare('SELECT id, device_id, device_name, lifecycle_status, last_seen_at FROM devices WHERE id = ?').get(deviceId);
        if (!device)
            return res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
        const lock = db.prepare('SELECT publication_job_id, worker_id, expires_at FROM device_automation_locks WHERE device_id = ? AND expires_at > ?').get(deviceId, now);
        const task = db.prepare("SELECT id FROM task_runs WHERE device_id = ? AND ((status IN ('running', 'paused') AND (lease_expires_at IS NULL OR lease_expires_at > ?)) OR (status IN ('pending', 'overdue') AND (scheduled_for IS NULL OR scheduled_for <= ?) AND (expires_at IS NULL OR expires_at > ?))) LIMIT 1").get(deviceId, now, now, now);
        const online = device.lifecycle_status === 'active' && typeof device.last_seen_at === 'string' && Date.parse(device.last_seen_at) >= Date.now() - onlineWindowSeconds * 1000;
        const reasons = [!online ? 'device_offline' : null, lock ? 'device_busy_publication' : null, task ? 'device_busy_task' : null].filter(Boolean);
        res.json({ device, online, available: reasons.length === 0, reasons, publication_lock: lock || null, active_task: Boolean(task), server_time: now });
    });
}
