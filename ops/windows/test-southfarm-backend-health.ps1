[CmdletBinding()]
param(
  [string]$BackendPath = (Join-Path $PSScriptRoot "..\..\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [int]$Port = 3011
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$outputLog = Join-Path $env:TEMP "southfarm-health-test.out.log"
$errorLog = Join-Path $env:TEMP "southfarm-health-test.err.log"

$env:PORT = [string]$Port
$env:SOUTHFARM_DB_PATH = $DatabasePath
$env:JWT_SECRET = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_SECRET", "User")
$env:SOUTHFARM_JWT_LEGACY_SECRETS = [Environment]::GetEnvironmentVariable("SOUTHFARM_JWT_LEGACY_SECRETS", "User")
$env:NODE_ENV = "production"
$env:SOUTHFARM_AUTO_PLANNER_ENABLED = "false"
$env:SOUTHFARM_SCHEDULER_MODE = "fixed"

$process = Start-Process -FilePath $NodePath -ArgumentList @("dist\index.js") -WorkingDirectory $BackendPath -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru -WindowStyle Hidden
try {
  $health = $null
  for ($attempt = 1; $attempt -le 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -TimeoutSec 2
      break
    } catch {
      if ($process.HasExited) { break }
    }
  }
  if ($null -eq $health) {
    $output = if (Test-Path -LiteralPath $outputLog) { Get-Content -LiteralPath $outputLog -Raw } else { "" }
    $errors = if (Test-Path -LiteralPath $errorLog) { Get-Content -LiteralPath $errorLog -Raw } else { "" }
    throw "Local health endpoint did not become ready. stdout=$output stderr=$errors"
  }
  $health | ConvertTo-Json -Compress
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
  $process.WaitForExit()
}
