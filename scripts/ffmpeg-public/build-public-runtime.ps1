[CmdletBinding()]
param(
  [string]$SourceCache = "",
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [string]$WorkRoot = "",
  [ValidateRange(0, 1024)]
  [int]$Jobs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedBuilderImage = "ghcr.io/btbn/ffmpeg-builds/base-win64@sha256:80f095930d8ec013bbc5205522a7ba0dc45e4c554e9f2b4b1e0818c1876e5e87"
$ExpectedBuilderImageId = "sha256:027c750e5181480fadacb108f1f634df6d875561d91c7972524e5dcf9d4f1015"
$OfflineBuilderTag = "ghcr.io/btbn/ffmpeg-builds/base-win64:gifp-pinned-80f09593"
$ExpectedSourceDateEpoch = "1785786727"
$Utf8NoBom = [Text.UTF8Encoding]::new($false)

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path)
}

function Test-PathOverlap {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  $leftFull = (Resolve-FullPath $Left).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $rightFull = (Resolve-FullPath $Right).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ([string]::Equals($leftFull, $rightFull, [StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $separator = [IO.Path]::DirectorySeparatorChar
  return $leftFull.StartsWith("$rightFull$separator", [StringComparison]::OrdinalIgnoreCase) -or
    $rightFull.StartsWith("$leftFull$separator", [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeMountPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  if ($Path.IndexOfAny([char[]]",`r`n") -ge 0) {
    throw "$Label contains a character that is unsafe in Docker --mount syntax: $Path"
  }
}

function Assert-EmptyDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (!$item.PSIsContainer) {
      throw "Output path exists but is not a directory: $Path"
    }
    if (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1) {
      throw "Output directory must be empty; existing files will never be deleted: $Path"
    }
  }
}

function Write-Utf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value,
    [int]$Depth = 16
  )

  $json = $Value | ConvertTo-Json -Depth $Depth
  [IO.File]::WriteAllText($Path, "$json`n", $Utf8NoBom)
}

$RepositoryRoot = Resolve-FullPath (Join-Path $PSScriptRoot "..\..")
$ComplianceDir = Resolve-FullPath (Join-Path $RepositoryRoot "compliance\ffmpeg-public")
$LockPath = Resolve-FullPath (Join-Path $ComplianceDir "sources.lock.json")
$RecipeLockPath = Resolve-FullPath (Join-Path $ComplianceDir "build-recipe.lock.json")
$VerifierPath = Resolve-FullPath (Join-Path $PSScriptRoot "verify-source-cache.mjs")
$RecipeDir = Resolve-FullPath $PSScriptRoot
$ResolvedSourceCache = if ($SourceCache) {
  Resolve-FullPath $SourceCache
} else {
  Resolve-FullPath (Join-Path $RepositoryRoot "tmp\ffmpeg-public-sources")
}
$ResolvedOutputDir = Resolve-FullPath $OutputDir
$ResolvedWorkRoot = if ($WorkRoot) {
  Resolve-FullPath $WorkRoot
} else {
  Resolve-FullPath (Join-Path $RepositoryRoot "tmp\ffmpeg-public-build-work")
}

foreach ($requiredFile in @($LockPath, $RecipeLockPath, $VerifierPath, (Join-Path $RecipeDir "build-offline.sh"))) {
  if (!(Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required public-runtime build input is missing: $requiredFile"
  }
}

function Get-VerifiedRecipeFacts {
  param(
    [Parameter(Mandatory = $true)][string]$RecipeLock,
    [Parameter(Mandatory = $true)][string]$RecipeRoot,
    [Parameter(Mandatory = $true)][string]$SourceLock
  )

  $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $RecipeLock | ConvertFrom-Json
  if ($value.schemaVersion -ne 1 -or $value.profile -ne "gifp-windows-x64-lgpl-shared") {
    throw "Unexpected build-recipe lock schema or profile"
  }
  if ($value.builderImage -ne $ExpectedBuilderImage -or [string]$value.sourceDateEpoch -ne $ExpectedSourceDateEpoch) {
    throw "Build-recipe lock does not match the audited builder identity or SOURCE_DATE_EPOCH"
  }
  $sourceItem = Get-Item -LiteralPath $SourceLock
  $sourceHash = (Get-FileHash -LiteralPath $SourceLock -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($value.sourceLock.path -ne "compliance/ffmpeg-public/sources.lock.json" -or
      $value.sourceLock.sizeBytes -ne $sourceItem.Length -or
      $value.sourceLock.sha256 -ne $sourceHash) {
    throw "Build-recipe lock does not bind the exact public source lock"
  }

  $expectedPaths = @(
    "scripts/ffmpeg-public/README.md",
    "scripts/ffmpeg-public/build-offline.sh",
    "scripts/ffmpeg-public/build-public-runtime.ps1",
    "scripts/ffmpeg-public/fetch-sources.ps1",
    "scripts/ffmpeg-public/ffmpeg-configure.args",
    "scripts/ffmpeg-public/ffmpeg-metadata-filter-avformat.patch",
    "scripts/ffmpeg-public/prepare_sources.py",
    "scripts/ffmpeg-public/verify-source-cache.mjs"
  )
  $entries = @($value.inputs)
  $actualPaths = @($entries | ForEach-Object { [string]$_.path })
  if ($entries.Count -ne $expectedPaths.Count -or
      @($actualPaths | Sort-Object -Unique).Count -ne $expectedPaths.Count -or
      @($expectedPaths | Where-Object { $actualPaths -notcontains $_ }).Count -gt 0) {
    throw "Build-recipe lock input set is incomplete or unreviewed"
  }

  $facts = foreach ($entry in $entries) {
    $relative = [string]$entry.path
    $name = [IO.Path]::GetFileName($relative)
    if ($relative -ne "scripts/ffmpeg-public/$name") {
      throw "Unsafe build-recipe input path: $relative"
    }
    $path = Join-Path $RecipeRoot $name
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Locked build-recipe input is missing: $relative"
    }
    $item = Get-Item -LiteralPath $path
    $sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($entry.sizeBytes -ne $item.Length -or $entry.sha256 -ne $sha256) {
      throw "Locked build-recipe input mismatch: $relative"
    }
    [ordered]@{ path = $relative; sizeBytes = $item.Length; sha256 = $sha256 }
  }

  return [ordered]@{
    schemaVersion = 1
    profile = [string]$value.profile
    builderImage = [string]$value.builderImage
    sourceDateEpoch = [long]$value.sourceDateEpoch
    sourceLock = [ordered]@{
      path = [string]$value.sourceLock.path
      sizeBytes = $sourceItem.Length
      sha256 = $sourceHash
    }
    inputs = @($facts)
  }
}
if (!(Test-Path -LiteralPath $ResolvedSourceCache -PathType Container)) {
  throw "Verified FFmpeg source cache does not exist: $ResolvedSourceCache"
}

foreach ($pair in @(
    @($ResolvedSourceCache, "Source cache"),
    @($RecipeDir, "Recipe directory"),
    @($ComplianceDir, "Compliance directory"),
    @($ResolvedOutputDir, "Output directory"),
    @($ResolvedWorkRoot, "Work root")
  )) {
  Assert-SafeMountPath -Path $pair[0] -Label $pair[1]
}

foreach ($inputDir in @($ResolvedSourceCache, $RecipeDir, $ComplianceDir)) {
  if (Test-PathOverlap -Left $ResolvedOutputDir -Right $inputDir) {
    throw "Output directory must not overlap a read-only build input: $inputDir"
  }
  if (Test-PathOverlap -Left $ResolvedWorkRoot -Right $inputDir) {
    throw "Work root must not overlap a read-only build input: $inputDir"
  }
}
if (Test-PathOverlap -Left $ResolvedOutputDir -Right $ResolvedWorkRoot) {
  throw "Output directory and work root must not overlap"
}
Assert-EmptyDirectory -Path $ResolvedOutputDir

$lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $LockPath | ConvertFrom-Json
if ($lock.schemaVersion -ne 1 -or $lock.profile -ne "gifp-windows-x64-lgpl-shared") {
  throw "Unexpected FFmpeg public source-lock schema or profile"
}
if ($lock.builder.image -ne $ExpectedBuilderImage) {
  throw "Source lock builder differs from the audited immutable image: $($lock.builder.image)"
}
if ($lock.builder.networkPolicy -ne "release-build-must-run-with-network-none") {
  throw "Source lock does not require an offline release build"
}
$recipeFacts = Get-VerifiedRecipeFacts -RecipeLock $RecipeLockPath -RecipeRoot $RecipeDir -SourceLock $LockPath

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required to verify the prepared source cache"
}
$verifyOutput = (& node $VerifierPath --lock $LockPath --cache $ResolvedSourceCache 2>&1 | Out-String)
$verifyExitCode = $LASTEXITCODE
if ($verifyExitCode -ne 0) {
  throw "FFmpeg source-cache verification failed before Docker was started:`n$verifyOutput"
}
try {
  $sourceFacts = $verifyOutput | ConvertFrom-Json
} catch {
  throw "FFmpeg source-cache verifier returned invalid JSON: $($_.Exception.Message)"
}
if ($sourceFacts.builderImage -ne $ExpectedBuilderImage) {
  throw "Verified source facts do not carry the audited builder identity"
}

if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker CLI is required. Prepare the pinned image in a separate network-enabled step, then rerun this offline build."
}
$BuilderRunReference = $ExpectedBuilderImage
$BuilderAcquisition = "registry-digest"
$inspectJson = (& docker image inspect $BuilderRunReference 2>&1 | Out-String)
$inspectExitCode = $LASTEXITCODE
if ($inspectExitCode -ne 0) {
  $BuilderRunReference = $OfflineBuilderTag
  $BuilderAcquisition = "offline-import-config-digest"
  $inspectJson = (& docker image inspect $BuilderRunReference 2>&1 | Out-String)
  $inspectExitCode = $LASTEXITCODE
  if ($inspectExitCode -ne 0) {
    throw "Pinned builder image is unavailable by repository digest or its audited offline-import tag. This script never pulls images:`n$ExpectedBuilderImage`n$OfflineBuilderTag`n$inspectJson"
  }
}
try {
  $inspect = @($inspectJson | ConvertFrom-Json)
} catch {
  throw "Docker returned invalid image-inspection JSON: $($_.Exception.Message)"
}
if ($inspect.Count -ne 1) {
  throw "Docker image inspection returned an unexpected number of records: $($inspect.Count)"
}
$repoDigests = @($inspect[0].RepoDigests)
$repoTags = @($inspect[0].RepoTags)
if ([string]$inspect[0].Id -ne $ExpectedBuilderImageId) {
  throw "Local Docker image config digest does not match the audited builder image ID: expected $ExpectedBuilderImageId, got $($inspect[0].Id)"
}
if ($BuilderAcquisition -eq "registry-digest" -and $repoDigests -notcontains $ExpectedBuilderImage) {
  throw "Local Docker image is not bound to the exact audited repository digest: $ExpectedBuilderImage"
}
if ($BuilderAcquisition -eq "offline-import-config-digest" -and $repoTags -notcontains $OfflineBuilderTag) {
  throw "Offline-imported builder is missing its exact audited local tag: $OfflineBuilderTag"
}

