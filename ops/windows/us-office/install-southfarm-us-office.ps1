# Instalador one-shot de la oficina EEUU de SouthFarm.
# Prepara la PC completa para operar celulares Android de la flota:
#   1. Toolchain: adb (platform-tools), Node portable, scrcpy-server, cloudflared
#      (se descargan de las URLs oficiales si no existen ya).
#   2. Screen Bridge: runtime en ProgramData + token + auto-arranque al login
#      (misma vía productiva que la oficina AR: supervisor inmortal por Startup).
#   3. Túnel Cloudflare (opcional): registra el servicio cloudflared con el token
#      del túnel creado en el dashboard de Zero Trust.
#   4. Windows: nunca suspender, RDP habilitado, SSH opcional.
# Ejecutar en PowerShell COMO ADMINISTRADOR desde la carpeta del kit descomprimido.
[CmdletBinding()]
param(
  # Token del screen-bridge (el MISMO que usa la oficina AR, horneado en Vercel).
  [Parameter(Mandatory = $true)]
  [string]$AuthToken,
  # Token del túnel Cloudflare (dashboard Zero Trust -> Networks -> Tunnels -> Install connector).
  [string]$CloudflaredToken = "",
  [int]$BridgePort = 8100,
  [int]$Bitrate = 2000000,
  [int]$MaxSize = 720,
  [switch]$EnableSsh,
  [switch]$SkipDownloads
)

$ErrorActionPreference = "Stop"
$kitDir = [IO.Path]::GetFullPath($PSScriptRoot)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Ejecutar PowerShell como Administrador (botón derecho -> Ejecutar como administrador)."
}

# ─── Rutas destino ───
$toolchainRoot = "C:\SouthFarm\toolchain"
$adbDir = Join-Path $toolchainRoot "android-sdk\platform-tools"
$adbPath = Join-Path $adbDir "adb.exe"
$nodeDir = Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64"
$nodeExe = Join-Path $nodeDir "node.exe"
$scrcpyJar = Join-Path $toolchainRoot "scrcpy\scrcpy-server-v4.1"
$cloudflaredExe = Join-Path $toolchainRoot "cloudflared\cloudflared.exe"
$programDataRoot = Join-Path $env:ProgramData "SouthFarm"
$bridgeRuntime = Join-Path $programDataRoot "screen-bridge"
$logDirectory = Join-Path $programDataRoot "logs"
$configPath = Join-Path $programDataRoot "config\screen-bridge-runtime.json"

