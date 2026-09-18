# Instalador del SouthFarm Screen Bridge como servicio 24/7 (tarea programada SYSTEM).
# Copia el runtime a ProgramData (desacoplado de los checkouts), genera token de auth,
# registra la tarea y arranca. Ejecutar en PowerShell como Administrador.
[CmdletBinding()]
param(
  [string]$TaskName = "SouthFarm Screen Bridge",
  [string]$SourcePath = "",
  [string]$NodePath = "",
  [string]$AdbPath = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe",
  [string]$ScrcpyJarPath = "",
  [string]$RuntimeRoot = (Join-Path $env:ProgramData "SouthFarm"),
  [int]$Bitrate = 2000000,
  [int]$MaxSize = 720,
  [int]$Port = 8100,
  [string]$AuthToken = "",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
# Defaults resueltos en el cuerpo: $PSScriptRoot y $env:LOCALAPPDATA pueden no
# estar disponibles durante el binding de parámetros según cómo se invoque.
if ([string]::IsNullOrWhiteSpace($SourcePath)) { $SourcePath = Join-Path $PSScriptRoot "..\..\screen-bridge" }
if ([string]::IsNullOrWhiteSpace($NodePath)) { $NodePath = Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe" }
if ([string]::IsNullOrWhiteSpace($ScrcpyJarPath)) { $ScrcpyJarPath = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v4.1\scrcpy-server" }
$SourcePath = [IO.Path]::GetFullPath($SourcePath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$AdbPath = [IO.Path]::GetFullPath($AdbPath)
$ScrcpyJarPath = [IO.Path]::GetFullPath($ScrcpyJarPath)
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$RuntimeDirectory = Join-Path $RuntimeRoot "screen-bridge"
$LogDirectory = Join-Path $RuntimeRoot "logs"
$RuntimeConfigPath = Join-Path $RuntimeRoot "config\screen-bridge-runtime.json"
$SupervisorPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "southfarm-screen-bridge-supervisor.ps1"))

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Este instalador debe ejecutarse en PowerShell como Administrador para registrar el servicio 24/7 como SYSTEM."
}
if (!(Test-Path -LiteralPath $SupervisorPath)) { throw "Supervisor not found: $SupervisorPath" }
if (!(Test-Path -LiteralPath (Join-Path $SourcePath "server.mjs"))) { throw "server.mjs not found under: $SourcePath" }
if (!(Test-Path -LiteralPath $NodePath)) { throw "Node executable not found: $NodePath" }
if (!(Test-Path -LiteralPath $AdbPath)) { throw "adb not found: $AdbPath" }
if (!(Test-Path -LiteralPath $ScrcpyJarPath)) { throw "scrcpy-server not found: $ScrcpyJarPath" }

# 1. Runtime copy desacoplada de los checkouts (server.mjs + ws + devices.json si no existe).
New-Item -ItemType Directory -Force -Path $RuntimeDirectory, $LogDirectory, (Join-Path $RuntimeRoot "config") | Out-Null
Copy-Item -LiteralPath (Join-Path $SourcePath "server.mjs") -Destination (Join-Path $RuntimeDirectory "server.mjs") -Force
Copy-Item -LiteralPath (Join-Path $SourcePath "package.json") -Destination (Join-Path $RuntimeDirectory "package.json") -Force
if (Test-Path -LiteralPath (Join-Path $SourcePath "node_modules")) {
  Copy-Item -LiteralPath (Join-Path $SourcePath "node_modules") -Destination (Join-Path $RuntimeDirectory "node_modules") -Recurse -Force
}
$runtimeDevicesPath = Join-Path $RuntimeDirectory "devices.json"
if (!(Test-Path -LiteralPath $runtimeDevicesPath) -and (Test-Path -LiteralPath (Join-Path $SourcePath "devices.json"))) {
  Copy-Item -LiteralPath (Join-Path $SourcePath "devices.json") -Destination $runtimeDevicesPath
}

# 2. Token de auth (generado si no se pasa) con ACL SYSTEM/Admins.
if ([string]::IsNullOrWhiteSpace($AuthToken)) {
  $AuthToken = -join ((1..48) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
}
$runtimeConfig = [ordered]@{
  auth_token = [string]$AuthToken
  port = $Port
  bitrate = $Bitrate
  max_size = $MaxSize
  created_at = (Get-Date).ToUniversalTime().ToString("o")
}
[IO.File]::WriteAllText($RuntimeConfigPath, ($runtimeConfig | ConvertTo-Json -Compress))
$configAcl = New-Object System.Security.AccessControl.FileSecurity
$configAcl.SetAccessRuleProtection($true, $false)
$systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminsSid, "FullControl", "Allow")))
Set-Acl -LiteralPath $RuntimeConfigPath -AclObject $configAcl

# 3. Tarea programada: supervisor como SYSTEM al arrancar el sistema.
$supervisorArgs = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $SupervisorPath,
  "-BridgePath", $RuntimeDirectory,
  "-NodePath", $NodePath,
  "-RuntimeConfigPath", $RuntimeConfigPath,
  "-LogDirectory", $LogDirectory,
  "-AdbPath", $AdbPath,
  "-ScrcpyJarPath", $ScrcpyJarPath,
  "-Bitrate", [string]$Bitrate,
  "-MaxSize", [string]$MaxSize,
  "-Port", [string]$Port
)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($supervisorArgs -join " ")
$trigger = New-ScheduledTaskTrigger -AtStartup
$principalTask = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings | Out-Null

Write-Output "Tarea registrada: $TaskName"
Write-Output "Runtime: $RuntimeDirectory"
Write-Output "Config:  $RuntimeConfigPath"
Write-Output "Logs:    $LogDirectory"
Write-Output "Puerto:  $Port (bitrate $Bitrate, maxSize $MaxSize)"
Write-Output ""
Write-Output "AUTH TOKEN (usar como NEXT_PUBLIC_SCREEN_BRIDGE_TOKEN en la web):"
Write-Output $AuthToken
if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  $health = $null
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health?token=$AuthToken" -TimeoutSec 5 } catch {}
  if ($null -ne $health -and $health.ok) { Write-Output "Bridge ARRIBA y saludable." } else { Write-Output "Bridge iniciado; salud aún no responde (revisar logs en $LogDirectory)." }
}
