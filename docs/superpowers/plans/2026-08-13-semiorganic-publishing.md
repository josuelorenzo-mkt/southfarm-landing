# Semiorganic Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver and deploy a SouthFarm `Crear publicación` workflow that queues immediate or scheduled Instagram Reel, TikTok, and YouTube Short jobs and executes them through an isolated Windows ADB worker with observable verification.

**Architecture:** The existing Express/SQLite API owns authorization, private media, durable jobs, leases, locks, and audit events. A separate Python worker running under an ADB-authorized Windows account claims due jobs and drives platform-specific UIAutomator state machines. The Next.js Command Center adds a dedicated composer and publication queue without changing the installed Android APK.

**Tech Stack:** TypeScript, Express 4, better-sqlite3, Multer, Node test scripts, Python 3 standard library, Android Platform Tools/UIAutomator, Next.js 16.2.6, React 19, Vitest, Windows Scheduled Tasks, Vercel.

## Global Constraints

- Source of truth is `C:\SouthFarm\source`; preserve every pre-existing dirty or untracked change.
- Production backend is published to `%LOCALAPPDATA%\SouthFarm\runtime\backend`; active DB is `%LOCALAPPDATA%\SouthFarm\data\southfarm.db`.
- Do not enable the automatic warmup planner and do not modify or reinstall the Android APK.
- Support only Instagram Reels, TikTok, and YouTube Shorts in this MVP.
- Captions contain 1-10 whitespace-delimited words; YouTube captions are also at most 100 characters.
- Upload limit is exactly 200 MiB; media is private and never stored in the repo, OneDrive, Vercel, or a public web directory.
- Worker ADB identity maps `devices.device_id` to `settings get secure android_id`; serial/position alone is never identity.
- At most one automation owns a device; publications must not overlap warmups or scans.
- After the final Share/Post/Upload Short action, never retry automatically; ambiguous outcomes become `review_required`.
- Do not store or log social passwords, PINs, 2FA codes, cookies, user JWTs, or device tokens.
- Real test posts must be verified and deleted, at most two simultaneously per account; never use Santiago's Instagram account.
- A successful ADB command or accepted gesture is not proof of publication.
- All new subagents use `gpt-5.6-terra` with reasoning effort `medium` at most.

---

## File Structure

Backend domain files are kept outside the existing large `index.ts`:

- `backend/src/publications-migrations.ts`: additive SQLite schema and indexes.
- `backend/src/publications-domain.ts`: validation, state machine, data views, claims, locks, and events.
- `backend/src/publications-routes.ts`: operator multipart/list/detail/schedule/cancel endpoints.
- `backend/src/publication-worker-routes.ts`: service-token claim/heartbeat/checkpoint/finish/media endpoints.
- `backend/scripts/test-publications-domain.mjs`: compiled-module tests with a temporary SQLite DB.
- `backend/scripts/test-publications-api.mjs`: black-box API tests against an isolated child process and temporary media root.

Worker files are a standalone Python package:

- `publisher_worker/southfarm_publisher/adb_device.py`: safe subprocess/UIAutomator device wrapper.
- `publisher_worker/southfarm_publisher/api_client.py`: worker HTTP contract.
- `publisher_worker/southfarm_publisher/models.py`: job/state types and errors.
- `publisher_worker/southfarm_publisher/runner.py`: claim loop, heartbeat, cancellation, dispatch, cleanup.
- `publisher_worker/southfarm_publisher/platforms/{instagram,tiktok,youtube}.py`: platform adapters.
- `publisher_worker/tests/fixtures/*.xml`: sanitized UI fixtures.
- `publisher_worker/tests/test_*.py`: deterministic unit/contract tests.

Web files stay focused:

- `webapp/src/app/publication-types.ts`: API/view types.
- `webapp/src/app/publication-validation.ts`: pure caption/schedule/file validation.
- `webapp/src/app/publication-panel.tsx`: composer, queue, details, actions.
- `webapp/src/app/publication-validation.test.ts`: Vitest unit tests.
- `webapp/src/app/page.tsx`: navigation and page integration only.
- `webapp/src/app/globals.css`: styles matching the existing Command Center.

---

### Task 1: Publication schema and domain state machine

