# Verificación de la oficina EEUU: corre todos los chequeos y devuelve PASS/FAIL.
# Pensado para que un agente (o un humano) valide el estado sin ambiguüedad.
# Código de salida: 0 = todo PASS, 1 = hay al menos un FAIL.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string]$AuthToken,
  [string]$PublicUrl = "https://screen-us.southfarm.tech",
  [int]$BridgePort = 8100
)
$ErrorActionPreference = "Continue"
$results = [System.Collections.Generic.List[string]]::new()
function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  $results.Add(("{0} {1}{2}" -f ($(if ($Ok) { "PASS" } else { "FAIL" })), $Name, $(if ($Detail) { " -- $Detail" } else { "" })))
}

# ─── Toolchain ───
$adb = "C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe"
$node = Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"
$scrcpy = "C:\SouthFarm\toolchain\scrcpy\scrcpy-server-v4.1"
Check "adb instalado" (Test-Path $adb)
Check "Node 22 instalado" (Test-Path $node)
Check "scrcpy-server presente" (Test-Path $scrcpy)

# ─── Bridge ───
$runtime = Join-Path $env:ProgramData "SouthFarm\screen-bridge"
Check "bridge runtime presente" (Test-Path (Join-Path $runtime "server.mjs"))
$localHealth = $null
try { $localHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/api/health?token=$AuthToken" -TimeoutSec 5 } catch {}
Check "bridge local responde" ($null -ne $localHealth)
$devJson = Join-Path $runtime "devices.json"
if (Test-Path $devJson) {
  try { $devs = Get-Content $devJson -Raw | ConvertFrom-Json } catch { $devs = $null }
  $serialCount = 0
  if ($devs) { $serialCount = ($devs.PSObject.Properties | Measure-Object).Count }
  Check "devices.json parseable" ($null -ne $devs) "$serialCount telefono(s) registrado(s)"
} else { Check "devices.json presente" $false }

# ─── Teléfonos ───
if (Test-Path $adb) {
  $serials = (& $adb devices | Select-String -Pattern "\tdevice$").Count
  Check "telefonos autorizados por ADB" ($serials -gt 0) "$serials conectado(s)"
}

# ─── Túnel público ───
try {
  $resp = Invoke-WebRequest -Uri "$PublicUrl/api/health?token=$AuthToken" -TimeoutSec 15 -UseBasicParsing
  Check "tunel publico responde" ($resp.StatusCode -eq 200)
} catch {
  Check "tunel publico responde" $false $_.Exception.Message
}

# ─── Servicios y auto-arranque ───
$cloudflared = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
Check "servicio cloudflared" ($null -ne $cloudflared -and $cloudflared.Status -eq "Running")
$startupCmd = Join-Path ([Environment]::GetFolderPath("Startup")) "iniciar-screen-bridge.cmd"
Check "auto-arranque del bridge" (Test-Path $startupCmd)
$winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
Check "auto-login configurado" ($winlogon.AutoAdminLogon -eq "1") "usuario: $($winlogon.DefaultUserName)"
$rdp = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server").fDenyTSConnections
Check "RDP habilitado" ($rdp -eq 0)
$standby = (powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>$null | Select-String "Current AC Power Setting" | Out-String)
Check "suspension AC deshabilitada" ($standby -match "0x0\s*$") ($standby.Trim())
$tailscale = "C:\Program Files\Tailscale IPN\tailscale.exe"
if (Test-Path $tailscale) {
  $tsIp = (& $tailscale ip -4 2>$null | Out-String).Trim()
  Check "Tailscale conectado" ($tsIp -match "^100\.") $tsIp
} else { Check "Tailscale instalado" $false }

# ─── Publisher (opcional) ───
$pubTasks = Get-ScheduledTask -TaskName "SouthFarm Publisher Worker *" -ErrorAction SilentlyContinue
if ($pubTasks) {
  Check "publisher workers registrados" $true (@($pubTasks).Count.ToString() + " tarea(s)")
} else {
  $results.Add("INFO publisher workers: ninguno registrado (solo necesario para publicar videos)")
}

$results | ForEach-Object { Write-Output $_ }
$failCount = ($results | Where-Object { $_ -like "FAIL*" }).Count
Write-Output ""
Write-Output "RESULTADO: $($results.Count - $failCount - ($results | Where-Object { $_ -like 'INFO*' }).Count) PASS / $failCount FAIL"
exit $(if ($failCount -gt 0) { 1 } else { 0 })
