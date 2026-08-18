[CmdletBinding()]
param(
  [string]$TaskName = "SouthFarm API",
  [string]$BackendPath = (Join-Path $PSScriptRoot "..\..\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [string]$RuntimeRoot = (Join-Path $env:ProgramData "SouthFarm"),
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$SupervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "southfarm-api-supervisor.ps1"))
$WatchdogPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "southfarm-api-watchdog.ps1"))
$BackupRunnerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "run-southfarm-backup.ps1"))
$MaintenanceRunnerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "run-southfarm-maintenance.ps1"))
$RuntimeConfigPath = Join-Path $RuntimeRoot "config\backend-runtime.json"
$LogDirectory = Join-Path $RuntimeRoot "logs"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Este instalador debe ejecutarse en PowerShell como Administrador para registrar el servicio 24/7 como SYSTEM."
}
if (!(Test-Path -LiteralPath $SupervisorPath)) { throw "Supervisor not found: $SupervisorPath" }
if (!(Test-Path -LiteralPath $WatchdogPath)) { throw "Watchdog not found: $WatchdogPath" }
if (!(Test-Path -LiteralPath $BackupRunnerPath)) { throw "Backup runner not found: $BackupRunnerPath" }
if (!(Test-Path -LiteralPath $MaintenanceRunnerPath)) { throw "Maintenance runner not found: $MaintenanceRunnerPath" }
if (!(Test-Path -LiteralPath $NodePath)) { throw "Node executable not found: $NodePath" }
if (!(Test-Path -LiteralPath (Join-Path $BackendPath "dist\index.js"))) { throw "Backend build not found under: $BackendPath" }
if (!(Test-Path -LiteralPath $DatabasePath)) { throw "Database not found: $DatabasePath" }

$jwtSecret = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_SECRET", "User")
if ([string]::IsNullOrWhiteSpace($jwtSecret)) { $jwtSecret = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_SECRET", "Machine") }
$legacySecrets = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_LEGACY_SECRETS", "User")
if ([string]::IsNullOrWhiteSpace($legacySecrets)) { $legacySecrets = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_LEGACY_SECRETS", "Machine") }
if ([string]::IsNullOrWhiteSpace($jwtSecret)) { throw "SOUTHFARM_JWT_SECRET no está configurado en User o Machine." }

New-Item -ItemType Directory -Force -Path (Join-Path $RuntimeRoot "config"), $LogDirectory | Out-Null
$runtimeConfig = [ordered]@{
  jwt_secret = [string]$jwtSecret
  legacy_jwt_secrets = [string]$legacySecrets
  created_at = (Get-Date).ToUniversalTime().ToString("o")
}
[IO.File]::WriteAllText($RuntimeConfigPath, ($runtimeConfig | ConvertTo-Json -Compress))

# The SYSTEM service needs the secret, but the file must not be readable by
# normal users. The installer itself must be run elevated to apply this ACL.
$configAcl = New-Object System.Security.AccessControl.FileSecurity
$configAcl.SetAccessRuleProtection($true, $false)
$systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminsSid, "FullControl", "Allow")))
Set-Acl -LiteralPath $RuntimeConfigPath -AclObject $configAcl

function Quote-Argument([string]$Value) { return '"' + $Value.Replace('"', '\"') + '"' }

$argumentList = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $SupervisorPath) -BackendPath $(Quote-Argument $BackendPath) -NodePath $(Quote-Argument $NodePath) -DatabasePath $(Quote-Argument $DatabasePath) -RuntimeConfigPath $(Quote-Argument $RuntimeConfigPath) -LogDirectory $(Quote-Argument $LogDirectory)"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argumentList
$trigger = New-ScheduledTaskTrigger -AtStartup
$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Description "SouthFarm API supervisor; Windows-native, persistent, single backend process with automatic restart." -Force | Out-Null
Write-Output ("Registered scheduled task: " + $TaskName)
Write-Output ("Database: " + $DatabasePath)
Write-Output ("Runtime config: " + $RuntimeConfigPath)

$watchdogArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $WatchdogPath) -BackendPath $(Quote-Argument $BackendPath) -SupervisorTaskName $(Quote-Argument $TaskName) -LogPath $(Quote-Argument (Join-Path $LogDirectory "southfarm-api-watchdog.log"))"
$watchdogAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $watchdogArguments
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName "SouthFarm API Watchdog" -Action $watchdogAction -Trigger $watchdogTrigger -Principal $taskPrincipal -Settings $settings -Description "SouthFarm API local health watchdog; restarts a hung backend process." -Force | Out-Null
Write-Output "Registered scheduled task: SouthFarm API Watchdog"

$backupArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $BackupRunnerPath) -BackendPath $(Quote-Argument $BackendPath) -NodePath $(Quote-Argument $NodePath) -DatabasePath $(Quote-Argument $DatabasePath) -Label daily"
$backupAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $backupArguments
$backupTrigger = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour 4 -Minute 0 -Second 0)
Register-ScheduledTask -TaskName "SouthFarm Database Backup" -Action $backupAction -Trigger $backupTrigger -Principal $taskPrincipal -Settings $settings -Description "Daily verified online backup of the SouthFarm SQLite database." -Force | Out-Null
Write-Output "Registered scheduled task: SouthFarm Database Backup"

$maintenanceArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $MaintenanceRunnerPath) -BackendPath $(Quote-Argument $BackendPath) -NodePath $(Quote-Argument $NodePath) -DatabasePath $(Quote-Argument $DatabasePath) -Apply"
$maintenanceAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $maintenanceArguments
$maintenanceTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At (Get-Date -Hour 4 -Minute 30 -Second 0)
Register-ScheduledTask -TaskName "SouthFarm Database Maintenance" -Action $maintenanceAction -Trigger $maintenanceTrigger -Principal $taskPrincipal -Settings $settings -Description "Weekly verified retention maintenance for SouthFarm SQLite data." -Force | Out-Null
Write-Output "Registered scheduled task: SouthFarm Database Maintenance"

if ($StartNow) {
  $registeredTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$registeredTask.State -eq "Running") {
    Write-Output "Scheduled task is already running."
  } else {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started scheduled task."
  }
}