**Files:**
- Create: `backend/src/publications-migrations.ts`
- Create: `backend/src/publications-domain.ts`
- Create: `backend/scripts/test-publications-domain.mjs`
- Modify: `backend/src/index.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `applyPublicationMigrations(db: Database.Database): void`.
- Produces: `PublicationStore` with `createJob`, `listJobs`, `getJob`, `rescheduleJob`, `requestCancellation`, `claimDueJob`, `heartbeat`, `checkpoint`, and `finish`.
- Produces: `validatePublicationInput(input): ValidatedPublicationInput` and `publicationJobView(row, db): PublicationJobView`.
- Consumes: existing `devices`, `social_accounts`, `task_runs`, workspace IDs, ISO timestamps, and SQLite WAL.

- [ ] **Step 1: Write the failing domain tests**

Create a compiled-module test script that creates a temporary DB, applies minimal prerequisite tables plus `applyPublicationMigrations`, and asserts:

```js
assert.throws(() => validatePublicationInput({ caption: "", platform: "instagram" }), /1 and 10 words/);
assert.throws(() => validatePublicationInput({ caption: "one two three four five six seven eight nine ten eleven", platform: "tiktok" }), /1 and 10 words/);
assert.throws(() => validatePublicationInput({ caption: "abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij", platform: "youtube" }), /100 characters/);
assert.equal(validatePublicationInput({ caption: "SouthFarm publishes this test video safely today", platform: "youtube" }).wordCount, 8);
assert.equal(store.claimDueJob(worker, now).job.id, job.id);
assert.equal(store.claimDueJob(worker, now).claimed, false);
assert.throws(() => store.rescheduleJob(job.id, future, actor), /queued/);
```

Also assert the exact state transition graph and that a job with `final_action_at` cannot return to `queued` or be automatically reclaimed after an expired lease.

- [ ] **Step 2: Run tests to verify the missing modules fail**

Run: `npm run build && node scripts/test-publications-domain.mjs`

Expected: FAIL because `dist/publications-domain.js` and migrations do not exist.

- [ ] **Step 3: Implement additive schema**

Create tables `publication_media`, `publication_jobs`, `publication_events`, and `device_automation_locks`. Use `CREATE TABLE IF NOT EXISTS`, additive column checks where needed, foreign keys to existing workspace/device/account rows, and indexes for `(status, scheduled_for)`, `(device_id, status)`, `(social_account_id, status)`, events by job/time, and lock expiry.

Use these exact terminal states:

```ts
export const PUBLICATION_TERMINAL_STATES = new Set([
  'completed', 'cancelled', 'failed', 'review_required',
]);
```

- [ ] **Step 4: Implement validation and `PublicationStore`**

Use `BEGIN IMMEDIATE` transactions for claim/lock mutations. Claim only `queued` jobs with `scheduled_for <= now`, no unresolved `review_required` job for the account, no live task run for the device, and no unexpired automation lock. Insert an append-only event for every state mutation.

Record `final_action_at` through `checkpoint`; `finish` rejects `failed` after that timestamp unless the target state is `completed` or `review_required`.

- [ ] **Step 5: Register migrations at backend startup**

Import and invoke `applyPublicationMigrations(db)` after existing auth/scheduler migrations. Add `test:publications:domain` to `package.json`.

- [ ] **Step 6: Run domain tests and backend build**

Run: `npm run build && npm run test:publications:domain`

Expected: build succeeds and all domain assertions pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/src/publications-migrations.ts backend/src/publications-domain.ts backend/src/index.ts backend/scripts/test-publications-domain.mjs backend/package.json
git commit -m "feat(backend): add publication job domain"
```

### Task 2: Operator upload and publication APIs

