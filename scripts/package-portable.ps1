param(
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"

# Resolve signature verification before the long-running build begins. Some
# Windows PowerShell hosts cannot autoload this built-in module reliably after
# native build tools have run. Keep the resolved CommandInfo so the release
# signature gate does not depend on a later module lookup.
$authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue
if (!$authenticodeCommand) {
  # Resolve the Windows inbox module explicitly. PSModulePath may also contain
  # a PowerShell 7 module with the same name, which Windows PowerShell cannot
  # safely import.
  $securityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
  Import-Module $securityModule -ErrorAction Stop
  $authenticodeCommand = Get-Command Get-AuthenticodeSignature -ErrorAction Stop
}

function Get-ReleaseAuthenticodeSignature(
  [Parameter(Mandatory = $true)][string]$LiteralPath
) {
  & $script:authenticodeCommand -LiteralPath $LiteralPath
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$packageManifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root "package.json") | ConvertFrom-Json
$productVersion = [string]$packageManifest.version
if ($productVersion -notmatch '^\d+\.\d+\.\d+$') {
  throw "The product version must be a numeric major.minor.patch version"
}
$tauriVersionConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root "src-tauri\tauri.conf.json") | ConvertFrom-Json
$cargoVersionText = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root "src-tauri\Cargo.toml")
$cargoVersionMatch = [regex]::Match($cargoVersionText, '(?m)^version\s*=\s*"([^"]+)"')
if ($tauriVersionConfig.version -ne $productVersion -or !$cargoVersionMatch.Success -or $cargoVersionMatch.Groups[1].Value -ne $productVersion) {
  throw "package.json, Tauri and Cargo product versions must agree before packaging"
}
$productAuthor = "acekanon"
$productLicenseId = "LicenseRef-GIFP-Freeware-1.0"
$distributionChannel = if ($env:GIFP_DISTRIBUTION_CHANNEL) {
  $env:GIFP_DISTRIBUTION_CHANNEL.Trim().ToLowerInvariant()
} else {
  "internal"
}
$isPublicReleaseChannel = $distributionChannel -in @("public-alpha", "public")
$isFormalPublicChannel = $distributionChannel -eq "public"
$productName = switch ($distributionChannel) {
  "internal" { "GIFP-$productVersion" }
  "public-alpha" { "GIFP-$productVersion-alpha" }
  "public" { "GIFP-$productVersion" }
  default { throw "Unsupported GIFP_DISTRIBUTION_CHANNEL: $distributionChannel" }
}
$requestedRuntimeProfile = if ($env:GIFP_FFMPEG_RUNTIME_PROFILE) {
  $env:GIFP_FFMPEG_RUNTIME_PROFILE.Trim().ToLowerInvariant()
} else {
  ""
}
$internalComplianceManifestPath = Join-Path $root "compliance\ffmpeg-windows-x64-gpl-shared.json"
$publicComplianceManifestPath = Join-Path $root "compliance\ffmpeg-windows-x64-lgpl-shared-public.json"
$complianceManifestPath = switch ($distributionChannel) {
  "internal" {
    if (!$requestedRuntimeProfile) { $requestedRuntimeProfile = "internal-gpl" }
    if ($requestedRuntimeProfile -ne "internal-gpl") {
      throw "Internal packaging only accepts GIFP_FFMPEG_RUNTIME_PROFILE=internal-gpl"
    }
    $internalComplianceManifestPath
  }
  "public-alpha" {
    if ($requestedRuntimeProfile -ne "public-lgpl") {
      throw "public-alpha requires explicit GIFP_FFMPEG_RUNTIME_PROFILE=public-lgpl; the internal GPL manifest is never selected implicitly"
    }
    $publicComplianceManifestPath
  }
  "public" {
    if ($requestedRuntimeProfile -ne "public-lgpl") {
      throw "public requires explicit GIFP_FFMPEG_RUNTIME_PROFILE=public-lgpl; the internal GPL manifest is never selected implicitly"
    }
    $publicComplianceManifestPath
  }
}

$releaseDir = if ($env:GIFP_RELEASE_DIR) {
  [IO.Path]::GetFullPath($env:GIFP_RELEASE_DIR)
} else {
  Join-Path $root "release"
}
$releaseFull = [IO.Path]::GetFullPath($releaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$versionedDir = Join-Path $releaseDir $productName
$archive = Join-Path $releaseDir "$productName-portable.zip"
$checksums = Join-Path $releaseDir "$productName-SHA256SUMS.txt"
$stagingDir = Join-Path $releaseDir ".$productName-staging-$PID"
$temporaryArchive = Join-Path $releaseDir ".$productName-portable-$PID.tmp.zip"
$temporaryChecksums = Join-Path $releaseDir ".$productName-checksums-$PID.tmp.txt"
$backupDir = Join-Path $releaseDir ".$productName-previous-$PID"
$backupArchive = Join-Path $releaseDir ".$productName-previous-$PID.zip"
$backupChecksums = Join-Path $releaseDir ".$productName-previous-checksums-$PID.txt"
$complianceVerifierPath = Join-Path $root "scripts\verify-release-compliance.mjs"
$dependencyGeneratorPath = Join-Path $root "scripts\generate-third-party-manifest.mjs"
$licenseOverlayManifestPath = Join-Path $root "compliance\license-text-overlays.json"
$unsignedPolicyPath = Join-Path $root "docs\release\UNSIGNED-ALPHA-POLICY.md"
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $root "tmp")).TrimEnd([IO.Path]::DirectorySeparatorChar)
$temporaryComplianceReport = Join-Path $temporaryRoot "gifp-release-compliance-$PID.json"
$temporaryDependencyManifest = Join-Path $temporaryRoot "gifp-third-party-manifest-$PID.json"
$temporaryLicenseBundle = Join-Path $temporaryRoot "release-license-bundle-$PID"
$publicSourceWorktree = Join-Path $temporaryRoot "release-source-worktree-$PID"
$publicCargoTarget = Join-Path $temporaryRoot "release-cargo-target-$PID"

# Use a self-contained SHA-256 implementation. Some restricted Windows
# PowerShell hosts expose Get-FileHash during startup but lose the autoloaded
# Microsoft.PowerShell.Utility command later in a long-running packaging
# script. The release gate must not depend on that host-specific behavior.
function Get-FileHash(
  [Parameter(Mandatory = $true)][string]$LiteralPath,
  [ValidateSet("SHA256")][string]$Algorithm = "SHA256"
) {
  $resolved = [IO.Path]::GetFullPath($LiteralPath)
  $stream = [IO.File]::Open($resolved, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "")
  } finally {
    $sha.Dispose()
    $stream.Dispose()
  }
  [pscustomobject]@{ Algorithm = $Algorithm; Hash = $hash; Path = $resolved }
}

function Test-ReparsePoint([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $false }
  $attributes = [IO.File]::GetAttributes([IO.Path]::GetFullPath($Path))
  return ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Assert-SafeContainedPath(
  [string]$TrustedRoot,
  [string]$Path,
  [switch]$AllowRoot,
  [switch]$RequireExisting
) {
  $rootFull = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $isRoot = $full.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)
  if ((!$AllowRoot -and $isRoot) -or (!$isRoot -and !$full.StartsWith("$rootFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase))) {
    throw "Refusing to access a path outside the trusted root ${rootFull}: $full"
  }
  if ($RequireExisting -and !(Test-Path -LiteralPath $full)) {
    throw "Required contained path does not exist: $full"
  }

  $existingRoot = $rootFull
  while ($existingRoot -and !(Test-Path -LiteralPath $existingRoot)) {
    $parent = Split-Path -Parent $existingRoot
    if (!$parent -or $parent -eq $existingRoot) { break }
    $existingRoot = $parent
  }
  if ($existingRoot -and (Test-ReparsePoint $existingRoot)) {
    throw "Trusted path resolves through a reparse point: $existingRoot"
  }

  if (Test-Path -LiteralPath $rootFull) {
    if (Test-ReparsePoint $rootFull) { throw "Trusted root is a reparse point: $rootFull" }
    $resolvedRoot = (Resolve-Path -LiteralPath $rootFull).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (!$resolvedRoot.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Trusted root canonical path changed: expected $rootFull, got $resolvedRoot"
    }
    $relative = if ($isRoot) { "" } else { $full.Substring($rootFull.Length + 1) }
    $cursor = $rootFull
    foreach ($segment in @($relative -split '[\\/]' | Where-Object { $_ })) {
      $cursor = Join-Path $cursor $segment
      if (!(Test-Path -LiteralPath $cursor)) { break }
      if (Test-ReparsePoint $cursor) { throw "Contained path uses a reparse point: $cursor" }
      $resolvedCursor = (Resolve-Path -LiteralPath $cursor).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
      if (!$resolvedCursor.Equals([IO.Path]::GetFullPath($cursor).TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Contained path canonical identity changed: $cursor -> $resolvedCursor"
      }
    }
  }
  return $full
}

function Assert-ReleaseChildPath([string]$Path, [switch]$RequireExisting) {
  return Assert-SafeContainedPath $releaseFull $Path -RequireExisting:$RequireExisting
}

function Assert-TemporaryChildPath([string]$Path, [switch]$RequireExisting) {
  return Assert-SafeContainedPath $temporaryRoot $Path -RequireExisting:$RequireExisting
}

function Assert-RegularFileNoReparse([string]$Path, [string]$Label) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is not a file: $Path" }
  if (Test-ReparsePoint $Path) { throw "$Label is a reparse point or link: $Path" }
  return [IO.Path]::GetFullPath($Path)
}

function Assert-TreeNoReparse([string]$Path, [string]$Label) {
  if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label is not a directory: $Path" }
  if (Test-ReparsePoint $Path) { throw "$Label is a reparse point or link: $Path" }
  foreach ($item in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point or link: $($item.FullName)"
    }
  }
  return [IO.Path]::GetFullPath($Path)
}

function Remove-SafeContainedItem([string]$TrustedRoot, [string]$Path, [switch]$Recurse) {
  if (!(Test-Path -LiteralPath $Path)) { return }
  $safe = Assert-SafeContainedPath $TrustedRoot $Path -RequireExisting
  $item = Get-Item -LiteralPath $safe -Force
  if ($item.PSIsContainer) {
    [void](Assert-TreeNoReparse $safe "recursive delete target")
    if (!$Recurse) { throw "Directory deletion requires -Recurse: $safe" }
    Remove-Item -LiteralPath $safe -Recurse -Force
  } else {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Delete target is a reparse point or link: $safe"
    }
    Remove-Item -LiteralPath $safe -Force
  }
}

function Move-SafeContainedItem([string]$TrustedRoot, [string]$Source, [string]$Destination) {
  $sourceSafe = Assert-SafeContainedPath $TrustedRoot $Source -RequireExisting
  $destinationSafe = Assert-SafeContainedPath $TrustedRoot $Destination
  if (Test-Path -LiteralPath $destinationSafe) {
    throw "Move destination already exists: $destinationSafe"
  }
  $sourceItem = Get-Item -LiteralPath $sourceSafe -Force
  if ($sourceItem.PSIsContainer) { [void](Assert-TreeNoReparse $sourceSafe "move source") }
  elseif (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Move source is a reparse point: $sourceSafe" }
  $destinationParent = Split-Path -Parent $destinationSafe
  [void](Assert-SafeContainedPath $TrustedRoot $destinationParent -AllowRoot -RequireExisting)
  $moveCompleted = $false
  for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
      Move-Item -LiteralPath $sourceSafe -Destination $destinationSafe -ErrorAction Stop
      $moveCompleted = $true
      break
    } catch {
      if (!(Test-Path -LiteralPath $sourceSafe) -or (Test-Path -LiteralPath $destinationSafe) -or $attempt -eq 15) {
        throw
      }
      # Compress-Archive, antivirus and Explorer metadata inspection can retain
      # a short-lived Windows handle after the package inventory is frozen.
      # Keep publication atomic, release managed streams, and retry the same
      # validated rename instead of falling back to an unverified copy.
      [GC]::Collect()
      [GC]::WaitForPendingFinalizers()
      Start-Sleep -Milliseconds ([Math]::Min(2000, 200 + ($attempt * 150)))
    }
  }
  if (!$moveCompleted) { throw "Move did not complete: $sourceSafe -> $destinationSafe" }
  try {
    [void](Assert-SafeContainedPath $TrustedRoot $destinationSafe -RequireExisting)
    if ((Get-Item -LiteralPath $destinationSafe -Force).PSIsContainer) {
      [void](Assert-TreeNoReparse $destinationSafe "move destination")
    }
  } catch {
    # Keep the caller's state flags truthful even when a post-move safety
    # check fails: restore the source before surfacing the failure.
    if ((Test-Path -LiteralPath $destinationSafe) -and !(Test-Path -LiteralPath $sourceSafe)) {
      Move-Item -LiteralPath $destinationSafe -Destination $sourceSafe
    }
    throw
  }
}

