[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [Parameter(Mandatory = $true)] [string]$RunAsUser,
  [Parameter(Mandatory = $true)] [int]$DeviceId,
  [Parameter(Mandatory = $true)] [string]$DeviceSerial,
  [string]$TaskName = "SouthFarm Publisher Worker",
  [string]$WorkerPath = "",
  [string]$PythonPath = "",
  [string]$AdbPath = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe",
  [string]$FfprobeSourcePath = "",
  [string]$ApiUrl = "http://127.0.0.1:3001",
  [string]$MediaRoot = (Join-Path $env:ProgramData "SouthFarm\publish-media"),
  [string]$RuntimeRoot = (Join-Path $env:ProgramData "SouthFarm"),
  [string]$BackendRuntimeConfigPath = (Join-Path $env:ProgramData "SouthFarm\config\backend-runtime.json"),
  [string]$BackendPath = (Join-Path $env:LOCALAPPDATA "SouthFarm\runtime\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [string]$ForbiddenInstagramAccounts,
  [switch]$AllowAllInstagramAccounts,
  [switch]$LegacyAppIdentity,
  [string]$SouthFarmPackage = "com.example.southfarm_app",
  [string]$WorkerToken,
  [switch]$ValidationOnly
)

$ErrorActionPreference = "Stop"
function FullPath([string]$Path) { [IO.Path]::GetFullPath($Path) }
function Quote-Argument([string]$Value) { '"' + $Value.Replace('"', '\"') + '"' }
function Assert-Path([string]$Path, [string]$Label) { if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label not found: $Path" } }
function Set-ProtectedFileAcl([string]$Path, [hashtable]$AccountRights) {
  $acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $AccountRights.Keys) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), $AccountRights[$sid], "Allow"))) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Set-ProtectedDirectoryAcl([string]$Path, [hashtable]$AccountRights) {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $AccountRights.Keys) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), $AccountRights[$sid], "ContainerInherit,ObjectInherit", "None", "Allow"))) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Get-AppPrivateIdentity([string]$Adb, [string]$Serial, [string]$PackageName) {
  $prefs = (& $Adb -s $Serial shell run-as $PackageName cat "shared_prefs/FlutterSharedPreferences.xml" 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($prefs)) { throw "Could not read SouthFarm private identity for the exact DeviceSerial." }
  $device = [regex]::Match($prefs, '<string name="(?:flutter\.)?device_id">([^<]+)</string>')
  $installation = [regex]::Match($prefs, '<string name="(?:flutter\.)?installation_id">([^<]+)</string>')
  if (!$device.Success -or !$installation.Success) { throw "SouthFarm private identity is incomplete for the exact DeviceSerial." }
  return [pscustomobject]@{ device_id=$device.Groups[1].Value; installation_id=$installation.Groups[1].Value }
}

