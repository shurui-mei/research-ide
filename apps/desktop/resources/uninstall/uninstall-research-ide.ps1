[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$KeepInstallation,
  [switch]$KeepData,
  [switch]$DeleteProjects,
  [string]$InstallDir,
  [string]$DataDir,
  [string[]]$Project = @(),
  [string[]]$ConfirmProject = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$InstallId = 'org.researchide.desktop'
$ScriptRoot = Split-Path -Parent $PSCommandPath

function Refuse([string]$Message) {
  throw "Research IDE uninstaller refused: $Message"
}

function Resolve-SafeDirectory([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate)) { Refuse 'empty directory path' }
  if ($Candidate -match "[\r\n|]") { Refuse 'directory path contains a forbidden line break or plan delimiter' }
  $item = Get-Item -LiteralPath $Candidate -Force -ErrorAction Stop
  if (-not $item.PSIsContainer) { Refuse "not a directory: $Candidate" }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse "reparse-point directory is unsafe: $Candidate" }
  $full = [IO.Path]::GetFullPath($item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $root = [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $home = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile')).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if ([string]::Equals($full, $root, [StringComparison]::OrdinalIgnoreCase)) { Refuse 'drive root is never removable' }
  if ([string]::Equals($full, $home, [StringComparison]::OrdinalIgnoreCase)) { Refuse 'home directory is never removable' }
  if ($home.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Refuse "ancestor of home is never removable: $full" }
  return $full
}

function Assert-RegularFileInside([string]$Root, [string]$File) {
  $item = Get-Item -LiteralPath $File -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Refuse "required regular file is unsafe: $File" }
  $full = [IO.Path]::GetFullPath($item.FullName)
  if (-not $full.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { Refuse "marker escapes candidate directory: $File" }
}

function Assert-JsonMarker([string]$Marker, [string]$Kind) {
  $value = Get-Content -LiteralPath $Marker -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($value.schemaVersion -ne 1 -or $value.installId -ne $InstallId -or $value.kind -ne $Kind) { Refuse "ownership marker mismatch: $Marker" }
}

function Assert-Installation([string]$Candidate) {
  $root = Resolve-SafeDirectory $Candidate
  $name = Split-Path -Leaf $root
  if ($name -notmatch '^(app-[0-9][0-9A-Za-z.+-]*|research-ide|Research IDE-win32-(x64|arm64))$') { Refuse "installation directory name is not recognized: $name" }
  $marker = Join-Path $root 'resources\distribution\install-manifest.json'
  $executable = Join-Path $root 'research-ide.exe'
  Assert-RegularFileInside $root $marker
  Assert-JsonMarker $marker 'application-installation'
  Assert-RegularFileInside $root $executable
  return $root
}

function Assert-ApplicationData([string]$Candidate) {
  $root = Resolve-SafeDirectory $Candidate
  if ((Split-Path -Leaf $root) -ne 'Research IDE') { Refuse 'application-data directory name is not Research IDE' }
  $marker = Join-Path $root '.research-ide-app-data.json'
  Assert-RegularFileInside $root $marker
  Assert-JsonMarker $marker 'application-data'
  return $root
}

function Assert-Project([string]$Candidate) {
  $root = Resolve-SafeDirectory $Candidate
  $toml = Join-Path $root '.research_ide\project.toml'
  $schema = Join-Path $root '.research_ide\project.schema.json'
  Assert-RegularFileInside $root $toml
  Assert-RegularFileInside $root $schema
  $tomlText = Get-Content -LiteralPath $toml -Raw -Encoding UTF8
  if ($tomlText -notmatch '(?m)^schema_version\s*=\s*1\s*$' -or $tomlText -notmatch '(?m)^id\s*=\s*"[A-Za-z0-9_-]{1,128}"\s*$') { Refuse "project.toml lacks Research IDE markers: $root" }
  $schemaValue = Get-Content -LiteralPath $schema -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($schemaValue.'$id' -ne 'https://research-ide.local/schemas/project.schema.json') { Refuse "project schema identifier mismatch: $root" }
  return $root
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..\..')) }
if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $env:APPDATA 'Research IDE' }

$installRoot = $null
if (-not $KeepInstallation) { $installRoot = Assert-Installation $InstallDir }
$dataRoot = $null
if (-not $KeepData -and (Test-Path -LiteralPath $DataDir)) { $dataRoot = Assert-ApplicationData $DataDir }

$projectPlan = @()
foreach ($candidate in $Project) {
  if (-not $DeleteProjects) {
    Write-Output "KEEP project: $candidate"
    continue
  }
  $root = Assert-Project $candidate
  $confirmed = $ConfirmProject | ForEach-Object {
    try { Resolve-SafeDirectory $_ } catch { $null }
  } | Where-Object { [string]::Equals($_, $root, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $confirmed) {
    if (-not $Execute) { Refuse "exact -ConfirmProject is required: $root" }
    $typed = Read-Host "Type the exact project path to delete it: $root"
    if (-not [string]::Equals($typed, $root, [StringComparison]::Ordinal)) { Refuse "project confirmation did not match: $root" }
  }
  $projectPlan += $root
}

if ($installRoot) { Write-Output "$(if ($Execute) { 'REMOVE' } else { 'PLAN' }) installation: $installRoot" }
if ($dataRoot) { Write-Output "$(if ($Execute) { 'REMOVE' } else { 'PLAN' }) application data: $dataRoot" }
foreach ($root in $projectPlan) { Write-Output "$(if ($Execute) { 'REMOVE' } else { 'PLAN' }) project: $root" }
if (-not $Execute) {
  Write-Output 'Dry run only; pass -Execute to apply this validated plan.'
  exit 0
}

if ($installRoot) {
  $parent = Split-Path -Parent $installRoot
  $update = Join-Path $parent 'Update.exe'
  if ((Split-Path -Leaf $installRoot) -like 'app-*' -and (Test-Path -LiteralPath $update -PathType Leaf)) {
    $updateItem = Get-Item -LiteralPath $update -Force
    if (($updateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Refuse 'Squirrel Update.exe is a reparse point' }
    $process = Start-Process -FilePath $update -ArgumentList '--uninstall' -Wait -PassThru
    if ($process.ExitCode -ne 0) { Refuse "Squirrel uninstaller failed with exit code $($process.ExitCode)" }
  } else {
    [void](Assert-Installation $installRoot)
    Remove-Item -LiteralPath $installRoot -Recurse -Force
  }
}

if ($dataRoot) {
  [void](Assert-ApplicationData $dataRoot)
  Remove-Item -LiteralPath $dataRoot -Recurse -Force
}
foreach ($root in $projectPlan) {
  [void](Assert-Project $root)
  Remove-Item -LiteralPath $root -Recurse -Force
}

Write-Output 'Research IDE uninstall plan completed.'
