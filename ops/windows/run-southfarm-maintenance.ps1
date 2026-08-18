[CmdletBinding()]
param(
  [string]$BackendPath = (Join-Path $env:LOCALAPPDATA "SouthFarm\runtime\backend"),
  [string]$NodePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\node-v22.23.1-win-x64\node.exe"),
  [string]$DatabasePath = (Join-Path $env:LOCALAPPDATA "SouthFarm\data\southfarm.db"),
  [string]$MediaRoot = (Join-Path $env:ProgramData "SouthFarm\publish-media"),
  [string]$EvidenceRoot = (Join-Path $env:ProgramData "SouthFarm\publish-evidence"),
  [int]$PublicationRetentionDays = 30,
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$BackendPath = [IO.Path]::GetFullPath($BackendPath)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$DatabasePath = [IO.Path]::GetFullPath($DatabasePath)
$BackupScript = Join-Path $PSScriptRoot "run-southfarm-backup.ps1"
$MaintenanceScript = Join-Path $BackendPath "scripts\southfarm-maintenance.mjs"

if (!(Test-Path -LiteralPath $MaintenanceScript)) { throw "Maintenance script not found: $MaintenanceScript" }
if (!(Test-Path -LiteralPath $DatabasePath)) { throw "Database not found: $DatabasePath" }
if ($PublicationRetentionDays -lt 1) { throw "PublicationRetentionDays must be positive." }
if ($Apply) {
  try {
    & $BackupScript -BackendPath $BackendPath -NodePath $NodePath -DatabasePath $DatabasePath -Label "pre-maintenance"
  } catch {
    throw ("Maintenance stopped because the pre-maintenance backup failed: {0}" -f $_.Exception.Message)
  }
}

$arguments = @($MaintenanceScript, "--db", $DatabasePath)
if ($Apply) { $arguments += "--apply" }
& $NodePath @arguments
if ($LASTEXITCODE -ne 0) { throw "SouthFarm maintenance failed with exit code $LASTEXITCODE" }

function Get-ContainedOldFiles([string]$Root, [datetime]$Cutoff) {
  if (!(Test-Path -LiteralPath $Root -PathType Container)) { return @() }
  $resolvedRoot = [IO.Path]::GetFullPath($Root)
  return @(Get-ChildItem -LiteralPath $resolvedRoot -File -Recurse | Where-Object {
    $_.LastWriteTimeUtc -lt $Cutoff.ToUniversalTime() -and -not ([IO.Path]::GetFullPath($_.FullName).StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -eq $false)
  })
}

$publicationCutoff = (Get-Date).ToUniversalTime().AddDays(-$PublicationRetentionDays)
$retentionSql = @"
SELECT media.private_path AS relative_path
FROM publication_media media
JOIN publication_jobs job ON job.media_id = media.id
WHERE job.status IN ('completed', 'failed', 'cancelled')
  AND COALESCE(job.completed_at, job.updated_at, job.created_at) < ?
"@
$eligibleMedia = @()
try {
  $sqliteScript = "const Database=require('better-sqlite3'); const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify(db.prepare(process.argv[2]).all(process.argv[3]))); db.close();"
  $rows = & $NodePath -e $sqliteScript $DatabasePath $retentionSql $publicationCutoff.ToString('o') 2>$null
  if ($LASTEXITCODE -eq 0 -and $rows) { $eligibleMedia = @($rows | ConvertFrom-Json) }
} catch { throw "Could not inspect publication retention candidates without deleting anything." }
$mediaCandidates = @()
$mediaRootFull = [IO.Path]::GetFullPath($MediaRoot)
foreach ($row in $eligibleMedia) {
  $relative = [string]$row.relative_path; if ([string]::IsNullOrWhiteSpace($relative)) { continue }
  $candidate = [IO.Path]::GetFullPath((Join-Path $mediaRootFull $relative))
  if ($candidate.StartsWith($mediaRootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $mediaCandidates += $candidate }
}
$evidenceCandidates = Get-ContainedOldFiles $EvidenceRoot $publicationCutoff
$summary = [pscustomobject]@{ publication_mode = if ($Apply) { 'apply' } else { 'dry-run' }; publication_media_eligible = $mediaCandidates.Count; publication_evidence_eligible = $evidenceCandidates.Count; publication_cutoff = $publicationCutoff.ToString('o') }
if ($Apply) {
  foreach ($path in $mediaCandidates + $evidenceCandidates.FullName) { Remove-Item -LiteralPath $path -Force }
}
$summary | ConvertTo-Json -Compress
