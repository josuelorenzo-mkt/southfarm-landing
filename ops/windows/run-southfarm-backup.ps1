[CmdletBinding()]
param(
  [string]$BackendPath = (Join-Path $env:LOCALAPPDATA "SouthFarm\runtime\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [string]$Label = "daily"
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$ScriptPath = Join-Path $BackendPath "scripts\southfarm-backup.mjs"
$OutputPath = Join-Path $BackendPath "backups"

if (!(Test-Path -LiteralPath $NodePath)) { throw "Node executable not found: $NodePath" }
if (!(Test-Path -LiteralPath $ScriptPath)) { throw "Backup script not found: $ScriptPath" }
if (!(Test-Path -LiteralPath $DatabasePath)) { throw "Database not found: $DatabasePath" }

& $NodePath $ScriptPath --db $DatabasePath --out-dir $OutputPath --label $Label
if ($LASTEXITCODE -ne 0) { throw "SouthFarm backup failed with exit code $LASTEXITCODE" }
