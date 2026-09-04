# Instalador del Publisher Worker para la oficina EEUU.
# A diferencia del instalador AR (acoplado al backend local), este apunta a la
# API remota https://api.southfarm.tech con el worker token global.
# Un teléfono = una tarea: correr UNA VEZ POR CADA celular que va a publicar.
# Requiere: el celular ya emparejado en Southfarm y autorizado por ADB.
# Ejecutar en PowerShell COMO ADMINISTRADOR, con la sesión del usuario que
# queda logueada (la tarea corre interactiva, igual que en la oficina AR).
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [int]$DeviceId,          # ID numérico en Southfarm (Fleet -> tarjeta del dispositivo)
  [Parameter(Mandatory = $true)] [string]$DeviceSerial,   # serial ADB (adb devices)
  [string]$AndroidId = "",                                # se lee solo del teléfono si se omite
  [string]$ApiUrl = "https://api.southfarm.tech",
  [Parameter(Mandatory = $true)] [string]$WorkerToken,    # el MISMO worker token de la oficina AR (32 bytes base64)
  [string]$WorkerId = "",
  [string]$ForbiddenInstagramAccounts = "santilorennzo",
  [switch]$AllowAllInstagramAccounts,
  [string]$PythonPath = "",
  [string]$FfmpegZipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  [switch]$ValidationOnly
)
$ErrorActionPreference = "Stop"
$kitDir = [IO.Path]::GetFullPath($PSScriptRoot)
$runtimeRoot = Join-Path $env:ProgramData "SouthFarm"
$workerPath = Join-Path $runtimeRoot "publisher-worker"
$adbPath = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe"
$toolsDir = Join-Path $runtimeRoot "tools\ffmpeg"
$supervisorPath = Join-Path $kitDir "southfarm-publisher-supervisor.ps1"
if ([string]::IsNullOrWhiteSpace($WorkerId)) { $WorkerId = "us-windows-$DeviceId" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$ValidationOnly -and !$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Ejecutar PowerShell como Administrador (o usar -ValidationOnly para probar)."
}

# ─── Validaciones previas ───
if (!(Test-Path $adbPath)) { throw "adb no encontrado en $adbPath (correr antes el instalador principal del kit)." }
if (!(Test-Path $supervisorPath)) { throw "Supervisor no encontrado: $supervisorPath" }
try { [Convert]::FromBase64String($WorkerToken) | Out-Null; } catch { throw "WorkerToken no es base64 válido." }
if ([Convert]::FromBase64String($WorkerToken).Length -ne 32) { throw "WorkerToken debe tener 32 bytes (el mismo valor que la oficina AR)." }

$adbState = (& $adbPath -s $DeviceSerial get-state 2>&1 | Out-String).Trim()
if ($adbState -ne "device") { throw "El serial $DeviceSerial no está autorizado en ADB (estado: '$adbState')." }

if ([string]::IsNullOrWhiteSpace($AndroidId)) {
  $AndroidId = (& $adbPath -s $DeviceSerial shell settings get secure android_id 2>&1 | Out-String).Trim()
}
if ([string]::IsNullOrWhiteSpace($AndroidId)) { throw "No se pudo leer el android_id del teléfono." }
Write-Output "Teléfono $DeviceSerial (android_id $AndroidId)"

# ─── Python portátil (embeddable, el worker no tiene dependencias externas) ───
if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = Join-Path $runtimeRoot "tools\python\python.exe" }
if (!(Test-Path $PythonPath)) {
  Write-Output "Descargando Python 3.12 embeddable..."
  $pyDir = Split-Path $PythonPath
  $zip = Join-Path $env:TEMP "python-embed.zip"
  Invoke-WebRequest "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip" -OutFile $zip -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $pyDir | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $pyDir -Force
  Remove-Item $zip -Force
}
if (!(Test-Path $PythonPath)) { throw "Python no quedó disponible en $PythonPath" }
# El Python embeddable ignora PYTHONPATH: registrar el worker en su .pth interno.
Get-ChildItem (Split-Path $PythonPath) -Filter "python*._pth" | ForEach-Object {
  if (-not (Select-String -LiteralPath $_.FullName -Pattern ([regex]::Escape($workerPath)) -Quiet)) {
    Add-Content -LiteralPath $_.FullName -Value $workerPath -Encoding ASCII
  }
}

