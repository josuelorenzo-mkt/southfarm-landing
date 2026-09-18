// Bridge between the activity planner and the publications queue. The
// planner's cluster publish (POST /api/clusters/:id/publish) used to create
// publish_reel task_runs nobody executed; the single-queue decision (owner,
// 2026-08-21) routes those publications into publication_jobs so the PC
// publisher workers claim and execute them like every other publication.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { inspectPublicationVideo } from './publication-media-inspector.js';
import { PLATFORM_MEDIA_RULES, mediaSupportedForPlatform } from './publications-routes.js';
import { validatePublicationInput } from './publications-domain.js';

export const PLANNER_VIDEO_MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export interface PlannerPublicationAccountInput {
  account: {
    id: number;
    username: string;
    display_name?: string | null;
    platform: string;
    device_id: number;
  };
  device: { id: number; device_id: string } | null;
}

export interface PlannerPublicationResult {
  publicationIds: number[];
  skipped: Array<{ account: string; reason: string }>;
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export async function createPlannerPublicationJobs(opts: {
  db: SqliteDatabase;
  mediaRoot: string;
  workspaceId: number;
  userId: number;
  videoPath: string;
  originalFilename: string;
  mimeType: string;
  title: string;
  scheduledFor: string;
  clusterId: number;
  clusterName: string;
  clusterAssetId: string;
  accounts: PlannerPublicationAccountInput[];
}): Promise<PlannerPublicationResult> {
  const { db, mediaRoot, workspaceId, userId, videoPath, originalFilename, mimeType, title, scheduledFor, clusterId, clusterName, clusterAssetId, accounts } = opts;
  const extension = PLANNER_VIDEO_MIME_EXTENSIONS[mimeType] ?? path.extname(originalFilename || '').replace('.', '').toLowerCase();
  const result: PlannerPublicationResult = { publicationIds: [], skipped: [] };
  if (!extension || !PLANNER_VIDEO_MIME_EXTENSIONS[mimeType]) {
    // Unsupported mime: every account is skipped for the same reason.
    for (const entry of accounts) result.skipped.push({ account: entry.account.username, reason: `Unsupported video mime ${mimeType || '(none)'} — use mp4, mov or webm` });
    return result;
  }

  const sha256 = hashFile(videoPath);
  let metadata;
  try {
    metadata = await inspectPublicationVideo(videoPath, process.env.SOUTHFARM_FFPROBE || 'ffprobe');
  } catch {
    for (const entry of accounts) result.skipped.push({ account: entry.account.username, reason: 'Video metadata could not be inspected (invalid or truncated file)' });
    return result;
  }

  fs.mkdirSync(mediaRoot, { recursive: true });
  const sizeBytes = fs.statSync(videoPath).size;
  const createdAtIso = new Date().toISOString();

  for (const entry of accounts) {
    const { account, device } = entry;
    let mediaId = 0;
    let mediaFile = '';
    try {
      const input = validatePublicationInput({ platform: account.platform, caption: title });
      const platformCheck = mediaSupportedForPlatform(input.platform, metadata);
      if (!platformCheck.supported) {
        const rules = PLATFORM_MEDIA_RULES[input.platform];
        result.skipped.push({ account: account.username, reason: `Video ${metadata.video_codec} ${metadata.width}x${metadata.height} not supported for ${input.platform} (max ${rules.maxWidth}x${rules.maxHeight}, ${rules.allowedVideoCodecs.join('/')})` });
        continue;
      }

      const transaction = db.transaction(() => {
        const mediaInsert = db.prepare(`INSERT INTO publication_media
          (workspace_id, created_by_user_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, duration_seconds, width, height, video_codec, audio_codec, upload_status, created_at, updated_at)
          VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?)`)
          .run(workspaceId, userId, originalFilename || 'cluster-video', mimeType, extension, sizeBytes, sha256, metadata.duration_seconds, metadata.width, metadata.height, metadata.video_codec, metadata.audio_codec, createdAtIso, createdAtIso);
        mediaId = Number(mediaInsert.lastInsertRowid);
        mediaFile = `${mediaId}.${extension}`;
        db.prepare('UPDATE publication_media SET private_path = ?, updated_at = ? WHERE id = ? AND upload_status = ?').run(mediaFile, createdAtIso, mediaId, 'staging');
      });
      transaction();
      fs.copyFileSync(videoPath, path.join(mediaRoot, mediaFile));

      const jobInsert = db.transaction(() => {
        db.prepare("UPDATE publication_media SET upload_status = 'stored', updated_at = ? WHERE id = ? AND upload_status = 'staging'").run(createdAtIso, mediaId);
        const insert = db.prepare(`INSERT INTO publication_jobs
          (workspace_id, created_by_user_id, device_id, social_account_id, media_id, platform, caption, word_count, scheduled_for,
           status, current_step, cluster_id, cluster_name, cluster_asset_id, created_by_type, created_by_id,
           account_snapshot, device_snapshot, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, 'planner', ?, ?, ?, ?, ?)`)
          .run(workspaceId, userId, account.device_id, account.id, mediaId, input.platform, input.caption, input.wordCount, scheduledFor,
            clusterId, clusterName, clusterAssetId, String(userId),
            JSON.stringify({ id: Number(account.id), username: String(account.username), display_name: String(account.display_name || account.username), platform: String(account.platform) }),
            JSON.stringify(device ? { id: Number(device.id), device_id: String(device.device_id) } : { id: Number(account.device_id), device_id: '' }),
            createdAtIso, createdAtIso);
        const jobId = Number(insert.lastInsertRowid);
        db.prepare(`INSERT INTO publication_events (publication_job_id, from_status, to_status, current_step, actor_type, actor_id, created_at)
          VALUES (?, NULL, 'queued', 'queued', 'planner', ?, ?)`).run(jobId, String(userId), createdAtIso);
        return jobId;
      });
      result.publicationIds.push(jobInsert());
      mediaId = 0; // committed; nothing to compensate from here on
    } catch (error: any) {
      // Compensate a half-ingested media row/file so the media store never
      // leaks orphans from a failed account.
      if (mediaId) {
        try { db.prepare('DELETE FROM publication_media WHERE id = ? AND upload_status = ?').run(mediaId, 'staging'); } catch { /* best effort */ }
        if (mediaFile) { try { fs.rmSync(path.join(mediaRoot, mediaFile), { force: true }); } catch { /* best effort */ } }
      }
      result.skipped.push({ account: account.username, reason: error?.message || 'publication job could not be created' });
    }
  }
  return result;
}
