[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackendPath,
  [Parameter(Mandatory = $true)]
  [string]$NodePath,
  [Parameter(Mandatory = $true)]
  [string]$DatabasePath,
  [Parameter(Mandatory = $true)]
  [string]$RuntimeConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$LogDirectory,
  [int]$InitialRestartDelaySeconds = 5,
  [int]$MaxRestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$RuntimeConfigPath = [IO.Path]::GetFullPath($RuntimeConfigPath)
$LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
$RunDirectory = Join-Path $LogDirectory "run"
$LockPath = Join-Path $RunDirectory "southfarm-api-supervisor.lock"
$OutputLog = Join-Path $LogDirectory "southfarm-api.out.log"
$ErrorLog = Join-Path $LogDirectory "southfarm-api.error.log"

New-Item -ItemType Directory -Force -Path $RunDirectory, $LogDirectory | Out-Null
if (!(Test-Path -LiteralPath $NodePath)) { throw "Node executable not found: $NodePath" }
if (!(Test-Path -LiteralPath (Join-Path $BackendPath "dist\index.js"))) { throw "Backend build not found under: $BackendPath" }
if (!(Test-Path -LiteralPath $RuntimeConfigPath)) { throw "Runtime config not found: $RuntimeConfigPath" }
if (!(Test-Path -LiteralPath (Split-Path -Parent $DatabasePath))) { throw "Database directory not found: $(Split-Path -Parent $DatabasePath)" }

function Rotate-LogIfNeeded([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  if ((Get-Item -LiteralPath $Path).Length -lt 10MB) { return }
  $rotatedPath = "$Path.1"
  Move-Item -LiteralPath $Path -Destination $rotatedPath -Force
}

try {
  $lockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  Add-Content -LiteralPath $ErrorLog -Value ("{0:o} Another SouthFarm API supervisor is already running." -f (Get-Date))
  exit 0
}

try {
  $runtimeConfig = Get-Content -LiteralPath $RuntimeConfigPath -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$runtimeConfig.jwt_secret)) {
    throw "Runtime config does not contain jwt_secret."
  }

  $env:PORT = "3001"
  $env:SOUTHFARM_DB_PATH = $DatabasePath
  $env:JWT_SECRET = [string]$runtimeConfig.jwt_secret
  $env:SOUTHFARM_JWT_LEGACY_SECRETS = [string]$runtimeConfig.legacy_jwt_secrets
  $env:NODE_ENV = "production"
  # The workspace is intentionally manual_only for the current MVP phase.
  $env:SOUTHFARM_AUTO_PLANNER_ENABLED = "false"
  $env:SOUTHFARM_SCHEDULER_MODE = "fixed"
  $env:SOUTHFARM_SCHEDULER_TICK_SECONDS = "30"
  $env:SOUTHFARM_AUTO_PLANNER_TICK_SECONDS = "30"
  # Publisher credentials and private-media paths remain only in this ACL-protected runtime config.
  $env:SOUTHFARM_PUBLICATION_MEDIA_ROOT = [string]$runtimeConfig.publication_media_root
  $env:SOUTHFARM_PUBLISHER_WORKER_TOKEN = [string]$runtimeConfig.publisher_worker_token
  $env:SOUTHFARM_PUBLISHER_WORKER_ENABLED = if ([bool]$runtimeConfig.publisher_worker_enabled) { "true" } else { "false" }
  $env:SOUTHFARM_FFPROBE = [string]$runtimeConfig.ffprobe_path

  $restartDelay = [Math]::Max(1, $InitialRestartDelaySeconds)
  $maxDelay = [Math]::Max($restartDelay, $MaxRestartDelaySeconds)

  while ($true) {
    Rotate-LogIfNeeded $OutputLog
    Rotate-LogIfNeeded $ErrorLog
    Add-Content -LiteralPath $OutputLog -Value ("{0:o} Starting SouthFarm API from {1}" -f (Get-Date), $BackendPath)
    Set-Location -LiteralPath $BackendPath

    & $NodePath (Join-Path $BackendPath "dist\index.js") *>> $OutputLog
    $exitCode = $LASTEXITCODE
    Add-Content -LiteralPath $ErrorLog -Value ("{0:o} SouthFarm API exited with code {1}; restarting in {2}s." -f (Get-Date), $exitCode, $restartDelay)
    Start-Sleep -Seconds $restartDelay
    $restartDelay = [Math]::Min($maxDelay, $restartDelay * 2)
  }
} catch {
  Add-Content -LiteralPath $ErrorLog -Value ("{0:o} Supervisor failure: {1}" -f (Get-Date), $_.Exception.Message)
  throw
} finally {
  if ($lockStream) { $lockStream.Dispose() }
}
