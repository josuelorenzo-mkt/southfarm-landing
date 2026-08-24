# Supervisor del SouthFarm Screen Bridge: mantiene node server.mjs corriendo
# 24/7 con reinicio por backoff y rotación de log. Lo registra el instalador
# install-southfarm-screen-bridge-task.ps1 como tarea programada de SYSTEM.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BridgePath,
  [Parameter(Mandatory = $true)]
  [string]$NodePath,
  [Parameter(Mandatory = $true)]
  [string]$RuntimeConfigPath,
  [Parameter(Mandatory = $true)]
  [string]$LogDirectory,
  [string]$AdbPath = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe",
  [string]$ScrcpyJarPath = "",
  [int]$Bitrate = 2000000,
  [int]$MaxSize = 720,
  [int]$Port = 8100,
  [int]$InitialRestartDelaySeconds = 5,
  [int]$MaxRestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"
$BridgePath = [IO.Path]::GetFullPath($BridgePath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$RuntimeConfigPath = [IO.Path]::GetFullPath($RuntimeConfigPath)
$LogDirectory = [IO.Path]::GetFullPath($LogDirectory)
$OutputLog = Join-Path $LogDirectory "screen-bridge.out.log"
$ErrorLog = Join-Path $LogDirectory "screen-bridge.error.log"

New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
if (!(Test-Path -LiteralPath $NodePath)) { throw "Node executable not found: $NodePath" }
if (!(Test-Path -LiteralPath (Join-Path $BridgePath "server.mjs"))) { throw "server.mjs not found under: $BridgePath" }
if (!(Test-Path -LiteralPath $RuntimeConfigPath)) { throw "Runtime config not found: $RuntimeConfigPath" }

function Rotate-LogIfNeeded([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  if ((Get-Item -LiteralPath $Path).Length -lt 10MB) { return }
  $rotatedPath = "$Path.1"
  Move-Item -LiteralPath $Path -Destination $rotatedPath -Force
}

$runtimeConfig = Get-Content -LiteralPath $RuntimeConfigPath -Raw | ConvertFrom-Json
$authToken = [string]$runtimeConfig.auth_token
if ([string]::IsNullOrWhiteSpace($authToken)) { throw "auth_token vacío en $RuntimeConfigPath" }

$restartDelay = $InitialRestartDelaySeconds
while ($true) {
  try {
    Rotate-LogIfNeeded $OutputLog
    Rotate-LogIfNeeded $ErrorLog
    $env:SCREEN_BRIDGE_PORT = [string]$Port
    $env:SCREEN_AUTH_TOKEN = $authToken
    $env:SCREEN_ADB = $AdbPath
    if (![string]::IsNullOrWhiteSpace($ScrcpyJarPath)) { $env:SCREEN_SCRCPY_JAR = $ScrcpyJarPath }
    $env:SCREEN_VIDEO_BITRATE = [string]$Bitrate
    $env:SCREEN_MAX_SIZE = [string]$MaxSize
    "[$(Get-Date -Format o)] iniciando bridge (puerto $Port, bitrate $Bitrate, maxSize $MaxSize)" | Add-Content -LiteralPath $OutputLog
    Push-Location $BridgePath
    try {
      & $NodePath server.mjs 2>> $ErrorLog 1>> $OutputLog
    } finally { Pop-Location }
    $exitCode = $LASTEXITCODE
    "[$(Get-Date -Format o)] bridge salió (exit=$exitCode); reinicio en ${restartDelay}s" | Add-Content -LiteralPath $OutputLog
  } catch {
    # El supervisor NUNCA muere: cualquier error de log/rotación se registra y se sigue.
    "[$(Get-Date -Format o)] supervisor: $($_.Exception.Message)" | Add-Content -LiteralPath $ErrorLog
    $exitCode = 1
  }
  Start-Sleep -Seconds $restartDelay
  $restartDelay = [Math]::Min($restartDelay * 2, $MaxRestartDelaySeconds)
  # Tras una corrida estable (>5 min) volvemos al delay base.
  if ($exitCode -eq 0) { $restartDelay = $InitialRestartDelaySeconds }
}
