# Windows Distribution Design

## Decision

GifLab MVP and first distributable builds are portable-first and will not bundle FFmpeg.

The app requires `ffmpeg.exe` and `ffprobe.exe` to be installed on the user's Windows machine and available on PATH.

## Rationale

- Smaller download.
- Simpler licensing posture.
- Faster first release.
- The current target users are expected to already have FFmpeg installed.
- The app can still move to bundled FFmpeg later if the audience becomes less technical.

## Distribution Shape

Distribute:

- `GifLab.exe` as a portable executable.
- Optional `GifLab-portable.zip` containing the executable, README, presets, and sample config.

Do not include:

- `ffmpeg.exe`
- `ffprobe.exe`
- FFmpeg license bundle

## Startup Check

On startup or before the first probe/export, the app should check:

```text
ffmpeg -version
ffprobe -version
```

If either command fails, show:

```text
GifLab needs FFmpeg and FFprobe on PATH.
Install FFmpeg, reopen GifLab, then try again.
```

Keep raw command errors in logs only.

## User-Facing Requirements

README and release page must say:

- Windows 10/11.
- FFmpeg installed and available on PATH.
- Local processing only.
- MP4 input for MVP.
- No installation required.
- Download, unzip, run.

## Later Option

If GifLab targets less technical users later, add a build flavor:

```text
GifLab Full Installer: bundles FFmpeg
GifLab Lite Installer: uses system FFmpeg
```

For now, only the portable/system-FFmpeg path is in scope.
