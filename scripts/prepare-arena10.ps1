[CmdletBinding()]
param(
    [string]$Manifest = "bench/arena10-manifest.json",
    [string]$RuntimeDir,
    [string]$QualityLab = "src-tauri/target/release/gifp_quality_lab.exe"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot

function Resolve-WorkspacePath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $workspaceRoot $Path))
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$manifestPath = Resolve-WorkspacePath $Manifest
$qualityLabPath = Resolve-WorkspacePath $QualityLab
$manifestValue = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = $manifestValue.canonical_fixture_identity
$expectedFfmpeg = [string]$identity.generator_ffmpeg_sha256
$expectedFfprobe = [string]$identity.generator_ffprobe_sha256

if (-not (Test-Path -LiteralPath $qualityLabPath -PathType Leaf)) {
    Push-Location $workspaceRoot
    try {
        & cargo build --release --manifest-path src-tauri/Cargo.toml --bin gifp_quality_lab
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to build GIFP Quality Lab (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}

$candidateDirs = if ($RuntimeDir) {
    @(Resolve-WorkspacePath $RuntimeDir)
}
else {
    @(Get-ChildItem -LiteralPath (Join-Path $workspaceRoot "release") -Directory |
        Sort-Object LastWriteTime -Descending |
        ForEach-Object FullName)
}

$matchingRuntime = $null
$matchingFfmpeg = $null
foreach ($candidateDir in $candidateDirs) {
    $ffmpegPath = Join-Path $candidateDir "ffmpeg.exe"
    $ffprobePath = Join-Path $candidateDir "ffprobe.exe"
    if (-not (Test-Path -LiteralPath $ffmpegPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $ffprobePath -PathType Leaf)) {
        continue
    }
    if ((Get-LowerSha256 $ffmpegPath) -eq $expectedFfmpeg -and
        (Get-LowerSha256 $ffprobePath) -eq $expectedFfprobe) {
        $matchingRuntime = $candidateDir
        $matchingFfmpeg = $ffmpegPath
        break
    }
}

if (-not $matchingRuntime) {
    throw "No release runtime matches the Arena 10 FFmpeg/FFprobe hashes. Pass -RuntimeDir with the pinned runtime."
}

$previousPath = $env:PATH
try {
    $env:PATH = "$matchingRuntime;$previousPath"
    Push-Location $workspaceRoot
    try {
        & $qualityLabPath prepare --manifest $manifestPath
        if ($LASTEXITCODE -ne 0) {
            throw "Arena 10 fixture preparation failed (exit $LASTEXITCODE)."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:PATH = $previousPath
}

function Get-ChangedAreaPercentages {
    param([Parameter(Mandatory = $true)][string]$MediaPath)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $filterLog = & $matchingFfmpeg -hide_banner -nostats -i $MediaPath `
            -vf "tblend=all_mode=difference,format=gray,blackframe=amount=0:threshold=2" `
            -an -f null NUL 2>&1
        $filterExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($filterExitCode -ne 0) {
        throw "Failed to inspect frame differences in $MediaPath."
    }
    return @($filterLog | Select-String -Pattern 'pblack:(\d+)' | ForEach-Object {
        100.0 - [double]$_.Matches[0].Groups[1].Value
    })
}

function Get-Median {
    param([Parameter(Mandatory = $true)][double[]]$Values)
    if ($Values.Count -eq 0) {
        throw "Cannot calculate the median of an empty value set."
    }
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count % 2 -eq 1) {
        return $sorted[[int][Math]::Floor($sorted.Count / 2)]
    }
    return ($sorted[$sorted.Count / 2 - 1] + $sorted[$sorted.Count / 2]) / 2
}

$fixtureRoot = Join-Path (Split-Path -Parent $manifestPath) ([string]$manifestValue.fixture_root)
$posterPath = Join-Path $fixtureRoot "poster-local-motion.mkv"
$posterChangedArea = Get-ChangedAreaPercentages $posterPath
$posterMedianChangedArea = Get-Median $posterChangedArea
if ($posterMedianChangedArea -lt 1.0 -or $posterMedianChangedArea -gt 20.0) {
    throw "poster-local-motion median changed area must stay within 1%-20%; got $posterMedianChangedArea%."
}

$longTimelinePath = Join-Path $fixtureRoot "long-timeline-cuts.mkv"
$previousPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = "Continue"
    $sceneLog = & $matchingFfmpeg -hide_banner -nostats -i $longTimelinePath `
        -vf "select='gt(scene,0.05)',showinfo" -an -f null NUL 2>&1
    $sceneExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousPreference
}
if ($sceneExitCode -ne 0) {
    throw "Failed to inspect scene cuts in $longTimelinePath."
}
$sceneCuts = @($sceneLog | Select-String -Pattern 'Parsed_showinfo.*pts_time:')
if ($sceneCuts.Count -ne 3) {
    throw "long-timeline-cuts must contain exactly three large scene cuts; got $($sceneCuts.Count)."
}

Write-Host "Arena 10 fixtures are ready under bench/generated/arena10."
Write-Host "Semantic checks: poster median changed area $posterMedianChangedArea%; long timeline scene cuts $($sceneCuts.Count)."