# ─── ffprobe (validación de videos) ───
$ffprobePath = Join-Path $toolsDir "ffprobe.exe"
if (!(Test-Path $ffprobePath)) {
  Write-Output "Descargando ffmpeg (para ffprobe)..."
  $zip = Join-Path $env:TEMP "ffmpeg-essentials.zip"
  $extract = Join-Path $env:TEMP "ffmpeg-essentials"
  Invoke-WebRequest $FfmpegZipUrl -OutFile $zip -UseBasicParsing
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Copy-Item (Get-ChildItem $extract -Recurse -Filter ffprobe.exe | Select-Object -First 1).FullName $ffprobePath -Force
  Copy-Item (Get-ChildItem $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName (Join-Path $toolsDir "ffmpeg.exe") -Force
  Remove-Item $zip, $extract -Recurse -Force
}

# ─── Código del worker ───
New-Item -ItemType Directory -Force -Path $workerPath | Out-Null
Copy-Item (Join-Path $kitDir "publisher_worker\southfarm_publisher\*") (Join-Path $workerPath "southfarm_publisher") -Recurse -Force

# ─── Config JSON por dispositivo (misma forma que la oficina AR) ───
New-Item -ItemType Directory -Force -Path (Join-Path $runtimeRoot "config"), (Join-Path $runtimeRoot "logs"), (Join-Path $runtimeRoot "publish-media"), (Join-Path $runtimeRoot "publish-evidence") | Out-Null
$config = [ordered]@{
  python_path = $PythonPath
  worker_path = $workerPath
  adb_path = $adbPath
  ffprobe_path = $ffprobePath
  api_url = $ApiUrl
  worker_id = $WorkerId
  run_as_user = $identity.Name
  run_as_sid = $identity.User.Value
  device_id = $DeviceId
  device_serial = $DeviceSerial
  android_id = $AndroidId
  legacy_app_identity = $false
  southfarm_package = "com.example.southfarm_app"
  worker_token = $WorkerToken
  media_root = (Join-Path $runtimeRoot "publish-media")
  evidence_root = (Join-Path $runtimeRoot "publish-evidence")
  log_root = (Join-Path $runtimeRoot "logs")
  forbidden_instagram_accounts = $ForbiddenInstagramAccounts
  allow_all_instagram_accounts = [bool]$AllowAllInstagramAccounts
}
$configPath = Join-Path $runtimeRoot "config\publisher-worker-$DeviceId.json"
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 3))
$configAcl = New-Object System.Security.AccessControl.FileSecurity
$configAcl.SetAccessRuleProtection($true, $false)
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "Allow")))
$configAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($identity.User.Value, "FullControl", "Allow")))
Set-Acl -LiteralPath $configPath -AclObject $configAcl

# ─── Tarea programada interactiva (una por dispositivo, logs separados) ───
$taskName = "SouthFarm Publisher Worker $DeviceId"
$logDirectory = Join-Path $runtimeRoot "logs\publisher-$DeviceId"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$supervisorArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
  "-File", $supervisorPath, "-ConfigPath", $configPath, "-LogDirectory", $logDirectory)
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument ($supervisorArgs -join " ")
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null

Write-Output ""
Write-Output "== Publisher Worker registrado para el dispositivo $DeviceId =="
Write-Output "Config: $configPath"
Write-Output "Logs:   $logDirectory"
Write-Output "Tarea:  $taskName (arranca al iniciar sesion; reinicia con: Start-ScheduledTask -TaskName '$taskName')"
if ($ValidationOnly) {
  & $supervisorPath -ConfigPath $configPath -LogDirectory $logDirectory -ValidateOnly
} else {
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 5
  Get-Content (Join-Path $logDirectory "southfarm-publisher.out.log") -Tail 3 -ErrorAction SilentlyContinue
}