New-Item -ItemType Directory -Force -Path $ResolvedOutputDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResolvedWorkRoot | Out-Null
$runId = "run-$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$RunRoot = Resolve-FullPath (Join-Path $ResolvedWorkRoot $runId)
if (Test-Path -LiteralPath $RunRoot) {
  throw "Generated run directory unexpectedly exists: $RunRoot"
}
New-Item -ItemType Directory -Path $RunRoot | Out-Null
$InputRoot = Resolve-FullPath (Join-Path $RunRoot "inputs")
$SnapshotSources = Resolve-FullPath (Join-Path $InputRoot "sources")
$SnapshotRecipe = Resolve-FullPath (Join-Path $InputRoot "recipe")
$SnapshotLock = Resolve-FullPath (Join-Path $InputRoot "lock")
foreach ($directory in @($SnapshotSources, $SnapshotRecipe, $SnapshotLock)) {
  New-Item -ItemType Directory -Path $directory | Out-Null
  Assert-SafeMountPath -Path $directory -Label "Immutable input snapshot"
}

foreach ($source in $lock.sources) {
  Copy-Item -LiteralPath (Join-Path $ResolvedSourceCache $source.archiveFile) -Destination (Join-Path $SnapshotSources $source.archiveFile)
}
$recipeLock = Get-Content -Raw -Encoding UTF8 -LiteralPath $RecipeLockPath | ConvertFrom-Json
foreach ($entry in $recipeLock.inputs) {
  $name = [IO.Path]::GetFileName([string]$entry.path)
  Copy-Item -LiteralPath (Join-Path $RecipeDir $name) -Destination (Join-Path $SnapshotRecipe $name)
}
Copy-Item -LiteralPath $LockPath -Destination (Join-Path $SnapshotLock "sources.lock.json")
Copy-Item -LiteralPath $RecipeLockPath -Destination (Join-Path $SnapshotLock "build-recipe.lock.json")