**Files:**
- Create: `backend/src/publications-routes.ts`
- Create: `backend/scripts/test-publications-api.mjs`
- Modify: `backend/src/index.ts`
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json`

**Interfaces:**
- Consumes: `PublicationStore`, existing `auth`, `requireRole`, `req.user.workspaceId`, devices, and social accounts.
- Produces: `registerPublicationRoutes({ app, db, store, auth, requireRole, mediaRoot }): void`.
- Produces: `POST/GET /api/publications`, `GET /api/publications/:id`, `PATCH /api/publications/:id/schedule`, and `POST /api/publications/:id/cancel`.

- [ ] **Step 1: Add failing black-box API tests**

The test launches the compiled API with a temporary DB/media root and asserts:

```js
const body = new FormData();
const mp4Header = Buffer.from('000000186674797069736f6d0000020069736f6d6d703431', 'hex');
body.set('video', new Blob([mp4Header], { type: 'video/mp4' }), 'clip.mp4');
body.set('platform', 'youtube');
body.set('device_id', String(deviceId));
body.set('social_account_id', String(accountId));
body.set('caption', 'A safe SouthFarm publishing test starts right now');
body.set('scheduled_for', futureIso);
```

Expected assertions: 201 for a valid workspace-owned combination; 400 for >10 words, YouTube >100 chars, invalid schedule, missing video, unsupported MIME, and >200 MiB declared/streamed input; 404 for a foreign device/account; 403 for viewer creation; uploaded bytes live under the temporary private root and not `public`; list/detail never expose absolute paths.

- [ ] **Step 2: Run the API test and verify route failure**

Run: `npm run build && node scripts/test-publications-api.mjs`

Expected: FAIL with 404 for `/api/publications`.

- [ ] **Step 3: Add Multer with constrained disk storage**

Install `multer` and `@types/multer`. Use `limits.fileSize = 200 * 1024 * 1024`, a single `video` field, an allowlist containing `video/mp4`, `video/quicktime`, and `video/webm`, plus file-signature checks for ISO-BMFF/QuickTime `ftyp` or WebM EBML bytes. Use randomized temporary names, SHA-256 during finalize, and atomic rename to `<media-id>.<safe-extension>` under `SOUTHFARM_PUBLICATION_MEDIA_ROOT` or `C:\ProgramData\SouthFarm\publish-media`.

Remove any temporary file on validation, DB, or request failure.

- [ ] **Step 4: Implement operator routes**

Validate workspace, account-device-platform relationship, role, caption, schedule, file and unresolved review gate. Respond with JSON views containing relative media identity and metadata but never filesystem paths or worker credentials.

Cancel is allowed through `ready_to_publish`; after `final_action_at`, return 409 and leave the job for verification/review. Reschedule only `queued` jobs.

- [ ] **Step 5: Register routes and error mapping**

Pass existing middleware functions into `registerPublicationRoutes`. Map Multer limit failures to `413 { error_code: 'VIDEO_TOO_LARGE' }`, validation to 400, unsafe transitions to 409, and unexpected failures to 500 without path leakage.

- [ ] **Step 6: Run API/domain/auth tests and build**

Run: `npm run build && npm run test:publications:domain && node scripts/test-publications-api.mjs && npm run test:auth`

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/src/publications-routes.ts backend/src/index.ts backend/scripts/test-publications-api.mjs backend/package.json backend/package-lock.json
git commit -m "feat(backend): add publication upload APIs"
```

### Task 3: Worker service API and shared device locking

**Files:**
- Create: `backend/src/publication-worker-routes.ts`
- Create: `backend/scripts/test-publication-worker-api.mjs`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/publications-domain.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `registerPublicationWorkerRoutes({ app, store, mediaRoot, workerTokenHash }): void`.
- Consumes: `Authorization: Bearer <service token>`, exact job claim token, worker ID, and existing task-run claim transaction.
- Produces: worker claim, heartbeat, checkpoint, finish, media download, and device availability endpoint data.

- [ ] **Step 1: Write failing worker-contract tests**

Assert: missing/wrong service token returns 401; claim is atomic under two concurrent requests; a claimed publication blocks `/api/tasks/claim` for that device; a running leased `task_run` blocks publication claim; heartbeat extends both job lease and device lock; wrong claim token returns 409; cancellation is returned by heartbeat; media download supports authenticated streaming and rejects foreign media IDs; finish releases the lock.

- [ ] **Step 2: Run the worker tests and verify failure**

Run: `npm run build && node scripts/test-publication-worker-api.mjs`

Expected: FAIL because worker endpoints are absent.

- [ ] **Step 3: Implement constant-time service authentication**

Hash `SOUTHFARM_PUBLISHER_WORKER_TOKEN` with SHA-256 at startup, reject startup of worker routes when missing outside tests, and compare request hashes with `timingSafeEqual`. Never print the token or authorization header.

- [ ] **Step 4: Implement worker endpoints**

Use a 45-second renewable lease. Check `worker_id`, `claim_token`, state transitions, and lock ownership on every mutation. Stream media with `Content-Type`, `Content-Length`, and `Content-Disposition: attachment`; prevent path traversal by resolving only stored media IDs.

