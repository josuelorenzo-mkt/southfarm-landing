# Arma el ZIP del kit de instalación de la oficina EEUU.
# Reúne: instalador, supervisor, README y el screen-bridge (con node_modules).
# El bridge vive hoy en el worktree visualize-phone (rama feature/device-fleet-live-view).
[CmdletBinding()]
param(
  [string]$ScreenBridgePath = "C:\SouthFarm\source\.worktrees\visualize-phone\screen-bridge",
  [string]$PublisherWorkerPath = "C:\SouthFarm\source\publisher_worker\southfarm_publisher",
  [string]$ApkPath = "C:\ProgramData\SouthFarm\app\southfarm.apk",
  [string]$OutZip = "C:\SouthFarm\kit\southfarm-us-kit.zip"
)
$ErrorActionPreference = "Stop"
$kitSource = $PSScriptRoot
$stage = Join-Path $env:TEMP ("southfarm-us-kit-" + (Get-Random))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  Copy-Item (Join-Path $kitSource "install-southfarm-us-office.ps1") $stage
  Copy-Item (Join-Path $kitSource "install-southfarm-us-publisher.ps1") $stage
  Copy-Item (Join-Path $kitSource "verify-us-office.ps1") $stage
  Copy-Item (Join-Path $kitSource "AGENT-SETUP.md") $stage
  Copy-Item (Join-Path $kitSource "README-US-OFFICE.md") $stage
  Copy-Item $ScreenBridgePath (Join-Path $stage "screen-bridge") -Recurse -Force
  Copy-Item $PublisherWorkerPath (Join-Path $stage "publisher_worker\southfarm_publisher") -Recurse -Force
  Copy-Item $ApkPath (Join-Path $stage "southfarm.apk")
  New-Item -ItemType Directory -Force -Path (Split-Path $OutZip) | Out-Null
  if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $OutZip
  Write-Output "Kit listo: $OutZip ($([math]::Round((Get-Item $OutZip).Length / 1KB)) KB)"
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
