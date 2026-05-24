$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

npm run tauri:build

$source = Join-Path $root "src-tauri\target\release\gif_p.exe"
$releaseDir = Join-Path $root "release"
$toolsDir = Join-Path $releaseDir "tools"
$target = Join-Path $releaseDir "GIF_P.exe"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

if (!(Test-Path $source)) {
  throw "Build succeeded but executable was not found: $source"
}

Copy-Item -LiteralPath $source -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $releaseDir "README.md") -Force

$ffmpegSource = Join-Path $toolsDir "ffmpeg.exe"
$ffprobeSource = Join-Path $toolsDir "ffprobe.exe"
if (Test-Path $ffmpegSource) {
  Copy-Item -LiteralPath $ffmpegSource -Destination (Join-Path $releaseDir "ffmpeg.exe") -Force
}
if (Test-Path $ffprobeSource) {
  Copy-Item -LiteralPath $ffprobeSource -Destination (Join-Path $releaseDir "ffprobe.exe") -Force
}

Write-Host "Portable executable ready:"
Write-Host $target
