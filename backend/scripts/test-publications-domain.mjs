import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applyPublicationMigrations } from '../dist/publications-migrations.js';
import {
  PUBLICATION_STATE_TRANSITIONS,
  PublicationStore,
  validatePublicationInput,
} from '../dist/publications-domain.js';

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE workspaces (id INTEGER PRIMARY KEY);
  CREATE TABLE devices (id INTEGER PRIMARY KEY, workspace_id INTEGER, device_id TEXT);
  CREATE TABLE social_accounts (id INTEGER PRIMARY KEY, device_id INTEGER, platform TEXT, username TEXT, display_name TEXT);
  CREATE TABLE task_runs (
    id INTEGER PRIMARY KEY,
    device_id INTEGER,
    status TEXT,
    scheduled_for TEXT,
    expires_at TEXT,
    lease_expires_at TEXT
  );
`);
applyPublicationMigrations(db);

assert.throws(() => validatePublicationInput({ caption: '', platform: 'instagram' }), /1 and 10 words/);
assert.throws(() => validatePublicationInput({ caption: 'one two three four five six seven eight nine ten eleven', platform: 'tiktok' }), /1 and 10 words/);
const longCaption = 'abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij';
assert.throws(() => validatePublicationInput({ caption: longCaption, platform: 'youtube' }), /100 characters/);
assert.doesNotThrow(() => validatePublicationInput({ caption: longCaption, platform: 'instagram' }));
assert.equal(validatePublicationInput({ caption: 'SouthFarm publishes this test video safely today', platform: 'youtube' }).wordCount, 7);

assert.deepEqual(PUBLICATION_STATE_TRANSITIONS, {
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
  completed: [],
  cancelled: [],
  failed: [],
  review_required: ['completed', 'failed'],
});

for (const column of [
  'current_step', 'progress_percent', 'claim_token', 'attempt_count', 'published_at', 'verified_at',
  'remote_post_identity', 'result', 'error_code', 'error_message', 'cancel_requested_at',
  'completed_at', 'priority', 'account_snapshot', 'device_snapshot',
]) {
  assert.ok(db.prepare('PRAGMA table_info(publication_jobs)').all().some((item) => item.name === column), `publication_jobs.${column}`);
}
for (const column of [
  'private_path', 'original_filename', 'mime_type', 'file_extension', 'size_bytes', 'sha256',
  'duration_seconds', 'width', 'height', 'video_codec', 'audio_codec', 'retention_until',
]) {
  assert.ok(db.prepare('PRAGMA table_info(publication_media)').all().some((item) => item.name === column), `publication_media.${column}`);
}

db.prepare('INSERT INTO workspaces (id) VALUES (1)').run();
db.prepare("INSERT INTO devices (id, workspace_id, device_id) VALUES (1, 1, 'southfarm-test-android')").run();
db.prepare("INSERT INTO social_accounts (id, device_id, platform, username, display_name) VALUES (1, 1, 'youtube', 'southfarm', 'SouthFarm')").run();

const store = new PublicationStore(db);
let mediaSequence = 0;
const createJob = (input, actor) => {
  const job = store.createJob(input, actor);
  const mediaId = ++mediaSequence;
  db.prepare(`INSERT INTO publication_media (id, workspace_id, original_filename, private_path, mime_type, file_extension, size_bytes, sha256, duration_seconds, width, height, video_codec, audio_codec, upload_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'video/mp4', 'mp4', 1, ?, 25, 1080, 1920, 'hevc', 'aac', 'stored', ?, ?)`).run(mediaId, input.workspaceId, `clip-${mediaId}.mp4`, `${mediaId}.mp4`, '0'.repeat(64), now, now);
  db.prepare('UPDATE publication_jobs SET media_id = ? WHERE id = ?').run(mediaId, job.id);
  return store.getJob(job.id);
};
const now = '2026-08-13T12:00:00.000Z';
const later = '2026-08-13T12:00:31.000Z';
const future = '2026-08-13T13:00:00.000Z';
const actor = { type: 'user', id: 'owner-1' };
const worker = { id: 'worker-1', deviceId: 1, leaseSeconds: 30, claimToken: '' };
const replacementWorker = { id: 'worker-2', deviceId: 1, leaseSeconds: 30, claimToken: '' };
const jobInput = {
  workspaceId: 1, deviceId: 1, socialAccountId: 1, platform: 'youtube',
  caption: 'SouthFarm publishes this test video safely today', scheduledFor: now,
};
const eventCount = (jobId) => db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(jobId).count;
const assertLockRejectsWithoutMutation = (jobId, action) => {
  const before = store.getJob(jobId);
  const beforeEvents = eventCount(jobId);
  assert.throws(action, /(active publication job|live device automation lock)/);
  const after = store.getJob(jobId);
  assert.deepEqual(
    [after.status, after.current_step, after.progress_percent, after.final_action_at],
    [before.status, before.current_step, before.progress_percent, before.final_action_at],
  );
  assert.equal(eventCount(jobId), beforeEvents);
};

db.prepare("INSERT INTO task_runs (id, device_id, status, scheduled_for, expires_at) VALUES (1, 1, 'pending', ?, ?)").run(future, null);
db.prepare("INSERT INTO task_runs (id, device_id, status, scheduled_for, expires_at) VALUES (2, 1, 'overdue', ?, ?)").run(now, now);
db.prepare("INSERT INTO task_runs (id, device_id, status, lease_expires_at) VALUES (3, 1, 'running', ?)").run(now);
const job = createJob(jobInput, actor);
const firstClaim = store.claimDueJob(worker, now);
assert.equal(firstClaim.job.id, job.id, 'future and expired task runs do not block a claim');
assert.deepEqual(firstClaim.job.media, { id: 1, size_bytes: 1, sha256: '0'.repeat(64), mime_type: 'video/mp4', file_extension: 'mp4', duration_seconds: 25, width: 1080, height: 1920, video_codec: 'hevc', audio_codec: 'aac' });
db.prepare('UPDATE publication_media SET sha256 = ? WHERE id = 1').run('f'.repeat(64));
assert.equal(firstClaim.job.media.sha256, '0'.repeat(64), 'claim returns its media snapshot even if storage changes after its transaction');
worker.claimToken = store.getJob(job.id).claim_token;
assert.equal(store.claimDueJob(worker, now).claimed, false);
assert.throws(() => store.rescheduleJob(job.id, future, actor), /queued/);

const steps = [
  ['preparing', 10], ['transferring', 20], ['selecting_media', 35], ['editing', 50],
  ['captioning', 65], ['ready_to_publish', 80], ['publishing', 90],
];
assert.throws(() => store.checkpoint(job.id, worker, now, { step: 'publishing', progressPercent: 90 }), /finalAction/);
assert.throws(() => store.checkpoint(job.id, worker, now, { step: 'preparing', progressPercent: 10, finalAction: true }), /finalAction/);
for (const [step, progressPercent] of steps) {
  const checkpoint = store.checkpoint(job.id, worker, now, { step, progressPercent, finalAction: step === 'publishing' });
  assert.equal(checkpoint.status, step);
  assert.equal(checkpoint.current_step, step);
  assert.equal(checkpoint.progress_percent, progressPercent);
}
assert.equal(store.getJob(job.id).final_action_at, now);
assert.throws(() => store.requestCancellation(job.id, actor, now), /final action/);
assert.throws(() => store.finish(job.id, worker, 'failed', now, actor), /final action/);
assert.throws(() => store.finish(job.id, worker, 'cancelled', now, actor), /after final action/);
assert.equal(store.checkpoint(job.id, worker, now, { step: 'verifying', progressPercent: 95 }).status, 'verifying');
assert.equal(store.finish(job.id, worker, 'completed', now, actor).status, 'completed');

db.prepare("INSERT INTO task_runs (id, device_id, status, scheduled_for, expires_at) VALUES (4, 1, 'pending', ?, ?)").run(now, future);
const blockedJob = createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).claimed, false, 'a due, unexpired pending task blocks a claim');
db.prepare('DELETE FROM task_runs WHERE id = 4').run();
store.rescheduleJob(blockedJob.id, future, actor);

const lockJob = createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).job.id, lockJob.id);
worker.claimToken = store.getJob(lockJob.id).claim_token;
db.prepare('DELETE FROM device_automation_locks WHERE publication_job_id = ?').run(lockJob.id);
assert.throws(() => store.heartbeat(lockJob.id, worker, now), /lock/);
assertLockRejectsWithoutMutation(lockJob.id, () => store.checkpoint(lockJob.id, worker, now, { step: 'preparing', progressPercent: 10 }));
assertLockRejectsWithoutMutation(lockJob.id, () => store.finish(lockJob.id, worker, 'failed', now, actor));
db.prepare("INSERT INTO device_automation_locks (device_id, publication_job_id, worker_id, expires_at, created_at, updated_at) VALUES (1, ?, 'other-worker', ?, ?, ?)").run(lockJob.id, future, now, now);
assert.throws(() => store.heartbeat(lockJob.id, worker, now), /lock/);
assertLockRejectsWithoutMutation(lockJob.id, () => store.checkpoint(lockJob.id, worker, now, { step: 'preparing', progressPercent: 10 }));
assertLockRejectsWithoutMutation(lockJob.id, () => store.finish(lockJob.id, worker, 'failed', now, actor));
db.prepare("UPDATE device_automation_locks SET worker_id = ?, expires_at = ? WHERE publication_job_id = ?").run(worker.id, now, lockJob.id);
assert.throws(() => store.heartbeat(lockJob.id, worker, now), /lock/);
assertLockRejectsWithoutMutation(lockJob.id, () => store.checkpoint(lockJob.id, worker, now, { step: 'preparing', progressPercent: 10 }));
assertLockRejectsWithoutMutation(lockJob.id, () => store.finish(lockJob.id, worker, 'failed', now, actor));

const replacementJob = createJob(jobInput, actor);
assert.equal(store.claimDueJob(replacementWorker, later).job.id, replacementJob.id);
replacementWorker.claimToken = store.getJob(replacementJob.id).claim_token;
assertLockRejectsWithoutMutation(lockJob.id, () => store.checkpoint(lockJob.id, worker, later, { step: 'preparing', progressPercent: 10 }));
assertLockRejectsWithoutMutation(lockJob.id, () => store.finish(lockJob.id, worker, 'failed', later, actor));
db.prepare('DELETE FROM device_automation_locks WHERE publication_job_id = ?').run(replacementJob.id);

const pausedJob = createJob(jobInput, actor);
db.prepare("INSERT INTO task_runs (id, device_id, status, lease_expires_at) VALUES (5, 1, 'paused', NULL)").run();
assert.equal(store.claimDueJob(worker, later).claimed, false, 'paused task with a live lease blocks a claim');
db.prepare('DELETE FROM task_runs WHERE id = 5').run();

const reviewActor = { type: 'user', id: 'reviewer-1' };
const toReview = (result) => {
  const job = createJob(jobInput, actor);
  db.prepare("UPDATE publication_jobs SET status = 'review_required', current_step = 'review_required', final_action_at = ?, result = ?, error_code = 'VERIFICATION_PENDING', error_message = 'Publication completed but could not be verified', completed_at = ? WHERE id = ?")
    .run(now, result, now, job.id);
  return job;
};
const reviewEvents = (jobId) => db.prepare("SELECT from_status, to_status, actor_type, actor_id, payload FROM publication_events WHERE publication_job_id = ? ORDER BY id").all(jobId);
const releaseDeviceLocks = () => db.prepare('DELETE FROM device_automation_locks').run();
const deleteJob = (jobId) => { db.prepare('DELETE FROM publication_events WHERE publication_job_id = ?').run(jobId); db.prepare('DELETE FROM device_automation_locks WHERE publication_job_id = ?').run(jobId); db.prepare('DELETE FROM publication_jobs WHERE id = ?').run(jobId); };

const confirmJob = toReview(JSON.stringify({ worker_dump: 'screen-capture.txt' }));
assert.equal(store.claimDueJob(worker, now).claimed, false, 'review_required job freezes the account claim gate');
const confirmed = store.resolveReview(confirmJob.id, 'completed', reviewActor, {}, now);
assert.equal(confirmed.status, 'completed');
assert.equal(confirmed.completed_at, now);
assert.equal(confirmed.verified_at, now, 'confirm sets verified_at');
assert.equal(confirmed.error_code, null);
assert.equal(confirmed.error_message, null);
assert.equal(confirmed.result, JSON.stringify({ worker_dump: 'screen-capture.txt' }) + '\n' + JSON.stringify({ action: 'completed', note: '', at: now, actor: { type: 'user', id: 'reviewer-1' } }), 'worker evidence is preserved and manual evidence is appended');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").get(1).count, 0, 'confirm clears the review gate');
const confirmedEvents = reviewEvents(confirmJob.id);
assert.equal(confirmedEvents.at(-1).from_status, 'review_required');
assert.equal(confirmedEvents.at(-1).to_status, 'completed');
assert.equal(confirmedEvents.at(-1).actor_type, 'user');
assert.deepEqual(JSON.parse(confirmedEvents.at(-1).payload), { action: 'completed', note: null, verified_at: now, error_code: null, error_message: null });
const claimedAfterConfirm = store.claimDueJob(worker, now);
assert.equal(claimedAfterConfirm.claimed, true, 'account can receive claims again after confirm');
releaseDeviceLocks();

const dismissJob = toReview('publish-response-evidence');
const dismissed = store.resolveReview(dismissJob.id, 'failed', reviewActor, { note: '  El video nunca apareció  ' }, now);
assert.equal(dismissed.status, 'failed');
assert.equal(dismissed.completed_at, now);
assert.equal(dismissed.error_code, 'REVIEW_DISMISSED');
assert.equal(dismissed.error_message, 'El video nunca apareció');
assert.equal(dismissed.verified_at, null, 'dismiss does not set verified_at');
assert.equal(dismissed.result, 'publish-response-evidence\n' + JSON.stringify({ action: 'failed', note: 'El video nunca apareció', at: now, actor: { type: 'user', id: 'reviewer-1' } }), 'worker evidence is preserved and manual evidence is appended');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE social_account_id = ? AND status = 'review_required'").get(1).count, 0, 'dismiss clears the review gate');
const dismissedEvents = reviewEvents(dismissJob.id);
assert.equal(dismissedEvents.at(-1).to_status, 'failed');
assert.deepEqual(JSON.parse(dismissedEvents.at(-1).payload), { action: 'failed', note: 'El video nunca apareció', verified_at: null, error_code: 'REVIEW_DISMISSED', error_message: 'El video nunca apareció' });
const postDismissJob = createJob(jobInput, actor);
const claimedAfterDismiss = store.claimDueJob(worker, now);
assert.equal(claimedAfterDismiss.claimed, true, 'account can receive claims again after dismiss');
releaseDeviceLocks();

const noNoteJob = toReview(null);
const noNote = store.resolveReview(noNoteJob.id, 'failed', reviewActor, {}, now);
assert.equal(noNote.error_message, 'Descartado por el operador');
assert.equal(noNote.result, JSON.stringify({ action: 'failed', note: '', at: now, actor: { type: 'user', id: 'reviewer-1' } }), 'result starts with manual evidence when the worker left none');
const noNoteEvents = reviewEvents(noNoteJob.id);
assert.deepEqual(JSON.parse(noNoteEvents.at(-1).payload), { action: 'failed', note: null, verified_at: null, error_code: 'REVIEW_DISMISSED', error_message: 'Descartado por el operador' });

const rejectJob = toReview(null);
assert.throws(() => store.resolveReview(rejectJob.id, 'cancelled', reviewActor, {}, now), /must be completed or failed/, 'non-terminal actions are rejected');
assert.equal(store.getJob(rejectJob.id).status, 'review_required', 'invalid action leaves the job untouched');
const frozenProbe = createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).claimed, false, 'rejected resolutions leave the claim gate frozen');
deleteJob(rejectJob.id);
deleteJob(frozenProbe.id);
releaseDeviceLocks();

const wrongStateJob = createJob(jobInput, actor);
assert.throws(() => store.resolveReview(wrongStateJob.id, 'completed', reviewActor, {}, now), /review_required/, 'jobs outside review_required cannot be resolved');
deleteJob(wrongStateJob.id);

const failedAfterReview = toReview(null);
assert.throws(() => store.finish(failedAfterReview.id, worker, 'failed', now, actor), /active publication job/, 'worker cannot finish a review_required job it no longer owns');
assert.throws(() => store.checkpoint(failedAfterReview.id, worker, now, { step: 'preparing', progressPercent: 10 }), /active publication job/, 'worker cannot checkpoint a review_required job');
assert.equal(store.getJob(failedAfterReview.id).status, 'review_required');
assert.throws(() => store.requestCancellation(failedAfterReview.id, actor, now), /final action/, 'cancellation is still blocked after final action');
assert.throws(() => store.checkpoint(confirmJob.id, worker, now, { step: 'publishing', progressPercent: 90, finalAction: true }), /active publication job/, 'resolved jobs cannot be checkpointed');
deleteJob(failedAfterReview.id);

const guardedJob = createJob(jobInput, actor);
const guardClaim = store.claimDueJob(worker, now);
assert.equal(guardClaim.claimed, true);
worker.claimToken = guardClaim.job.claim_token;
for (const [step, progressPercent] of [['preparing', 10], ['transferring', 20], ['selecting_media', 35], ['editing', 50], ['captioning', 65], ['ready_to_publish', 80], ['publishing', 90]]) store.checkpoint(guardClaim.job.id, worker, now, { step, progressPercent, finalAction: step === 'publishing' });
assert.equal(store.getJob(guardClaim.job.id).final_action_at, now);
assert.throws(() => store.resolveReview(guardClaim.job.id, 'failed', reviewActor, {}, now), /review_required/, 'post-final-action jobs not in review_required cannot resolve to failed');
assert.throws(() => store.finish(guardClaim.job.id, worker, 'failed', now, actor), /after final action/, 'post-final-action transition to failed stays prohibited');
assert.equal(store.getJob(guardClaim.job.id).status, 'publishing');
releaseDeviceLocks();

console.log('publications-domain test passed: full state machine, task leases, locks, and final-action safety');
console.log('publications-domain review resolution test passed: confirm, dismiss, claim gate, and guard integrity');
