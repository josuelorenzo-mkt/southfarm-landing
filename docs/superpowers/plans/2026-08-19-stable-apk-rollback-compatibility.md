# Stable APK Rollback and Legacy Worker Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to execute this plan task-by-task with verification checkpoints.

**Goal:** Restore the stable SouthFarm Android release (1.1.8, versionCode 10) as the downloadable web APK, while making the publisher worker operate against both the current app (1.2.0 service UI snapshots) and the stable app (legacy `uiautomator` UI dumps).

**Architecture:** Keep the publication adapters and backend contract unchanged. Add an explicit `auto` UI-source mode to the worker: attempt the app-provided service snapshot once, cache service unavailability, then use `uiautomator` selectors for the remainder of that device session. The worker must fail closed when neither source produces a usable hierarchy. Roll back one device (phone 08) first with an in-place signed downgrade, validate identity/data/accessibility and a worker smoke path, then change the public APK and only afterward consider the remaining fleet.

**Tech Stack:** Python worker and pytest, PowerShell scheduled-task supervisor, Android ADB, Flutter APK artifacts, Next/Vercel webapp, `aapt2`/`apksigner` verification.

## Global Constraints

- Preserve all pre-existing dirty files; never use `git reset --hard`, `git checkout --`, broad cleanup, uninstall, or app-data clearing.
- Use semantic UI selectors and physical `input tap` behavior; do not introduce fixed-coordinate automation.
- Do not expose worker/API secrets in logs or documentation.
- Do not use the forbidden `santilorennzo` account. The authorized test accounts remain `marczell.vibes` (Instagram/TikTok) and `marczellwisdom` (YouTube).
- Do not downgrade the fleet until phone 08 succeeds. A failed compatibility check must stop the rollout.
- Keep a verified copy of the currently public APK before replacing it.

## Tasks

### 1. Capture baseline and artifact provenance

- Record fresh git status for the publisher worktree and the canonical `C:\SouthFarm\source\webapp` checkout.
- Verify the current public APK package/version/signature/hash and the stable 1.1.8 release package/version/signature/hash.
- Confirm the scheduled publisher task and phone serial/Android ID before any device mutation.

### 2. Add failing tests for automatic UI-source fallback

- Extend `publisher_worker/tests/test_adb_device.py` with tests proving that `auto` tries the service dump, falls back to `uiautomator` when the service is unavailable, caches that decision, and accepts a usable legacy hierarchy during health checks.
- Add a fail-closed test proving that when both sources fail no tap is emitted and a clear retryable UI-dump error is raised.
- Run the targeted tests and capture the expected red result before implementation.

### 3. Implement compatibility in `SafeAdb` and registry/runner plumbing

- Permit `auto` as a UI source without changing the explicit `service` and `uiautomator` semantics.
- Cache service unavailability per `SafeAdb` instance so legacy devices do not incur an eight-second failed service poll on every selector action.
- In `auto` health checks, accept a usable `uiautomator` hierarchy; repair/abort only when both paths fail.
- Keep semantic selector/tap behavior and existing service freshness guarantees intact.
- Run the targeted tests, then the complete worker suite.

### 4. Make production worker configuration use compatibility mode

- Update runner validation and the Windows supervisor/installer to accept `auto` and default production configuration to it while preserving explicit overrides.
- Do not rewrite protected configuration except through the existing installer/config path; preserve device IDs, serials, API URL, and tokens.
- Run PowerShell/config/static checks and the full worker suite again.

### 5. Pause and validate a guarded rollback on phone 08

- Stop the `SouthFarm Publisher Worker` scheduled task and confirm it is no longer running.
- Copy the exact signed 1.1.8 release to a clearly named local rollback artifact and verify its hash before installing.
- Run `adb install -r -d` on `192.168.0.21:5555` only; do not uninstall or clear data.
- Verify package version/signature, Android ID, accessibility component, app data continuity, and that the old app does not provide the service dump while `uiautomator` can produce a hierarchy.
- Exercise `SafeAdb(ui_source="auto")` against the device and require a usable hierarchy before proceeding. If it fails, restore the prior APK from the verified backup and stop.

### 6. Replace the web-download artifact with stable 1.1.8

- Back up the current `C:\SouthFarm\source\webapp\public\southfarm.apk` artifact.
- Replace only that binary with the verified 1.1.8 release; leave publication UI/backend source untouched.
- Run webapp build/tests and inspect the resulting binary with `aapt2`/`apksigner`.
- Deploy using the repository’s normal Vercel process only after local verification, then verify the public URL serves the 1.1.8 artifact and correct signature/hash.

### 7. Re-enable and verify, then decide fleet rollout

- Update the active worker configuration to `ui_source=auto`, start the scheduled task, and confirm healthy polling without secret output.
- Verify the phone 08 worker smoke path and that no unexpected publication occurs.
- If phone 08 and production download both pass, roll the same signed APK to the remaining intended devices one at a time with identity/version checks. If not, leave the rest untouched and report the blocker.

### 8. Final evidence and handoff

- Run final worker/web verification commands and capture concise evidence: tests, package versions/signatures, production download metadata, task state, and device IDs.
- Update the Spanish handoff with exact recovery commands, compatibility behavior, known limitations, and whether fleet rollout was completed.