- [ ] **Step 5: Integrate the publication lock with mobile task claim**

Before selecting/claiming a `task_run`, reject with `{ claimed: false, reason: 'device_busy_publication' }` when an unexpired publication lock exists. Publication claim must query active task rows whose status is `running` or `paused` and whose lease is still valid. Do not cancel or preempt an existing task.

- [ ] **Step 6: Run all backend tests**

Run: `npm run build && npm run test:publications:domain && node scripts/test-publications-api.mjs && node scripts/test-publication-worker-api.mjs && npm run test:auth`

Expected: all pass.

- [ ] **Step 7: Commit**

```powershell
git add backend/src/publication-worker-routes.ts backend/src/publications-domain.ts backend/src/index.ts backend/scripts/test-publication-worker-api.mjs backend/package.json
git commit -m "feat(backend): add publisher worker contract"
```

### Task 4: Publisher worker core and API client

**Files:**
- Create: `publisher_worker/pyproject.toml`
- Create: `publisher_worker/southfarm_publisher/__init__.py`
- Create: `publisher_worker/southfarm_publisher/models.py`
- Create: `publisher_worker/southfarm_publisher/api_client.py`
- Create: `publisher_worker/southfarm_publisher/adb_device.py`
- Create: `publisher_worker/southfarm_publisher/runner.py`
- Create: `publisher_worker/tests/test_api_client.py`
- Create: `publisher_worker/tests/test_adb_device.py`
- Create: `publisher_worker/tests/test_runner.py`

**Interfaces:**
- Consumes: worker HTTP endpoints from Task 3 and `SOUTHFARM_ADB`, `SOUTHFARM_API_URL`, `SOUTHFARM_PUBLISHER_WORKER_TOKEN`, `SOUTHFARM_PUBLISHER_WORKER_ID`.
- Produces: `PublisherApiClient`, `AdbDeviceRegistry`, `PublicationRunner`, and `python -m southfarm_publisher.runner`.
- Produces adapter protocol `prepare(job, device)`, `publish(job, device, checkpoint)`, `verify(job, device)`, `cleanup(job, device)`.

- [ ] **Step 1: Write failing worker core tests**

Use `unittest` and fake HTTP/ADB subprocesses. Assert device enumeration parses only `device` state, mapping calls `adb -s <serial> shell settings get secure android_id`, duplicate USB/Wi-Fi endpoints for one Android ID resolve deterministically, unauthorized/offline devices are excluded, heartbeat cancellation raises `JobCancelled`, and a post-final exception finishes as `review_required` rather than retrying.

- [ ] **Step 2: Run tests and verify imports fail**

Run: `python -m unittest discover -s publisher_worker/tests -v`

Expected: FAIL because `southfarm_publisher` modules do not exist.

- [ ] **Step 3: Implement job models and API client**

Define enums matching backend states, dataclasses for device/job/claim, structured `PublisherError(code, message, retryable, final_action_uncertain)`, JSON request helpers, streamed media download with SHA-256 verification, heartbeat and checkpoint methods. Authorization values must never appear in exception text.

- [ ] **Step 4: Port the safe ADB device engine**

Adapt only required behavior from legacy `engine/device.py`, `human.py`, and `video_publish.py`: command execution without `shell=True`, UI dump parsing, semantic finders, randomized bounded taps, slow text entry, screenshot, push, MediaStore scan, foreground package and Android ID. Default ADB is `C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe`.

- [ ] **Step 5: Implement the runner loop**

Claim one job, map device, download/verify media, launch a heartbeat thread, dispatch adapter, checkpoint every state, clean local/remote temporary media, and back off 2-30 seconds with jitter when idle/error. Never run two jobs for the same device in one process.

- [ ] **Step 6: Run worker tests**

Run: `python -m unittest discover -s publisher_worker/tests -v`

Expected: all pass without a connected phone.

- [ ] **Step 7: Commit**

```powershell
git add publisher_worker
git commit -m "feat(worker): add ADB publisher runtime"
```

### Task 5: Instagram, TikTok, and YouTube adapters