function Publish-VerifiedDirectory(
  [string]$TrustedRoot,
  [string]$Source,
  [string]$Destination,
  [object[]]$Inventory,
  [switch]$ForceCopyFallback
) {
  $sourceSafe = Assert-SafeContainedPath $TrustedRoot $Source -RequireExisting
  $destinationSafe = Assert-SafeContainedPath $TrustedRoot $Destination
  if (Test-Path -LiteralPath $destinationSafe) {
    throw "Publish destination already exists: $destinationSafe"
  }
  [void](Assert-TreeNoReparse $sourceSafe "directory publish source")

  if (!$ForceCopyFallback) {
    $movedAtomically = $false
    try {
      Move-SafeContainedItem $TrustedRoot $sourceSafe $destinationSafe
      $movedAtomically = $true
    } catch {
      if (!(Test-Path -LiteralPath $sourceSafe) -or (Test-Path -LiteralPath $destinationSafe)) {
        throw
      }
      Write-Warning "Atomic directory publication was unavailable; using a verified copy fallback: $($_.Exception.Message)"
    }
    if ($movedAtomically) {
      try {
        Assert-DirectoryMatchesInventory $destinationSafe $Inventory
      } catch {
        if ((Test-Path -LiteralPath $destinationSafe) -and !(Test-Path -LiteralPath $sourceSafe)) {
          Move-SafeContainedItem $TrustedRoot $destinationSafe $sourceSafe
        }
        throw
      }
      return $false
    }
  }

  # Some Windows filesystem filters deny renaming a directory that contains a
  # freshly materialized license-text tree even though every file is readable,
  # stable and deletable. Copy only into a new, contained destination and make
  # the frozen inventory check the publication gate. The portable ZIP and its
  # checksum are still published by atomic file renames below.
  try {
    Copy-Item -LiteralPath $sourceSafe -Destination $destinationSafe -Recurse
    [void](Assert-TreeNoReparse $destinationSafe "copied directory publish destination")
    Assert-DirectoryMatchesInventory $sourceSafe $Inventory
    Assert-DirectoryMatchesInventory $destinationSafe $Inventory
  } catch {
    if (Test-Path -LiteralPath $destinationSafe) {
      Remove-SafeContainedItem $TrustedRoot $destinationSafe -Recurse
    }
    throw
  }
  return $true
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, (New-Object Text.UTF8Encoding($false)))
}

function Copy-StableReleaseFile(
  [string]$Source,
  [string]$Destination,
  [string]$Label,
  [string]$ExpectedSha256 = "",
  [Nullable[Int64]]$ExpectedSizeBytes = $null
) {
  $sourceSafe = Assert-RegularFileNoReparse $Source "$Label source"
  $destinationSafe = Assert-ReleaseChildPath $Destination
  if (Test-Path -LiteralPath $destinationSafe) { throw "$Label destination already exists: $destinationSafe" }
  $destinationParent = Split-Path -Parent $destinationSafe
  [void](Assert-SafeContainedPath $releaseFull $destinationParent -AllowRoot -RequireExisting)
  $sourceBefore = Get-Item -LiteralPath $sourceSafe
  $sourceHashBefore = (Get-FileHash -LiteralPath $sourceSafe -Algorithm SHA256).Hash.ToLowerInvariant()
  Copy-Item -LiteralPath $sourceSafe -Destination $destinationSafe
  [void](Assert-RegularFileNoReparse $destinationSafe "$Label destination")
  $sourceAfter = Get-Item -LiteralPath $sourceSafe
  $sourceHashAfter = (Get-FileHash -LiteralPath $sourceSafe -Algorithm SHA256).Hash.ToLowerInvariant()
  $destinationItem = Get-Item -LiteralPath $destinationSafe
  $destinationHash = (Get-FileHash -LiteralPath $destinationSafe -Algorithm SHA256).Hash.ToLowerInvariant()
  if (
    $sourceBefore.Length -ne $sourceAfter.Length -or
    $sourceBefore.Length -ne $destinationItem.Length -or
    $sourceHashBefore -ne $sourceHashAfter -or
    $sourceHashBefore -ne $destinationHash
  ) {
    throw "$Label changed while it was materialized into controlled staging"
  }
  if ($ExpectedSha256 -and $destinationHash -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "$Label staged SHA-256 does not match its frozen expectation"
  }
  if ($null -ne $ExpectedSizeBytes -and [int64]$destinationItem.Length -ne [int64]$ExpectedSizeBytes) {
    throw "$Label staged size does not match its frozen expectation"
  }
  return [pscustomobject]@{
    Path = $destinationSafe
    SizeBytes = [int64]$destinationItem.Length
    Sha256 = $destinationHash
  }
}

