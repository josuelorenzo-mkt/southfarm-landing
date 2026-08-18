[CmdletBinding()]
param(
  [string]$HealthUrl = "http://127.0.0.1:3001/api/health",
  [string]$SupervisorTaskName = "SouthFarm API",
  [Parameter(Mandatory = $true)]
  [string]$BackendPath,
  [string]$LogPath = (Join-Path $env:ProgramData "SouthFarm\logs\southfarm-api-watchdog.log")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Log([string]$Message) {
  Add-Content -LiteralPath $LogPath -Value ("{0:o} {1}" -f (Get-Date), $Message)
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    $response = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 8
    if ($response.status -eq "ok") {
      Log "Health check OK (attempt $attempt)."
      exit 0
    }
    Log "Health check returned status '$($response.status)' (attempt $attempt)."
  } catch {
    Log "Health check failed (attempt $attempt): $($_.Exception.Message)"
  }
  if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
}

# A hung Node process can keep the supervisor waiting forever. Kill only the
# SouthFarm backend command line, never unrelated Node processes.
$backendEntry = [IO.Path]::GetFullPath((Join-Path $BackendPath "dist\index.js"))
$backendProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($backendEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0
}
if ($backendProcesses) {
  foreach ($process in $backendProcesses) {
    Log "Stopping unresponsive SouthFarm backend PID $($process.ProcessId)."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Log "Supervisor will restart the backend after the watchdog intervention."
} else {
  Log "No SouthFarm backend process found; requesting supervisor start."
  Start-ScheduledTask -TaskName $SupervisorTaskName -ErrorAction SilentlyContinue
}
exit 1
