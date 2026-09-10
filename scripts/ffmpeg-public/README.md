# GIFP Public LGPL FFmpeg build

This directory defines the Windows x64 FFmpeg runtime intended for GIFP public packages. It is deliberately separate from the full GPL runtime used by internal Quality Lab work.

The release build has two phases:

1. `fetch-sources.ps1` downloads the exact archives recorded in `compliance/ffmpeg-public/sources.lock.json` and verifies every size, SHA-256, archive root, and license path. Git submodules needed by a locked parent revision are separate archive inputs bound to the parent's exact gitlink commit; the offline preparation step materializes them without Git or network access.
2. `build-public-runtime.ps1` verifies `build-recipe.lock.json`, copies only the hash-locked sources/recipe/locks into a fresh preserved input snapshot, and accepts only the pinned local builder image. It then runs `build-offline.sh` with `--pull=never`, `--network=none`, read-only snapshot mounts, a fresh Linux-native Docker build volume, and a new empty output directory. Repository snapshots that omit generated build files are bootstrapped with their upstream scripts and the pinned builder's audited toolchain before compilation. The recipe also applies the hash-locked `ffmpeg-metadata-filter-avformat.patch`, which records the `metadata` filter's existing AVIO dependency in FFmpeg's shared-library link graph. The native volume avoids the severe small-file penalty of compiling directly in a Windows bind mount; it is removed after success and preserved after failure for diagnosis.

Example preparation:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ffmpeg-public/fetch-sources.ps1
docker pull --platform linux/amd64 ghcr.io/btbn/ffmpeg-builds/base-win64@sha256:80f095930d8ec013bbc5205522a7ba0dc45e4c554e9f2b4b1e0818c1876e5e87
```

If the registry no longer exposes the digest to the build host, an offline Docker archive may be imported and tagged as `ghcr.io/btbn/ffmpeg-builds/base-win64:gifp-pinned-80f09593`. The driver accepts that fallback only when Docker reports the locked config/image ID `sha256:027c750e5181480fadacb108f1f634df6d875561d91c7972524e5dcf9d4f1015`; the acquisition mode and actual run reference are recorded in reproducibility evidence.

Example offline build:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/ffmpeg-public/build-public-runtime.ps1 `
  -OutputDir F:\codex\tmp\gifp-ffmpeg-public-alpha\out
```

After two builds from the same clean commit and locked inputs, create the machine-readable replay record:

```powershell
node scripts/ffmpeg-public/verify-reproducible-build.mjs `
  --baseline F:\path\to\first-output `
  --replay F:\path\to\second-output `
  --git-commit 40-character-clean-commit `
  --output F:\path\to\reproducibility-review.json
```

The output contains:

- `runtime/`: `ffmpeg.exe`, `ffprobe.exe`, and the reviewed shared FFmpeg DLL closure;
- `GIFP-FFmpeg-Windows-x64-LGPL-shared.zip`: a deterministic binary asset containing the runtime closure and its license bundle, ready for immutable publication and manifest pinning;
- `RUNTIME-LICENSES.txt`: a deterministic bundle of the exact FFmpeg and statically linked runtime-component license texts pinned by the public manifest;
- `evidence/`: configuration, component inventories, PE imports, hashes, toolchain facts, and build logs;
- `corresponding-source/`: the original locked source archives, license texts, lock file, and exact build recipe.
- `GIFP-FFmpeg-Corresponding-Source.tar`: a deterministic archive of that tree for review and publication.

The runtime is not public-release ready merely because it compiles. A clean Windows task must still prove real `h264_mf` software and hardware fallback behavior, all five delivery formats, screen capture, ASS text, isolated DLL loading, and real-media regressions. Two fresh builds from the same immutable inputs must also reproduce the runtime ZIP, every runtime file, the license bundle, and the Corresponding Source archive byte-for-byte. The public manifest hash-binds both review records and the separate human Corresponding Source review; readiness booleans alone cannot unlock packaging. An explicit GIFP project license, immutable distribution URLs, and the public compliance manifest's real hashes are required before its blockers may be cleared.

The FFmpeg archive has no Git metadata, so the recipe fixes `--extra-version=gifp-n9.0`. The final compliance manifest must record the actual first `ffmpeg -version` token; it must not reuse the Gyan.dev marker from the internal GPL runtime.

Because this profile starts from `--disable-everything`, enabling the GIF demuxer and decoder is not sufficient for reliable multi-frame input. The recipe explicitly enables the `gif` parser, asserts `CONFIG_GIF_PARSER=1` before compilation, and binds the exact parser allowlist into `ffmpeg -buildconf`. Windows qualification must still decode and count a non-trivial multi-frame GIF with bounded `ffmpeg` and `ffprobe` commands; a configuration assertion alone cannot clear the runtime review.