function Get-FrozenGitInputEntry([object]$Inventory, [string]$RelativePath) {
  $normalized = $RelativePath.Replace("\", "/")
  $matches = @($Inventory.files | Where-Object { $_.path -ceq $normalized })
  if ($matches.Count -ne 1) { throw "Frozen Git inventory does not contain exactly one $normalized" }
  return $matches[0]
}

function Copy-TrackedReleaseFile(
  [string]$RepositoryRoot,
  [string]$RelativePath,
  [string]$Destination,
  [string]$Label,
  [object]$Inventory = $null
) {
  $expectedHash = ""
  $expectedSize = $null
  if ($null -ne $Inventory) {
    $entry = Get-FrozenGitInputEntry $Inventory $RelativePath
    $expectedHash = $entry.sha256
    $expectedSize = [Nullable[Int64]]([int64]$entry.sizeBytes)
  }
  return Copy-StableReleaseFile (Join-Path $RepositoryRoot $RelativePath) $Destination $Label $expectedHash $expectedSize
}

function Invoke-NodeChecked([string[]]$Arguments, [string]$Description) {
  $output = & $script:nodeCommand @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed:`n$($output | Out-String)"
  }
  return $output
}

function Get-RelativeReleasePath([string]$BasePath, [string]$FilePath) {
  $baseFull = [IO.Path]::GetFullPath($BasePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $fileFull = [IO.Path]::GetFullPath($FilePath)
  if (!$fileFull.StartsWith("$baseFull$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    throw "File is outside the package staging directory: $fileFull"
  }
  return $fileFull.Substring($baseFull.Length + 1).Replace("\", "/")
}

function Get-ReleaseGitState([string]$RepositoryRoot = $root) {
  $repositoryFull = [IO.Path]::GetFullPath($RepositoryRoot)
  $safeRoot = $repositoryFull.Replace("\", "/")
  $commitOutput = @(& git -C $repositoryFull -c "safe.directory=$safeRoot" rev-parse HEAD 2>&1)
  $commitExitCode = $LASTEXITCODE
  $commit = ($commitOutput | Out-String).Trim().ToLowerInvariant()
  if ($commitExitCode -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') {
    throw "Unable to record the full Git commit for this release"
  }
  $status = @(& git -C $repositoryFull -c "safe.directory=$safeRoot" status --porcelain=v1 --untracked-files=all 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Unable to read Git worktree state" }
  return [pscustomobject]@{
    Commit = $commit
    Dirty = $status.Count -gt 0
  }
}

function Assert-PublicReleaseGitState([string]$ExpectedCommit = "", [string]$Checkpoint = "checkpoint") {
  $state = Get-ReleaseGitState $root
  if ($ExpectedCommit -and $state.Commit -ne $ExpectedCommit.ToLowerInvariant()) {
    throw "public-alpha Git HEAD changed at ${Checkpoint}: expected $ExpectedCommit, got $($state.Commit)"
  }
  if ($state.Dirty) {
    throw "public-alpha requires a clean Git worktree at $Checkpoint"
  }
  return $state
}

function Get-FrozenDirectoryInventory([string]$DirectoryPath, [string[]]$ExcludeRelativePaths = @()) {
  [void](Assert-TreeNoReparse $DirectoryPath "inventory directory")
  $excluded = @{}
  foreach ($relative in $ExcludeRelativePaths) { $excluded[$relative.Replace("\", "/").ToLowerInvariant()] = $true }
  $entries = @()
  foreach ($file in Get-ChildItem -LiteralPath $DirectoryPath -File -Recurse -Force | Sort-Object FullName) {
    $relative = Get-RelativeReleasePath $DirectoryPath $file.FullName
    if ($excluded.ContainsKey($relative.ToLowerInvariant())) { continue }
    $entries += [pscustomobject]@{
      Path = $relative
      SizeBytes = [int64]$file.Length
      Sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  # Emit entries individually so callers using @(...), including the release
  # license-bundle freeze, receive a flat object array rather than a nested
  # Object[] that cannot be keyed by relative path.
  return $entries
}

function Assert-DirectoryMatchesInventory([string]$DirectoryPath, [object[]]$Inventory) {
  [void](Assert-TreeNoReparse $DirectoryPath "frozen inventory directory")
  $expected = @{}
  foreach ($entry in $Inventory) {
    $key = $entry.Path.ToLowerInvariant()
    if ($expected.ContainsKey($key)) { throw "Frozen inventory repeats path: $($entry.Path)" }
    $expected[$key] = $entry
  }
  $seen = @{}
  foreach ($file in Get-ChildItem -LiteralPath $DirectoryPath -File -Recurse -Force) {
    $relative = Get-RelativeReleasePath $DirectoryPath $file.FullName
    $key = $relative.ToLowerInvariant()
    if (!$expected.ContainsKey($key)) { throw "Directory contains a file outside frozen inventory: $relative" }
    if ($seen.ContainsKey($key)) { throw "Directory repeats frozen path: $relative" }
    $entry = $expected[$key]
    if ([int64]$file.Length -ne [int64]$entry.SizeBytes) { throw "Directory size mismatch for $relative" }
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $entry.Sha256) { throw "Directory hash mismatch for $relative" }
    $seen[$key] = $true
  }
  if ($seen.Count -ne $expected.Count) {
    $missing = @($expected.Keys | Where-Object { !$seen.ContainsKey($_) } | Sort-Object)
    throw "Directory is missing frozen files: $($missing -join ', ')"
  }
}

function Test-ZipAgainstInventory([string]$ZipPath, [object[]]$Inventory) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expected = @{}
  foreach ($artifact in $Inventory) {
    $expected[$artifact.Path] = $artifact.Sha256
  }

  $seen = @{}
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName.EndsWith("/")) { continue }
      $name = $entry.FullName.Replace("\", "/")
      if (!$expected.ContainsKey($name)) {
        throw "Portable archive contains an unexpected file: $name"
      }
      if ($seen.ContainsKey($name)) {
        throw "Portable archive contains a duplicate file: $name"
      }
      $stream = $entry.Open()
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
      } finally {
        $sha.Dispose()
        $stream.Dispose()
      }
      if ($actual -ne $expected[$name]) {
        throw "Portable archive hash mismatch for $name"
      }
      $seen[$name] = $true
    }
  } finally {
    $zip.Dispose()
  }
  if ($seen.Count -ne $expected.Count) {
    $missing = @($expected.Keys | Where-Object { !$seen.ContainsKey($_) } | Sort-Object)
    throw "Portable archive is missing files: $($missing -join ', ')"
  }
}

function Invoke-GitHashObjectPaths([string]$RepositoryRoot, [string[]]$RelativePaths) {
  $gitCommand = Get-Command git -ErrorAction Stop
  $startInfo = New-Object Diagnostics.ProcessStartInfo
  $startInfo.FileName = $gitCommand.Source
  $startInfo.WorkingDirectory = [IO.Path]::GetFullPath($RepositoryRoot)
  $startInfo.Arguments = "hash-object --stdin-paths"
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $safeRoot = ([IO.Path]::GetFullPath($RepositoryRoot)).Replace("\", "/")
  $startInfo.EnvironmentVariables["GIT_CONFIG_COUNT"] = "1"
  $startInfo.EnvironmentVariables["GIT_CONFIG_KEY_0"] = "safe.directory"
  $startInfo.EnvironmentVariables["GIT_CONFIG_VALUE_0"] = $safeRoot
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $startInfo
  $previousConsoleInputEncoding = [Console]::InputEncoding
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  try {
    if (!$process.Start()) { throw "Unable to start git hash-object" }
    foreach ($relativePath in $RelativePaths) {
      $process.StandardInput.WriteLine($relativePath)
    }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "Unable to batch-hash tracked build inputs through Git: $($stderr.Trim())"
    }
    return @($stdout -split "`r?`n" | Where-Object { $_ })
  } finally {
    [Console]::InputEncoding = $previousConsoleInputEncoding
    $process.Dispose()
  }
}

function Get-FrozenGitInputInventory(
  [string]$RepositoryRoot,
  [string]$ExpectedCommit,
  [switch]$SkipContentSha256
) {
  $state = Get-ReleaseGitState $RepositoryRoot
  if ($state.Commit -ne $ExpectedCommit -or $state.Dirty) {
    throw "Build snapshot is not the expected clean commit"
  }
  $safeRoot = ([IO.Path]::GetFullPath($RepositoryRoot)).Replace("\", "/")
  $tracked = @(& git -C $RepositoryRoot -c "safe.directory=$safeRoot" -c core.quotepath=false ls-files -v 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Unable to enumerate build snapshot files" }
  $relativePaths = @()
  foreach ($record in $tracked) {
    if (!$record) { continue }
    if ($record.Length -lt 3 -or $record[1] -ne ' ' -or $record[0] -cne 'H') {
      throw "Tracked build input has assume-unchanged, skip-worktree, or unsupported index flags: $record"
    }
    $relativePaths += $record.Substring(2)
  }
  if ($relativePaths.Count -eq 0) { throw "Build snapshot has no tracked inputs" }

  $expectedBlobs = @{}
  $treeLines = @(& git -C $RepositoryRoot -c "safe.directory=$safeRoot" -c core.quotepath=false ls-tree -r --full-tree $ExpectedCommit 2>&1)
  if ($LASTEXITCODE -ne 0) { throw "Unable to enumerate committed build input blobs" }
  foreach ($line in $treeLines) {
    if ($line -notmatch '^[0-7]+ blob ([a-f0-9]{40,64})\t(.+)$') { continue }
    $expectedBlobs[$Matches[2]] = $Matches[1].ToLowerInvariant()
  }
  $actualBlobOutput = @(Invoke-GitHashObjectPaths $RepositoryRoot $relativePaths)
  if ($actualBlobOutput.Count -ne $relativePaths.Count) {
    throw "Unable to batch-hash tracked build inputs through Git filters"
  }

  $files = @()
  $canonicalTree = New-Object Text.StringBuilder
  for ($index = 0; $index -lt $relativePaths.Count; $index++) {
    $relative = $relativePaths[$index]
    $path = Join-Path $RepositoryRoot $relative
    [void](Assert-RegularFileNoReparse $path "tracked build input")
    if (!$expectedBlobs.ContainsKey($relative)) {
      throw "Committed tree does not contain tracked build input: $relative"
    }
    if ($actualBlobOutput[$index] -notmatch '^[a-f0-9]{40,64}$') {
      throw "Unable to hash tracked build input through Git filters: $relative"
    }
    $expectedBlob = $expectedBlobs[$relative]
    $actualBlob = $actualBlobOutput[$index].ToLowerInvariant()
    if ($actualBlob -ne $expectedBlob) {
      throw "Tracked build input does not match ${ExpectedCommit}: $relative"
    }
    [void]$canonicalTree.Append($relative.Replace("\", "/"))
    [void]$canonicalTree.Append([char]0)
    [void]$canonicalTree.Append($actualBlob)
    [void]$canonicalTree.Append([char]0)
    $files += [ordered]@{
      path = $relative.Replace("\", "/")
      sizeBytes = [int64](Get-Item -LiteralPath $path).Length
      sha256 = if ($SkipContentSha256) { $null } else { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
      gitBlob = $actualBlob
    }
  }
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  $treeDigestInput = Join-Path $temporaryRoot "git-tree-inventory-$PID.tmp"
  if (Test-Path -LiteralPath $treeDigestInput) { Remove-SafeContainedItem $temporaryRoot $treeDigestInput }
  try {
    [IO.File]::WriteAllBytes($treeDigestInput, [Text.Encoding]::UTF8.GetBytes($canonicalTree.ToString()))
    [void](Assert-RegularFileNoReparse $treeDigestInput "tracked-tree digest input")
    $treeHashOutput = @(& git -C $RepositoryRoot -c "safe.directory=$safeRoot" hash-object -- $treeDigestInput 2>&1)
    if ($LASTEXITCODE -ne 0 -or $treeHashOutput.Count -ne 1 -or $treeHashOutput[0] -notmatch '^[a-f0-9]{40,64}$') {
      throw "Unable to compute tracked-tree content hash"
    }
    $trackedTreeHash = $treeHashOutput[0].ToLowerInvariant()
  } finally {
    if (Test-Path -LiteralPath $treeDigestInput) { Remove-SafeContainedItem $temporaryRoot $treeDigestInput }
  }
  return [ordered]@{
    schemaVersion = 1
    gitCommit = $ExpectedCommit
    trackedTreeHash = $trackedTreeHash
    fileCount = $files.Count
    files = $files
  }
}

function Assert-FrozenGitTreeIdentity([string]$RepositoryRoot, [object]$Inventory) {
  $actual = Get-FrozenGitInputInventory $RepositoryRoot $Inventory.gitCommit -SkipContentSha256
  if ($actual.trackedTreeHash -ne $Inventory.trackedTreeHash -or $actual.fileCount -ne $Inventory.fileCount) {
    throw "Tracked public build tree identity changed"
  }
}

function Assert-FrozenGitInputInventory([string]$RepositoryRoot, [object]$Inventory) {
  $actual = Get-FrozenGitInputInventory $RepositoryRoot $Inventory.gitCommit
  if ($actual.trackedTreeHash -ne $Inventory.trackedTreeHash) { throw "Tracked build tree hash changed" }
  if ($actual.fileCount -ne $Inventory.fileCount) { throw "Build input file count changed" }
  for ($index = 0; $index -lt $Inventory.files.Count; $index++) {
    $expected = $Inventory.files[$index]
    $observed = $actual.files[$index]
    if ($expected.path -ne $observed.path -or $expected.sizeBytes -ne $observed.sizeBytes -or $expected.sha256 -ne $observed.sha256 -or $expected.gitBlob -ne $observed.gitBlob) {
      throw "Build input inventory changed: expected $($expected.path), observed $($observed.path)"
    }
  }
}

function Get-FrozenNodeDependencyInventory([string]$RepositoryRoot, [string]$NpmCommand) {
  $nodeModules = Join-Path $RepositoryRoot "node_modules"
  [void](Assert-TreeNoReparse $nodeModules "isolated npm dependency tree")
  $packageLock = Assert-RegularFileNoReparse (Join-Path $RepositoryRoot "package-lock.json") "npm lockfile"
  $npmExecutable = Assert-RegularFileNoReparse $NpmCommand "npm launcher"
  $nodeExecutable = Assert-RegularFileNoReparse $script:nodeCommand "Node.js executable"
  $files = @(Get-FrozenDirectoryInventory $nodeModules)
  return [ordered]@{
    schemaVersion = 1
    installCommand = "npm ci --ignore-scripts --no-audit --no-fund"
    packageLockSha256 = (Get-FileHash -LiteralPath $packageLock -Algorithm SHA256).Hash.ToLowerInvariant()
    nodeExecutable = [ordered]@{
      fileName = [IO.Path]::GetFileName($nodeExecutable)
      sha256 = (Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    npmLauncher = [ordered]@{
      fileName = [IO.Path]::GetFileName($npmExecutable)
      sha256 = (Get-FileHash -LiteralPath $npmExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    root = "node_modules"
    fileCount = $files.Count
    files = $files
  }
}

function Assert-FrozenNodeDependencyInventory([string]$RepositoryRoot, [object]$Inventory) {
  $nodeModules = Join-Path $RepositoryRoot "node_modules"
  $packageLock = Assert-RegularFileNoReparse (Join-Path $RepositoryRoot "package-lock.json") "npm lockfile"
  $lockHash = (Get-FileHash -LiteralPath $packageLock -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($lockHash -ne $Inventory.packageLockSha256) { throw "npm lockfile changed after dependency installation" }
  $nodeExecutable = Assert-RegularFileNoReparse $script:nodeCommand "frozen Node.js executable"
  $npmExecutable = Assert-RegularFileNoReparse $script:npmCommand "frozen npm launcher"
  if ((Get-FileHash -LiteralPath $nodeExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Inventory.nodeExecutable.sha256) {
    throw "Node.js executable changed after dependency installation"
  }
  if ((Get-FileHash -LiteralPath $npmExecutable -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Inventory.npmLauncher.sha256) {
    throw "npm launcher changed after dependency installation"
  }
  Assert-DirectoryMatchesInventory $nodeModules @($Inventory.files)
}

function Assert-FrozenPublicBuildInputsFull([string]$RepositoryRoot, [object]$GitInventory, [object]$NodeInventory) {
  Assert-FrozenGitInputInventory $RepositoryRoot $GitInventory
  Assert-FrozenNodeDependencyInventory $RepositoryRoot $NodeInventory
}

function Assert-FrozenPublicBuildInputs([string]$RepositoryRoot, [object]$GitInventory, [object]$NodeInventory) {
  [void]$NodeInventory
  Assert-FrozenGitTreeIdentity $RepositoryRoot $GitInventory
}

function Get-VerifiedRuntimeFact([object]$Compliance, [object]$RuntimeFile) {
  $verified = @($Compliance.runtimeFiles | Where-Object { $_.name -ceq $RuntimeFile.name })
  if ($verified.Count -ne 1 -or $verified[0].sha256 -ne $RuntimeFile.sha256 -or [int64]$verified[0].sizeBytes -ne [int64]$RuntimeFile.sizeBytes) {
    throw "Compliance evidence for FFmpeg runtime $($RuntimeFile.name) is inconsistent"
  }
  return $verified[0]
}

function Set-FrozenPublicInputsReadOnly(
  [string]$RepositoryRoot,
  [object]$GitInventory,
  [object]$NodeInventory,
  [bool]$ReadOnly
) {
  $paths = @($GitInventory.files | ForEach-Object { Join-Path $RepositoryRoot $_.path })
  $nodeRoot = Join-Path $RepositoryRoot "node_modules"
  $paths += @($NodeInventory.files | ForEach-Object {
    Assert-SafeContainedPath $nodeRoot (Join-Path $nodeRoot $_.Path) -RequireExisting
  })
  foreach ($path in $paths) {
    $safe = Assert-RegularFileNoReparse $path "frozen public build input"
    $attributes = [IO.File]::GetAttributes($safe)
    if ($ReadOnly) {
      [IO.File]::SetAttributes($safe, $attributes -bor [IO.FileAttributes]::ReadOnly)
    } else {
      [IO.File]::SetAttributes($safe, $attributes -band (-bnot [IO.FileAttributes]::ReadOnly))
    }
  }
}

function Invoke-PackagePortableSelfTest {
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  $testRoot = Join-Path $temporaryRoot "package-portable-self-test-$PID"
  if (Test-Path -LiteralPath $testRoot) {
    Remove-SafeContainedItem $temporaryRoot $testRoot -Recurse
  }
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  try {
    Write-Utf8NoBom (Join-Path $testRoot "a.txt") "a`n"
    New-Item -ItemType Directory -Path (Join-Path $testRoot "nested") | Out-Null
    Write-Utf8NoBom (Join-Path $testRoot "nested\b.txt") "b`n"
    $inventory = @(Get-FrozenDirectoryInventory $testRoot)
    Assert-DirectoryMatchesInventory $testRoot $inventory
    Write-Utf8NoBom (Join-Path $testRoot "a.txt") "mutated`n"
    $mutationRejected = $false
    try { Assert-DirectoryMatchesInventory $testRoot $inventory } catch { $mutationRejected = $true }
    if (!$mutationRejected) { throw "Self-test failed to reject inventory mutation" }
    $escapeRejected = $false
    try { [void](Assert-SafeContainedPath $testRoot (Join-Path $testRoot "..\escape")) } catch { $escapeRejected = $true }
    if (!$escapeRejected) { throw "Self-test failed to reject containment escape" }

    $publishSource = Join-Path $testRoot "publish-source"
    $publishDestination = Join-Path $testRoot "publish-destination"
    New-Item -ItemType Directory -Path (Join-Path $publishSource "licenses") | Out-Null
    Write-Utf8NoBom (Join-Path $publishSource "licenses\license.txt") "license`n"
    $publishInventory = @(Get-FrozenDirectoryInventory $publishSource)
    $sourceRetained = Publish-VerifiedDirectory $testRoot $publishSource $publishDestination $publishInventory -ForceCopyFallback
    if (!$sourceRetained) { throw "Self-test copy publication did not report its retained source" }
    Assert-DirectoryMatchesInventory $publishSource $publishInventory
    Assert-DirectoryMatchesInventory $publishDestination $publishInventory

    $runtimeFact = [pscustomobject]@{ name = "ffmpeg.exe"; sizeBytes = 7; sha256 = (("a" * 64) -join "") }
    $runtimeCompliance = [pscustomobject]@{ runtimeFiles = @($runtimeFact) }
    $resolvedRuntimeFact = Get-VerifiedRuntimeFact $runtimeCompliance $runtimeFact
    if ($resolvedRuntimeFact.name -ne "ffmpeg.exe") { throw "Self-test failed runtime compliance field binding" }

    $gitTestRoot = Join-Path $testRoot "git-inputs"
    New-Item -ItemType Directory -Path $gitTestRoot | Out-Null
    & git -C $gitTestRoot init -q
    & git -C $gitTestRoot config user.name "GIFP Test"
    & git -C $gitTestRoot config user.email "gifp-test@example.invalid"
    Write-Utf8NoBom (Join-Path $gitTestRoot "tracked.txt") "original`n"
    Write-Utf8NoBom (Join-Path $gitTestRoot "固定.json") "{}`n"
    & git -C $gitTestRoot add -- tracked.txt "固定.json"
    & git -C $gitTestRoot commit -q -m fixture
    if ($LASTEXITCODE -ne 0) { throw "Self-test failed to create Git fixture" }
    $gitTestCommit = @(& git -C $gitTestRoot rev-parse HEAD)[0]
    $gitInventory = Get-FrozenGitInputInventory $gitTestRoot $gitTestCommit
    Assert-FrozenGitInputInventory $gitTestRoot $gitInventory
    & git -C $gitTestRoot update-index --assume-unchanged tracked.txt
    Write-Utf8NoBom (Join-Path $gitTestRoot "tracked.txt") "mutated`n"
    $hiddenMutationRejected = $false
    try { [void](Get-FrozenGitInputInventory $gitTestRoot $gitTestCommit) } catch { $hiddenMutationRejected = $true }
    if (!$hiddenMutationRejected) { throw "Self-test failed to reject assume-unchanged source mutation" }
  } finally {
    if (Test-Path -LiteralPath $testRoot) {
      Remove-SafeContainedItem $temporaryRoot $testRoot -Recurse
    }
  }
  Write-Host "package-portable self-test passed"
}