$snapshotLockPath = Join-Path $SnapshotLock "sources.lock.json"
$snapshotRecipeLockPath = Join-Path $SnapshotLock "build-recipe.lock.json"
$recipeFacts = Get-VerifiedRecipeFacts -RecipeLock $snapshotRecipeLockPath -RecipeRoot $SnapshotRecipe -SourceLock $snapshotLockPath
$snapshotVerifierPath = Join-Path $SnapshotRecipe "verify-source-cache.mjs"
$snapshotVerifyOutput = (& node $snapshotVerifierPath --lock $snapshotLockPath --cache $SnapshotSources 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) {
  throw "Immutable FFmpeg source snapshot verification failed:`n$snapshotVerifyOutput"
}
try {
  $sourceFacts = $snapshotVerifyOutput | ConvertFrom-Json
} catch {
  throw "Immutable source snapshot verifier returned invalid JSON: $($_.Exception.Message)"
}

$workVolume = "gifp-public-work-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$volumeCreateOutput = (& docker volume create --label "org.gifp.purpose=public-lgpl-build" $workVolume 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $volumeCreateOutput -ne $workVolume) {
  throw "Unable to create the fresh Linux-native build volume $workVolume`: $volumeCreateOutput"
}
$containerName = "gifp-public-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$dockerArgs = @(
  "run",
  "--rm",
  "--platform=linux/amd64",
  "--pull=never",
  "--network=none",
  "--read-only",
  "--security-opt=no-new-privileges",
  "--hostname=gifp-public-builder",
  "--name=$containerName",
  "--tmpfs", "/tmp:rw,exec,nosuid,size=2147483648",
  "--mount", "type=bind,source=$SnapshotSources,target=/sources,readonly",
  "--mount", "type=bind,source=$SnapshotRecipe,target=/recipe,readonly",
  "--mount", "type=bind,source=$SnapshotLock,target=/lock,readonly",
  "--mount", "type=volume,source=$workVolume,target=/work,volume-nocopy",
  "--mount", "type=bind,source=$ResolvedOutputDir,target=/out",
  "--env", "GIFP_BUILDER_IMAGE=$ExpectedBuilderImage",
  "--env", "SOURCE_DATE_EPOCH=$ExpectedSourceDateEpoch",
  "--env", "TZ=UTC",
  "--env", "LC_ALL=C",
  "--env", "LANG=C",
  "--env", "PYTHONHASHSEED=0"
)
if ($Jobs -gt 0) {
  $dockerArgs += @("--env", "GIFP_BUILD_JOBS=$Jobs")
}
$dockerArgs += @(
  "--entrypoint=/bin/bash",
  $BuilderRunReference,
  "/recipe/build-offline.sh"
)