**Files:**
- Create: `publisher_worker/southfarm_publisher/platforms/__init__.py`
- Create: `publisher_worker/southfarm_publisher/platforms/common.py`
- Create: `publisher_worker/southfarm_publisher/platforms/instagram.py`
- Create: `publisher_worker/southfarm_publisher/platforms/tiktok.py`
- Create: `publisher_worker/southfarm_publisher/platforms/youtube.py`
- Create: `publisher_worker/tests/test_platform_adapters.py`
- Create: `publisher_worker/tests/fixtures/instagram_*.xml`
- Create: `publisher_worker/tests/fixtures/tiktok_*.xml`
- Create: `publisher_worker/tests/fixtures/youtube_*.xml`
- Modify: `publisher_worker/southfarm_publisher/runner.py`

**Interfaces:**
- Consumes: adapter protocol and ADB wrapper from Task 4.
- Produces: `InstagramPublisher`, `TikTokPublisher`, `YouTubeShortPublisher`, selected by exact platform ID.
- Consumes proven semantics from the four guides and legacy TikTok/YouTube scripts; all captions use the new 1-10 word contract.

- [ ] **Step 1: Add sanitized fixtures and failing selector/state tests**

Fixtures must cover every required screen and selector, plus collision cases: Instagram Next versus Share, TikTok Create versus Create a Story, YouTube Short versus Shorts, duplicate gallery items, missing account label, wrong account, keyboard-open details, disabled final button, and verification item matching.

Assert every adapter refuses a wrong package/account and refuses to click a final button when its contextual guard is missing.

- [ ] **Step 2: Run adapter tests and verify failure**

Run: `python -m unittest publisher_worker.tests.test_platform_adapters -v`

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement common guarded actions**

Add fresh-dump waits, exact semantic match, bounds validation, contextual final-button guards, caption word validation, evidence callbacks, and `mark_final_action()` that checkpoints before the final gesture.

- [ ] **Step 4: Port TikTok and YouTube flows**

Port the already validated navigation/verification logic without delete behavior in normal jobs. Replace hard-coded `MP-V-4.mp4`, captions, paths, and cycle numbers with job values and unique remote filenames. TikTok must baseline the profile; YouTube must select an exact generated remote display name and enforce 100 characters.

- [ ] **Step 5: Implement guarded Instagram Reel flow**

Implement Profile/account verification, Create New/Reel, gallery video, editor Next, recognized privacy Continue, caption, New reel Next, `About Reels` context, final Share, and profile verification. Coordinate fallback taps only after package, resolution, and expected semantic context match.

- [ ] **Step 6: Add explicit test-cleanup helpers**

Expose deletion only through `cleanup_test_post(expected_identity, baseline)`. It must locate the newly verified item, preserve the baseline, require a confirmation dialog, and prove restoration. Normal publication jobs never delete posts.

- [ ] **Step 7: Run the complete worker suite**

