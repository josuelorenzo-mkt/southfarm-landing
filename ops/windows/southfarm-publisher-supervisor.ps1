[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$ConfigPath,
  [Parameter(Mandatory = $true)] [string]$LogDirectory,
  [switch]$ValidateOnly,
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
function Get-AppPrivateIdentity($Config) {
  $prefs = (& ([string]$Config.adb_path) -s ([string]$Config.device_serial) shell run-as ([string]$Config.southfarm_package) cat "shared_prefs/FlutterSharedPreferences.xml" 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($prefs)) { throw "Could not read SouthFarm private identity for the configured ADB serial." }
  $device = [regex]::Match($prefs, '<string name="(?:flutter\.)?device_id">([^<]+)</string>')
  $installation = [regex]::Match($prefs, '<string name="(?:flutter\.)?installation_id">([^<]+)</string>')
  if (!$device.Success -or !$installation.Success) { throw "SouthFarm private identity is incomplete for the configured ADB serial." }
  return [pscustomobject]@{ device_id=$device.Groups[1].Value; installation_id=$installation.Groups[1].Value }
}
function Assert-ConfiguredDeviceIdentity($Config) {
  $adbState = (& ([string]$Config.adb_path) -s ([string]$Config.device_serial) get-state 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $adbState -ne "device") { throw "Configured ADB serial is not authorized." }
  $liveAndroidId = (& ([string]$Config.adb_path) -s ([string]$Config.device_serial) shell settings get secure android_id 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $liveAndroidId -cne [string]$Config.android_id) { throw "Configured ADB serial no longer matches the expected Android ID." }
  if ([bool]$Config.legacy_app_identity) {
    $appIdentity = Get-AppPrivateIdentity $Config
    if ([string]$appIdentity.device_id -cne [string]$Config.legacy_device_id -or [string]$appIdentity.installation_id -cne [string]$Config.legacy_installation_id) { throw "Configured SouthFarm private identity no longer matches the expected device." }
  }
}

New-Item -ItemType Directory -Force -Path $RunDirectory, $LogDirectory | Out-Null
try { $lockStream = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
catch { Log $ErrorLog "Another SouthFarm Publisher Worker supervisor is already running."; exit 0 }

try {
  if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Publisher worker config not found." }
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  foreach ($name in @("python_path", "worker_path", "adb_path", "api_url", "worker_token", "worker_id", "device_id", "device_serial", "android_id")) {
    if ([string]::IsNullOrWhiteSpace([string]$config.$name)) { throw "Publisher worker config is missing $name." }
  }
  if ([bool]$config.legacy_app_identity) {
    foreach ($name in @("southfarm_package", "legacy_device_id", "legacy_installation_id")) { if ([string]::IsNullOrWhiteSpace([string]$config.$name)) { throw "Legacy publisher worker config is missing $name." } }
  }
  foreach ($pathName in @("python_path", "adb_path")) {
    if (!(Test-Path -LiteralPath ([string]$config.$pathName) -PathType Leaf)) { throw "Configured $pathName is unavailable." }
  }
  if (!(Test-Path -LiteralPath ([string]$config.worker_path) -PathType Container)) { throw "Configured worker_path is unavailable." }
  if ([Convert]::FromBase64String([string]$config.worker_token).Length -ne 32) { throw "Publisher worker token is not 32 bytes." }
  if ([string]::IsNullOrWhiteSpace([string]$config.forbidden_instagram_accounts) -and -not [bool]$config.allow_all_instagram_accounts) { throw "Instagram forbidden-account policy must be explicit." }

  Assert-ConfiguredDeviceIdentity $config
  if ($ValidateOnly) { Write-Output "Publisher worker supervisor identity validation passed."; return }

  $env:SOUTHFARM_API_URL = [string]$config.api_url
  $env:SOUTHFARM_PUBLISHER_WORKER_TOKEN = [string]$config.worker_token
  $env:SOUTHFARM_PUBLISHER_WORKER_ID = [string]$config.worker_id
  $env:SOUTHFARM_PUBLISHER_DEVICE_ID = [string]$config.device_id
  $env:SOUTHFARM_ADB_SERIAL = [string]$config.device_serial
  $env:SOUTHFARM_EXPECTED_ANDROID_ID = [string]$config.android_id
  $env:SOUTHFARM_BACKEND_DEVICE_ID = if ([bool]$config.legacy_app_identity) { [string]$config.legacy_device_id } else { [string]$config.device_id }
  $env:SOUTHFARM_ADB = [string]$config.adb_path
  $env:SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS = [string]$config.forbidden_instagram_accounts
  $env:SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS = if ([bool]$config.allow_all_instagram_accounts) { "true" } else { "false" }
  $env:PYTHONPATH = [string]$config.worker_path
  $restartDelay = [Math]::Max(1, $InitialRestartDelaySeconds); $maxDelay = [Math]::Max($restartDelay, $MaxRestartDelaySeconds)
  while ($true) {
    Assert-ConfiguredDeviceIdentity $config
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
