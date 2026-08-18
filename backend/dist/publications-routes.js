import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer, { MulterError } from 'multer';
import { PublicationTransitionError, validatePublicationInput } from './publications-domain.js';
import { inspectPublicationVideo } from './publication-media-inspector.js';
export const PLATFORM_MEDIA_RULES = {
    instagram: { maxWidth: 1080, maxHeight: 1920, allowedVideoCodecs: ['h264', 'hevc'] },
    tiktok: { maxWidth: 1080, maxHeight: 1920, allowedVideoCodecs: ['h264', 'hevc'] },
    youtube: { maxWidth: 1080, maxHeight: 1920, allowedVideoCodecs: ['h264', 'hevc'] },
};
export function mediaSupportedForPlatform(platform, metadata) {
    const rules = PLATFORM_MEDIA_RULES[platform];
    if (!rules)
        return { supported: false, reason: 'codec' };
    if (typeof metadata.video_codec !== 'string' || !metadata.video_codec || typeof metadata.width !== 'number' || !Number.isInteger(metadata.width) || typeof metadata.height !== 'number' || !Number.isInteger(metadata.height)) {
        return { supported: false, reason: 'metadata' };
    }
    if (metadata.width > rules.maxWidth || metadata.height > rules.maxHeight)
        return { supported: false, reason: 'dimensions' };
    if (!rules.allowedVideoCodecs.includes(metadata.video_codec))
        return { supported: false, reason: 'codec' };
    return { supported: true };
}
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MIME_EXTENSIONS = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
};
class PublicationRouteError extends Error {
    constructor(status, errorCode, message) {
        super(message);
        this.status = status;
        this.errorCode = errorCode;
    }
}
function routeError(status, errorCode, message) {
    throw new PublicationRouteError(status, errorCode, message);
}
function removeFile(filePath) {
    if (!filePath)
        return;
    try {
        fs.unlinkSync(filePath);
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
}
function cleanupUploadedFiles(req) {
    const candidates = [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())]
        .map((file) => file?.path)
        .filter((filePath) => typeof filePath === 'string');
    for (const filePath of candidates) {
        try {
            removeFile(filePath);
        }
        catch { }
    }
}
function compensateUpload(db, req, state) {
    if (state.committed || state.cleaning)
        return;
    state.cleaning = true;
    cleanupUploadedFiles(req);
    try {
        removeFile(state.uploadedPath);
    }
    catch { }
    try {
        removeFile(state.finalPath);
    }
    catch { }
    try {
        db.transaction(() => {
            if (state.jobId)
                db.prepare('DELETE FROM publication_events WHERE publication_job_id = ?').run(state.jobId);
            if (state.jobId)
                db.prepare('DELETE FROM publication_jobs WHERE id = ?').run(state.jobId);
            if (state.mediaId)
                db.prepare('DELETE FROM publication_media WHERE id = ?').run(state.mediaId);
        })();
    }
    catch { }
    state.cleaning = false;
}
function parseEbmlVint(buffer, offset, preserveMarker) {
    if (offset >= buffer.length)
        return null;
    const first = buffer[offset];
    let length = 1;
    while (length <= 8 && (first & (0x80 >> (length - 1))) === 0)
        length += 1;
    if (length > 8 || offset + length > buffer.length)
        return null;
    let value = preserveMarker ? first : first & ((1 << (8 - length)) - 1);
    for (let index = 1; index < length; index += 1)
        value = value * 256 + buffer[offset + index];
    const unknown = !preserveMarker && Array.from(buffer.subarray(offset, offset + length)).every((byte, index) => index === 0 ? byte === ((0xff >> (length - 1)) | (0x80 >> (length - 1))) : byte === 0xff);
    return { value, length, unknown };
}
function isExactWebmEbmlHeader(buffer) {
    const rootId = parseEbmlVint(buffer, 0, true);
    if (!rootId || rootId.value !== 0x1a45dfa3)
        return false;
    const rootSize = parseEbmlVint(buffer, rootId.length, false);
    if (!rootSize || rootSize.unknown)
        return false;
    let offset = rootId.length + rootSize.length;
    const end = offset + rootSize.value;
    if (end > buffer.length)
        return false;
    while (offset < end) {
        const elementId = parseEbmlVint(buffer, offset, true);
        if (!elementId)
            return false;
        const elementSize = parseEbmlVint(buffer, offset + elementId.length, false);
        if (!elementSize || elementSize.unknown)
            return false;
        const valueStart = offset + elementId.length + elementSize.length;
        const valueEnd = valueStart + elementSize.value;
        if (valueEnd > end)
            return false;
        if (elementId.value === 0x4282)
            return elementSize.value === 4 && buffer.subarray(valueStart, valueEnd).toString('ascii') === 'webm';
        offset = valueEnd;
    }
    return false;
}
function cleanFilename(name) {
    const base = path.basename(String(name || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
    return base.slice(0, 180) || 'video';
}
function validSignature(filePath, mimeType) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const header = Buffer.alloc(64);
        const bytes = fs.readSync(fd, header, 0, header.length, 0);
        if (mimeType === 'video/webm') {
            return isExactWebmEbmlHeader(header.subarray(0, bytes));
        }
        if (bytes < 16 || header.subarray(4, 8).toString('ascii') !== 'ftyp')
            return false;
        const boxSize = header.readUInt32BE(0);
        if (boxSize < 16 || boxSize > bytes)
            return false;
        const majorBrand = header.subarray(8, 12).toString('ascii').toLowerCase();
        const compatibleBrands = [];
        for (let offset = 16; offset + 4 <= boxSize; offset += 4)
            compatibleBrands.push(header.subarray(offset, offset + 4).toString('ascii').toLowerCase());
        const brands = [majorBrand, ...compatibleBrands];
        const mp4Brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msdh', 'mmp4']);
        const quicktimeBrands = new Set(['qt  ']);
        const imageOrHevcBrands = new Set(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);
        if (brands.some((brand) => imageOrHevcBrands.has(brand)))
            return false;
        if (mimeType === 'video/quicktime')
            return majorBrand === 'qt  ' && !brands.some((brand) => mp4Brands.has(brand));
        return mp4Brands.has(majorBrand) && !brands.some((brand) => quicktimeBrands.has(brand));
    }
    finally {
        fs.closeSync(fd);
    }
}
function hashFile(filePath) {
    const hash = createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        for (;;) {
            const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!bytes)
                break;
            hash.update(buffer.subarray(0, bytes));
        }
    }
    finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}