if ($DeviceId -le 0) { throw "DeviceId must be positive." }
if ([string]::IsNullOrWhiteSpace($DeviceSerial) -or $DeviceSerial -notmatch '^[A-Za-z0-9._:-]+$') { throw "DeviceSerial must be an exact safe ADB serial." }
if ([string]::IsNullOrWhiteSpace($SouthFarmPackage) -or $SouthFarmPackage -notmatch '^[A-Za-z0-9._]+$') { throw "SouthFarmPackage must be an exact safe Android package name." }
if ([string]::IsNullOrWhiteSpace($ForbiddenInstagramAccounts) -and !$AllowAllInstagramAccounts) { throw "Provide ForbiddenInstagramAccounts or explicitly set AllowAllInstagramAccounts." }
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($WorkerPath)) { $WorkerPath = Join-Path $scriptRoot "..\..\publisher_worker" }
if ([string]::IsNullOrWhiteSpace($FfprobeSourcePath)) {
  $ffprobeCommand = Get-Command ffprobe.exe -ErrorAction SilentlyContinue
  if ($ffprobeCommand) { $FfprobeSourcePath = $ffprobeCommand.Source }
  else {
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $candidate = Get-ChildItem -LiteralPath $wingetPackages -Filter ffprobe.exe -File -Recurse -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($candidate) { $FfprobeSourcePath = $candidate.FullName }
  }
  if ([string]::IsNullOrWhiteSpace($FfprobeSourcePath)) { throw "ffprobe.exe was not found on PATH or under the current user's WinGet packages; pass FfprobeSourcePath explicitly." }
}
$WorkerPath = FullPath $WorkerPath; $AdbPath = FullPath $AdbPath; $FfprobeSourcePath = FullPath $FfprobeSourcePath; $MediaRoot = FullPath $MediaRoot; $RuntimeRoot = FullPath $RuntimeRoot; $BackendRuntimeConfigPath = FullPath $BackendRuntimeConfigPath; $BackendPath = FullPath $BackendPath; $NodePath = FullPath $NodePath; $DatabasePath = FullPath $DatabasePath
if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = (Get-Command python.exe -ErrorAction Stop).Source }
$PythonPath = FullPath $PythonPath
Assert-Path $PythonPath "Python executable"; Assert-Path $AdbPath "ADB executable"; Assert-Path $FfprobeSourcePath "ffprobe executable"; Assert-Path $NodePath "Node executable"; Assert-Path $DatabasePath "SouthFarm database"
if (!(Test-Path -LiteralPath (Join-Path $BackendPath "node_modules\better-sqlite3") -PathType Container)) { throw "Backend better-sqlite3 runtime not found: $BackendPath" }
$nodeMajor = (& $NodePath -p "process.versions.node.split('.')[0]" 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeMajor -ne "22") { throw "Publisher installer requires the SouthFarm portable Node 22 runtime." }
if (!(Test-Path -LiteralPath (Join-Path $WorkerPath "southfarm_publisher\runner.py"))) { throw "Publisher worker module not found: $WorkerPath" }
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent(); $requested = New-Object Security.Principal.NTAccount($RunAsUser); $requestedSid = $requested.Translate([Security.Principal.SecurityIdentifier]).Value
if ($requestedSid -ne $currentIdentity.User.Value) { throw "Run this script while signed in as RunAsUser; validation from an administrator's different profile is rejected." }
$principalCheck = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (!$ValidationOnly -and !$principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Real installation must be run elevated from the exact RunAsUser account. First run ValidationOnly normally, then reopen PowerShell as Administrator in the same account." }
$adbState = (& $AdbPath -s $DeviceSerial get-state 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $adbState -ne "device") { throw "The exact DeviceSerial is not authorized for ADB in the RunAsUser profile." }
$androidId = (& $AdbPath -s $DeviceSerial shell settings get secure android_id 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $androidId -notmatch '^[A-Fa-f0-9]{8,32}$') { throw "Could not verify android_id for the exact DeviceSerial." }
$deviceLookup = "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});const r=d.prepare('SELECT id, device_id, installation_id FROM devices WHERE id=? AND lifecycle_status != ?').get(Number(process.argv[2]),'revoked');d.close();if(!r){process.exit(4)};process.stdout.write(JSON.stringify(r));"
Push-Location -LiteralPath $BackendPath
try { $deviceRowJson = & $NodePath -e $deviceLookup $DatabasePath $DeviceId 2>$null; $deviceLookupExit = $LASTEXITCODE }
finally { Pop-Location }
if ($deviceLookupExit -ne 0 -or [string]::IsNullOrWhiteSpace(($deviceRowJson -join ""))) { throw "DeviceId does not identify an active SouthFarm device." }
$deviceRow = ($deviceRowJson -join "") | ConvertFrom-Json
if ($LegacyAppIdentity) {
  $appIdentity = Get-AppPrivateIdentity $AdbPath $DeviceSerial $SouthFarmPackage
  if ([string]$deviceRow.device_id -cne [string]$appIdentity.device_id -or [string]$deviceRow.installation_id -cne [string]$appIdentity.installation_id) { throw "SouthFarm private identity does not match the requested backend device." }
}
if ([string]$deviceRow.device_id -cne $androidId -and !$LegacyAppIdentity) { throw "DeviceId is registered to a different Android ID than DeviceSerial." }

$configDir = Join-Path $RuntimeRoot "config"; $logDir = Join-Path $RuntimeRoot "logs"; $evidenceRoot = Join-Path $RuntimeRoot "publish-evidence"; $toolPath = Join-Path $RuntimeRoot "tools\ffmpeg\ffprobe.exe"; $workerConfigPath = Join-Path $configDir "publisher-worker.json"; $supervisorPath = FullPath (Join-Path $scriptRoot "southfarm-publisher-supervisor.ps1")
if ([string]::IsNullOrWhiteSpace($WorkerToken)) { $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes); $WorkerToken = [Convert]::ToBase64String($bytes) }
if ([Convert]::FromBase64String($WorkerToken).Length -ne 32) { throw "WorkerToken must be a Base64 encoding of exactly 32 bytes." }
if (!(Test-Path -LiteralPath $BackendRuntimeConfigPath -PathType Leaf)) { throw "Backend runtime config not found: $BackendRuntimeConfigPath" }
$backendConfig = Get-Content -LiteralPath $BackendRuntimeConfigPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$backendConfig.jwt_secret)) { throw "Backend runtime config is invalid." }
if ($ValidationOnly -or $WhatIfPreference) { Write-Output "Validated publisher worker installation inputs; no config or task was changed."; return }

