[CmdletBinding()]
param(
  [string]$SourceBackendPath = (Join-Path $PSScriptRoot "..\..\backend"),
  [string]$SouthFarmLocalRoot = (Join-Path $env:LOCALAPPDATA "SouthFarm"),
  [string]$RuntimeSystemRoot = (Join-Path $env:ProgramData "SouthFarm"),
  [switch]$InstallPublisherWorker,
  [string]$PublisherRunAsUser,
  [int]$PublisherDeviceId,
  [string]$PublisherDeviceSerial,
  [string]$ForbiddenInstagramAccounts,
  [switch]$AllowAllInstagramAccounts,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Este instalador debe ejecutarse en PowerShell como Administrador."
}

$SourceBackendPath = [IO.Path]::GetFullPath($SourceBackendPath)
$SouthFarmLocalRoot = [IO.Path]::GetFullPath($SouthFarmLocalRoot)
$RuntimeSystemRoot = [IO.Path]::GetFullPath($RuntimeSystemRoot)
$runtimeBackendPath = Join-Path $SouthFarmLocalRoot "runtime\backend"
$nodePath = Join-Path $SouthFarmLocalRoot "node-v22.23.1-win-x64\node.exe"
$databasePath = Join-Path $SouthFarmLocalRoot "data\southfarm.db"
$publishPath = Join-Path $PSScriptRoot "publish-southfarm-backend-runtime.ps1"
$apiInstallerPath = Join-Path $PSScriptRoot "install-southfarm-api-task.ps1"
$cloudflaredInstallerPath = Join-Path $PSScriptRoot "install-southfarm-cloudflared.ps1"
$publisherInstallerPath = Join-Path $PSScriptRoot "install-southfarm-publisher-worker.ps1"

function Invoke-RequiredPowerShellScript {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [hashtable]$Arguments = @{},
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  try {
    # These are PowerShell scripts, not native processes. `$LASTEXITCODE` is
    # intentionally not used here: it can be empty or retain the exit code of
    # an unrelated native command even when the child .ps1 completed correctly.
    & $Path @Arguments
  } catch {
    throw ("{0}: {1}" -f $FailureMessage, $_.Exception.Message)
  }
}

Invoke-RequiredPowerShellScript `
  -Path $publishPath `
  -Arguments @{ SourceBackendPath = $SourceBackendPath; RuntimeBackendPath = $runtimeBackendPath } `
  -FailureMessage "Backend runtime publication failed"

$apiArgs = @{
  BackendPath = $runtimeBackendPath
  NodePath = $nodePath
  DatabasePath = $databasePath
  RuntimeRoot = $RuntimeSystemRoot
}
if ($StartNow) { $apiArgs.StartNow = $true }
Invoke-RequiredPowerShellScript `
  -Path $apiInstallerPath `
  -Arguments $apiArgs `
  -FailureMessage "Windows API task installation failed"

$cloudflaredArgs = @{}
if ($StartNow) { $cloudflaredArgs.StartNow = $true }
Invoke-RequiredPowerShellScript `
  -Path $cloudflaredInstallerPath `
  -Arguments $cloudflaredArgs `
  -FailureMessage "Windows Cloudflare Tunnel installation failed"

if ($InstallPublisherWorker) {
  if ([string]::IsNullOrWhiteSpace($PublisherRunAsUser) -or $PublisherDeviceId -le 0 -or [string]::IsNullOrWhiteSpace($PublisherDeviceSerial)) { throw "PublisherRunAsUser, PublisherDeviceId, and PublisherDeviceSerial are required with InstallPublisherWorker." }
  $publisherArgs = @{ RunAsUser = $PublisherRunAsUser; DeviceId = $PublisherDeviceId; DeviceSerial = $PublisherDeviceSerial; RuntimeRoot = $RuntimeSystemRoot; ForbiddenInstagramAccounts = $ForbiddenInstagramAccounts; AllowAllInstagramAccounts = $AllowAllInstagramAccounts }
  Invoke-RequiredPowerShellScript `
    -Path $publisherInstallerPath `
    -Arguments $publisherArgs `
    -FailureMessage "Publisher Worker installation failed"
}

Write-Output "SouthFarm Windows runtime installation completed."
Write-Output ("Backend runtime: " + $runtimeBackendPath)
Write-Output ("Database: " + $databasePath)
Write-Output "Next verification: test https://api.southfarm.tech/api/health, then disable the old WSL cloudflared service."
