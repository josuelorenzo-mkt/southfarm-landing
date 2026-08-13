import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { PublicationStore, PublicationTransitionError } from './publications-domain.js';

type SqliteDatabase = Database.Database;
type WorkerIdentity = { id: string; deviceId: number; leaseSeconds: number };
const LEASE_SECONDS = 45;
const CHECKPOINTS = new Set(['preparing', 'transferring', 'selecting_media', 'editing', 'captioning', 'ready_to_publish', 'publishing', 'verifying']);
const FINISH_STATES = new Set(['completed', 'cancelled', 'failed', 'review_required']);

function value(input: unknown): string | null { return typeof input === 'string' && input.trim() ? input.trim() : null; }
function jobId(input: unknown): number | null { const id = Number(input); return Number.isInteger(id) && id > 0 ? id : null; }
function safeJson(value: unknown): string | null { if (value === undefined) return null; try { return JSON.stringify(value); } catch { return null; } }
function workerFrom(req: Request): WorkerIdentity | null {
  const id = value(req.body?.worker_id) || value(req.header('X-SouthFarm-Worker-Id'));
  const deviceId = Number(req.body?.device_id);
  return id && Number.isInteger(deviceId) && deviceId > 0 ? { id, deviceId, leaseSeconds: LEASE_SECONDS } : null;
}