if ($SelfTest) {
  Invoke-PackagePortableSelfTest
  return
}

foreach ($path in @($versionedDir, $archive, $checksums, $stagingDir, $temporaryArchive, $temporaryChecksums, $backupDir, $backupArchive, $backupChecksums)) {
  [void](Assert-ReleaseChildPath $path)
}
[void](Assert-TemporaryChildPath $temporaryLicenseBundle)
[void](Assert-TemporaryChildPath $temporaryComplianceReport)
[void](Assert-TemporaryChildPath $temporaryDependencyManifest)
[void](Assert-TemporaryChildPath $publicSourceWorktree)
[void](Assert-TemporaryChildPath $publicCargoTarget)

$expectedPublicCommit = $null
$buildRoot = $root
$frozenBuildInputs = $null
$frozenNodeDependencies = $null
$publicWorktreeCreated = $false
$publicInputsReadOnly = $false
$previousCargoTargetDir = $env:CARGO_TARGET_DIR
$binaryAssetOutput = $null
$temporaryBinaryAsset = $null
$backupBinaryAsset = $null
$temporarySource = $null
$sourceOutput = $null
$backupSource = $null
$qualityEvidenceInventory = $null
$publicationCompleted = $false
try {
if (!(Test-Path -LiteralPath $temporaryRoot)) {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
}
[void](Assert-SafeContainedPath $temporaryRoot $temporaryRoot -AllowRoot -RequireExisting)
if ($isPublicReleaseChannel -and $env:GIFP_SKIP_BUILD -eq "1") {
  throw "public-alpha packaging must rebuild from the clean source commit; GIFP_SKIP_BUILD is forbidden"
}
if ($isPublicReleaseChannel) {
  if ($isFormalPublicChannel) {
    if ($env:GIFP_ALLOW_UNSIGNED_ALPHA) {
      throw "public forbids GIFP_ALLOW_UNSIGNED_ALPHA; unsigned overrides are Alpha-only"
    }
    $formalPublicThumbprint = ([string]$env:GIFP_ALLOWED_SIGNER_THUMBPRINT).Replace(" ", "").ToLowerInvariant()
    if ($formalPublicThumbprint -notmatch '^[a-f0-9]{40,64}$') {
      throw "public requires a reviewed GIFP_ALLOWED_SIGNER_THUMBPRINT"
    }
  }
  if (!(Test-Path -LiteralPath $complianceManifestPath -PathType Leaf)) {
    throw "The explicit Public LGPL FFmpeg compliance manifest is missing: $complianceManifestPath"
  }
  $publicRuntimePolicy = Get-Content -Raw -LiteralPath $complianceManifestPath | ConvertFrom-Json
  $expectedPublicProfile = "gifp-windows-x64-lgpl-shared-public-v1"
  if ($publicRuntimePolicy.releaseProfile -ne $expectedPublicProfile -or
      $publicRuntimePolicy.publicReleaseProfile.id -ne $expectedPublicProfile -or
      $publicRuntimePolicy.variant -ne "gifp-win64-lgpl-shared" -or
      $publicRuntimePolicy.licenseExpression -ne "LGPL-2.1-or-later") {
    throw "The selected public-alpha manifest is not the reviewed Public LGPL profile"
  }
  $readiness = $publicRuntimePolicy.publicReleaseProfile.readiness
  $incompleteReadiness = @(
    "runtimeBuiltAndPinned",
    "runtimeCapabilitiesReviewed",
    "correspondingSourceArchived",
    "immutableBuildInputsVerified"
  ) | Where-Object {
    !$readiness -or !$readiness.PSObject.Properties[$_] -or $readiness.PSObject.Properties[$_].Value -ne $true
  }
  $reviewEvidence = $publicRuntimePolicy.publicReleaseProfile.reviewEvidence
  $missingReviewEvidence = @(
    "reproducibilityReview",
    "windowsRuntimeReview",
    "correspondingSourceReview"
  ) | Where-Object {
    !$reviewEvidence -or !$reviewEvidence.PSObject.Properties[$_] -or !$reviewEvidence.PSObject.Properties[$_].Value
  }
  $publicBlockers = @($publicRuntimePolicy.distributionPolicy.publicBlockers)
  if ($publicRuntimePolicy.distributionPolicy.publicAlphaAllowed -ne $true -or
      $publicBlockers.Count -gt 0 -or
      $incompleteReadiness.Count -gt 0 -or
      $missingReviewEvidence.Count -gt 0) {
    $blockerDetails = @($publicBlockers) +
      @($incompleteReadiness | ForEach-Object { "READINESS_$_" }) +
      @($missingReviewEvidence | ForEach-Object { "EVIDENCE_$_" })
    throw "Public LGPL runtime profile is fail-closed until a reviewed runtime and Corresponding Source exist: $($blockerDetails -join ', ')"
  }
  $requiredPublicInputs = [ordered]@{
    GIFP_FFMPEG_BINARY_ARCHIVE = $env:GIFP_FFMPEG_BINARY_ARCHIVE
    GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE = $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE
    GIFP_FFMPEG_CORRESPONDING_SOURCE_SHA256 = $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_SHA256
    GIFP_FFMPEG_CORRESPONDING_SOURCE_RECORD = $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_RECORD
    GIFP_QUALITY_REPORT = $env:GIFP_QUALITY_REPORT
  }
  $missingPublicInputs = @($requiredPublicInputs.GetEnumerator() | Where-Object { !$_.Value } | ForEach-Object { $_.Key })
  if ($missingPublicInputs.Count) {
    throw "public-alpha release inputs are incomplete: $($missingPublicInputs -join ', ')"
  }
  foreach ($publicFile in @(
    $env:GIFP_FFMPEG_BINARY_ARCHIVE,
    $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE,
    $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_RECORD,
    $env:GIFP_QUALITY_REPORT
  )) {
    if (!(Test-Path -LiteralPath $publicFile -PathType Leaf)) {
      throw "public-alpha release input file does not exist: $publicFile"
    }
    [void](Assert-RegularFileNoReparse $publicFile "public-alpha release input")
  }
  $expectedPublicCommit = (Assert-PublicReleaseGitState "" "preflight").Commit
  New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
  if (Test-Path -LiteralPath $publicSourceWorktree) {
    Remove-SafeContainedItem $temporaryRoot $publicSourceWorktree -Recurse
  }
  if (Test-Path -LiteralPath $publicCargoTarget) {
    Remove-SafeContainedItem $temporaryRoot $publicCargoTarget -Recurse
  }
  $safeRoot = $root.Replace("\", "/")
  $worktreeOutput = @(& git -C $root -c "safe.directory=$safeRoot" worktree add --detach $publicSourceWorktree $expectedPublicCommit 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to create independent public-alpha source worktree:`n$($worktreeOutput | Out-String)"
  }
  $publicWorktreeCreated = $true
  $buildRoot = [IO.Path]::GetFullPath($publicSourceWorktree)
  [void](Assert-TreeNoReparse $buildRoot "public-alpha source worktree")
  $snapshotState = Get-ReleaseGitState $buildRoot
  if ($snapshotState.Commit -ne $expectedPublicCommit -or $snapshotState.Dirty) {
    throw "Independent public-alpha source worktree is not the expected clean commit"
  }
  $frozenBuildInputs = Get-FrozenGitInputInventory $buildRoot $expectedPublicCommit
  $env:CARGO_TARGET_DIR = $publicCargoTarget
}

$complianceManifestRelativePath = if ($isPublicReleaseChannel) {
  "compliance/ffmpeg-windows-x64-lgpl-shared-public.json"
} else {
  "compliance/ffmpeg-windows-x64-gpl-shared.json"
}
$complianceManifestPath = Join-Path $buildRoot $complianceManifestRelativePath
$complianceVerifierPath = Join-Path $buildRoot "scripts\verify-release-compliance.mjs"
$dependencyGeneratorPath = Join-Path $buildRoot "scripts\generate-third-party-manifest.mjs"
$licenseOverlayManifestPath = Join-Path $buildRoot "compliance\license-text-overlays.json"
$unsignedPolicyPath = Join-Path $buildRoot "docs\release\UNSIGNED-ALPHA-POLICY.md"

if ($env:GIFP_QUALITY_REPORT -and !(Test-Path -LiteralPath $env:GIFP_QUALITY_REPORT -PathType Leaf)) {
  throw "GIFP_QUALITY_REPORT does not exist: $($env:GIFP_QUALITY_REPORT)"
}

foreach ($requiredFile in @(
  $complianceManifestPath,
  $complianceVerifierPath,
  $dependencyGeneratorPath,
  $licenseOverlayManifestPath,
  $unsignedPolicyPath,
  (Join-Path $buildRoot "THIRD_PARTY_NOTICES.md"),
  (Join-Path $buildRoot "README.md"),
  (Join-Path $buildRoot "ABOUT.md"),
  (Join-Path $buildRoot "LICENSE.txt")
)) {
  if (!(Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Release input is missing: $requiredFile"
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (!$node) { throw "Portable packaging requires Node.js for compliance verification" }
$nodeCommand = $node.Source
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
if (!$npm) { throw "Portable packaging requires npm" }
$npmCommand = $npm.Source
[void](Assert-RegularFileNoReparse $nodeCommand "Node.js executable")
[void](Assert-RegularFileNoReparse $npmCommand "npm launcher")

if ($isPublicReleaseChannel) {
  [void](Assert-PublicReleaseGitState $expectedPublicCommit "before isolated npm install")
  Assert-FrozenGitInputInventory $buildRoot $frozenBuildInputs
  $previousLocation = Get-Location
  try {
    Set-Location $buildRoot
    & $npmCommand ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Isolated npm ci failed with exit code $LASTEXITCODE" }
  } finally {
    Set-Location $previousLocation
  }
  Assert-FrozenGitInputInventory $buildRoot $frozenBuildInputs
  $frozenNodeDependencies = Get-FrozenNodeDependencyInventory $buildRoot $npmCommand
  Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  $publicInputsReadOnly = $true
  Set-FrozenPublicInputsReadOnly $buildRoot $frozenBuildInputs $frozenNodeDependencies $true
  Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  [void](Assert-PublicReleaseGitState $expectedPublicCommit "after isolated npm install")
}

if (!$env:GIFP_FFMPEG_DIR) {
  throw "Portable packaging requires an explicit reviewed GIFP_FFMPEG_DIR; PATH fallback is forbidden"
}
$requestedFfmpegDir = [IO.Path]::GetFullPath($env:GIFP_FFMPEG_DIR)
$ffmpegRuntimeDir = if (Test-Path -LiteralPath (Join-Path $requestedFfmpegDir "ffmpeg.exe") -PathType Leaf) {
  $requestedFfmpegDir
} elseif (Test-Path -LiteralPath (Join-Path $requestedFfmpegDir "bin\ffmpeg.exe") -PathType Leaf) {
  Join-Path $requestedFfmpegDir "bin"
} else {
  throw "GIFP_FFMPEG_DIR must contain ffmpeg.exe or bin\ffmpeg.exe: $requestedFfmpegDir"
}
$ffmpegRuntimeDir = [IO.Path]::GetFullPath($ffmpegRuntimeDir)

$ffmpegManifest = Get-Content -Raw -LiteralPath $complianceManifestPath | ConvertFrom-Json
$runtimeLicensePackageName = if ($isPublicReleaseChannel) {
  "FFmpeg-RUNTIME-LICENSES.txt"
} else {
  "FFmpeg-LICENSE.txt"
}

function Test-FfmpegRuntimeArchive([string]$ZipPath, $Manifest, [string]$RuntimeDir, [string]$LicensePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expected = @{}
  foreach ($runtimeFile in $Manifest.runtimeFiles) {
    $runtimePath = Join-Path $RuntimeDir $runtimeFile.name
    if (!(Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
      throw "FFmpeg runtime archive source file is missing: $runtimePath"
    }
    $runtimeItem = Get-Item -LiteralPath $runtimePath
    $runtimeHash = (Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($runtimeItem.Length -ne $runtimeFile.sizeBytes -or $runtimeHash -ne $runtimeFile.sha256) {
      throw "FFmpeg runtime archive source does not match the manifest: $($runtimeFile.name)"
    }
    $expected["runtime/$($runtimeFile.name)"] = [ordered]@{
      sizeBytes = [long]$runtimeItem.Length
      sha256 = $runtimeHash
    }
  }
  $licenseItem = Get-Item -LiteralPath $LicensePath
  $licenseHash = (Get-FileHash -LiteralPath $LicensePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($licenseItem.Length -ne $Manifest.licenseFile.sizeBytes -or $licenseHash -ne $Manifest.licenseFile.sha256) {
    throw "FFmpeg runtime archive license source does not match the manifest"
  }
  $expected[[string]$Manifest.licenseFile.name] = [ordered]@{
    sizeBytes = [long]$licenseItem.Length
    sha256 = $licenseHash
  }

  $seen = @{}
  $zip = [IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $zip.Entries) {
      if ($entry.FullName.EndsWith("/")) {
        throw "FFmpeg runtime archive contains an unreviewed directory entry: $($entry.FullName)"
      }
      $name = $entry.FullName.Replace("\", "/")
      if (!$expected.ContainsKey($name)) {
        throw "FFmpeg runtime archive contains an unexpected file: $name"
      }
      if ($seen.ContainsKey($name)) {
        throw "FFmpeg runtime archive contains a duplicate file: $name"
      }
      if ($entry.Length -ne $expected[$name].sizeBytes) {
        throw "FFmpeg runtime archive size mismatch for $name"
      }
      $stream = $entry.Open()
      $sha = [Security.Cryptography.SHA256]::Create()
      try {
        $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
      } finally {
        $sha.Dispose()
        $stream.Dispose()
      }
      if ($actual -ne $expected[$name].sha256) {
        throw "FFmpeg runtime archive hash mismatch for $name"
      }
      $seen[$name] = $true
    }
  } finally {
    $zip.Dispose()
  }
  if ($seen.Count -ne $expected.Count) {
    $missing = @($expected.Keys | Where-Object { !$seen.ContainsKey($_) } | Sort-Object)
    throw "FFmpeg runtime archive is missing files: $($missing -join ', ')"
  }
}
$ffmpegLicenseCandidates = @(
  (Join-Path $ffmpegRuntimeDir $ffmpegManifest.licenseFile.name),
  (Join-Path (Split-Path -Parent $ffmpegRuntimeDir) $ffmpegManifest.licenseFile.name),
  (Join-Path $ffmpegRuntimeDir "THIRD_PARTY_LICENSES\FFmpeg-LICENSE.txt"),
  (Join-Path (Split-Path -Parent $ffmpegRuntimeDir) "THIRD_PARTY_LICENSES\FFmpeg-LICENSE.txt")
) | Select-Object -Unique
$ffmpegLicense = $null
foreach ($candidate in $ffmpegLicenseCandidates) {
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $item = Get-Item -LiteralPath $candidate
  $hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($item.Length -eq $ffmpegManifest.licenseFile.sizeBytes -and
      $hash -eq $ffmpegManifest.licenseFile.sha256) {
    $ffmpegLicense = $candidate
    break
  }
}
if (!$ffmpegLicense) {
  throw "The pinned FFmpeg license file matching the compliance manifest was not found beside the reviewed runtime"
}

$projectLicensePath = Join-Path $buildRoot "LICENSE.txt"
$projectLicenseSha256 = (Get-FileHash -LiteralPath $projectLicensePath -Algorithm SHA256).Hash.ToLowerInvariant()

  $dependencyArguments = @(
    $dependencyGeneratorPath,
    "--root", $buildRoot,
    "--cargo-filter-platform", "x86_64-pc-windows-msvc",
    "--output", $temporaryDependencyManifest,
    "--licenses-output-dir", $temporaryLicenseBundle,
    "--license-overlay-manifest", $licenseOverlayManifestPath,
    "--fail-on-missing-license"
  )
  if ($isPublicReleaseChannel) {
    $dependencyArguments += "--fail-on-missing-license-text"
    Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  }
  [void](Invoke-NodeChecked $dependencyArguments "Third-party dependency/license manifest generation")
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  }
  $temporaryLicenseTextManifest = Join-Path $temporaryLicenseBundle "LICENSE-TEXTS.json"
  if (!(Test-Path -LiteralPath $temporaryLicenseTextManifest -PathType Leaf)) {
    throw "Third-party license-text generator did not create LICENSE-TEXTS.json"
  }

  if ($env:GIFP_SKIP_BUILD -ne "1") {
    if ($isPublicReleaseChannel) {
      [void](Assert-PublicReleaseGitState $expectedPublicCommit "before build")
      Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
      $env:GIFP_RELEASE_EXPECTED_GIT_COMMIT = $expectedPublicCommit
      $env:GIFP_RELEASE_EXPECTED_GIT_TREE_HASH = $frozenBuildInputs.trackedTreeHash
    }
    $previousLocation = Get-Location
    $previousBuildPath = $env:PATH
    try {
      Set-Location $buildRoot
      & $npmCommand run tauri:build
      if ($LASTEXITCODE -ne 0) {
        throw "Tauri build failed with exit code $LASTEXITCODE"
      }
    } finally {
      Set-Location $previousLocation
      $env:PATH = $previousBuildPath
      Remove-Item Env:GIFP_RELEASE_EXPECTED_GIT_COMMIT -ErrorAction SilentlyContinue
      Remove-Item Env:GIFP_RELEASE_EXPECTED_GIT_TREE_HASH -ErrorAction SilentlyContinue
    }
    if ($isPublicReleaseChannel) {
      Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
      [void](Assert-PublicReleaseGitState $expectedPublicCommit "after build")
    }
  }

  $cargoTarget = if ($env:CARGO_TARGET_DIR) {
    [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
  } else {
    Join-Path $root "src-tauri\target"
  }
  $source = Join-Path $cargoTarget "release\gif_p.exe"
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Build succeeded but executable was not found: $source"
  }

  if (Test-Path -LiteralPath $releaseDir) {
    [void](Assert-SafeContainedPath $releaseFull $releaseDir -AllowRoot -RequireExisting)
    [void](Assert-TreeNoReparse $releaseDir "release directory")
  } else {
    New-Item -ItemType Directory -Path $releaseDir | Out-Null
    [void](Assert-SafeContainedPath $releaseFull $releaseDir -AllowRoot -RequireExisting)
  }
  if (Test-Path -LiteralPath $stagingDir) {
    Remove-SafeContainedItem $releaseFull $stagingDir -Recurse
  }
  $stagingFull = Assert-ReleaseChildPath $stagingDir
  New-Item -ItemType Directory -Path $stagingFull | Out-Null
  [void](Assert-ReleaseChildPath $stagingFull -RequireExisting)
  $qualityEvidenceDir = Join-Path $stagingFull "QUALITY_EVIDENCE"
  $target = Join-Path $stagingFull "$productName.exe"
  $applicationCopy = Copy-StableReleaseFile $source $target "release executable"
  $applicationHash = $applicationCopy.Sha256

  # From this point onward version, embedded assets, signature and hashes are
  # inspected only on the controlled staging copy that will be published.
  $sourceVersion = (Get-Item -LiteralPath $target).VersionInfo
  if ($sourceVersion.ProductVersion -ne $productVersion) {
    throw "Release executable has the wrong product version: $($sourceVersion.ProductVersion)"
  }
  $sourceAscii = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($target))
  $indexPath = Join-Path $buildRoot "dist\index.html"
  if (!(Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "Production frontend index is missing: $indexPath"
  }
  $assetNames = [regex]::Matches((Get-Content -Raw -LiteralPath $indexPath), 'assets/[^"'']+') |
    ForEach-Object { [IO.Path]::GetFileName($_.Value) } |
    Sort-Object -Unique
  if (!$assetNames.Count) {
    throw "No production assets were found in dist/index.html"
  }
  foreach ($assetName in $assetNames) {
    if (!$sourceAscii.Contains($assetName)) {
      throw "Release executable does not contain embedded frontend asset: $assetName. Run npm run tauri:build before packaging."
    }
  }

  $gitState = if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    Assert-PublicReleaseGitState $expectedPublicCommit "before compliance evidence"
  } else {
    Get-ReleaseGitState
  }
  $gitCommit = $gitState.Commit
  $gitDirty = $gitState.Dirty
  if ($isPublicReleaseChannel) {
    $reviewedBuildCommit = [string]$publicRuntimePolicy.publicReleaseProfile.reviewedBuildCommit
    if ($reviewedBuildCommit -notmatch '^[a-f0-9]{40}$') {
      throw "Public LGPL reviewed-build commit is not a full Git commit"
    }
    $null = & git -c "safe.directory=$safeRoot" cat-file -e "$reviewedBuildCommit^{commit}" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Public LGPL reviewed-build commit does not exist in this repository: $reviewedBuildCommit"
    }
    $null = & git -c "safe.directory=$safeRoot" merge-base --is-ancestor $reviewedBuildCommit $gitCommit 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Public LGPL reviewed-build commit is not an ancestor of the clean release commit"
    }
  }

  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $applicationHash) {
    throw "Controlled release executable changed during version/asset inspection"
  }
  $signature = Get-ReleaseAuthenticodeSignature -LiteralPath $target
  $signatureStatus = [string]$signature.Status
  $signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { "" }
  $signerSubject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }

  $releaseGitInventory = if ($isPublicReleaseChannel) { $frozenBuildInputs } else { $null }
  $stagedComplianceManifest = Join-Path $stagingFull "FFmpeg-PROVENANCE.json"
  $stagedDependencyManifest = Join-Path $stagingFull "THIRD_PARTY-MANIFEST.json"
  $stagedUnsignedPolicy = Join-Path $stagingFull "UNSIGNED-ALPHA-POLICY.md"
  [void](Copy-TrackedReleaseFile $buildRoot $complianceManifestRelativePath $stagedComplianceManifest "FFmpeg provenance manifest" $releaseGitInventory)
  [void](Copy-StableReleaseFile $temporaryDependencyManifest $stagedDependencyManifest "third-party dependency manifest")
  [void](Copy-TrackedReleaseFile $buildRoot "docs/release/UNSIGNED-ALPHA-POLICY.md" $stagedUnsignedPolicy "unsigned Alpha policy" $releaseGitInventory)
  [void](Copy-TrackedReleaseFile $buildRoot "README.md" (Join-Path $stagingFull "README.md") "README" $releaseGitInventory)
  [void](Copy-TrackedReleaseFile $buildRoot "ABOUT.md" (Join-Path $stagingFull "ABOUT.md") "About" $releaseGitInventory)
  [void](Copy-TrackedReleaseFile $buildRoot "THIRD_PARTY_NOTICES.md" (Join-Path $stagingFull "THIRD_PARTY_NOTICES.md") "third-party notices" $releaseGitInventory)
  Write-Utf8NoBom (Join-Path $stagingFull "VERSION.txt") "GIFP $productVersion`nAuthor: $productAuthor`nLicense: $productLicenseId (freeware)`nChannel: $distributionChannel`nArtifact: $productName`n"

  # Materialize every externally supplied compliance input first. The Node
  # verifier is pointed only at these controlled bytes, and these exact files
  # are later moved into or retained in the published package.
  $ffmpegManifest = Get-Content -Raw -LiteralPath $stagedComplianceManifest | ConvertFrom-Json
  $runtimeReviewDir = Join-Path $stagingFull ".ffmpeg-runtime-review"
  New-Item -ItemType Directory -Path $runtimeReviewDir | Out-Null
  foreach ($runtimeFile in $ffmpegManifest.runtimeFiles) {
    $runtimeSource = Join-Path $ffmpegRuntimeDir $runtimeFile.name
    $runtimeDestination = Join-Path $runtimeReviewDir $runtimeFile.name
    [void](Copy-StableReleaseFile $runtimeSource $runtimeDestination "FFmpeg runtime $($runtimeFile.name)" $runtimeFile.sha256 ([Nullable[Int64]]([int64]$runtimeFile.sizeBytes)))
  }
  $thirdPartyLicenseDir = Join-Path $stagingFull "THIRD_PARTY_LICENSES"
  New-Item -ItemType Directory -Path $thirdPartyLicenseDir | Out-Null
  $stagedFfmpegLicense = Join-Path $thirdPartyLicenseDir $runtimeLicensePackageName
  [void](Copy-StableReleaseFile $ffmpegLicense $stagedFfmpegLicense "FFmpeg license" $ffmpegManifest.licenseFile.sha256 ([Nullable[Int64]]([int64]$ffmpegManifest.licenseFile.sizeBytes)))
  $licenseBundleInventory = @(Get-FrozenDirectoryInventory $temporaryLicenseBundle)
  $stagedLicenseBundle = Join-Path $thirdPartyLicenseDir "DEPENDENCIES"
  Copy-Item -LiteralPath $temporaryLicenseBundle -Destination $stagedLicenseBundle -Recurse
  Assert-DirectoryMatchesInventory $temporaryLicenseBundle $licenseBundleInventory
  Assert-DirectoryMatchesInventory $stagedLicenseBundle $licenseBundleInventory
  $stagedLicenseTextManifest = Join-Path $stagedLicenseBundle "LICENSE-TEXTS.json"

  $stagedProjectLicense = Join-Path $stagingFull "LICENSE.txt"
  [void](Copy-TrackedReleaseFile $buildRoot "LICENSE.txt" $stagedProjectLicense "project license" $releaseGitInventory)
  if ((Get-FileHash -LiteralPath $stagedProjectLicense -Algorithm SHA256).Hash.ToLowerInvariant() -ne $projectLicenseSha256) {
    throw "Packaged GIFP project license changed during staging"
  }

  $stagedSourceRecord = $null
  if ($isPublicReleaseChannel) {
    $binaryAssetOutputName = [IO.Path]::GetFileName($env:GIFP_FFMPEG_BINARY_ARCHIVE)
    $binaryAssetOutput = Join-Path $releaseDir $binaryAssetOutputName
    $temporaryBinaryAsset = Join-Path $releaseDir ".$binaryAssetOutputName-$PID.tmp"
    $backupBinaryAsset = Join-Path $releaseDir ".$binaryAssetOutputName-$PID.previous"
    $sourceOutputName = "$productName-$([IO.Path]::GetFileName($env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE))"
    $sourceOutput = Join-Path $releaseDir $sourceOutputName
    $temporarySource = Join-Path $releaseDir ".$sourceOutputName-$PID.tmp"
    $backupSource = Join-Path $releaseDir ".$sourceOutputName-$PID.previous"
    foreach ($reservedOutput in @($archive, $checksums)) {
      if ([string]::Equals([IO.Path]::GetFullPath($binaryAssetOutput), [IO.Path]::GetFullPath($reservedOutput), [StringComparison]::OrdinalIgnoreCase) -or
          [string]::Equals([IO.Path]::GetFullPath($sourceOutput), [IO.Path]::GetFullPath($reservedOutput), [StringComparison]::OrdinalIgnoreCase)) {
        throw "A public FFmpeg release asset collides with a GIFP package output: $reservedOutput"
      }
    }
    if ([string]::Equals([IO.Path]::GetFullPath($binaryAssetOutput), [IO.Path]::GetFullPath($sourceOutput), [StringComparison]::OrdinalIgnoreCase)) {
      throw "The FFmpeg runtime archive and Corresponding Source output names must be distinct"
    }
    foreach ($path in @($binaryAssetOutput, $temporaryBinaryAsset, $backupBinaryAsset, $sourceOutput, $temporarySource, $backupSource)) {
      [void](Assert-ReleaseChildPath $path)
    }
    if (Test-Path -LiteralPath $temporaryBinaryAsset) { Remove-SafeContainedItem $releaseFull $temporaryBinaryAsset }
    [void](Copy-StableReleaseFile $env:GIFP_FFMPEG_BINARY_ARCHIVE $temporaryBinaryAsset "Public FFmpeg runtime archive" $ffmpegManifest.binaryAsset.sha256 ([Nullable[Int64]]([int64]$ffmpegManifest.binaryAsset.sizeBytes)))
    $copiedBinaryAssetHash = (Get-FileHash -LiteralPath $temporaryBinaryAsset -Algorithm SHA256).Hash.ToLowerInvariant()
    Test-FfmpegRuntimeArchive $temporaryBinaryAsset $ffmpegManifest $ffmpegRuntimeDir $ffmpegLicense
    if (Test-Path -LiteralPath $temporarySource) { Remove-SafeContainedItem $releaseFull $temporarySource }
    [void](Copy-StableReleaseFile $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE $temporarySource "Corresponding Source archive" $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_SHA256)
    $copiedSourceHash = (Get-FileHash -LiteralPath $temporarySource -Algorithm SHA256).Hash.ToLowerInvariant()
    $stagedSourceRecord = Join-Path $stagingFull "FFmpeg-SOURCE-REVIEW.json"
    [void](Copy-StableReleaseFile $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_RECORD $stagedSourceRecord "Corresponding Source review record")
  }

  $complianceArguments = @(
    $complianceVerifierPath,
    "--manifest", $stagedComplianceManifest,
    "--runtime-dir", $runtimeReviewDir,
    "--ffmpeg-license", $stagedFfmpegLicense,
    "--dependency-manifest", $stagedDependencyManifest,
    "--license-text-manifest", $stagedLicenseTextManifest,
    "--channel", $distributionChannel,
    "--artifact-name", $productName,
    "--git-commit", $gitCommit,
    "--git-dirty", $gitDirty.ToString().ToLowerInvariant(),
    "--signature-status", $signatureStatus,
    "--output", $temporaryComplianceReport
  )
  if ($isPublicReleaseChannel) {
    $complianceArguments += @("--git-tree-hash", $frozenBuildInputs.trackedTreeHash)
  }
  $optionalComplianceArguments = @{
    "project-license-id" = $productLicenseId
    "project-license-file" = $stagedProjectLicense
    "project-license-sha256" = $projectLicenseSha256
    "binary-asset" = $temporaryBinaryAsset
    "source-bundle" = $temporarySource
    "source-bundle-sha256" = $env:GIFP_FFMPEG_CORRESPONDING_SOURCE_SHA256
    "source-bundle-record" = $stagedSourceRecord
    "allow-unsigned-alpha" = $env:GIFP_ALLOW_UNSIGNED_ALPHA
    "signer-thumbprint" = $signerThumbprint
    "allowed-signer-thumbprint" = $env:GIFP_ALLOWED_SIGNER_THUMBPRINT
  }
  foreach ($entry in $optionalComplianceArguments.GetEnumerator()) {
    if ($entry.Value) {
      $complianceArguments += @("--$($entry.Key)", [string]$entry.Value)
    }
  }
  if ($env:GIFP_QUALITY_REPORT) {
    $complianceArguments += @(
      "--quality-report", [IO.Path]::GetFullPath($env:GIFP_QUALITY_REPORT),
      "--quality-evidence-dir", $qualityEvidenceDir,
      "--quality-evidence-root", $stagingFull
    )
  }
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  }
  [void](Invoke-NodeChecked $complianceArguments "Release compliance verification")
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputsFull $buildRoot $frozenBuildInputs $frozenNodeDependencies
  }
  $compliance = Get-Content -Raw -LiteralPath $temporaryComplianceReport | ConvertFrom-Json
  $qualityEvidence = $compliance.qualityEvidence
  $compliance.PSObject.Properties.Remove("qualityEvidence")
  if ($isPublicReleaseChannel) {
    if (!$qualityEvidence -or $qualityEvidence.qualifiedForFirstTierRelease -ne $true) {
      throw "public-alpha compliance did not produce qualified first-tier Quality evidence"
    }
    if (!(Test-Path -LiteralPath (Join-Path $qualityEvidenceDir "QUALITY-EVIDENCE.json") -PathType Leaf)) {
      throw "public-alpha compliance did not materialize QUALITY_EVIDENCE"
    }
    [void](Assert-TreeNoReparse $qualityEvidenceDir "public-alpha Quality evidence")
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "after evidence materialization")
  }
  if (Test-Path -LiteralPath $qualityEvidenceDir -PathType Container) {
    $qualityEvidenceInventory = @(Get-FrozenDirectoryInventory $qualityEvidenceDir)
    Assert-DirectoryMatchesInventory $qualityEvidenceDir $qualityEvidenceInventory
  }

  if ($isPublicReleaseChannel) {
    $manifestEntry = Get-FrozenGitInputEntry $frozenBuildInputs $complianceManifestRelativePath
    if ((Get-FileHash -LiteralPath $stagedComplianceManifest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifestEntry.sha256) {
      throw "Staged FFmpeg provenance manifest changed during compliance verification"
    }
    if ((Get-FileHash -LiteralPath $stagedProjectLicense -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compliance.distribution.projectLicense.sha256) {
      throw "Staged project license changed during compliance verification"
    }
    if ([int64](Get-Item -LiteralPath $stagedProjectLicense).Length -ne [int64]$compliance.distribution.projectLicense.sizeBytes) {
      throw "Staged project license size changed during compliance verification"
    }
    if ((Get-FileHash -LiteralPath $stagedSourceRecord -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compliance.distribution.correspondingSource.recordSha256) {
      throw "Staged Corresponding Source review record changed during compliance verification"
    }
    if ([int64](Get-Item -LiteralPath $stagedSourceRecord).Length -ne [int64]$compliance.distribution.correspondingSource.recordSizeBytes) {
      throw "Staged Corresponding Source review record size changed during compliance verification"
    }
    if ((Get-FileHash -LiteralPath $temporaryBinaryAsset -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compliance.binaryAsset.sha256) {
      throw "Controlled Public FFmpeg runtime archive changed during compliance verification"
    }
    if ([int64](Get-Item -LiteralPath $temporaryBinaryAsset).Length -ne [int64]$compliance.binaryAsset.sizeBytes) {
      throw "Controlled Public FFmpeg runtime archive size changed during compliance verification"
    }
    Test-FfmpegRuntimeArchive $temporaryBinaryAsset $ffmpegManifest $ffmpegRuntimeDir $ffmpegLicense
    if ((Get-FileHash -LiteralPath $temporarySource -Algorithm SHA256).Hash.ToLowerInvariant() -ne $compliance.distribution.correspondingSource.sha256) {
      throw "Controlled Corresponding Source archive changed during compliance verification"
    }
  }

  # Move the already-verified runtime bytes into their final package names;
  # no external FFmpeg path is read again after compliance verification.
  foreach ($runtimeFile in $ffmpegManifest.runtimeFiles) {
    [void](Get-VerifiedRuntimeFact $compliance $runtimeFile)
    $reviewedRuntimePath = Join-Path $runtimeReviewDir $runtimeFile.name
    $packagedRuntimePath = Join-Path $stagingFull $runtimeFile.name
    Move-SafeContainedItem $releaseFull $reviewedRuntimePath $packagedRuntimePath
    $packagedRuntimeHash = (Get-FileHash -LiteralPath $packagedRuntimePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($packagedRuntimeHash -ne $runtimeFile.sha256 -or [int64](Get-Item -LiteralPath $packagedRuntimePath).Length -ne [int64]$runtimeFile.sizeBytes) {
      throw "Packaged FFmpeg runtime $($runtimeFile.name) changed after verification"
    }
  }
  Remove-SafeContainedItem $releaseFull $runtimeReviewDir -Recurse
  if ($compliance.ffmpegLicense.sha256 -ne (Get-FileHash -LiteralPath $stagedFfmpegLicense -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw "Packaged FFmpeg license changed after compliance verification"
  }
  if ($compliance.dependencyManifest.sha256 -ne (Get-FileHash -LiteralPath $stagedDependencyManifest -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw "Packaged dependency manifest changed after compliance verification"
  }
  if ($compliance.licenseTextBundle.sha256 -ne (Get-FileHash -LiteralPath $stagedLicenseTextManifest -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw "Packaged dependency license manifest changed after compliance verification"
  }
  Assert-DirectoryMatchesInventory $stagedLicenseBundle $licenseBundleInventory

  $sourceAvailabilityStatement = if ($isPublicReleaseChannel) {
    "The reviewed complete Corresponding Source is named in FFmpeg-SOURCE-OFFER.txt and published beside the binary release assets."
  } else {
    "This internal package records upstream source locations only. It is not represented as a reviewed complete Corresponding Source archive and is not approved for redistribution."
  }
  $sourceInfo = @"
GIFP $productVersion - FFmpeg Source Information

Bundled component: FFmpeg
Version: $($compliance.version.marker)
License: $($compliance.licenseExpression)
Binary package: $($compliance.binaryAsset.url)
Binary package SHA256: $($compliance.binaryAsset.sha256)
FFmpeg commit: $($compliance.version.ffmpegCommit)
FFmpeg source archive: $($compliance.sourceProvenance.ffmpegArchiveUrl)
Build recipe commit: $($compliance.version.buildRecipeCommit)
Build recipe source: $($compliance.sourceProvenance.buildRecipeCommitUrl)
License text: THIRD_PARTY_LICENSES/$runtimeLicensePackageName
Runtime provenance: FFmpeg-PROVENANCE.json

$sourceAvailabilityStatement
"@
  Write-Utf8NoBom (Join-Path $stagingFull "FFmpeg-SOURCE-INFO.txt") $sourceInfo

  if ($isPublicReleaseChannel) {
    $sourceOffer = @"
GIFP $productVersion FFmpeg Corresponding Source
Binary artifact: $productName-portable.zip
FFmpeg runtime archive: $binaryAssetOutputName
Source archive: $sourceOutputName
Source SHA256: $($compliance.distribution.correspondingSource.sha256)
Distribution URL: $($compliance.distribution.correspondingSource.distributionUrl)
FFmpeg commit: $($compliance.version.ffmpegCommit)
Builder recipe commit: $($compliance.version.buildRecipeCommit)
Source lock SHA256: $($compliance.publicSourceLock.sha256)
GIFP build-recipe lock SHA256: $($compliance.publicSourceLock.buildRecipeLock.sha256)
"@
    Write-Utf8NoBom (Join-Path $stagingFull "FFmpeg-SOURCE-OFFER.txt") $sourceOffer
    $buildInputsRecord = [ordered]@{
      schemaVersion = 2
      gitSource = $frozenBuildInputs
      npmDependencies = $frozenNodeDependencies
    }
    Write-Utf8NoBom (Join-Path $stagingFull "BUILD-INPUTS.json") (($buildInputsRecord | ConvertTo-Json -Depth 12) + "`n")
  }

  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $applicationHash) {
    throw "Controlled release executable changed after compliance verification"
  }
  $finalSignature = Get-ReleaseAuthenticodeSignature -LiteralPath $target
  $finalSignerThumbprint = if ($finalSignature.SignerCertificate) { $finalSignature.SignerCertificate.Thumbprint } else { "" }
  if ([string]$finalSignature.Status -ne $signatureStatus -or $finalSignerThumbprint -ne $signerThumbprint) {
    throw "Controlled release executable signature changed after compliance verification"
  }
  $stagedPackageVerifier = Join-Path $stagingFull "VERIFY-GIFP.ps1"
  [void](Copy-TrackedReleaseFile $buildRoot "scripts/VERIFY-GIFP.ps1" $stagedPackageVerifier "package verification entry point" $releaseGitInventory)
  $embeddedSignerThumbprint = if ($isFormalPublicChannel) {
    $formalPublicThumbprint
  } elseif ($signerThumbprint) {
    $signerThumbprint.Replace(" ", "").ToLowerInvariant()
  } else {
    ""
  }
  $verifierText = Get-Content -Raw -LiteralPath $stagedPackageVerifier
  $verifierText = $verifierText.
    Replace("__GIFP_VERSION__", $productVersion).
    Replace("__GIFP_CHANNEL__", $distributionChannel).
    Replace("__GIFP_REDISTRIBUTABLE__", ([bool]$compliance.distribution.redistributable).ToString()).
    Replace("__GIFP_ALLOWED_SIGNER_THUMBPRINT__", $embeddedSignerThumbprint)
  if ($verifierText -match '__GIFP_[A-Z_]+__') {
    throw "Package verification entry point contains an unresolved release placeholder"
  }
  Write-Utf8NoBom $stagedPackageVerifier $verifierText
  $dependencyManifestHash = (Get-FileHash -LiteralPath $stagedDependencyManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  $licenseTextManifestHash = (Get-FileHash -LiteralPath $stagedLicenseTextManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  $publicBlockers = @($compliance.distributionPolicy.publicBlockers)
  if ($distributionChannel -eq "internal") {
    if (!$env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE) { $publicBlockers += "CORRESPONDING_SOURCE_BUNDLE_REQUIRED" }
    if ($signatureStatus -eq "NotSigned") { $publicBlockers += "SIGNATURE_OR_UNSIGNED_ALPHA_OVERRIDE_REQUIRED" }
    if ($gitDirty) { $publicBlockers += "CLEAN_WORKTREE_REQUIRED" }
    if ($compliance.licenseTextBundle.missingLicenseTextCount -gt 0 -and $publicBlockers -notcontains "THIRD_PARTY_LICENSE_TEXTS_INCOMPLETE") {
      $publicBlockers += "THIRD_PARTY_LICENSE_TEXTS_INCOMPLETE"
    }
    if (!$qualityEvidence) {
      $publicBlockers += "FIRST_TIER_QUALITY_EVIDENCE_REQUIRED"
    } else {
      if ($qualityEvidence.binding.commitMatchesPackage -ne $true) { $publicBlockers += "QUALITY_EVIDENCE_COMMIT_MISMATCH" }
      if ($qualityEvidence.binding.reportClean -ne $true) { $publicBlockers += "QUALITY_EVIDENCE_DIRTY" }
      if ($qualityEvidence.binding.buildCommitMatchesPackage -ne $true) { $publicBlockers += "QUALITY_EXECUTOR_COMMIT_MISMATCH" }
      if ($qualityEvidence.binding.buildTreeMatchesPackage -ne $true) { $publicBlockers += "QUALITY_EXECUTOR_TREE_MISMATCH" }
      if ($qualityEvidence.binding.buildProvenancePassed -ne $true) { $publicBlockers += "QUALITY_BUILD_PROVENANCE_FAILED" }
      if (
        $qualityEvidence.gate.applicable -ne $true -or
        $qualityEvidence.gate.provenancePassed -ne $true -or
        $qualityEvidence.gate.canonicalCorpusPassed -ne $true -or
        $qualityEvidence.gate.canonicalFixtureIdentityPassed -ne $true -or
        $qualityEvidence.gate.passed -ne $true
      ) {
        $publicBlockers += "FIRST_TIER_QUALITY_GATE_NOT_PASSED"
      }
    }
    $publicBlockers += "PUBLIC_CHANNEL_NOT_REQUESTED"
  }
  $publicBlockers = @($publicBlockers | Select-Object -Unique)
  $distributionRecord = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTimeOffset]::Now.ToString("o")
    product = [ordered]@{
      name = "GIFP"
      version = $productVersion
      author = $productAuthor
      softwareType = "freeware"
      license = [ordered]@{
        id = $productLicenseId
        fileName = "LICENSE.txt"
        sizeBytes = (Get-Item -LiteralPath $stagedProjectLicense).Length
        sha256 = $projectLicenseSha256
      }
      artifactName = $productName
      channel = $distributionChannel
    }
    source = [ordered]@{
      gitCommit = $gitCommit
      dirty = $gitDirty
    }
    application = [ordered]@{
      fileName = [IO.Path]::GetFileName($target)
      sizeBytes = (Get-Item -LiteralPath $target).Length
      sha256 = $applicationHash
      productVersion = $sourceVersion.ProductVersion
      signatureStatus = $signatureStatus
      signerSubject = $signerSubject
      signerThumbprint = if ($signerThumbprint) { $signerThumbprint.ToLowerInvariant() } else { $null }
    }
    thirdPartyManifest = [ordered]@{
      fileName = "THIRD_PARTY-MANIFEST.json"
      sha256 = $dependencyManifestHash
      componentCount = $compliance.dependencyManifest.componentCount
      missingLicenseCount = $compliance.dependencyManifest.missingLicenseCount
      licenseTextBundle = [ordered]@{
        fileName = "THIRD_PARTY_LICENSES/DEPENDENCIES/LICENSE-TEXTS.json"
        sha256 = $licenseTextManifestHash
        componentsWithLicenseTextCount = $compliance.licenseTextBundle.componentsWithLicenseTextCount
        missingLicenseTextCount = $compliance.licenseTextBundle.missingLicenseTextCount
        uniqueLicenseTextCount = $compliance.licenseTextBundle.uniqueLicenseTextCount
      }
    }
    qualityEvidence = $qualityEvidence
    ffmpeg = $compliance
    distribution = $compliance.distribution
    publicReleaseBlockers = $publicBlockers
  }
  Write-Utf8NoBom (Join-Path $stagingFull "DISTRIBUTION.json") (($distributionRecord | ConvertTo-Json -Depth 20) + "`n")

  $buildInfo = @"
GIFP portable release evidence
Generated: $([DateTimeOffset]::Now.ToString("o"))
Artifact: $productName
Author: $productAuthor
Product license: $productLicenseId (freeware)
Channel: $distributionChannel
Distribution status: $($compliance.distribution.status)
Git commit: $gitCommit
Git dirty: $gitDirty
Application SHA256: $applicationHash
Authenticode status: $signatureStatus
Pinned binary package URL: $($compliance.binaryAsset.url)
Pinned binary package SHA256: $($compliance.binaryAsset.sha256)
FFmpeg source commit: $($compliance.sourceProvenance.ffmpegCommitUrl)
FFmpeg source archive: $($compliance.sourceProvenance.ffmpegArchiveUrl)
Builder recipe commit: $($compliance.sourceProvenance.buildRecipeCommitUrl)
FFmpeg runtime license: $($compliance.licenseExpression)
FFmpeg runtime manifest: FFmpeg-PROVENANCE.json
FFmpeg source information: FFmpeg-SOURCE-INFO.txt
Third-party dependency manifest: THIRD_PARTY-MANIFEST.json ($($compliance.dependencyManifest.componentCount) components)
Third-party license texts: $($compliance.licenseTextBundle.componentsWithLicenseTextCount)/$($compliance.licenseTextBundle.componentCount) components; $($compliance.licenseTextBundle.missingLicenseTextCount) unresolved

$($compliance.ffmpeg.versionLine)
$($compliance.ffmpeg.configurationLine)
"@
  Write-Utf8NoBom (Join-Path $stagingFull "FFmpeg-BUILDINFO.txt") $buildInfo

  if ($qualityEvidenceInventory) {
    Assert-DirectoryMatchesInventory $qualityEvidenceDir $qualityEvidenceInventory
  }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $applicationHash) {
    throw "Controlled release executable changed before package inventory freeze"
  }
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "before package inventory freeze")
  }
  $payloadInventory = Get-FrozenDirectoryInventory $stagingFull @("FILES-SHA256.txt")
  foreach ($requiredPayloadPath in @(
    "ABOUT.md",
    "LICENSE.txt",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES/FFmpeg-LICENSE.txt",
    "FFmpeg-PROVENANCE.json",
    "FFmpeg-BUILDINFO.txt",
    "FFmpeg-SOURCE-INFO.txt",
    "DISTRIBUTION.json",
    "VERIFY-GIFP.ps1",
    "VERSION.txt"
  )) {
    $requiredPayloadMatches = @($payloadInventory | Where-Object { $_.Path -ceq $requiredPayloadPath })
    if ($requiredPayloadMatches.Count -ne 1) {
      throw "Portable package is missing required release information: $requiredPayloadPath"
    }
  }
  $frozenApplication = @($payloadInventory | Where-Object { $_.Path -ceq "$productName.exe" })
  if ($frozenApplication.Count -ne 1 -or $frozenApplication[0].Sha256 -ne $applicationHash) {
    throw "Frozen package inventory does not contain the verified release executable"
  }
  $hashLines = @($payloadInventory | Sort-Object Path | ForEach-Object { "$($_.Sha256)  $($_.Path)" })
  $filesManifestPath = Join-Path $stagingFull "FILES-SHA256.txt"
  Write-Utf8NoBom $filesManifestPath (($hashLines -join "`n") + "`n")
  $filesManifestItem = Get-Item -LiteralPath $filesManifestPath
  $frozenPackageInventory = @($payloadInventory) + @([pscustomobject]@{
    Path = "FILES-SHA256.txt"
    SizeBytes = [int64]$filesManifestItem.Length
    Sha256 = (Get-FileHash -LiteralPath $filesManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  })
  Assert-DirectoryMatchesInventory $stagingFull $frozenPackageInventory
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "after package inventory freeze")
  }

  $previousPath = $env:PATH
  try {
    $env:PATH = $stagingFull
    & (Join-Path $stagingFull "ffmpeg.exe") -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Bundled ffmpeg.exe failed its isolated smoke test" }
    & (Join-Path $stagingFull "ffprobe.exe") -version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Bundled ffprobe.exe failed its isolated smoke test" }
  } finally {
    $env:PATH = $previousPath
  }

  Assert-DirectoryMatchesInventory $stagingFull $frozenPackageInventory
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $stagedPackageVerifier -PackageRoot $stagingFull
  if ($LASTEXITCODE -ne 0) {
    throw "Packaged VERIFY-GIFP.ps1 failed against the frozen portable payload"
  }

  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "before archive")
  }

  if (Test-Path -LiteralPath $temporaryArchive) { Remove-SafeContainedItem $releaseFull $temporaryArchive }
  Compress-Archive -Path (Join-Path $stagingFull "*") -DestinationPath $temporaryArchive -CompressionLevel Optimal
  Assert-DirectoryMatchesInventory $stagingFull $frozenPackageInventory
  Test-ZipAgainstInventory $temporaryArchive $frozenPackageInventory
  $archiveHash = (Get-FileHash -LiteralPath $temporaryArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "after archive verification")
  }
  $checksumLines = @("$archiveHash  $([IO.Path]::GetFileName($archive))")
  if ($isPublicReleaseChannel) {
    [void](Assert-RegularFileNoReparse $temporaryBinaryAsset "verified Public FFmpeg runtime archive")
    $currentBinaryAssetHash = (Get-FileHash -LiteralPath $temporaryBinaryAsset -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentBinaryAssetHash -ne $copiedBinaryAssetHash) {
      throw "Verified Public FFmpeg runtime archive changed before publication"
    }
    if ($copiedBinaryAssetHash -ne $compliance.binaryAsset.sha256) {
      throw "Verified Public FFmpeg runtime archive no longer matches compliance evidence"
    }
    [void](Assert-RegularFileNoReparse $temporarySource "verified Corresponding Source archive")
    $currentSourceHash = (Get-FileHash -LiteralPath $temporarySource -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentSourceHash -ne $copiedSourceHash) {
      throw "Verified Corresponding Source archive changed before publication"
    }
    if ($copiedSourceHash -ne $compliance.distribution.correspondingSource.sha256) {
      throw "Verified Corresponding Source archive no longer matches compliance evidence"
    }
    $checksumLines += "$copiedBinaryAssetHash  $binaryAssetOutputName"
    $checksumLines += "$copiedSourceHash  $sourceOutputName"
  }
  $expectedChecksumsText = (($checksumLines -join "`n") + "`n")
  Write-Utf8NoBom $temporaryChecksums $expectedChecksumsText
  [void](Assert-RegularFileNoReparse $temporaryChecksums "temporary checksum manifest")

  if ($isPublicReleaseChannel) {
    Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
    [void](Assert-PublicReleaseGitState $expectedPublicCommit "before publish transaction")
  }

  foreach ($backupPath in @($backupDir, $backupArchive, $backupChecksums, $backupBinaryAsset, $backupSource)) {
    if (!$backupPath -or !(Test-Path -LiteralPath $backupPath)) { continue }
    $backupItem = Get-Item -LiteralPath $backupPath
    if ($backupItem.PSIsContainer) {
      Remove-SafeContainedItem $releaseFull $backupPath -Recurse
    } else {
      Remove-SafeContainedItem $releaseFull $backupPath
    }
  }

  $hadPreviousDirectory = Test-Path -LiteralPath $versionedDir
  $hadPreviousArchive = Test-Path -LiteralPath $archive
  $hadPreviousChecksums = Test-Path -LiteralPath $checksums
  $hadPreviousBinaryAsset = $binaryAssetOutput -and (Test-Path -LiteralPath $binaryAssetOutput)
  $hadPreviousSource = $sourceOutput -and (Test-Path -LiteralPath $sourceOutput)
  $backupDirectorySucceeded = $false
  $backupArchiveSucceeded = $false
  $backupChecksumsSucceeded = $false
  $backupBinaryAssetSucceeded = $false
  $backupSourceSucceeded = $false
  $newDirectoryPublished = $false
  $newArchivePublished = $false
  $newChecksumsPublished = $false
  $newBinaryAssetPublished = $false
  $newSourcePublished = $false
  try {
    if ($hadPreviousDirectory) { Move-SafeContainedItem $releaseFull $versionedDir $backupDir; $backupDirectorySucceeded = $true }
    if ($hadPreviousArchive) { Move-SafeContainedItem $releaseFull $archive $backupArchive; $backupArchiveSucceeded = $true }
    if ($hadPreviousChecksums) { Move-SafeContainedItem $releaseFull $checksums $backupChecksums; $backupChecksumsSucceeded = $true }
    if ($hadPreviousBinaryAsset) { Move-SafeContainedItem $releaseFull $binaryAssetOutput $backupBinaryAsset; $backupBinaryAssetSucceeded = $true }
    if ($hadPreviousSource) { Move-SafeContainedItem $releaseFull $sourceOutput $backupSource; $backupSourceSucceeded = $true }

    [void](Publish-VerifiedDirectory $releaseFull $stagingFull $versionedDir $frozenPackageInventory)
    $newDirectoryPublished = $true
    Move-SafeContainedItem $releaseFull $temporaryArchive $archive
    $newArchivePublished = $true
    Move-SafeContainedItem $releaseFull $temporaryChecksums $checksums
    $newChecksumsPublished = $true
    if ($binaryAssetOutput) { Move-SafeContainedItem $releaseFull $temporaryBinaryAsset $binaryAssetOutput; $newBinaryAssetPublished = $true }
    if ($sourceOutput) { Move-SafeContainedItem $releaseFull $temporarySource $sourceOutput; $newSourcePublished = $true }

    Assert-DirectoryMatchesInventory $versionedDir $frozenPackageInventory
    [void](Assert-RegularFileNoReparse $archive "published portable archive")
    Test-ZipAgainstInventory $archive $frozenPackageInventory
    $publishedArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($publishedArchiveHash -ne $archiveHash) { throw "Published portable archive hash changed during publication" }
    [void](Assert-RegularFileNoReparse $checksums "published checksum manifest")
    if ((Get-Content -Raw -LiteralPath $checksums) -cne $expectedChecksumsText) {
      throw "Published checksum manifest changed during publication"
    }
    if ($binaryAssetOutput) {
      [void](Assert-RegularFileNoReparse $binaryAssetOutput "published Public FFmpeg runtime archive")
      $publishedBinaryAssetHash = (Get-FileHash -LiteralPath $binaryAssetOutput -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($publishedBinaryAssetHash -ne $copiedBinaryAssetHash) { throw "Published Public FFmpeg runtime archive hash changed during publication" }
    }
    if ($sourceOutput) {
      [void](Assert-RegularFileNoReparse $sourceOutput "published Corresponding Source archive")
      $publishedSourceHash = (Get-FileHash -LiteralPath $sourceOutput -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($publishedSourceHash -ne $copiedSourceHash) { throw "Published Corresponding Source hash changed during publication" }
    }
    if ($isPublicReleaseChannel) {
      Assert-FrozenPublicBuildInputs $buildRoot $frozenBuildInputs $frozenNodeDependencies
      [void](Assert-PublicReleaseGitState $expectedPublicCommit "after publish transaction")
    }
  } catch {
    if ($newDirectoryPublished -and (Test-Path -LiteralPath $versionedDir)) { Remove-SafeContainedItem $releaseFull $versionedDir -Recurse }
    if ($newArchivePublished -and (Test-Path -LiteralPath $archive)) { Remove-SafeContainedItem $releaseFull $archive }
    if ($newChecksumsPublished -and (Test-Path -LiteralPath $checksums)) { Remove-SafeContainedItem $releaseFull $checksums }
    if ($newBinaryAssetPublished -and $binaryAssetOutput -and (Test-Path -LiteralPath $binaryAssetOutput)) { Remove-SafeContainedItem $releaseFull $binaryAssetOutput }
    if ($newSourcePublished -and $sourceOutput -and (Test-Path -LiteralPath $sourceOutput)) { Remove-SafeContainedItem $releaseFull $sourceOutput }
    if ($backupDirectorySucceeded -and (Test-Path -LiteralPath $backupDir)) { Move-SafeContainedItem $releaseFull $backupDir $versionedDir }
    if ($backupArchiveSucceeded -and (Test-Path -LiteralPath $backupArchive)) { Move-SafeContainedItem $releaseFull $backupArchive $archive }
    if ($backupChecksumsSucceeded -and (Test-Path -LiteralPath $backupChecksums)) { Move-SafeContainedItem $releaseFull $backupChecksums $checksums }
    if ($backupBinaryAssetSucceeded -and $binaryAssetOutput -and (Test-Path -LiteralPath $backupBinaryAsset)) { Move-SafeContainedItem $releaseFull $backupBinaryAsset $binaryAssetOutput }
    if ($backupSourceSucceeded -and $sourceOutput -and (Test-Path -LiteralPath $backupSource)) { Move-SafeContainedItem $releaseFull $backupSource $sourceOutput }
    throw
  }

  foreach ($backupPath in @($backupDir, $backupArchive, $backupChecksums, $backupBinaryAsset, $backupSource)) {
    if (!$backupPath -or !(Test-Path -LiteralPath $backupPath)) { continue }
    $backupItem = Get-Item -LiteralPath $backupPath
    if ($backupItem.PSIsContainer) {
      Remove-SafeContainedItem $releaseFull $backupPath -Recurse
    } else {
      Remove-SafeContainedItem $releaseFull $backupPath
    }
  }

  Write-Host "GIFP $productVersion portable package ready:"
  Write-Host (Join-Path $versionedDir "$productName.exe")
  Write-Host "Portable archive:"
  Write-Host $archive
  Write-Host "Archive SHA256: $archiveHash"
  Write-Host "Distribution status: $($compliance.distribution.status)"
  $publicationCompleted = $true
} finally {
  Set-Location $root
  if ($publicInputsReadOnly -and $frozenBuildInputs -and $frozenNodeDependencies -and (Test-Path -LiteralPath $publicSourceWorktree)) {
    Set-FrozenPublicInputsReadOnly $buildRoot $frozenBuildInputs $frozenNodeDependencies $false
    $publicInputsReadOnly = $false
  }
  foreach ($temporaryFile in @($temporaryComplianceReport, $temporaryDependencyManifest)) {
    if ($temporaryFile -and (Test-Path -LiteralPath $temporaryFile)) {
      Remove-SafeContainedItem $temporaryRoot $temporaryFile
    }
  }
  foreach ($temporaryFile in @($temporaryArchive, $temporaryChecksums, $temporaryBinaryAsset, $temporarySource)) {
    if ($temporaryFile -and (Test-Path -LiteralPath $temporaryFile)) {
      Remove-SafeContainedItem $releaseFull $temporaryFile
    }
  }
  if (Test-Path -LiteralPath $stagingDir) {
    try {
      Remove-SafeContainedItem $releaseFull $stagingDir -Recurse
    } catch {
      if (!$publicationCompleted) {
        throw
      }
      Write-Warning "The verified release was published, but its temporary staging directory could not be removed: $stagingDir"
    }
  }
  if (Test-Path -LiteralPath $temporaryLicenseBundle) {
    Remove-SafeContainedItem $temporaryRoot $temporaryLicenseBundle -Recurse
  }
  if (Test-Path -LiteralPath $publicSourceWorktree) {
    [void](Assert-TemporaryChildPath $publicSourceWorktree -RequireExisting)
    [void](Assert-TreeNoReparse $publicSourceWorktree "public-alpha source worktree cleanup")
    Remove-SafeContainedItem $temporaryRoot $publicSourceWorktree -Recurse
  }
  if ($publicWorktreeCreated -or $isPublicReleaseChannel) {
    $safeRoot = $root.Replace("\", "/")
    & git -C $root -c "safe.directory=$safeRoot" worktree prune
    if ($LASTEXITCODE -ne 0) { throw "Failed to prune public-alpha source worktree metadata" }
  }
  if (Test-Path -LiteralPath $publicCargoTarget) {
    Remove-SafeContainedItem $temporaryRoot $publicCargoTarget -Recurse
  }
  if ($null -eq $previousCargoTargetDir) {
    Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
  } else {
    $env:CARGO_TARGET_DIR = $previousCargoTargetDir
  }
}