$startedUtc = [DateTime]::UtcNow.ToString("o")
$dockerExitCode = -1
$dockerInvocationError = $null
try {
  & docker @dockerArgs
  $dockerExitCode = $LASTEXITCODE
} catch {
  $dockerInvocationError = $_.Exception.Message
}
$finishedUtc = [DateTime]::UtcNow.ToString("o")
$workVolumeStatus = "preserved-after-failure"
if ($null -eq $dockerInvocationError -and $dockerExitCode -eq 0) {
  $volumeRemoveOutput = (& docker volume rm $workVolume 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -eq 0) {
    $workVolumeStatus = "removed-after-success"
  } else {
    $workVolumeStatus = "cleanup-failed-after-success: $volumeRemoveOutput"
  }
}

$EvidenceDir = Join-Path $ResolvedOutputDir "evidence"
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
[IO.File]::WriteAllText((Join-Path $EvidenceDir "docker-image-inspect.json"), $inspectJson.TrimEnd() + "`n", $Utf8NoBom)
Write-Utf8Json -Path (Join-Path $EvidenceDir "source-cache-verification.json") -Value $sourceFacts
Write-Utf8Json -Path (Join-Path $EvidenceDir "build-recipe-verification.json") -Value $recipeFacts
Write-Utf8Json -Path (Join-Path $EvidenceDir "host-driver.json") -Value ([ordered]@{
    schemaVersion = 1
    startedUtc = $startedUtc
    finishedUtc = $finishedUtc
    builderImage = $ExpectedBuilderImage
    builderImageId = $inspect[0].Id
    builderAcquisition = $BuilderAcquisition
    builderRunReference = $BuilderRunReference
    sourceDateEpoch = [long]$ExpectedSourceDateEpoch
    networkPolicy = "docker --network=none; --pull=never"
    platform = "linux/amd64"
    inputSnapshot = "fresh verified copies under the preserved run directory"
    inputMountPolicy = @(
      "/sources:read-only",
      "/recipe:read-only",
      "/lock:read-only"
    )
    outputMountPolicy = @(
      "/work:fresh Linux-native Docker volume",
      "/out:read-write"
    )
    workVolume = $workVolume
    workVolumeStatus = $workVolumeStatus
    jobs = if ($Jobs -gt 0) { $Jobs } else { $null }
    dockerExitCode = $dockerExitCode
    dockerInvocationError = $dockerInvocationError
  })

if ($null -ne $dockerInvocationError) {
  throw "Docker public-runtime build could not be started: $dockerInvocationError"
}
if ($dockerExitCode -ne 0) {
  throw "Offline public-runtime build failed with Docker exit code $dockerExitCode. Evidence and the immutable input snapshot were preserved; Linux build state remains in Docker volume $workVolume."
}

Write-Host "Public FFmpeg runtime build completed."
Write-Host "Output: $ResolvedOutputDir"
Write-Host "Preserved immutable input snapshot: $RunRoot"
Write-Host "Linux build volume status: $workVolumeStatus"
