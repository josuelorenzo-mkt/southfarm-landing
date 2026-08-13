[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:ProgramData "SouthFarm\config\publisher-worker.json"),
  [string]$BackendRuntimeConfigPath = (Join-Path $env:ProgramData "SouthFarm\config\backend-runtime.json"),
  [string]$TaskName = "SouthFarm Publisher Worker",
  [string]$ExpectedRunAsUser,
  [switch]$SkipTaskLookup,
  [switch]$SkipHealthProbe,
  [switch]$CreateTemporaryFixture
)

$ErrorActionPreference = "Stop"

function Assert-WorkerCondition([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}
function Has-AllowSid($Acl, [string]$Sid) {
  return [bool]($Acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $Sid -and $_.AccessControlType -eq "Allow" })
}

$temporaryRoot = $null
if ($CreateTemporaryFixture) {
  $temporaryRoot = Join-Path $env:TEMP ("southfarm-publisher-test-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $mediaRoot = Join-Path $temporaryRoot "media"; $evidenceRoot = Join-Path $temporaryRoot "evidence"; $logRoot = Join-Path $temporaryRoot "logs"; $toolRoot = Join-Path $temporaryRoot "tools\ffmpeg"; $fixtureFfprobe = Join-Path $toolRoot "ffprobe.exe"
  New-Item -ItemType Directory -Force -Path $mediaRoot, $evidenceRoot, $logRoot, $toolRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $env:WINDIR "System32\cmd.exe") -Destination $fixtureFfprobe
  $fixtureSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $fixture = [ordered]@{ python_path=(Join-Path $env:WINDIR "System32\\cmd.exe"); worker_path=$temporaryRoot; adb_path=(Join-Path $env:WINDIR "System32\\cmd.exe"); ffprobe_path=$fixtureFfprobe; api_url="http://127.0.0.1:1"; worker_id="test-worker"; run_as_user=[Security.Principal.WindowsIdentity]::GetCurrent().Name; run_as_sid=$fixtureSid; device_id=1; device_serial="fixture-serial"; android_id="0123456789abcdef"; worker_token=[Convert]::ToBase64String($bytes); media_root=$mediaRoot; evidence_root=$evidenceRoot; log_root=$logRoot; forbidden_instagram_accounts="fixture-account"; allow_all_instagram_accounts=$false }
  $ConfigPath = Join-Path $temporaryRoot "publisher-worker.json"
  [IO.File]::WriteAllText($ConfigPath, ($fixture | ConvertTo-Json -Compress))
  $acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544", [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "Allow"))) }
  Set-Acl -LiteralPath $ConfigPath -AclObject $acl
  foreach ($directory in @($mediaRoot, $evidenceRoot, $logRoot, $toolRoot)) {
    $directoryAcl = New-Object System.Security.AccessControl.DirectorySecurity; $directoryAcl.SetAccessRuleProtection($true, $false)
    $directorySids = @("S-1-5-18", "S-1-5-32-544", [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    foreach ($sid in $directorySids) { $directoryAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"))) }
    Set-Acl -LiteralPath $directory -AclObject $directoryAcl
  }
  $toolFileAcl = New-Object System.Security.AccessControl.FileSecurity; $toolFileAcl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544", $fixtureSid)) { $toolFileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "Allow"))) }
  Set-Acl -LiteralPath $fixtureFfprobe -AclObject $toolFileAcl
  $fakeAdb = Join-Path $temporaryRoot "fake-adb.cmd"
  [IO.File]::WriteAllText($fakeAdb, "@echo off`r`nif `%3==get-state (echo device) else (echo 0123456789abcdef)`r`nexit /b 0`r`n")
  $fixture.adb_path = $fakeAdb
  [IO.File]::WriteAllText($ConfigPath, ($fixture | ConvertTo-Json -Compress))
  $backendConfig = Join-Path $temporaryRoot "backend-runtime.json"
  [IO.File]::WriteAllText($backendConfig, '{"jwt_secret":"fixture-only"}')
  $installer = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "install-southfarm-publisher-worker.ps1"
  $backendPath = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..\backend"))
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source; $fixtureDatabase = Join-Path $temporaryRoot "southfarm.db"
  $createDeviceDb = 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.exec("CREATE TABLE devices(id INTEGER PRIMARY KEY,device_id TEXT,lifecycle_status TEXT)");d.prepare("INSERT INTO devices VALUES(?,?,?)").run(1,"0123456789abcdef","active");d.close()'
  Push-Location -LiteralPath $backendPath
  try { & $nodePath -e $createDeviceDb $fixtureDatabase }
  finally { Pop-Location }
  $validationArgs = @{ RunAsUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name; DeviceId=1; DeviceSerial="fixture-serial"; PythonPath=(Join-Path $env:WINDIR "System32\cmd.exe"); AdbPath=$fakeAdb; FfprobeSourcePath=(Join-Path $env:WINDIR "System32\cmd.exe"); RuntimeRoot=(Join-Path $temporaryRoot "runtime"); BackendRuntimeConfigPath=$backendConfig; BackendPath=$backendPath; NodePath=$nodePath; DatabasePath=$fixtureDatabase; ForbiddenInstagramAccounts="fixture-account"; ValidationOnly=$true; WhatIf=$true }
  $validationOutput = & $installer @validationArgs
  Assert-WorkerCondition (($validationOutput -join "`n") -eq "Validated publisher worker installation inputs; no config or task was changed.") "Installer ValidationOnly fixture did not pass exactly"
  Assert-WorkerCondition (!(Test-Path -LiteralPath (Join-Path $temporaryRoot "runtime\config\publisher-worker.json"))) "ValidationOnly wrote a worker config"
  Push-Location -LiteralPath $backendPath
  try { & $nodePath -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.prepare("UPDATE devices SET device_id=? WHERE id=1").run("fedcba9876543210");d.close()' $fixtureDatabase }
  finally { Pop-Location }
  $failedAsExpected = $false
  try { & $installer @validationArgs | Out-Null } catch { $failedAsExpected = $_.Exception.Message -eq "DeviceId is registered to a different Android ID than DeviceSerial." }
  Assert-WorkerCondition $failedAsExpected "DeviceId/DeviceSerial mismatch was not rejected"
  Push-Location -LiteralPath $backendPath
  try { & $nodePath -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);d.prepare("UPDATE devices SET device_id=? WHERE id=1").run("0123456789abcdef");d.close()' $fixtureDatabase }
  finally { Pop-Location }
  [IO.File]::WriteAllText($backendConfig, (@{ jwt_secret="fixture-only"; publisher_worker_token=$fixture.worker_token; publisher_worker_enabled=$true; publication_media_root=$mediaRoot; ffprobe_path=$fixture.ffprobe_path } | ConvertTo-Json -Compress))
  $backendFileAcl = New-Object System.Security.AccessControl.FileSecurity; $backendFileAcl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544", $fixtureSid)) { $backendFileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "Allow"))) }
  Set-Acl -LiteralPath $backendConfig -AclObject $backendFileAcl
  $BackendRuntimeConfigPath = $backendConfig
  $SkipTaskLookup = $true; $SkipHealthProbe = $true
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$BackendRuntimeConfigPath = [IO.Path]::GetFullPath($BackendRuntimeConfigPath)
Assert-WorkerCondition (Test-Path -LiteralPath $ConfigPath) "Publisher worker config not found: $ConfigPath"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
foreach ($name in @("python_path", "adb_path", "ffprobe_path", "api_url", "worker_id", "run_as_user", "run_as_sid", "device_id", "device_serial", "android_id", "worker_token", "media_root", "evidence_root", "log_root")) {
  Assert-WorkerCondition (![string]::IsNullOrWhiteSpace([string]$config.$name)) "Publisher worker config is missing $name"
}
foreach ($pathName in @("python_path", "adb_path", "ffprobe_path")) {
  Assert-WorkerCondition (Test-Path -LiteralPath ([string]$config.$pathName) -PathType Leaf) "Configured $pathName does not exist"
}
Assert-WorkerCondition (([int]$config.device_id) -gt 0) "Publisher worker device_id must be positive"
Assert-WorkerCondition ([Convert]::FromBase64String([string]$config.worker_token).Length -eq 32) "Publisher worker token must contain exactly 32 bytes"
Assert-WorkerCondition (![string]::IsNullOrWhiteSpace([string]$config.forbidden_instagram_accounts) -or [bool]$config.allow_all_instagram_accounts) "Instagram forbidden-account policy must be explicit"
Assert-WorkerCondition ([IO.Path]::IsPathRooted([string]$config.media_root)) "Publisher media root must be absolute"
Assert-WorkerCondition ([IO.Path]::IsPathRooted([string]$config.evidence_root)) "Publisher evidence root must be absolute"
Assert-WorkerCondition ([string]$config.device_serial -match '^[A-Za-z0-9._:-]+$') "Publisher device serial is unsafe"
Assert-WorkerCondition ([string]$config.android_id -match '^[A-Fa-f0-9]{8,32}$') "Publisher Android ID is invalid"

$acl = Get-Acl -LiteralPath $ConfigPath
Assert-WorkerCondition ($acl.AreAccessRulesProtected) "Publisher worker config inherits broad ACLs"
$systemSid = "S-1-5-18"; $adminsSid = "S-1-5-32-544"; $runAsSid = [string]$config.run_as_sid
Assert-WorkerCondition (Has-AllowSid $acl $systemSid) "Publisher worker config does not grant SYSTEM"
Assert-WorkerCondition (Has-AllowSid $acl $adminsSid) "Publisher worker config does not grant Administrators"
Assert-WorkerCondition (Has-AllowSid $acl $runAsSid) "Publisher worker config does not grant its RunAs user"
$ordinarySids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545")
foreach ($ordinarySid in $ordinarySids) {
  Assert-WorkerCondition (-not ($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ordinarySid -and $_.AccessControlType -eq "Allow" })) "Publisher worker config ACL grants ordinary users"
}
Assert-WorkerCondition (Test-Path -LiteralPath $BackendRuntimeConfigPath -PathType Leaf) "Backend runtime config not found"
$backendConfig = Get-Content -LiteralPath $BackendRuntimeConfigPath -Raw | ConvertFrom-Json
Assert-WorkerCondition ([string]$backendConfig.publisher_worker_token -ceq [string]$config.worker_token) "Backend and worker tokens do not match"
Assert-WorkerCondition ([bool]$backendConfig.publisher_worker_enabled) "Backend publisher worker is not enabled"
$backendAcl = Get-Acl -LiteralPath $BackendRuntimeConfigPath
Assert-WorkerCondition ($backendAcl.AreAccessRulesProtected) "Backend runtime config inherits broad ACLs"
Assert-WorkerCondition (Has-AllowSid $backendAcl $systemSid) "Backend runtime config does not grant SYSTEM"
Assert-WorkerCondition (Has-AllowSid $backendAcl $adminsSid) "Backend runtime config does not grant Administrators"
if (!$temporaryRoot) { Assert-WorkerCondition (-not (Has-AllowSid $backendAcl $runAsSid)) "Backend runtime config unnecessarily grants the worker user" }
foreach ($ordinarySid in $ordinarySids) {
  Assert-WorkerCondition (-not ($backendAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ordinarySid -and $_.AccessControlType -eq "Allow" })) "Backend runtime config grants ordinary users"
}
foreach ($directory in @([string]$config.media_root, [string]$config.evidence_root, [string]$config.log_root)) {
  Assert-WorkerCondition (Test-Path -LiteralPath $directory -PathType Container) "Protected publisher directory is missing: $directory"
  $directoryAcl = Get-Acl -LiteralPath $directory
  Assert-WorkerCondition ($directoryAcl.AreAccessRulesProtected) "Publisher directory inherits broad ACLs: $directory"
  foreach ($ordinarySid in $ordinarySids) {
    Assert-WorkerCondition (-not ($directoryAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ordinarySid -and $_.AccessControlType -eq "Allow" })) "Publisher directory grants ordinary users: $directory"
  }
  Assert-WorkerCondition (Has-AllowSid $directoryAcl $systemSid) "Publisher directory does not grant SYSTEM: $directory"
  Assert-WorkerCondition (Has-AllowSid $directoryAcl $adminsSid) "Publisher directory does not grant Administrators: $directory"
  if ($directory -eq [string]$config.media_root) { if (!$temporaryRoot) { Assert-WorkerCondition (-not (Has-AllowSid $directoryAcl $runAsSid)) "Media root unnecessarily grants the worker user" } }
  else { Assert-WorkerCondition (Has-AllowSid $directoryAcl $runAsSid) "Worker user cannot write required logs/evidence: $directory" }
}
$toolFile = [IO.Path]::GetFullPath([string]$config.ffprobe_path); $toolDirectory = Split-Path -Parent $toolFile
foreach ($toolTarget in @($toolDirectory, $toolFile)) {
  $toolAcl = Get-Acl -LiteralPath $toolTarget
  Assert-WorkerCondition ($toolAcl.AreAccessRulesProtected) "Publisher tool inherits broad ACLs: $toolTarget"
  foreach ($ordinarySid in $ordinarySids) { Assert-WorkerCondition (-not (Has-AllowSid $toolAcl $ordinarySid)) "Ordinary users can replace publisher tools: $toolTarget" }
  Assert-WorkerCondition (Has-AllowSid $toolAcl $systemSid) "Publisher tool does not grant SYSTEM: $toolTarget"
  Assert-WorkerCondition (Has-AllowSid $toolAcl $adminsSid) "Publisher tool does not grant Administrators: $toolTarget"
  Assert-WorkerCondition (Has-AllowSid $toolAcl $runAsSid) "Publisher worker cannot execute ffprobe: $toolTarget"
}

if (!$SkipTaskLookup) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Assert-WorkerCondition ($task.Principal.UserId -notmatch "^(SYSTEM|S-1-5-18)$") "Publisher worker task must not run as SYSTEM"
  Assert-WorkerCondition ($task.Principal.LogonType -match "Interactive") "Publisher worker task must use an interactive logon principal"
  Assert-WorkerCondition ($task.Settings.MultipleInstances -eq "IgnoreNew") "Publisher worker task must ignore overlapping instances"
  Assert-WorkerCondition ($task.Settings.RestartCount -ge 1) "Publisher worker task must restart after failure"
  if (![string]::IsNullOrWhiteSpace($ExpectedRunAsUser)) {
    $expectedSid = (New-Object Security.Principal.NTAccount($ExpectedRunAsUser)).Translate([Security.Principal.SecurityIdentifier]).Value
    $actualSid = (New-Object Security.Principal.NTAccount($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value
    Assert-WorkerCondition ($actualSid -eq $expectedSid) "Publisher worker task principal does not match ExpectedRunAsUser"
  }
}
if (!$SkipHealthProbe) {
  $headers = @{ Authorization = "Bearer $([string]$config.worker_token)" }
  try { Invoke-WebRequest -Uri (([string]$config.api_url).TrimEnd('/') + "/api/publication-worker/devices/" + [int]$config.device_id + "/availability") -Headers $headers -TimeoutSec 8 -UseBasicParsing | Out-Null }
  catch { if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { throw "Publisher worker local health probe was not authenticated." }; throw "Publisher worker local health probe failed." }
}

if ($temporaryRoot) {
  $selfPath = $MyInvocation.MyCommand.Path
  $originalBackendText = Get-Content -LiteralPath $BackendRuntimeConfigPath -Raw
  $badBackend = $originalBackendText | ConvertFrom-Json; $badBackend.publisher_worker_token = [Convert]::ToBase64String((New-Object byte[] 32))
  [IO.File]::WriteAllText($BackendRuntimeConfigPath, ($badBackend | ConvertTo-Json -Compress))
  $failedAsExpected = $false
  try { & $selfPath -ConfigPath $ConfigPath -BackendRuntimeConfigPath $BackendRuntimeConfigPath -SkipTaskLookup -SkipHealthProbe | Out-Null } catch { $failedAsExpected = $_.Exception.Message -eq "Backend and worker tokens do not match" }
  Assert-WorkerCondition $failedAsExpected "Negative token mismatch fixture was not rejected"
  [IO.File]::WriteAllText($BackendRuntimeConfigPath, $originalBackendText)

  $originalConfigText = Get-Content -LiteralPath $ConfigPath -Raw
  $badConfig = $originalConfigText | ConvertFrom-Json; $badConfig.device_serial = "unsafe serial with spaces"
  [IO.File]::WriteAllText($ConfigPath, ($badConfig | ConvertTo-Json -Compress))
  $failedAsExpected = $false
  try { & $selfPath -ConfigPath $ConfigPath -BackendRuntimeConfigPath $BackendRuntimeConfigPath -SkipTaskLookup -SkipHealthProbe | Out-Null } catch { $failedAsExpected = $_.Exception.Message -eq "Publisher device serial is unsafe" }
  Assert-WorkerCondition $failedAsExpected "Negative unsafe serial fixture was not rejected"
  [IO.File]::WriteAllText($ConfigPath, $originalConfigText)

  $supervisor = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "southfarm-publisher-supervisor.ps1"
  $supervisorOutput = & $supervisor -ConfigPath $ConfigPath -LogDirectory $logRoot -ValidateOnly
  Assert-WorkerCondition (($supervisorOutput -join "`n") -eq "Publisher worker supervisor identity validation passed.") "Supervisor did not validate the exact configured serial/Android identity"
  $badConfig = $originalConfigText | ConvertFrom-Json; $badConfig.android_id = "fedcba9876543210"
  [IO.File]::WriteAllText($ConfigPath, ($badConfig | ConvertTo-Json -Compress))
  $failedAsExpected = $false
  try { & $supervisor -ConfigPath $ConfigPath -LogDirectory $logRoot -ValidateOnly | Out-Null } catch { $failedAsExpected = $_.Exception.Message -eq "Configured ADB serial no longer matches the expected Android ID." }
  Assert-WorkerCondition $failedAsExpected "Supervisor accepted a different live Android identity"
  [IO.File]::WriteAllText($ConfigPath, $originalConfigText)
}

# Deliberately never print the configuration object: it contains the worker token.
try { [pscustomobject]@{ status = "ok"; config_path = $ConfigPath; task_checked = (-not $SkipTaskLookup); health_checked = (-not $SkipHealthProbe) } | ConvertTo-Json -Compress }
finally { if ($temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force } }
