import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { PublicationStore, validatePublicationInput } from './publications-domain.js';

type SqliteDatabase = Database.Database;
type Middleware = (req: Request, res: Response, next: NextFunction) => void;

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

class PublicationRouteError extends Error {
  constructor(readonly status: number, readonly errorCode: string, message: string) { super(message); }
}

function routeError(status: number, errorCode: string, message: string): never {
  throw new PublicationRouteError(status, errorCode, message);
}

function removeFile(filePath?: string): void {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
}

function cleanFilename(name: unknown): string {
  const base = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return base.slice(0, 180) || 'video';
}

function validSignature(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    return (bytes >= 8 && header.subarray(4, 8).toString('ascii') === 'ftyp')
      || (bytes >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
  } finally { fs.closeSync(fd); }
}

function hashFile(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function parseId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) routeError(400, 'VALIDATION_ERROR', `${label} must be a positive integer`);
  return id;
}

function parseSchedule(value: unknown): string {
  const scheduledFor = typeof value === 'string' ? value.trim() : '';
  const parsed = new Date(scheduledFor);
  if (!scheduledFor || Number.isNaN(parsed.getTime())) routeError(400, 'VALIDATION_ERROR', 'scheduled_for must be an ISO timestamp');
  if (parsed.getTime() < Date.now() - 60_000) routeError(400, 'VALIDATION_ERROR', 'scheduled_for cannot be in the past');
  return parsed.toISOString();
}

function workspaceJob(db: SqliteDatabase, workspaceId: number, rawId: unknown): any {
  const id = parseId(rawId, 'publication id');
  const job = db.prepare('SELECT * FROM publication_jobs WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as any;
  if (!job) routeError(404, 'NOT_FOUND', 'Publication not found');
  return job;
}

function safePublication(job: any, media?: any, events?: any[]): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: Number(job.id), workspace_id: Number(job.workspace_id), device_id: Number(job.device_id), social_account_id: Number(job.social_account_id),
    platform: job.platform, caption: job.caption, word_count: Number(job.word_count), scheduled_for: job.scheduled_for,
    status: job.status, current_step: job.current_step, progress_percent: Number(job.progress_percent || 0),
    attempt_count: Number(job.attempt_count || 0), final_action_at: job.final_action_at || null, published_at: job.published_at || null,
    verified_at: job.verified_at || null, remote_post_identity: job.remote_post_identity || null,
    error_code: job.error_code || null, error_message: job.error_message || null, cancel_requested_at: job.cancel_requested_at || null,
    created_at: job.created_at, updated_at: job.updated_at, completed_at: job.completed_at || null,
  };
  if (media) view.media = {
    id: Number(media.id), media_key: path.basename(String(media.private_path || '')),
    original_filename: media.original_filename, mime_type: media.mime_type, file_extension: media.file_extension,
    size_bytes: Number(media.size_bytes), sha256: media.sha256,
  };
  if (events) view.events = events.map((event) => ({
    id: Number(event.id), from_status: event.from_status, to_status: event.to_status, current_step: event.current_step,
    message: event.message || null, actor_type: event.actor_type || null, created_at: event.created_at,
    payload: event.payload ? JSON.parse(event.payload) : null,
  }));
  return view;
}

function mediaForJob(db: SqliteDatabase, job: any): any | null {
  if (!job.media_id) return null;
  return db.prepare('SELECT * FROM publication_media WHERE id = ? AND workspace_id = ?').get(job.media_id, job.workspace_id) as any || null;
}

