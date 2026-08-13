[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:ProgramData "SouthFarm\config\publisher-worker.json"),
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

$temporaryRoot = $null
if ($CreateTemporaryFixture) {
  $temporaryRoot = Join-Path $env:TEMP ("southfarm-publisher-test-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $fixture = [ordered]@{ python_path=(Join-Path $env:WINDIR "System32\\cmd.exe"); worker_path=$temporaryRoot; adb_path=(Join-Path $env:WINDIR "System32\\cmd.exe"); ffprobe_path=(Join-Path $env:WINDIR "System32\\cmd.exe"); api_url="http://127.0.0.1:1"; worker_id="test-worker"; device_id=1; worker_token=[Convert]::ToBase64String($bytes); media_root=$temporaryRoot; forbidden_instagram_accounts="fixture-account"; allow_all_instagram_accounts=$false }
  $ConfigPath = Join-Path $temporaryRoot "publisher-worker.json"
  [IO.File]::WriteAllText($ConfigPath, ($fixture | ConvertTo-Json -Compress))
  $acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @("S-1-5-18", "S-1-5-32-544", [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) { $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), "FullControl", "Allow"))) }
  Set-Acl -LiteralPath $ConfigPath -AclObject $acl
  $SkipTaskLookup = $true; $SkipHealthProbe = $true
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
Assert-WorkerCondition (Test-Path -LiteralPath $ConfigPath) "Publisher worker config not found: $ConfigPath"
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
foreach ($name in @("python_path", "adb_path", "ffprobe_path", "api_url", "worker_id", "device_id", "worker_token", "media_root")) {
  Assert-WorkerCondition (![string]::IsNullOrWhiteSpace([string]$config.$name)) "Publisher worker config is missing $name"
}
foreach ($pathName in @("python_path", "adb_path", "ffprobe_path")) {
  Assert-WorkerCondition (Test-Path -LiteralPath ([string]$config.$pathName) -PathType Leaf) "Configured $pathName does not exist"
}
Assert-WorkerCondition (([int]$config.device_id) -gt 0) "Publisher worker device_id must be positive"
Assert-WorkerCondition ([Convert]::FromBase64String([string]$config.worker_token).Length -eq 32) "Publisher worker token must contain exactly 32 bytes"
Assert-WorkerCondition (![string]::IsNullOrWhiteSpace([string]$config.forbidden_instagram_accounts) -or [bool]$config.allow_all_instagram_accounts) "Instagram forbidden-account policy must be explicit"
Assert-WorkerCondition ([IO.Path]::IsPathRooted([string]$config.media_root)) "Publisher media root must be absolute"

$acl = Get-Acl -LiteralPath $ConfigPath
$ordinarySids = @("S-1-1-0", "S-1-5-11", "S-1-5-32-545")
foreach ($ordinarySid in $ordinarySids) {
  Assert-WorkerCondition (-not ($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ordinarySid -and $_.AccessControlType -eq "Allow" })) "Publisher worker config ACL grants ordinary users"
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

# Deliberately never print the configuration object: it contains the worker token.
try { [pscustomobject]@{ status = "ok"; config_path = $ConfigPath; task_checked = (-not $SkipTaskLookup); health_checked = (-not $SkipHealthProbe) } | ConvertTo-Json -Compress }
finally { if ($temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force } }
