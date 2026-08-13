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
  CREATE TABLE devices (id INTEGER PRIMARY KEY, workspace_id INTEGER);
  CREATE TABLE social_accounts (id INTEGER PRIMARY KEY, device_id INTEGER, platform TEXT, username TEXT);
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
  review_required: [],
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
db.prepare('INSERT INTO devices (id, workspace_id) VALUES (1, 1)').run();
db.prepare("INSERT INTO social_accounts (id, device_id, platform, username) VALUES (1, 1, 'youtube', 'southfarm')").run();

const store = new PublicationStore(db);
const now = '2026-08-13T12:00:00.000Z';
const later = '2026-08-13T12:00:31.000Z';
const future = '2026-08-13T13:00:00.000Z';
const actor = { type: 'user', id: 'owner-1' };
const worker = { id: 'worker-1', deviceId: 1, leaseSeconds: 30 };
const replacementWorker = { id: 'worker-2', deviceId: 1, leaseSeconds: 30 };
const jobInput = {
  workspaceId: 1, deviceId: 1, socialAccountId: 1, platform: 'youtube',
  caption: 'SouthFarm publishes this test video safely today', scheduledFor: now,
};
const eventCount = (jobId) => db.prepare('SELECT COUNT(*) AS count FROM publication_events WHERE publication_job_id = ?').get(jobId).count;
const assertLockRejectsWithoutMutation = (jobId, action) => {
  const before = store.getJob(jobId);
  const beforeEvents = eventCount(jobId);
  assert.throws(action, /live device automation lock/);
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
const job = store.createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).job.id, job.id, 'future and expired task runs do not block a claim');
assert.equal(store.claimDueJob(worker, now).claimed, false);
assert.throws(() => store.rescheduleJob(job.id, future, actor), /queued/);

const steps = [
  ['preparing', 10], ['transferring', 20], ['selecting_media', 35], ['editing', 50],
  ['captioning', 65], ['ready_to_publish', 80], ['publishing', 90],
];
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
const blockedJob = store.createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).claimed, false, 'a due, unexpired pending task blocks a claim');
db.prepare('DELETE FROM task_runs WHERE id = 4').run();
store.rescheduleJob(blockedJob.id, future, actor);

const lockJob = store.createJob(jobInput, actor);
assert.equal(store.claimDueJob(worker, now).job.id, lockJob.id);
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

const replacementJob = store.createJob(jobInput, actor);
assert.equal(store.claimDueJob(replacementWorker, later).job.id, replacementJob.id);
assertLockRejectsWithoutMutation(lockJob.id, () => store.checkpoint(lockJob.id, worker, later, { step: 'preparing', progressPercent: 10 }));
assertLockRejectsWithoutMutation(lockJob.id, () => store.finish(lockJob.id, worker, 'failed', later, actor));
db.prepare('DELETE FROM device_automation_locks WHERE publication_job_id = ?').run(replacementJob.id);

const pausedJob = store.createJob(jobInput, actor);
db.prepare("INSERT INTO task_runs (id, device_id, status, lease_expires_at) VALUES (5, 1, 'paused', NULL)").run();
assert.equal(store.claimDueJob(worker, later).claimed, false, 'paused task with a live lease blocks a claim');

console.log('publications-domain test passed: full state machine, task leases, locks, and final-action safety');
