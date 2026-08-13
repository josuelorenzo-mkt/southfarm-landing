[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$ConfigPath,
  [Parameter(Mandatory = $true)] [string]$LogDirectory,
  [int]$InitialRestartDelaySeconds = 5,
  [int]$MaxRestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
$RunDirectory = Join-Path $LogDirectory "run"
$LockPath = Join-Path $RunDirectory "southfarm-publisher-supervisor.lock"
$OutputLog = Join-Path $LogDirectory "southfarm-publisher.out.log"
$ErrorLog = Join-Path $LogDirectory "southfarm-publisher.error.log"

function Rotate-LogIfNeeded([string]$Path) {
  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -ge 10MB) {
    Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
  }
}
function Log([string]$Path, [string]$Message) { Add-Content -LiteralPath $Path -Value ("{0:o} {1}" -f (Get-Date), $Message) }

New-Item -ItemType Directory -Force -Path $RunDirectory, $LogDirectory | Out-Null
try { $lockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { Log $ErrorLog "Another SouthFarm Publisher Worker supervisor is already running."; exit 0 }

try {
  if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Publisher worker config not found." }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  foreach ($name in @("python_path", "worker_path", "adb_path", "api_url", "worker_token", "worker_id", "device_id")) {
    if ([string]::IsNullOrWhiteSpace([string]$config.$name)) { throw "Publisher worker config is missing $name." }
  }
  foreach ($pathName in @("python_path", "adb_path")) {
    if (!(Test-Path -LiteralPath ([string]$config.$pathName) -PathType Leaf)) { throw "Configured $pathName is unavailable." }
  }
  if (!(Test-Path -LiteralPath ([string]$config.worker_path) -PathType Container)) { throw "Configured worker_path is unavailable." }
  if ([Convert]::FromBase64String([string]$config.worker_token).Length -ne 32) { throw "Publisher worker token is not 32 bytes." }
  if ([string]::IsNullOrWhiteSpace([string]$config.forbidden_instagram_accounts) -and -not [bool]$config.allow_all_instagram_accounts) { throw "Instagram forbidden-account policy must be explicit." }

  $env:SOUTHFARM_API_URL = [string]$config.api_url
  $env:SOUTHFARM_PUBLISHER_WORKER_TOKEN = [string]$config.worker_token
  $env:SOUTHFARM_PUBLISHER_WORKER_ID = [string]$config.worker_id
  $env:SOUTHFARM_PUBLISHER_DEVICE_ID = [string]$config.device_id
  $env:SOUTHFARM_ADB = [string]$config.adb_path
  $env:SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS = [string]$config.forbidden_instagram_accounts
  $env:SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS = if ([bool]$config.allow_all_instagram_accounts) { "true" } else { "false" }
  $env:PYTHONPATH = [string]$config.worker_path
  $restartDelay = [Math]::Max(1, $InitialRestartDelaySeconds); $maxDelay = [Math]::Max($restartDelay, $MaxRestartDelaySeconds)
  while ($true) {
    Rotate-LogIfNeeded $OutputLog; Rotate-LogIfNeeded $ErrorLog
    Log $OutputLog "Starting SouthFarm Publisher Worker."
    & ([string]$config.python_path) -m southfarm_publisher.runner *>> $OutputLog
    $exitCode = $LASTEXITCODE
    Log $ErrorLog ("Publisher Worker exited with code {0}; restarting in {1}s." -f $exitCode, $restartDelay)
    Start-Sleep -Seconds $restartDelay
    $restartDelay = [Math]::Min($maxDelay, $restartDelay * 2)
  }
} catch { Log $ErrorLog ("Supervisor failure: {0}" -f $_.Exception.Message); throw }
finally { if ($lockStream) { $lockStream.Dispose() } }