New-Item -ItemType Directory -Force -Path $configDir, $logDir, $MediaRoot, $evidenceRoot, (Split-Path -Parent $toolPath) | Out-Null
$systemSid = "S-1-5-18"; $adminsSid = "S-1-5-32-544"
Set-ProtectedDirectoryAcl $configDir @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="ReadAndExecute" }
Set-ProtectedDirectoryAcl $logDir @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="Modify" }
Set-ProtectedDirectoryAcl $MediaRoot @{ $systemSid="FullControl"; $adminsSid="FullControl" }
Set-ProtectedDirectoryAcl $evidenceRoot @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="Modify" }
Set-ProtectedDirectoryAcl (Split-Path -Parent $toolPath) @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="ReadAndExecute" }
Copy-Item -LiteralPath $FfprobeSourcePath -Destination $toolPath -Force
Set-ProtectedFileAcl $toolPath @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="ReadAndExecute" }
$workerConfig = [ordered]@{ python_path=$PythonPath; worker_path=$WorkerPath; adb_path=$AdbPath; ffprobe_path=$toolPath; api_url=$ApiUrl.TrimEnd('/'); worker_id=("windows-{0}" -f $DeviceId); run_as_user=$RunAsUser; run_as_sid=$requestedSid; device_id=$DeviceId; device_serial=$DeviceSerial; android_id=$androidId; legacy_app_identity=[bool]$LegacyAppIdentity; southfarm_package=$SouthFarmPackage; legacy_device_id=if ($LegacyAppIdentity) { [string]$appIdentity.device_id } else { "" }; legacy_installation_id=if ($LegacyAppIdentity) { [string]$appIdentity.installation_id } else { "" }; worker_token=$WorkerToken; media_root=$MediaRoot; evidence_root=$evidenceRoot; log_root=$logDir; forbidden_instagram_accounts=$ForbiddenInstagramAccounts; allow_all_instagram_accounts=[bool]$AllowAllInstagramAccounts }
[IO.File]::WriteAllText($workerConfigPath, ($workerConfig | ConvertTo-Json -Compress))
Set-ProtectedFileAcl $workerConfigPath @{ $systemSid="FullControl"; $adminsSid="FullControl"; $requestedSid="ReadAndExecute" }

$backendValues = [ordered]@{}; foreach ($property in $backendConfig.PSObject.Properties) { $backendValues[$property.Name] = $property.Value }
$backendValues["publisher_worker_token"] = $WorkerToken; $backendValues["publisher_worker_enabled"] = $true; $backendValues["publication_media_root"] = $MediaRoot; $backendValues["ffprobe_path"] = $toolPath
[IO.File]::WriteAllText($BackendRuntimeConfigPath, ($backendValues | ConvertTo-Json -Compress))
Set-ProtectedFileAcl $BackendRuntimeConfigPath @{ $systemSid="FullControl"; $adminsSid="FullControl" }

$arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $(Quote-Argument $supervisorPath) -ConfigPath $(Quote-Argument $workerConfigPath) -LogDirectory $(Quote-Argument $logDir)"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $RunAsUser
$principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
if ($PSCmdlet.ShouldProcess($TaskName, "register SouthFarm interactive publisher worker task")) { Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "SouthFarm Publisher Worker; interactive ADB account, one worker per device." -Force | Out-Null }
Write-Output ("Registered publisher worker task: " + $TaskName)