function Get-File([string]$Url, [string]$Destination) {
  Write-Output "Descargando $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

Write-Output "== SouthFarm Oficina EEUU =="
New-Item -ItemType Directory -Force -Path $toolchainRoot, $adbDir, (Split-Path $scrcpyJar), (Split-Path $cloudflaredExe), `
  $bridgeRuntime, $logDirectory, (Split-Path $configPath) | Out-Null

# ─── 1. Toolchain ───
if (!$SkipDownloads) {
  if (!(Test-Path $adbPath)) {
    $zip = Join-Path $env:TEMP "platform-tools.zip"
    $extractRoot = Join-Path $env:TEMP "platform-tools-extract"
    Get-File "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" $zip
    if (Test-Path $extractRoot) { Remove-Item $extractRoot -Recurse -Force }
    Expand-Archive -LiteralPath $zip -DestinationPath $extractRoot -Force
    # El zip trae platform-tools/ adentro.
    Copy-Item (Join-Path $extractRoot "platform-tools\*") $adbDir -Recurse -Force
    Remove-Item $zip, $extractRoot -Recurse -Force
  }
  if (!(Test-Path $nodeExe)) {
    $zip = Join-Path $env:TEMP "node-portable.zip"
    Get-File "https://nodejs.org/dist/v22.23.1/node-v22.23.1-win-x64.zip" $zip
    Expand-Archive -LiteralPath $zip -DestinationPath (Split-Path $nodeDir) -Force
    Remove-Item $zip -Force
  }
  if (!(Test-Path $scrcpyJar)) {
    Get-File "https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1" $scrcpyJar
  }
}
foreach ($required in @(@($adbPath, "adb"), @($nodeExe, "Node"), @($scrcpyJar, "scrcpy-server"))) {
  if (!(Test-Path $required[0])) { throw "$($required[1]) no encontrado en $($required[0])" }
}
& $adbPath version | Select-Object -First 1

# ─── 2. Screen Bridge runtime + auto-arranque ───
Copy-Item (Join-Path $kitDir "screen-bridge\server.mjs") $bridgeRuntime -Force
Copy-Item (Join-Path $kitDir "screen-bridge\package.json") $bridgeRuntime -Force
Copy-Item (Join-Path $kitDir "screen-bridge\node_modules") $bridgeRuntime -Recurse -Force
$devicesJson = Join-Path $bridgeRuntime "devices.json"
if (!(Test-Path $devicesJson)) { Set-Content -LiteralPath $devicesJson -Value "{}" -Encoding UTF8 }

$runtimeConfig = [ordered]@{
  auth_token = [string]$AuthToken
  port       = $BridgePort
  bitrate    = $Bitrate
  max_size   = $MaxSize
  created_at = (Get-Date).ToUniversalTime().ToString("o")
}
[IO.File]::WriteAllText($configPath, ($runtimeConfig | ConvertTo-Json -Compress))
$configAcl = New-Object System.Security.AccessControl.FileSecurity
$configAcl.SetAccessRuleProtection($true, $false)
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "Allow")))
Set-Acl -LiteralPath $configPath -AclObject $configAcl

$startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "iniciar-screen-bridge.cmd"
@"
@echo off
rem SouthFarm Screen Bridge (oficina EEUU): auto-arranque al iniciar sesion.
start "SouthFarm Screen Bridge" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "& '$(Join-Path $kitDir 'southfarm-screen-bridge-supervisor.ps1')' -BridgePath '$bridgeRuntime' -NodePath '$nodeExe' -RuntimeConfigPath '$configPath' -LogDirectory '$logDirectory' -Port $BridgePort"
"@ | Set-Content -LiteralPath $startupCmd -Encoding ASCII
Write-Output "Auto-arranque registrado: $startupCmd"

# Arrancar el supervisor ahora mismo (sesión actual) si el puerto sigue libre.
$portInUse = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
if (-not $portInUse) {
  Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    "& '$(Join-Path $kitDir 'southfarm-screen-bridge-supervisor.ps1')' -BridgePath '$bridgeRuntime' -NodePath '$nodeExe' -RuntimeConfigPath '$configPath' -LogDirectory '$logDirectory' -Port $BridgePort"
  Start-Sleep -Seconds 5
}
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/api/health?token=$AuthToken" -TimeoutSec 5
  Write-Output "Bridge ARRIBA: $($health | ConvertTo-Json -Compress)"
} catch {
  Write-Warning "El bridge aún no responde en el puerto $BridgePort; revisar logs en $logDirectory."
}

# ─── 3. Túnel Cloudflare (opcional) ───
if (!$SkipDownloads -and !(Test-Path $cloudflaredExe)) {
  Get-File "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" $cloudflaredExe
}
if (![string]::IsNullOrWhiteSpace($CloudflaredToken)) {
  & $cloudflaredExe service install $CloudflaredToken
  Write-Output "Servicio cloudflared instalado."
} else {
  Write-Output "Sin -CloudflaredToken: instalar el túnel después con:"
  Write-Output "  $cloudflaredExe service install <TOKEN>"
}

# ─── 4. Configuración de Windows ───
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 15
Set-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0
Enable-NetFirewallRule -DisplayGroup "Escritorio remoto", "Remote Desktop" -ErrorAction SilentlyContinue
Write-Output "Suspensión deshabilitada (AC) y RDP habilitado."

# Auto-login: requiere contraseña interactiva, NO automatizable acá.
Write-Output ""
Write-Output "PENDIENTE MANUAL: ejecutar 'netplwiz', elegir el usuario y destildar"
Write-Output "'Los usuarios deben escribir su nombre y contrasena' (ingresar la contrasena)."
Write-Output "Sin esto, tras un reinicio nadie abre sesion y el bridge queda caido."

if ($EnableSsh) {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Set-Service sshd -StartupType Automatic
  Start-Service sshd
  Write-Output "OpenSSH Server habilitado (puerto 22)."
}

Write-Output ""
Write-Output "== Instalación completa =="
Write-Output "Siguiente paso: verificar Tailscale, luego conectar un celular y probar la vista en vivo."
