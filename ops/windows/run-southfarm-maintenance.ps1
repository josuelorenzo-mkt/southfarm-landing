[CmdletBinding()]
param(
  [string]$BackendPath = (Join-Path $env:LOCALAPPDATA "SouthFarm\runtime\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$BackupScript = Join-Path $PSScriptRoot "run-southfarm-backup.ps1"
$MaintenanceScript = Join-Path $BackendPath "scripts\southfarm-maintenance.mjs"

if (!(Test-Path -LiteralPath $MaintenanceScript)) { throw "Maintenance script not found: $MaintenanceScript" }
if (!(Test-Path -LiteralPath $DatabasePath)) { throw "Database not found: $DatabasePath" }
if ($Apply) {
  try {
    & $BackupScript -BackendPath $BackendPath -NodePath $NodePath -DatabasePath $DatabasePath -Label "pre-maintenance"
  } catch {
    throw ("Maintenance stopped because the pre-maintenance backup failed: {0}" -f $_.Exception.Message)
  }
}

$arguments = @($MaintenanceScript, "--db", $DatabasePath)
if ($Apply) { $arguments += "--apply" }
& $NodePath @arguments
if ($LASTEXITCODE -ne 0) { throw "SouthFarm maintenance failed with exit code $LASTEXITCODE" }