Run: `python -m unittest discover -s publisher_worker/tests -v`

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add publisher_worker/southfarm_publisher/platforms publisher_worker/southfarm_publisher/runner.py publisher_worker/tests
git commit -m "feat(worker): automate social video publishing"
```

### Task 6: Windows worker installation, supervision, and retention

**Files:**
- Create: `ops/windows/southfarm-publisher-supervisor.ps1`
- Create: `ops/windows/install-southfarm-publisher-worker.ps1`
- Create: `ops/windows/test-southfarm-publisher-worker.ps1`
- Modify: `ops/windows/install-southfarm-windows-runtime.ps1`
- Modify: `ops/windows/run-southfarm-maintenance.ps1`
- Modify: `ops/windows/README.md`

**Interfaces:**
- Consumes: worker module from Task 4/5 and protected backend config conventions.
- Produces: single-instance Scheduled Task `SouthFarm Publisher Worker`, config `%PROGRAMDATA%\SouthFarm\config\publisher-worker.json`, logs `%PROGRAMDATA%\SouthFarm\logs`, media/evidence retention.

- [ ] **Step 1: Write a failing PowerShell verification script**

The script checks: configured Python and ADB paths exist; worker config ACL excludes ordinary users; task principal is not SYSTEM and matches the requested interactive account; task is single-instance/restart-on-failure; dry health probe authenticates locally; no secret value is printed.

Run: `powershell -ExecutionPolicy Bypass -File .\ops\windows\test-southfarm-publisher-worker.ps1`

Expected: FAIL because the task/config are absent.

- [ ] **Step 2: Implement supervisor and installer**

Installer accepts `-RunAsUser`, generates a 32-byte worker token when absent, writes matching protected backend/worker config, validates that ADB is authorized under that account, registers a logon/start task with `MultipleInstances IgnoreNew`, restart/backoff, and never logs the token.

- [ ] **Step 3: Extend runtime publishing/config**

Make backend runtime receive `SOUTHFARM_PUBLICATION_MEDIA_ROOT` and the worker-token hash through the protected config. Do not change `SOUTHFARM_AUTO_PLANNER_ENABLED=false` or `manual_only` behavior.

- [ ] **Step 4: Add retention**

Preview and apply deletion for completed/failed job media older than 30 days and evidence older than 30 days; retain job/event DB metadata for six months. Never delete queued, running, verifying, or review-required media.

- [ ] **Step 5: Run non-destructive ops verification**

Run installer with its documented `-WhatIf`/validation mode, then run the test script against a temporary config/task name. Expected: checks pass without replacing production.

- [ ] **Step 6: Commit**

```powershell
git add ops/windows backend
git commit -m "feat(ops): supervise publisher worker on Windows"
```

### Task 7: Command Center `Crear publicación` UX/UI

**Working directory:** `C:\SouthFarm\source\webapp` (nested Git repository)

**Files:**
- Create: `webapp/src/app/publication-types.ts`
- Create: `webapp/src/app/publication-validation.ts`
- Create: `webapp/src/app/publication-validation.test.ts`
- Create: `webapp/src/app/publication-panel.tsx`
- Modify: `webapp/src/app/page.tsx`
- Modify: `webapp/src/app/globals.css`
- Modify: `webapp/package.json`
- Modify: `webapp/package-lock.json`

**Interfaces:**
- Consumes: operator endpoints from Task 2, existing `authRequest`, `Device`, `SocialAccount`, role, platform colors and navigation patterns.
- Produces: page ID `publish`, nav label `Crear publicación`, `PublicationPanel({ token, devices, accounts, canManage })`.

- [ ] **Step 1: Read the installed Next.js guides before editing**

Read the relevant client-components, forms, data-fetching, and file-upload guidance under `webapp/node_modules/next/dist/docs/`. Record deprecations that affect this implementation in the task report.

- [ ] **Step 2: Add Vitest and write failing pure validation tests**

Tests assert exact word/character rules, account filtering by device/platform, future Buenos Aires schedule conversion, 200 MiB limit, allowed MIME, and YouTube-specific error messages.

Run: `npm test -- --run src/app/publication-validation.test.ts`

Expected: FAIL because validation helpers are missing.

- [ ] **Step 3: Implement types and validation helpers**

Export `countWords`, `validateCaption`, `validateVideoFile`, `accountsForSelection`, `toBuenosAiresIso`, and typed API models matching backend JSON exactly.

- [ ] **Step 4: Implement the composer**

Build an accessible two-column page using current `cc-*` primitives: platform cards, device/account selects, ADB availability warning, drag/drop and keyboard file picker, local video preview, metadata summary, caption counter, Now/Schedule segmented control, upload progress, confirmation summary, and guarded CTA. Preserve fields on recoverable errors and prevent double submit.

- [ ] **Step 5: Implement queue, timeline, and safe actions**

Poll while active jobs exist; tabs are `En cola`, `En progreso`, `Revisión`, `Finalizadas`. Show platform/account/device/time/progress, expandable event timeline, and only valid cancel/reschedule controls. Map stable backend error codes to actionable Spanish copy.

- [ ] **Step 6: Integrate navigation and responsive styles**

Add `publish` to desktop/mobile navigation between Command center and Device fleet. Keep page state within the existing client shell. Add responsive layouts at existing 1080px/760px breakpoints, visible focus states, reduced-motion behavior, and no horizontal overflow at 360px.

- [ ] **Step 7: Run web verification**

Run: `npm test -- --run`, `npm run lint`, and `npm run build`.

Expected: all pass.

- [ ] **Step 8: Commit**

```powershell
git add src/app/publication-types.ts src/app/publication-validation.ts src/app/publication-validation.test.ts src/app/publication-panel.tsx src/app/page.tsx src/app/globals.css package.json package-lock.json
git commit -m "feat(web): add publication composer and queue"
```

### Task 8: Local integration and dry-run device validation

**Files:**
- Create: `publisher_worker/tests/test_local_integration.py`
- Create: `docs/operations/semiorganic-publishing-runbook.md`
- Modify: files only when a verified integration defect requires a fix.

**Interfaces:**
- Consumes all backend/worker/web contracts.
- Produces a local end-to-end job and a device dry-run ending at each platform's guarded final button.

- [ ] **Step 1: Run all automated suites from clean processes**

Run backend build/tests, full worker unittest discovery, and web test/lint/build. Save commands and exact results in the task report.

- [ ] **Step 2: Start isolated local API/worker and submit immediate/scheduled jobs**

Use temporary DB/media/config roots. Verify upload -> queued -> claim -> checkpoint -> finish, future jobs are not claimed early, cancellation releases locks, and task claim cannot overlap a publication.

- [ ] **Step 3: Revalidate the physical phone without publishing**

Confirm ADB serial, Android ID, resolution, installed platform versions, unlocked state, current packages and exact account labels. Abort Instagram if the account belongs to Santiago. Do not alter pairing/app data.

- [ ] **Step 4: Execute one dry-run per platform**

Use `MP-V-4.mp4` and unique captions of at most 10 words. Stop after confirming the exact final Share/Post/Upload Short control and capture sanitized screenshot/XML evidence. Verify no post was created and clean only the draft/media created by this run.

- [ ] **Step 5: Document operating/recovery procedure**

Runbook includes installation, account/device preflight, state meanings, safe cancellation, review-required resolution, media retention, worker recovery, and explicit prohibition against blind retry after final action.

- [ ] **Step 6: Commit integration tests/runbook and any reviewed fixes**

```powershell
git add publisher_worker/tests/test_local_integration.py docs/operations/semiorganic-publishing-runbook.md
git commit -m "test: verify publisher integration and dry runs"
```

### Task 9: Production deployment and real publication verification

**Files:**
- Modify: deployment metadata/config only through existing Windows/Vercel workflows.
- Create: `.superpowers` report artifacts only; do not commit screenshots containing account data.

**Interfaces:**
- Consumes approved builds from Tasks 1-8.
- Produces verified Windows API/worker runtime, Vercel deployment, and real publish/verify/delete evidence for all three platforms.

- [ ] **Step 1: Back up and publish backend**

Create and integrity-check a SQLite backup. Build backend, run all backend tests, publish with `ops/windows/publish-southfarm-backend-runtime.ps1`, restart only the SouthFarm API task, and verify runtime metadata hash, local/public health, DB integrity, planner disabled, and existing task endpoints.

- [ ] **Step 2: Install/start the worker**

Install under the current ADB-authorized Windows account, verify task/log/config ACLs, confirm it maps the connected phone by Android ID, and prove stopping the worker does not affect API health.

- [ ] **Step 3: Deploy the webapp to Vercel**

Run tests/lint/build, push the nested `webapp` main branch, deploy through the official Vercel connector/CLI, wait for `READY`, verify the production alias and inspect runtime/build errors.

- [ ] **Step 4: Verify production UX before real posting**

Sign in through the production UI, confirm `Crear publicación` on desktop/mobile widths, upload validation, account/device filtering, immediate/scheduled controls, queue/timeline, cancel/reprogram, and no regressions in Command center, fleet, planner, history, team or auth refresh.

- [ ] **Step 5: Publish, verify, and delete one real test per platform**

Use MP-V-4 and unique captions <=10 words. Record each account baseline and ensure fewer than two temporary posts. Never select Santiago's Instagram. Create from the production web UI, observe every job checkpoint, verify the post in the profile/channel, invoke the explicit test cleanup path, and confirm baseline restoration before continuing.

- [ ] **Step 6: Verify an actual scheduled publication**

Schedule a job a few minutes ahead on a safe account, prove it is not claimed early, observe execution after due time, verify it, delete it, and confirm baseline restoration. It may satisfy one platform's real test if all other requirements are met.

- [ ] **Step 7: Run final regression and safety audit**

Confirm no test posts/drafts remain, no account is `review_required`, no media/credential leaked publicly, API/worker/cloudflared tasks are healthy, planner remains disabled/manual-only, DB integrity passes, and all explicit spec requirements have current evidence.

- [ ] **Step 8: Audit repository and runtime cleanliness**

Run `git status --short` in both `C:\SouthFarm\source` and `C:\SouthFarm\source\webapp`. Confirm Task 9 created no source modifications. If a deployment defect required a source fix, return it to the owning implementation task and its review loop before completing Task 9. Do not commit runtime DBs, logs, screenshots, tokens, generated Gradle caches, or unrelated pre-existing changes.