function parseId(value, label) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0)
        routeError(400, 'VALIDATION_ERROR', `${label} must be a positive integer`);
    return id;
}
function parseSchedule(value) {
    const scheduledFor = typeof value === 'string' ? value.trim() : '';
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(scheduledFor);
    if (!match)
        routeError(400, 'VALIDATION_ERROR', 'scheduled_for must be an RFC3339 timestamp with an offset');
    const [, year, month, day, hour, minute, second = '0', fraction = '', offset] = match;
    const values = [year, month, day, hour, minute, second].map(Number);
    const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = values;
    const offsetValid = offset === 'Z' || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
    const calendar = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber, secondNumber));
    if (!offsetValid || monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31 || hourNumber > 23 || minuteNumber > 59 || secondNumber > 59
        || calendar.getUTCFullYear() !== yearNumber || calendar.getUTCMonth() !== monthNumber - 1 || calendar.getUTCDate() !== dayNumber) {
        routeError(400, 'VALIDATION_ERROR', 'scheduled_for is not a valid RFC3339 timestamp');
    }
    const parsed = new Date(scheduledFor);
    if (Number.isNaN(parsed.getTime()))
        routeError(400, 'VALIDATION_ERROR', 'scheduled_for is not a valid RFC3339 timestamp');
    if (parsed.getTime() < Date.now() - 60000)
        routeError(400, 'VALIDATION_ERROR', 'scheduled_for cannot be in the past');
    return parsed.toISOString();
}
function workspaceJob(db, workspaceId, rawId) {
    const id = parseId(rawId, 'publication id');
    const job = db.prepare('SELECT * FROM publication_jobs WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    if (!job)
        routeError(404, 'NOT_FOUND', 'Publication not found');
    return job;
}
// Roles that may see the worker evidence captured in `result` (accessibility
// tree dumps of the phone screen). This mirrors the managing-role set used by
// requireRole for mutating endpoints, so `viewer` never receives evidence.
const MANAGING_ROLES = ['owner', 'admin', 'operator'];
function isManagingRole(role) {
    return MANAGING_ROLES.includes(String(role || '').toLowerCase());
}
function safePublication(job, media, events, includeResult = false) {
    const view = {
        id: Number(job.id), workspace_id: Number(job.workspace_id), device_id: Number(job.device_id), social_account_id: Number(job.social_account_id),
        platform: job.platform, caption: job.caption, word_count: Number(job.word_count), scheduled_for: job.scheduled_for,
        status: job.status, current_step: job.current_step, progress_percent: Number(job.progress_percent || 0),
        attempt_count: Number(job.attempt_count || 0), final_action_at: job.final_action_at || null, published_at: job.published_at || null,
        verified_at: job.verified_at || null, remote_post_identity: job.remote_post_identity || null,
        error_code: job.error_code || null, error_message: job.error_message || null, cancel_requested_at: job.cancel_requested_at || null,
        created_at: job.created_at, updated_at: job.updated_at, completed_at: job.completed_at || null,
    };
    if (includeResult)
        view.result = job.result || null;
    if (media)
        view.media = {
            id: Number(media.id), media_key: path.basename(String(media.private_path || '')),
            original_filename: media.original_filename, mime_type: media.mime_type, file_extension: media.file_extension,
            size_bytes: Number(media.size_bytes), sha256: media.sha256,
        };
    if (events)
        view.events = events.map((event) => ({
            id: Number(event.id), from_status: event.from_status, to_status: event.to_status, current_step: event.current_step,
            message: event.message || null, actor_type: event.actor_type || null, created_at: event.created_at,
            payload: event.payload ? (() => { try {
                return JSON.parse(event.payload);
            }
            catch {
                return null;
            } })() : null,
        }));
    return view;
}
function mediaForJob(db, job) {
    if (!job.media_id)
        return null;
    return db.prepare('SELECT * FROM publication_media WHERE id = ? AND workspace_id = ?').get(job.media_id, job.workspace_id) || null;
}
export function registerPublicationRoutes({ app, db, store, auth, requireRole, mediaRoot, workerTokenHash, testHooks, inspectVideo = inspectPublicationVideo, }) {
    const root = path.resolve(mediaRoot);
    const tempRoot = path.join(root, '.tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const isInsideRoot = (candidate) => {
        const resolved = path.resolve(root, candidate);
        return resolved.startsWith(`${root}${path.sep}`) && path.dirname(resolved) === root;
    };
    const recoveryCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    for (const row of db.prepare(`SELECT id, private_path FROM publication_media media
    WHERE media.upload_status = 'staging' AND media.updated_at < ?
      AND NOT EXISTS (SELECT 1 FROM publication_jobs job WHERE job.media_id = media.id)`).all(recoveryCutoff)) {
        const privatePath = String(row.private_path || '');
        if (privatePath && isInsideRoot(privatePath)) {
            try {
                removeFile(path.resolve(root, privatePath));
            }
            catch { }
        }
        db.prepare('DELETE FROM publication_media WHERE id = ?').run(row.id);
    }
    for (const name of fs.readdirSync(tempRoot)) {
        const candidate = path.join(tempRoot, name);
        try {
            if (fs.statSync(candidate).isFile() && Date.now() - fs.statSync(candidate).mtimeMs > 15 * 60 * 1000)
                removeFile(candidate);
        }
        catch { }
    }
    const requireUserSession = (req, res, next) => {
        if (req.user?.authType !== 'user') {
            res.status(403).json({ error_code: 'USER_SESSION_REQUIRED', error: 'A user session is required for publications' });
            return;
        }
        next();
    };
    const cleanupTokenHash = workerTokenHash ? (Buffer.isBuffer(workerTokenHash) ? workerTokenHash : Buffer.from(workerTokenHash, 'hex')) : null;
    const cleanupMac = (nonce) => createHmac('sha256', cleanupTokenHash).update(`southfarm-test-cleanup-v1.${nonce}`).digest('base64url');
    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, callback) => callback(null, tempRoot),
            filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`),
        }),
        limits: { files: 1, fileSize: MAX_VIDEO_BYTES },
        fileFilter: (_req, file, callback) => callback(null, Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, file.mimetype)),
    }).single('video');
    app.post('/api/publications', auth, requireUserSession, requireRole('owner', 'admin', 'operator'), (req, res) => {
        const state = { committed: false, aborted: false, cleaning: false };
        req.once('aborted', () => { state.aborted = true; compensateUpload(db, req, state); });
        res.once('close', () => { if (!state.committed) {
            state.aborted = true;
            compensateUpload(db, req, state);
        } });
        upload(req, res, async (uploadError) => {
            state.uploadedPath = req.file?.path;
            try {
                if (uploadError instanceof MulterError && uploadError.code === 'LIMIT_FILE_SIZE')
                    routeError(413, 'VIDEO_TOO_LARGE', 'Video exceeds the 200 MiB limit');
                if (uploadError)
                    routeError(400, 'VALIDATION_ERROR', 'Invalid video upload');
                if (!req.file)
                    routeError(400, 'VALIDATION_ERROR', 'A single video file is required');
                if (!validSignature(state.uploadedPath, req.file.mimetype))
                    routeError(400, 'VALIDATION_ERROR', 'Video signature is not supported');
                let input;
                try {
                    input = validatePublicationInput({ platform: req.body?.platform, caption: req.body?.caption });
                }
                catch {
                    routeError(400, 'VALIDATION_ERROR', 'platform or caption is invalid');
                }
                const scheduledFor = parseSchedule(req.body?.scheduled_for);
                const testMode = req.body?.test_mode === 'true' || req.body?.test_mode === true;
                const deviceId = parseId(req.body?.device_id, 'device_id');
                const accountId = parseId(req.body?.social_account_id, 'social_account_id');
                const workspaceId = Number(req.user.workspaceId);
                const device = db.prepare('SELECT * FROM devices WHERE id = ? AND workspace_id = ? AND lifecycle_status != ?').get(deviceId, workspaceId, 'revoked');
                if (!device)
                    routeError(404, 'NOT_FOUND', 'Device not found');
                const account = db.prepare('SELECT * FROM social_accounts WHERE id = ? AND device_id = ? AND platform = ?').get(accountId, deviceId, input.platform);
                if (!account)
                    routeError(404, 'NOT_FOUND', 'Social account not found');
                const review = db.prepare("SELECT 1 FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required' LIMIT 1").get(accountId);
                if (review)
                    routeError(409, 'REVIEW_REQUIRED', 'This social account has a publication requiring review');
                const sizeBytes = Number(req.file.size);
                if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_VIDEO_BYTES)
                    routeError(400, 'VALIDATION_ERROR', 'Video size is invalid');
                const extension = MIME_EXTENSIONS[req.file.mimetype];
                const createdAt = new Date().toISOString();
                const sha256 = hashFile(state.uploadedPath);
                let metadata;
                try {
                    metadata = await inspectVideo(state.uploadedPath);
                }
                catch {
                    routeError(400, 'MEDIA_METADATA_INVALID', 'Video metadata could not be verified');
                }
                // Fail-closed platform media rules: a job whose media the target
                // platform cannot handle must be rejected here, before any phone
                // minutes are spent on it (e.g. 4K HEVC clips that Instagram's
                // gallery refuses with MEDIA_UNSELECTABLE after a long run).
                const platformCheck = mediaSupportedForPlatform(input.platform, metadata);
                if (!platformCheck.supported) {
                    const rules = PLATFORM_MEDIA_RULES[input.platform];
                    const ruleText = `max ${rules.maxWidth}x${rules.maxHeight} with ${rules.allowedVideoCodecs.join('/')}`;
                    const message = platformCheck.reason === 'dimensions'
                        ? `Video is ${metadata.video_codec} ${metadata.width}x${metadata.height} but platform allows ${ruleText}`
                        : platformCheck.reason === 'metadata'
                            ? `Video metadata is missing (codec or dimensions not inspected) but platform allows ${ruleText}`
                            : `Video codec ${metadata.video_codec} is not supported: platform allows ${ruleText}`;
                    routeError(400, 'MEDIA_UNSUPPORTED', message);
                }
                if (state.aborted || req.aborted)
                    routeError(400, 'REQUEST_ABORTED', 'Upload request was aborted');
                const mediaInsert = db.prepare(`INSERT INTO publication_media
          (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, duration_seconds, width, height, video_codec, audio_codec, upload_status, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?)`)
                    .run(workspaceId, Number(req.user.userId), cleanFilename(req.file.originalname), req.file.mimetype, extension, sizeBytes, sha256, metadata.duration_seconds, metadata.width, metadata.height, metadata.video_codec, metadata.audio_codec, createdAt, createdAt);
                state.mediaId = Number(mediaInsert.lastInsertRowid);
                const mediaKey = `${state.mediaId}.${extension}`;
                state.finalPath = path.join(root, mediaKey);
                // The staging row records its intended final key before the rename.
                // Startup recovery can therefore remove either half of a crash safely.
                db.prepare('UPDATE publication_media SET private_path = ?, updated_at = ? WHERE id = ? AND upload_status = ?')
                    .run(mediaKey, createdAt, state.mediaId, 'staging');
                fs.renameSync(state.uploadedPath, state.finalPath);
                await testHooks?.afterRename?.(req, res);
                if (state.aborted || req.aborted)
                    routeError(400, 'REQUEST_ABORTED', 'Upload request was aborted');
                const transaction = db.transaction(() => {
                    db.prepare("UPDATE publication_media SET private_path = ?, upload_status = 'stored', updated_at = ? WHERE id = ? AND upload_status = 'staging'").run(mediaKey, createdAt, state.mediaId);
                    const jobInsert = db.prepare(`INSERT INTO publication_jobs
            (workspace_id, created_by_user_id, device_id, social_account_id, media_id, platform, caption, word_count, test_mode, scheduled_for,
             status, current_step, created_by_type, created_by_id, account_snapshot, device_snapshot, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 'user', ?, ?, ?, ?, ?)`)
                        .run(workspaceId, Number(req.user.userId), deviceId, accountId, state.mediaId, input.platform, input.caption, input.wordCount, testMode ? 1 : 0, scheduledFor, String(req.user.userId), JSON.stringify({ id: Number(account.id), username: String(account.username), display_name: String(account.display_name || account.username), platform: String(account.platform) }), JSON.stringify({ id: Number(device.id), device_id: String(device.device_id) }), createdAt, createdAt);
                    state.jobId = Number(jobInsert.lastInsertRowid);
                    db.prepare(`INSERT INTO publication_events (publication_job_id, from_status, to_status, current_step, actor_type, actor_id, created_at)
            VALUES (?, NULL, 'queued', 'queued', 'user', ?, ?)`).run(state.jobId, String(req.user.userId), createdAt);
                });
                transaction();
                if (state.aborted || req.aborted)
                    routeError(400, 'REQUEST_ABORTED', 'Upload request was aborted');
                const job = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(state.jobId);
                state.committed = true;
                res.status(201).json({ publication: safePublication(job, mediaForJob(db, job), undefined, isManagingRole(req.user?.role)) });
            }
            catch (error) {
                compensateUpload(db, req, state);
                if (state.aborted || req.aborted || res.headersSent)
                    return;
                if (error instanceof PublicationRouteError)
                    return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
                return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to create publication' });
            }
        });
    });
    app.get('/api/publications', auth, requireUserSession, (req, res) => {
        try {
            const workspaceId = Number(req.user.workspaceId);
            const where = ['workspace_id = ?'];
            const values = [workspaceId];
            for (const [key, column] of [['status', 'status'], ['platform', 'platform'], ['device_id', 'device_id'], ['social_account_id', 'social_account_id']]) {
                if (req.query[key] !== undefined) {
                    where.push(`${column} = ?`);
                    values.push(key.endsWith('_id') ? parseId(req.query[key], key) : String(req.query[key]));
                }
            }
            const jobs = db.prepare(`SELECT * FROM publication_jobs WHERE ${where.join(' AND ')} ORDER BY scheduled_for DESC, id DESC`).all(...values);
            res.json({ publications: jobs.map((job) => safePublication(job, mediaForJob(db, job), undefined, isManagingRole(req.user?.role))) });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to list publications' });
        }
    });
    app.get('/api/publications/:id', auth, requireUserSession, (req, res) => {
        try {
            const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
            const events = db.prepare('SELECT * FROM publication_events WHERE publication_job_id = ? ORDER BY id ASC').all(job.id);
            res.json({ publication: safePublication(job, mediaForJob(db, job), events, isManagingRole(req.user?.role)) });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to retrieve publication' });
        }
    });
    app.patch('/api/publications/:id/schedule', auth, requireUserSession, requireRole('owner', 'admin', 'operator'), (req, res) => {
        try {
            const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
            if (job.status !== 'queued')
                routeError(409, 'UNSAFE_TRANSITION', 'Only queued publications can be rescheduled');
            testHooks?.beforeReschedule?.();
            const scheduledFor = parseSchedule(req.body?.scheduled_for);
            const publication = store.rescheduleJob(Number(job.id), scheduledFor, { type: 'user', id: String(req.user.userId) });
            const refreshed = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(publication.id);
            res.json({ publication: safePublication(refreshed, mediaForJob(db, refreshed), undefined, isManagingRole(req.user?.role)) });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            if (error instanceof PublicationTransitionError)
                return res.status(409).json({ error_code: 'UNSAFE_TRANSITION', error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to reschedule publication' });
        }
    });
    app.post('/api/publications/:id/cancel', auth, requireUserSession, requireRole('owner', 'admin', 'operator'), (req, res) => {
        try {
            const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
            if (job.final_action_at)
                routeError(409, 'UNSAFE_TRANSITION', 'Publication cannot be cancelled after final action');
            testHooks?.beforeCancel?.();
            const publication = store.requestCancellation(Number(job.id), { type: 'user', id: String(req.user.userId) });
            const refreshed = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(publication.id);
            res.json({ publication: safePublication(refreshed, mediaForJob(db, refreshed), undefined, isManagingRole(req.user?.role)) });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            if (error instanceof PublicationTransitionError)
                return res.status(409).json({ error_code: 'UNSAFE_TRANSITION', error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to cancel publication' });
        }
    });
    app.post('/api/publications/:id/review', auth, requireUserSession, requireRole('owner', 'admin', 'operator'), (req, res) => {
        try {
            const job = workspaceJob(db, Number(req.user.workspaceId), req.params.id);
            if (job.status !== 'review_required')
                routeError(409, 'UNSAFE_TRANSITION', 'Only publications in review_required can be resolved');
            const action = String(req.body?.action || '');
            if (action !== 'confirm' && action !== 'dismiss')
                routeError(400, 'VALIDATION_ERROR', 'action must be confirm or dismiss');
            const note = req.body?.note;
            if (note !== undefined && typeof note !== 'string')
                routeError(400, 'VALIDATION_ERROR', 'note must be a string');
            const publication = store.resolveReview(Number(job.id), action === 'confirm' ? 'completed' : 'failed', { type: 'user', id: String(req.user.userId) }, { note });
            const refreshed = db.prepare('SELECT * FROM publication_jobs WHERE id = ?').get(publication.id);
            res.json({ publication: safePublication(refreshed, mediaForJob(db, refreshed), undefined, isManagingRole(req.user?.role)) });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            if (error instanceof PublicationTransitionError)
                return res.status(409).json({ error_code: 'UNSAFE_TRANSITION', error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to resolve publication review' });
        }
    });
    app.post('/api/publications/:id/test-cleanup-authorizations', auth, requireUserSession, requireRole('owner', 'admin', 'operator'), (req, res) => {
        try {
            if (!cleanupTokenHash || cleanupTokenHash.length !== 32)
                routeError(503, 'CLEANUP_UNAVAILABLE', 'Cleanup worker is not configured');
            const id = parseId(req.params.id, 'publication_id');
            const body = req.body || {};
            const workspaceId = Number(req.user.workspaceId);
            const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
            const serial = typeof body.serial === 'string' ? body.serial.trim() : '';
            const androidId = typeof body.android_id === 'string' ? body.android_id.trim() : '';
            const account = typeof body.account === 'string' ? body.account.trim() : '';
            const identity = typeof body.expected_identity === 'string' ? body.expected_identity.trim() : '';
            const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
            const deviceId = Number(body.device_id);
            const baseline = body.baseline;
            if (!platform || !serial || !androidId || !account || !identity || !workerId || !Number.isInteger(deviceId) || deviceId <= 0 || !Array.isArray(baseline) || !baseline.length || baseline.some((item) => typeof item !== 'string' || !item.trim()) || baseline.includes(identity))
                routeError(400, 'CLEANUP_AUTH_INVALID', 'Cleanup authorization proof is invalid');
            const job = db.prepare(`SELECT job.*, account.username, device.device_id AS android_id FROM publication_jobs job JOIN social_accounts account ON account.id = job.social_account_id JOIN devices device ON device.id = job.device_id WHERE job.id = ? AND job.workspace_id = ? AND job.device_id = ?`).get(id, workspaceId, deviceId);
            if (!job || Number(job.test_mode) !== 1 || job.status !== 'completed' || !job.verified_at || !job.remote_post_identity || job.platform !== platform || job.username !== account || job.android_id !== androidId || job.remote_post_identity !== identity)
                routeError(409, 'CLEANUP_AUTH_INELIGIBLE', 'Job is not an eligible verified test publication');
            const payload = { schema: 1, marker: 'SOUTHFARM_AUTHORIZED_TEST_POST', job_id: id, job_status: 'completed', platform, serial, android_id: androidId, account, expected_identity: identity, baseline, test_mode: true };
            const nonce = randomUUID();
            const now = new Date();
            const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
            db.prepare('INSERT INTO publication_cleanup_authorizations (nonce, job_id, workspace_id, device_id, social_account_id, worker_id, issued_by_user_id, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(nonce, id, workspaceId, deviceId, job.social_account_id, workerId, Number(req.user.userId), JSON.stringify(payload), expiresAt, now.toISOString());
            res.status(201).json({ authorization: `${nonce}.${cleanupMac(nonce)}`, expires_at: expiresAt, cleanup: payload });
        }
        catch (error) {
            if (error instanceof PublicationRouteError)
                return res.status(error.status).json({ error_code: error.errorCode, error: error.message });
            return res.status(500).json({ error_code: 'INTERNAL_ERROR', error: 'Unable to authorize cleanup' });
        }
    });
}
