param(
  [string]$CacheDir = ""
)

$ErrorActionPreference = "Stop"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$lockPath = Join-Path $root "compliance\ffmpeg-public\sources.lock.json"
$verifierPath = Join-Path $PSScriptRoot "verify-source-cache.mjs"
$cache = if ($CacheDir) {
  [IO.Path]::GetFullPath($CacheDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $root "tmp\ffmpeg-public-sources"))
}

if (!(Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw "FFmpeg source lock is missing: $lockPath"
}
if (!(Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
  throw "FFmpeg source-cache verifier is missing: $verifierPath"
}

$lock = Get-Content -Raw -Encoding UTF8 -LiteralPath $lockPath | ConvertFrom-Json
if ($lock.schemaVersion -ne 1 -or !$lock.sources.Count) {
  throw "FFmpeg source lock is invalid"
}
New-Item -ItemType Directory -Force -Path $cache | Out-Null

foreach ($source in $lock.sources) {
  $destination = [IO.Path]::GetFullPath((Join-Path $cache $source.archiveFile))
  if ((Split-Path -Parent $destination) -ne $cache) {
    throw "Unsafe source archive filename: $($source.archiveFile)"
  }
  if (Test-Path -LiteralPath $destination -PathType Leaf) {
    $existing = Get-Item -LiteralPath $destination
    $existingHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existing.Length -ne $source.sizeBytes -or $existingHash -ne $source.sha256) {
      throw "Existing source archive does not match the lock; refusing to overwrite: $destination"
    }
    continue
  }

  $partial = "$destination.$PID.partial"
  if (Test-Path -LiteralPath $partial) {
    Remove-Item -LiteralPath $partial -Force
  }
  try {
    & curl.exe -L --fail --retry 3 --output $partial $source.archiveUrl
    if ($LASTEXITCODE -ne 0) {
      throw "Download failed with exit code $LASTEXITCODE"
    }
    $download = Get-Item -LiteralPath $partial
    $downloadHash = (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($download.Length -ne $source.sizeBytes -or $downloadHash -ne $source.sha256) {
      throw "Downloaded source archive does not match the lock: $($source.archiveFile)"
    }
    Move-Item -LiteralPath $partial -Destination $destination
  } finally {
    if (Test-Path -LiteralPath $partial) {
      Remove-Item -LiteralPath $partial -Force
    }
  }
}

& node $verifierPath --lock $lockPath --cache $cache
if ($LASTEXITCODE -ne 0) {
  throw "FFmpeg source-cache verification failed"
}
