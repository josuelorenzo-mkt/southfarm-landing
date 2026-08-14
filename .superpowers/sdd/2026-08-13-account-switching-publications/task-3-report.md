## Task 3 report

- Added a runner integration regression for an `ACCOUNT_UNAVAILABLE` adapter preflight.
- The test was red first because the runner downloaded media before validating the selected account.
- Moved `preparing` and `adapter.prepare()` before media download. The terminal path now finishes exactly once as `failed` with `ACCOUNT_UNAVAILABLE`, stops the heartbeat, and performs no download, device push, downstream checkpoint, or final checkpoint.
- The existing backend finish route already persists supplied worker error metadata without an error-code allowlist, so no backend normalization was needed.

Verification:

- `python -m unittest publisher_worker.tests.test_runner.RunnerTests.test_unavailable_selected_account_finishes_once_without_media_transfer_or_final_checkpoint -v` passed after the change (and failed before it: expected zero downloads, got one).
- `python -m unittest discover -s publisher_worker/tests -v` passed: 106 tests.
- Backend worker/domain/auth suites each completed TypeScript compilation, but their runtime portion is blocked locally: `better-sqlite3` is built for Node ABI 127 while the available Node is v26.5.1 / ABI 147. No compatible Node runtime is installed; dependencies were not rebuilt.
