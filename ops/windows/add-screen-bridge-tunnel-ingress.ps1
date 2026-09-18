# Agrega screen.<dominio> al túnel productivo de Cloudflare para el Screen Bridge.
# Edita el config.yml del servicio (ACL SYSTEM/Admins), valida y reinicia cloudflared.
# Ejecutar en PowerShell como Administrador. El CNAME en Cloudflare se crea aparte.
[CmdletBinding()]
param(
  [string]$Hostname = "screen.southfarm.tech",
  [string]$BridgePort = 8100,
  [string]$SystemProfileCloudflared = "C:\Windows\System32\config\systemprofile\.cloudflared",
  [string]$InstallRoot = "C:\ProgramData\SouthFarm\cloudflared"
)

$ErrorActionPreference = "Stop"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Este script debe ejecutarse en PowerShell como Administrador para editar el config del túnel."
}
$configPath = Join-Path $SystemProfileCloudflared "config.yml"
if (!(Test-Path -LiteralPath $configPath)) { throw "No se encontró $configPath" }

$content = [IO.File]::ReadAllText($configPath)
if ($content -match [regex]::Escape("hostname: $Hostname")) {
  Write-Output "El ingress de $Hostname ya existe en el config; nada que cambiar."
} else {
  $rule = "  - hostname: $Hostname`n    service: http://127.0.0.1:$BridgePort`n"
  $catchAll = "  - service: http_status:404"
  if (!$content.Contains($catchAll)) { throw "No encontré el catch-all 404 en el config; editarlo a mano." }
  $content = $content.Replace($catchAll, "$rule$catchAll")
  [IO.File]::WriteAllText($configPath, $content)
  Write-Output "Ingress agregado: $Hostname -> http://127.0.0.1:$BridgePort"
}

$cloudflaredPath = Join-Path $InstallRoot "cloudflared.exe"
$validation = & $cloudflaredPath --config $configPath tunnel ingress validate 2>&1
if ($LASTEXITCODE -ne 0) { throw "Validación de ingress falló: $validation" }
Write-Output "Config validado."

Restart-Service -Name "cloudflared"
Start-Sleep -Seconds 4
$service = Get-Service -Name "cloudflared"
Write-Output "cloudflared reiniciado (estado: $($service.Status))."

Write-Output ""
Write-Output "PASO QUE FALTA (una vez): en el dashboard de Cloudflare, zona southfarm.tech,"
Write-Output "crear registro CNAME: $Hostname -> <UUID-del-túnel>.cfargotunnel.com (proxied)."
Write-Output "El UUID del túnel está en la primera línea de $configPath"
