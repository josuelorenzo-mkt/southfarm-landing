# Account Switching for Semi-Organic Publications Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

Goal: Make the selected scanned account authoritative for Instagram, TikTok, and YouTube publications by switching to that account before media selection and reporting an actionable unavailable-account error when it cannot be found.

Architecture: Keep the latest social_accounts scan as the account inventory. Add a shared worker contract that opens each platform's account switcher, selects the exact username from the immutable publication snapshot, and verifies the resulting profile. Platform adapters provide selectors and navigation details; the runner preserves fail-closed terminal behavior. The web maps the new worker error to a concise recovery message and keeps the job timeline visible.

Tech Stack: Python 3.12 worker, ADB/UIAutomator XML, existing Instagram/TikTok/YouTube adapters, TypeScript/Next webapp, existing Express/SQLite publication API.

## Global Constraints

- The selected account must come from the latest SouthFarm scan for the selected device and platform.
- No automatic credential entry or login is allowed.
- No automatic pre-publication rescan is required.
- If the exact account is not present in the platform account switcher, do not transfer, select, or publish media.
- santilorennzo remains forbidden for Instagram tests and production worker policy.
- Captions remain limited to 10 words; test captions use "you just need to think bigger".
- A failed account preflight must finish the job as failed with ACCOUNT_UNAVAILABLE and no final-action checkpoint.

### Task 1: Define the shared account-switch contract

Files:
- Modify: publisher_worker/southfarm_publisher/platforms/common.py
- Modify: publisher_worker/southfarm_publisher/models.py
- Test: publisher_worker/tests/test_platform_adapters.py
- Test: publisher_worker/tests/test_runner.py

Interfaces:
- Add GuardedPublisher.select_account(job, device) -> None.
- Add GuardedPublisher.require_account_available(...) that raises PublisherError("ACCOUNT_UNAVAILABLE", ...) when the exact scanned username is absent.
- Preserve the existing immutable job.account["username"] snapshot.

- [ ] Step 1: Add failing tests for a different active account, exact account found in the switcher, and exact account absent.
- [ ] Step 2: Run focused worker tests and confirm they fail because adapters only validate the current profile.
- [ ] Step 3: Implement the shared contract with exact username matching, no substring matching, and no credential interaction.
- [ ] Step 4: Run focused tests and confirm all three cases pass.
- [ ] Step 5: Commit feat(worker): define scanned account selection contract.

### Task 2: Implement platform-specific account switching

Files:
- Modify: publisher_worker/southfarm_publisher/platforms/instagram.py
- Modify: publisher_worker/southfarm_publisher/platforms/tiktok.py
- Modify: publisher_worker/southfarm_publisher/platforms/youtube.py
- Modify: publisher_worker/southfarm_publisher/platforms/common.py
- Test: publisher_worker/tests/test_platform_adapters.py

Interfaces:
- Each adapter prepare() must call its own account-switch flow before capturing the profile/gallery baseline.
- Each adapter must verify the selected username after switching and before media selection.
- A missing account raises ACCOUNT_UNAVAILABLE; an ambiguous selector raises the same code with safe diagnostic text.

- [ ] Step 1: Add failing scripted-UI tests for Instagram profile menu/account switch, TikTok account switch, and YouTube account/channel switch.
- [ ] Step 2: Run adapter tests and confirm they fail at the current-account check.
- [ ] Step 3: Implement fresh-dump navigation for each platform, using existing tap_and_wait/absence-reappearance guards and exact account text.
- [ ] Step 4: Add tests proving a wrong active account is switched, a missing account never reaches media selection, and Santiago remains blocked.
- [ ] Step 5: Run all platform adapter tests and commit feat(worker): switch to selected social account.

### Task 3: Preserve fail-closed runner and observable error semantics

Files:
- Modify: publisher_worker/southfarm_publisher/runner.py
- Modify: backend/src/publication-worker-routes.ts only if error metadata needs normalization
- Test: publisher_worker/tests/test_runner.py
- Test: backend/scripts/test-publication-worker-api.mjs

Interfaces:
- PublicationRunner.run_once() must finish ACCOUNT_UNAVAILABLE exactly once, stop heartbeat, release the lock, and skip transferring, selecting_media, and final action.
- Existing ACCOUNT_MISMATCH remains reserved for immutable device/account identity corruption, not a different currently active social profile.

- [ ] Step 1: Add a failing runner integration test asserting one failed finish, no media push, no final checkpoint, and released lock for ACCOUNT_UNAVAILABLE.
- [ ] Step 2: Run the focused test and confirm the current adapter error is misclassified or reaches the wrong checkpoint.
- [ ] Step 3: Implement minimal error mapping and terminal cleanup.
- [ ] Step 4: Run worker API, domain, and auth regressions.
- [ ] Step 5: Commit fix(worker): report unavailable selected accounts safely.

### Task 4: Show actionable account recovery in the webapp

Files:
- Modify: webapp/src/app/publication-panel.tsx
- Modify: webapp/src/app/publication-types.ts only if a typed error field is needed
- Test: webapp/src/app/publication-panel.test.tsx

Interfaces:
- Map ACCOUNT_UNAVAILABLE to: La cuenta seleccionada ya no está disponible en este teléfono. Volvé a escanear sus cuentas o elegí otra cuenta disponible.
- Keep the message focused on the operator; do not mention asking a human.
- Show the message in the active queue/detail state as soon as polling receives the failed job.
- Keep existing account and device selections visible so the operator can choose another account without rebuilding the form.

- [ ] Step 1: Add a failing component test for the exact error copy and recovery guidance.
- [ ] Step 2: Run the component test and confirm the error code has no dedicated mapping.
- [ ] Step 3: Implement the mapping and queue alert.
- [ ] Step 4: Run web tests, lint, and production build.
- [ ] Step 5: Commit fix(web): explain unavailable publication accounts.

### Task 5: End-to-end verification and two live Instagram posts

Files:
- Test: publisher_worker/tests/test_runner.py
- Test: publisher_worker/tests/test_platform_adapters.py
- Test: webapp/src/app/publication-panel.test.tsx
- Use: C:\Users\josu_\Downloads\Videos to test\MP-V-1.mp4
- Use: C:\Users\josu_\Downloads\Videos to test\MP-V-2.mp4

- [ ] Step 1: Run backend build and publication/worker/auth black-box suites.
- [ ] Step 2: Run the complete Python worker suite and verify zero failures.
- [ ] Step 3: Deploy webapp and publish the worker/backend runtime containing reviewed commits.
- [ ] Step 4: Launch Instagram publication 1 from the deployed webapp for a scanned, permitted account, then verify phone profile, final checkpoint, completed job, and remote post identity.
- [ ] Step 5: Launch Instagram publication 2 for the same scanned account with the second test video and verify the same evidence.
- [ ] Step 6: Confirm no publication uses santilorennzo and report both post identities and job timelines.

## Self-review

- The selected scanned account remains authoritative; no task requires a pre-publication rescan.
- All three platform adapters have explicit account-switch work.
- Missing accounts fail before transfer and have a web recovery message without credential instructions.
- Device identity mismatch remains separate from social-account availability.
- Live validation requires two consecutive Instagram completions before declaring the feature ready.
