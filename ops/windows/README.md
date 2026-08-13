# SouthFarm Windows operation

The MVP runtime is Windows-native. WSL is used only as a one-time migration source for the existing Cloudflare Tunnel credential; it must not remain part of the production path.

## Runtime layout

- Backend runtime: `%LOCALAPPDATA%\SouthFarm\runtime\backend`
- Portable Node 22: `%LOCALAPPDATA%\SouthFarm\node-v22.23.1-win-x64\node.exe`
- Active SQLite database: `%LOCALAPPDATA%\SouthFarm\data\southfarm.db`
- Protected service configuration: `%PROGRAMDATA%\SouthFarm\config\backend-runtime.json`
- Logs: `%PROGRAMDATA%\SouthFarm\logs`
- Verified backups: `%LOCALAPPDATA%\SouthFarm\runtime\backend\backups`
- Cloudflare Tunnel: `C:\ProgramData\SouthFarm\cloudflared`

The runtime copy is outside OneDrive so the server does not depend on a user session or file synchronization at boot. The source checkout remains the place for development and publishing.

## One-time installation

Open PowerShell as Administrator in the repository root and run:

~~~powershell
.\ops\windows\install-southfarm-windows-runtime.ps1 -StartNow
~~~

This publishes the current backend build, stores the JWT configuration in an ACL-protected file, registers the API supervisor as `SYSTEM`, registers the local health watchdog, registers daily backup and weekly retention tasks, and installs `cloudflared` as a Windows service. The workspace remains `manual_only`; the supervisor deliberately disables automatic planning.

The installer migrates the existing tunnel credential from the old WSL path. Once the public API health check is green, stop and disable the old WSL `cloudflared` service so there is only one tunnel replica serving the origin.

## Scheduled tasks and service

- `SouthFarm API`: starts at boot as `SYSTEM`, keeps one Node process alive, and restarts it with backoff.
- `SouthFarm API Watchdog`: checks `http://127.0.0.1:3001/api/health` every minute and terminates only a hung SouthFarm backend process so the supervisor can restart it.
- `SouthFarm Database Backup`: daily verified online SQLite backup.
- `SouthFarm Database Maintenance`: weekly retention maintenance after a pre-maintenance backup.
- `cloudflared` Windows service: starts at boot and routes `api.southfarm.tech` to `http://127.0.0.1:3001`.

## Backups and retention

Preview retention without deleting anything:

~~~powershell
.\ops\windows\run-southfarm-maintenance.ps1
~~~

Apply retention only after reviewing the preview:

~~~powershell
.\ops\windows\run-southfarm-maintenance.ps1 -Apply
~~~

The policy is 30 days for scan sessions/results and 6 months for warmup activity, task audit events and in-panel notifications. The backup script uses SQLite's online backup API and verifies the resulting database with `PRAGMA integrity_check` plus SHA-256. Never copy the live `.db-wal` file manually.
