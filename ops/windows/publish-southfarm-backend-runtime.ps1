[CmdletBinding()]
param(
  [string]$SourceBackendPath = (Join-Path $PSScriptRoot "..\..\backend"),
  [string]$RuntimeBackendPath = (Join-Path $env:LOCALAPPDATA "SouthFarm\runtime\backend")
)

$ErrorActionPreference = "Stop"
$SourceBackendPath = [IO.Path]::GetFullPath($SourceBackendPath)
$RuntimeBackendPath = [IO.Path]::GetFullPath($RuntimeBackendPath)
$sourceDist = Join-Path $SourceBackendPath "dist"
$sourceModules = Join-Path $SourceBackendPath "node_modules"
if (!(Test-Path -LiteralPath (Join-Path $sourceDist "index.js"))) { throw "Backend build not found: $(Join-Path $sourceDist 'index.js')" }
if (!(Test-Path -LiteralPath $sourceModules)) { throw "Backend dependencies not found: $sourceModules" }

New-Item -ItemType Directory -Force -Path $RuntimeBackendPath | Out-Null
foreach ($name in @("dist", "node_modules", "scripts")) {
  $source = Join-Path $SourceBackendPath $name
  if (Test-Path -LiteralPath $source) {
    $destination = Join-Path $RuntimeBackendPath $name
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    # Copy the contents into the existing runtime directory. Copying the
    # directory itself creates an accidental nested `dist\dist` tree when a
    # runtime has already been published once.
    Copy-Item -Path (Join-Path $source "*") -Destination $destination -Recurse -Force
  }
}
foreach ($name in @("package.json", "package-lock.json")) {
  $source = Join-Path $SourceBackendPath $name
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $RuntimeBackendPath $name) -Force
  }
}

$metadata = [ordered]@{
  published_at = (Get-Date).ToUniversalTime().ToString("o")
  source_backend = $SourceBackendPath
  runtime_backend = $RuntimeBackendPath
  dist_index = (Get-Item -LiteralPath (Join-Path $RuntimeBackendPath "dist\index.js")).LastWriteTimeUtc.ToString("o")
}
[IO.File]::WriteAllText((Join-Path $RuntimeBackendPath "runtime-metadata.json"), ($metadata | ConvertTo-Json -Depth 3))
Write-Output ("Published SouthFarm backend runtime to " + $RuntimeBackendPath)
