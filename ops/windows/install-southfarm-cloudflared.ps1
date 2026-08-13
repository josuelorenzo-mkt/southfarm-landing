[CmdletBinding()]
param(
  [string]$TunnelId = "d93e5fe4-24b6-4141-9047-5dbc4c004187",
  [string]$Hostname = "api.southfarm.tech",
  [string]$CredentialSource = "\\wsl$\Ubuntu\home\josue\.cloudflared\d93e5fe4-24b6-4141-9047-5dbc4c004187.json",
  [string]$InstallRoot = "C:\ProgramData\SouthFarm\cloudflared",
  [string]$SystemProfileCloudflared = "C:\Windows\System32\config\systemprofile\.cloudflared",
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Este instalador debe ejecutarse en PowerShell como Administrador para registrar Cloudflare Tunnel como servicio del sistema."
}
if (!(Test-Path -LiteralPath $CredentialSource)) { throw "No se encontró la credencial del túnel en: $CredentialSource" }

New-Item -ItemType Directory -Force -Path $InstallRoot, $SystemProfileCloudflared | Out-Null
$cloudflaredPath = Join-Path $InstallRoot "cloudflared.exe"
$credentialName = "$TunnelId.json"
$credentialPath = Join-Path $SystemProfileCloudflared $credentialName
$configPath = Join-Path $SystemProfileCloudflared "config.yml"
$logPath = Join-Path $InstallRoot "cloudflared.log"

if (!(Test-Path -LiteralPath $cloudflaredPath)) {
  $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  Invoke-WebRequest -Uri $downloadUrl -OutFile $cloudflaredPath -UseBasicParsing
}
if (!(Test-Path -LiteralPath $cloudflaredPath)) { throw "No se pudo descargar cloudflared." }

Copy-Item -LiteralPath $CredentialSource -Destination $credentialPath -Force
$credentialForYaml = $credentialPath.Replace("\", "/")
$logForYaml = $logPath.Replace("\", "/")
$config = @"
tunnel: $TunnelId
credentials-file: $credentialForYaml
logfile: $logForYaml
loglevel: info
ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:3001
  - service: http_status:404
"@
[IO.File]::WriteAllText($configPath, $config.TrimStart())

$validation = & $cloudflaredPath --config $configPath tunnel ingress validate 2>&1
if ($LASTEXITCODE -ne 0) { throw "La configuración de Cloudflare Tunnel no pasó validación: $validation" }

$service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Push-Location $InstallRoot
  try { & $cloudflaredPath service install } finally { Pop-Location }
  $service = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
}
if ($null -eq $service) { throw "cloudflared service install no creó el servicio esperado." }

$imagePath = "`"$cloudflaredPath`" --config=`"$configPath`" tunnel run"
$sc = Join-Path $env:WINDIR "System32\sc.exe"
& $sc config cloudflared binPath= $imagePath start= auto obj= LocalSystem | Out-Null
& $sc failure cloudflared reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null
Write-Output "Configured Windows service: cloudflared"
Write-Output ("Config: " + $configPath)
Write-Output ("Origin: http://127.0.0.1:3001")

if ($StartNow) {
  Start-Service -Name "cloudflared"
  Write-Output "Started Windows service: cloudflared"
}
