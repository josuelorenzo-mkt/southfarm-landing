[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)] [string]$RunAsUser,
  [Parameter(Mandatory = $true)] [int]$DeviceId,
  [string]$TaskName = "SouthFarm Publisher Worker",
  [string]$WorkerPath = (Join-Path $PSScriptRoot "..\..\publisher_worker"),
  [string]$PythonPath = "",
  [string]$AdbPath = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe",
  [string]$FfprobeSourcePath = "C:\Users\josu_\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-essentials_build\bin\ffprobe.exe",
  [string]$ApiUrl = "http://127.0.0.1:3001",
  [string]$MediaRoot = (Join-Path $env:ProgramData "SouthFarm\publish-media"),
  [string]$RuntimeRoot = (Join-Path $env:ProgramData "SouthFarm"),
  [string]$BackendRuntimeConfigPath = (Join-Path $env:ProgramData "SouthFarm\config\backend-runtime.json"),
  [string]$ForbiddenInstagramAccounts,
  [switch]$AllowAllInstagramAccounts,
  [string]$WorkerToken,
  [switch]$ValidationOnly
)

$ErrorActionPreference = "Stop"
function FullPath([string]$Path) { [IO.Path]::GetFullPath($Path) }
function Quote-Argument([string]$Value) { '"' + $Value.Replace('"', '\"') + '"' }
function Assert-Path([string]$Path, [string]$Label) { if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label not found: $Path" } }
function Set-ProtectedAcl([string]$Path, [string[]]$AccountSids) {
  $acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $AccountSids | Select-Object -Unique) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "Allow"))) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($DeviceId -le 0) { throw "DeviceId must be positive." }
if ([string]::IsNullOrWhiteSpace($ForbiddenInstagramAccounts) -and !$AllowAllInstagramAccounts) { throw "Provide ForbiddenInstagramAccounts or explicitly set AllowAllInstagramAccounts." }
$WorkerPath = FullPath $WorkerPath; $AdbPath = FullPath $AdbPath; $FfprobeSourcePath = FullPath $FfprobeSourcePath; $MediaRoot = FullPath $MediaRoot; $RuntimeRoot = FullPath $RuntimeRoot; $BackendRuntimeConfigPath = FullPath $BackendRuntimeConfigPath
if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = (Get-Command python.exe -ErrorAction Stop).Source }
$PythonPath = FullPath $PythonPath
Assert-Path $PythonPath "Python executable"; Assert-Path $AdbPath "ADB executable"; Assert-Path $FfprobeSourcePath "ffprobe executable"
if (!(Test-Path -LiteralPath (Join-Path $WorkerPath "southfarm_publisher\runner.py"))) { throw "Publisher worker module not found: $WorkerPath" }
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent(); $requested = New-Object Security.Principal.NTAccount($RunAsUser); $requestedSid = $requested.Translate([Security.Principal.SecurityIdentifier]).Value
if (!$ValidationOnly -and $requestedSid -ne $currentIdentity.User.Value) { throw "Run this installer from the requested interactive account so ADB authorization is verified in that account." }
if (!$ValidationOnly) { $adbDevices = & $AdbPath devices 2>&1; if ($LASTEXITCODE -ne 0 -or -not (($adbDevices -join "`n") -match "\tdevice$")) { throw "ADB has no authorized device for the requested interactive account." } }

$configDir = Join-Path $RuntimeRoot "config"; $logDir = Join-Path $RuntimeRoot "logs"; $toolPath = Join-Path $RuntimeRoot "tools\ffmpeg\ffprobe.exe"; $workerConfigPath = Join-Path $configDir "publisher-worker.json"; $supervisorPath = FullPath (Join-Path $PSScriptRoot "southfarm-publisher-supervisor.ps1")
if ([string]::IsNullOrWhiteSpace($WorkerToken)) { $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $WorkerToken = [Convert]::ToBase64String($bytes) }
if ([Convert]::FromBase64String($WorkerToken).Length -ne 32) { throw "WorkerToken must be a Base64 encoding of exactly 32 bytes." }
if ($ValidationOnly -or $WhatIfPreference) { Write-Output "Validated publisher worker installation inputs; no config or task was changed."; return }

New-Item -ItemType Directory -Force -Path $configDir, $logDir, $MediaRoot, (Split-Path -Parent $toolPath) | Out-Null
Copy-Item -LiteralPath $FfprobeSourcePath -Destination $toolPath -Force
$workerConfig = [ordered]@{ python_path=$PythonPath; worker_path=$WorkerPath; adb_path=$AdbPath; ffprobe_path=$toolPath; api_url=$ApiUrl.TrimEnd('/'); worker_id=("windows-{0}" -f $DeviceId); device_id=$DeviceId; worker_token=$WorkerToken; media_root=$MediaRoot; forbidden_instagram_accounts=$ForbiddenInstagramAccounts; allow_all_instagram_accounts=[bool]$AllowAllInstagramAccounts }
[IO.File]::WriteAllText($workerConfigPath, ($workerConfig | ConvertTo-Json -Compress))
Set-ProtectedAcl $workerConfigPath @("S-1-5-18", "S-1-5-32-544", $requestedSid)

if (!(Test-Path -LiteralPath $BackendRuntimeConfigPath)) { throw "Backend runtime config not found: $BackendRuntimeConfigPath" }
$backendConfig = Get-Content -LiteralPath $BackendRuntimeConfigPath -Raw | ConvertFrom-Json
$backendValues = [ordered]@{}; foreach ($property in $backendConfig.PSObject.Properties) { $backendValues[$property.Name] = $property.Value }
$backendValues["publisher_worker_token"] = $WorkerToken; $backendValues["publisher_worker_enabled"] = $true; $backendValues["publication_media_root"] = $MediaRoot; $backendValues["ffprobe_path"] = $toolPath
[IO.File]::WriteAllText($BackendRuntimeConfigPath, ($backendValues | ConvertTo-Json -Compress))
Set-ProtectedAcl $BackendRuntimeConfigPath @("S-1-5-18", "S-1-5-32-544")

$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $supervisorPath) -ConfigPath $(Quote-Argument $workerConfigPath) -LogDirectory $(Quote-Argument $logDir)"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType InteractiveToken -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
if ($PSCmdlet.ShouldProcess($TaskName, "register SouthFarm interactive publisher worker task")) { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "SouthFarm Publisher Worker; interactive ADB account, one worker per device." -Force | Out-Null }
Write-Output ("Registered publisher worker task: " + $TaskName)