export function registerPublicationRoutes({
  app, db, store, auth, requireRole, mediaRoot,
}: { app: Express; db: SqliteDatabase; store: PublicationStore; auth: Middleware; requireRole: (...roles: any[]) => Middleware; mediaRoot: string }): void {
  const root = path.resolve(mediaRoot);
  const tempRoot = path.join(root, '.tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => callback(null, tempRoot),
      filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
    }),
    limits: { files: 1, fileSize: MAX_VIDEO_BYTES },
    fileFilter: (_req, file, callback) => callback(null, Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, file.mimetype)),
  }).single('video');

  app.post('/api/publications', auth, requireRole('owner', 'admin', 'operator'), (req: any, res: Response) => {
    upload(req, res, (uploadError) => {
      const uploadedPath = req.file?.path as string | undefined;
      let finalPath: string | undefined;
      let mediaId: number | undefined;
      let jobId: number | undefined;
      try {
        if (uploadError instanceof MulterError && uploadError.code === 'LIMIT_FILE_SIZE') routeError(413, 'VIDEO_TOO_LARGE', 'Video exceeds the 200 MiB limit');
        if (uploadError) routeError(400, 'VALIDATION_ERROR', 'Invalid video upload');
        if (!req.file) routeError(400, 'VALIDATION_ERROR', 'A single video file is required');
        if (!validSignature(uploadedPath!)) routeError(400, 'VALIDATION_ERROR', 'Video signature is not supported');
        let input;
        try {
          input = validatePublicationInput({ platform: req.body?.platform, caption: req.body?.caption });
        } catch {
          routeError(400, 'VALIDATION_ERROR', 'platform or caption is invalid');
        }
        const scheduledFor = parseSchedule(req.body?.scheduled_for);
        const deviceId = parseId(req.body?.device_id, 'device_id');
        const accountId = parseId(req.body?.social_account_id, 'social_account_id');
        const workspaceId = Number(req.user.workspaceId);
        const device = db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ? AND lifecycle_status != ?').get(deviceId, workspaceId, 'revoked') as any;
        if (!device) routeError(404, 'NOT_FOUND', 'Device not found');
        const account = db.prepare('SELECT * FROM social_accounts WHERE id = ? AND device_id = ? AND platform = ?').get(accountId, deviceId, input.platform) as any;
        if (!account) routeError(404, 'NOT_FOUND', 'Social account not found');
        const review = db.prepare("SELECT 1 FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required' LIMIT 1").get(accountId);
        if (review) routeError(409, 'REVIEW_REQUIRED', 'This social account has a publication requiring review');

        const sizeBytes = Number(req.file.size);
        if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_VIDEO_BYTES) routeError(400, 'VALIDATION_ERROR', 'Video size is invalid');
        const extension = MIME_EXTENSIONS[req.file.mimetype];
        const createdAt = new Date().toISOString();
        const sha256 = hashFile(uploadedPath!);
        const mediaInsert = db.prepare(`INSERT INTO publication_media
          (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)`)
          .run(workspaceId, Number(req.user.userId), cleanFilename(req.file.originalname), req.file.mimetype, extension, sizeBytes, sha256, createdAt, createdAt);
        mediaId = Number(mediaInsert.lastInsertRowid);
        const mediaKey = `${mediaId}.${extension}`;
        finalPath = path.join(root, mediaKey);
        fs.renameSync(uploadedPath!, finalPath);
        db.prepare('UPDATE publication_media SET private_path = ? WHERE id = ?').run(mediaKey, mediaId);

        const transaction = db.transaction(() => {
          const jobInsert = db.prepare(`INSERT INTO publication_jobs
            (workspace_id, created_by_user_id, device_id, social_account_id, media_id, platform, caption, word_count, scheduled_for,
             status, current_step, created_by_type, created_by_id, account_snapshot, device_snapshot, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 'user', ?, ?, ?, ?, ?)`)
            .run(workspaceId, Number(req.user.userId), deviceId, accountId, mediaId, input.platform, input.caption, input.wordCount, scheduledFor,
              String(req.user.userId), JSON.stringify({ username: account.username, platform: account.platform }), JSON.stringify({ device_id: device.device_id, device_name: device.device_name }), createdAt, createdAt);
          jobId = Number(jobInsert.lastInsertRowid);
          db.prepare(`INSERT INTO publication_events (publication_job_id, from_status, to_status, current_step, actor_type, actor_id, created_at)
            VALUES (?, NULL, 'queued', 'queued', 'user', ?, ?)`).run(jobId, String(req.user.userId), createdAt);
        });
        transaction();
        const job = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(jobId) as any;
        res.status(201).json({ publication: safePublication(job, mediaForJob(db, job)) });
      } catch (error: any) {
        try { removeFile(uploadedPath); } catch {}
        try { removeFile(finalPath); } catch {}
        if (jobId) db.prepare('DELETE FROM publication_jobs WHERE id = ?').run(jobId);
        if (mediaId) db.prepare('DELETE FROM publication_media WHERE id = ?').run(mediaId);
        if (error instanceof PublicationRouteError) return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
        return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to create publication' });
      }
    });
  });

  app.get('/api/publications', auth, (req: any, res: Response) => {
    try {
      const workspaceId = Number(req.user.workspaceId);
      const where = ['workspace_id = ?']; const values: unknown[] = [workspaceId];
      for (const [key, column] of [['status', 'status'], ['platform', 'platform'], ['device_id', 'device_id'], ['social_account_id', 'social_account_id']] as const) {
        if (req.query[key] !== undefined) { where.push(`${column} = ?`); values.push(key.endsWith('_id') ? parseId(req.query[key], key) : String(req.query[key])); }
      }
      const jobs = db.prepare(`SELECT * FROM publication_jobs WHERE ${where.join(' AND ')} ORDER BY scheduled_for DESC, id DESC`).all(...values) as any[];
      res.json({ publications: jobs.map((job) => safePublication(job, mediaForJob(db, job))) });
    } catch (error: any) {
      if (error instanceof PublicationRouteError) return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
      return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to list publications' });
    }
  });

  app.get('/api/publications/:id', auth, (req: any, res: Response) => {
    try {
      const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
      const events = db.prepare('SELECT * FROM publication_events WHERE publication_job_id = ? ORDER BY id ASC').all(job.id) as any[];
      res.json({ publication: safePublication(job, mediaForJob(db, job), events) });
    } catch (error: any) {
      if (error instanceof PublicationRouteError) return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
      return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to retrieve publication' });
    }
  });

  app.patch('/api/publications/:id/schedule', auth, requireRole('owner', 'admin', 'operator'), (req: any, res: Response) => {
    try {
      const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
      if (job.status !== 'queued') routeError(409, 'UNSAFE_TRANSITION', 'Only queued publications can be rescheduled');
      const scheduledFor = parseSchedule(req.body?.scheduled_for);
      const publication = store.rescheduleJob(Number(job.id), scheduledFor, { type: 'user', id: String(req.user.userId) });
      const refreshed = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(publication.id) as any;
      res.json({ publication: safePublication(refreshed, mediaForJob(db, refreshed)) });
    } catch (error: any) {
      if (error instanceof PublicationRouteError) return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
      return res.status(409).json({ error_code: 'UNSAFE_TRANSITION', error: 'Publication cannot be rescheduled' });
    }
  });

  app.post('/api/publications/:id/cancel', auth, requireRole('owner', 'admin', 'operator'), (req: any, res: Response) => {
    try {
      const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
      if (job.final_action_at) routeError(409, 'UNSAFE_TRANSITION', 'Publication cannot be cancelled after final action');
      const publication = store.requestCancellation(Number(job.id), { type: 'user', id: String(req.user.userId) });
      const refreshed = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(publication.id) as any;
      res.json({ publication: safePublication(refreshed, mediaForJob(db, refreshed)) });
    } catch (error: any) {
      if (error instanceof PublicationRouteError) return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
      return res.status(409).json({ error_code: 'UNSAFE_TRANSITION', error: 'Publication cannot be cancelled' });
    }
  });
}
