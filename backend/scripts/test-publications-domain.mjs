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
  CREATE TABLE task_runs (id INTEGER PRIMARY KEY, device_id INTEGER, status TEXT);
`);
applyPublicationMigrations(db);

assert.throws(() => validatePublicationInput({ caption: '', platform: 'instagram' }), /1 and 10 words/);
assert.throws(() => validatePublicationInput({ caption: 'one two three four five six seven eight nine ten eleven', platform: 'tiktok' }), /1 and 10 words/);
assert.throws(() => validatePublicationInput({ caption: 'abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij', platform: 'youtube' }), /100 characters/);
assert.equal(validatePublicationInput({ caption: 'SouthFarm publishes this test video safely today', platform: 'youtube' }).wordCount, 7);

assert.deepEqual(PUBLICATION_STATE_TRANSITIONS, {
  queued: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'cancellation_requested', 'failed', 'review_required'],
  in_progress: ['completed', 'cancellation_requested', 'failed', 'review_required'],
  cancellation_requested: ['cancelled'],
  completed: [],
  cancelled: [],
  failed: [],
  review_required: [],
});

db.prepare('INSERT INTO workspaces (id) VALUES (1)').run();
db.prepare('INSERT INTO devices (id, workspace_id) VALUES (1, 1)').run();
db.prepare("INSERT INTO social_accounts (id, device_id, platform, username) VALUES (1, 1, 'youtube', 'southfarm')").run();

const store = new PublicationStore(db);
const now = '2026-08-13T12:00:00.000Z';
const future = '2026-08-13T13:00:00.000Z';
const actor = { type: 'user', id: 'owner-1' };
const worker = { id: 'worker-1', deviceId: 1, leaseSeconds: 30 };
const job = store.createJob({
  workspaceId: 1,
  deviceId: 1,
  socialAccountId: 1,
  platform: 'youtube',
  caption: 'SouthFarm publishes this test video safely today',
  scheduledFor: now,
}, actor);

assert.equal(store.claimDueJob(worker, now).job.id, job.id);
assert.equal(store.claimDueJob(worker, now).claimed, false);
assert.throws(() => store.rescheduleJob(job.id, future, actor), /queued/);

const checkpointed = store.checkpoint(job.id, worker, now, { finalAction: true });
assert.equal(checkpointed.status, 'in_progress');
assert.equal(checkpointed.final_action_at, now);
assert.throws(() => store.finish(job.id, worker, 'failed', now, actor), /final action/);
assert.equal(store.finish(job.id, worker, 'completed', now, actor).status, 'completed');

const expiredJob = store.createJob({
  workspaceId: 1,
  deviceId: 1,
  socialAccountId: 1,
  platform: 'youtube',
  caption: 'SouthFarm publishes another safe test video today',
  scheduledFor: now,
}, actor);
assert.equal(store.claimDueJob(worker, now).job.id, expiredJob.id);
store.checkpoint(expiredJob.id, worker, now, { finalAction: true });
assert.equal(store.claimDueJob(worker, '2026-08-13T12:01:00.000Z').claimed, false);
assert.notEqual(store.getJob(expiredJob.id).status, 'queued');

console.log('publications-domain test passed: validation, transitions, leases, and final-action safety');