export function registerPublicationWorkerRoutes({ app, db, store, mediaRoot, workerTokenHash }: { app: Express; db: SqliteDatabase; store: PublicationStore; mediaRoot: string; workerTokenHash: Buffer | string }): void {
  const expectedHash = Buffer.isBuffer(workerTokenHash) ? workerTokenHash : Buffer.from(workerTokenHash, 'hex');
  if (expectedHash.length !== 32) throw new Error('Publisher worker token digest must be SHA-256');
  const authenticate = (req: Request, res: Response, next: () => void) => {
    const match = /^Bearer ([^\s]+)$/.exec(String(req.header('authorization') || ''));
    const receivedHash = createHash('sha256').update(match?.[1] || '').digest();
    if (!match || !timingSafeEqual(receivedHash, expectedHash)) return res.status(401).json({ error_code: 'WORKER_UNAUTHORIZED', error: 'Worker authorization is required' });
    next();
  };
  const claimToken = (req: Request): string | null => value(req.body?.claim_token) || value(req.header('X-SouthFarm-Claim-Token'));
  const owner = (req: Request, id: number): WorkerIdentity | null => {
    const workerId = value(req.body?.worker_id) || value(req.header('X-SouthFarm-Worker-Id'));
    const token = claimToken(req);
    if (!workerId || !token) return null;
    const row: any = db.prepare('SELECT device_id FROM publication_jobs WHERE id = ? AND claimed_by = ? AND claim_token = ? AND lease_expires_at > ?').get(id, workerId, token, new Date().toISOString());
    return row ? { id: workerId, deviceId: Number(row.device_id), leaseSeconds: LEASE_SECONDS } : null;
  };
  const conflict = (res: Response, error: unknown) => res.status(409).json({ error_code: 'WORKER_CLAIM_INVALID', error: error instanceof Error ? error.message : 'Worker claim is invalid or expired' });

  app.post('/api/publication-worker/claim', authenticate, (req, res) => {
    const worker = workerFrom(req);
    if (!worker) return res.status(400).json({ error_code: 'WORKER_REQUEST_INVALID', error: 'worker_id and device_id are required' });
    try {
      const result = store.claimDueJob(worker, new Date().toISOString());
      if (!result.claimed || !result.job) return res.json({ claimed: false, server_time: new Date().toISOString() });
      const job: any = result.job;
      res.json({ claimed: true, worker_id: worker.id, claim_token: job.claim_token, job, server_time: new Date().toISOString() });
    } catch (error) { conflict(res, error); }
  });

  app.post('/api/publication-worker/jobs/:id/heartbeat', authenticate, (req, res) => {
    const id = jobId(req.params.id); const worker = id ? owner(req, id) : null;
    if (!id || !worker) return conflict(res, new Error('Worker claim is invalid or expired'));
    try { const job: any = store.heartbeat(id, worker, new Date().toISOString()); res.json({ ok: true, job, cancel_requested: Boolean(job.cancel_requested_at), server_time: new Date().toISOString() }); } catch (error) { conflict(res, error); }
  });

  app.post('/api/publication-worker/jobs/:id/checkpoint', authenticate, (req, res) => {
    const id = jobId(req.params.id); const worker = id ? owner(req, id) : null; const step = value(req.body?.step);
    const progress = Number(req.body?.progress_percent); const finalAction = Boolean(req.body?.final_action);
    if (!id || !worker) return conflict(res, new Error('Worker claim is invalid or expired'));
    if (!step || !CHECKPOINTS.has(step) || !Number.isInteger(progress)) return res.status(400).json({ error_code: 'CHECKPOINT_INVALID', error: 'step and progress_percent are invalid' });
    try {
      const job = store.checkpoint(id, worker, new Date().toISOString(), { step: step as any, progressPercent: progress, finalAction });
      const evidence = safeJson(req.body?.evidence);
      if (evidence) db.prepare('UPDATE publication_events SET payload = ? WHERE id = (SELECT MAX(id) FROM publication_events WHERE publication_job_id = ?)').run(evidence, id);
      res.json({ ok: true, job });
    } catch (error) { conflict(res, error); }
  });

  app.post('/api/publication-worker/jobs/:id/finish', authenticate, (req, res) => {
    const id = jobId(req.params.id); const worker = id ? owner(req, id) : null; const target = value(req.body?.status);
    if (!id || !worker) return conflict(res, new Error('Worker claim is invalid or expired'));
    if (!target || !FINISH_STATES.has(target)) return res.status(400).json({ error_code: 'FINISH_INVALID', error: 'status is invalid' });
    try {
      const current: any = db.prepare('SELECT final_action_at FROM publication_jobs WHERE id = ?').get(id);
      if (current?.final_action_at && (target === 'failed' || target === 'cancelled')) return res.status(409).json({ error_code: 'FINAL_ACTION_UNCERTAIN', error: 'Final action requires review_required or completed' });
      if (target === 'failed' && Boolean(req.body?.final_action_uncertain)) return res.status(400).json({ error_code: 'FINISH_INVALID', error: 'Uncertain final action must finish as review_required' });
      const job = store.finish(id, worker, target as any, new Date().toISOString());
      db.prepare('UPDATE publication_jobs SET result = ?, error_code = ?, error_message = ?, remote_post_identity = COALESCE(?, remote_post_identity), updated_at = ? WHERE id = ?').run(safeJson(req.body?.result), value(req.body?.error_code), value(req.body?.error_message), value(req.body?.remote_post_identity), new Date().toISOString(), id);
      res.json({ ok: true, job: store.getJob(id) });
    } catch (error) { conflict(res, error); }
  });

  app.get('/api/publication-worker/media/:id', authenticate, (req, res) => {
    const mediaId = jobId(req.params.id); const workerId = value(req.header('X-SouthFarm-Worker-Id')); const token = claimToken(req);
    if (!mediaId || !workerId || !token) return conflict(res, new Error('Worker claim is invalid or expired'));
    const row: any = db.prepare(`SELECT media.* FROM publication_media media JOIN publication_jobs job ON job.media_id = media.id WHERE media.id = ? AND job.claimed_by = ? AND job.claim_token = ? AND job.lease_expires_at > ? AND media.upload_status = 'stored'`).get(mediaId, workerId, token, new Date().toISOString());
    if (!row) return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media is not available for this claim' });
    const root = path.resolve(mediaRoot); const filePath = path.resolve(root, String(row.private_path));
    if (path.relative(root, filePath).startsWith('..') || path.isAbsolute(path.relative(root, filePath)) || !fs.existsSync(filePath)) return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media file is not available' });
    const stat = fs.statSync(filePath); if (!stat.isFile() || stat.size !== Number(row.size_bytes)) return res.status(404).json({ error_code: 'MEDIA_NOT_FOUND', error: 'Media file is not available' });
    res.setHeader('Content-Type', row.mime_type); res.setHeader('Content-Length', String(stat.size)); res.setHeader('Content-Disposition', `attachment; filename="publication-${mediaId}.${String(row.file_extension || 'mp4').replace(/[^a-z0-9]/gi, '')}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/publication-worker/devices/:id/availability', authenticate, (req, res) => {
    const deviceId = jobId(req.params.id); if (!deviceId) return res.status(400).json({ error_code: 'DEVICE_INVALID', error: 'device id is invalid' });
    const now = new Date().toISOString(); const device: any = db.prepare('SELECT id, device_id, device_name, lifecycle_status, last_seen_at FROM devices WHERE id = ?').get(deviceId);
    if (!device) return res.status(404).json({ error_code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
    const lock: any = db.prepare('SELECT publication_job_id, worker_id, expires_at FROM device_automation_locks WHERE device_id = ? AND expires_at > ?').get(deviceId, now);
    const task: any = db.prepare("SELECT id FROM task_runs WHERE device_id = ? AND status IN ('running', 'paused') AND (lease_expires_at IS NULL OR lease_expires_at > ?) LIMIT 1").get(deviceId, now);
    res.json({ device, available: !lock && !task, publication_lock: lock || null, active_task: Boolean(task), server_time: now });
  });
}
