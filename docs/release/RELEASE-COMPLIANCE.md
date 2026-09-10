# GIFP release compliance

GIFP uses a fail-closed release pipeline. The default output is an `internal`
artifact marked `redistributable: false`; there is no implicit production
channel. A `public-alpha` package is produced only when every mechanical gate
passes. A formal `public` package reuses all public evidence gates and additionally
requires a valid allowlisted Authenticode signature with no unsigned override.
These checks preserve evidence and prevent accidental publication, but
they are not legal advice.

## Pinned Windows media runtimes

The internal Quality Lab/runtime is locked by
`compliance/ffmpeg-windows-x64-gpl-shared.json`:

- Gyan.dev release tag: `9.0`
- Asset: `ffmpeg-9.0-full_build-shared.7z`
- Asset SHA-256:
  `c07e3313aba524186c4684052e1c860dd2bb6983a7299668255939660126907a`
- FFmpeg commit: `d32b387f2b0a484599d4587d651891f0c63c4238`
- GyanD/codexffmpeg build-recipe tag commit: `46465995c991fe65c5de853fa79bddec09cd6c37`
- Runtime: GPL, version 3 or later, shared build

The pipeline verifies the size and SHA-256 of FFmpeg, FFprobe, every shipped
DLL, and the supplied FFmpeg license. It rejects a mutable `latest` URL,
unreviewed DLLs, a missing required configure flag, and `--enable-nonfree`.

This full Gyan.dev GPL build is explicitly approved for `internal` packaging only.
Its enabled third-party libraries are largely linked into the libav DLLs, while
the complete build cache, recursive sources, Cargo vendor set, toolchain source,
and immutable container image are not archived locally. The tracked manifest
therefore sets `publicAlphaAllowed: false`; supplying environment variables
cannot override that decision.

The separate public route is defined by
`compliance/ffmpeg-windows-x64-lgpl-shared-public.json`,
`compliance/ffmpeg-public/sources.lock.json`, and
`compliance/ffmpeg-public/build-recipe.lock.json`. It builds a minimal
LGPL-2.1-or-later shared runtime
with GIF/WebP/APNG/MP4/WebM, `h264_mf`, the accepted input/decode closure,
screen capture, libass, and the production filters. It explicitly disables
GPL, version-3-only terms, nonfree components, libx264, `eq`, and `hqdn3d`.

Source download and build are separate phases. The release build hash-verifies
both locks, creates a fresh immutable snapshot containing only reviewed inputs,
accepts only the digest-pinned local builder image, runs with `--pull=never`
and `--network=none`, and mounts that snapshot read-only. It emits a
deterministic Corresponding Source tar archive and linked-runtime license
bundle. The tracked public manifest remains `publicAlphaAllowed: false` until
real runtime hashes, Windows capability review, a reproducibility replay, and
human review/publication of the Corresponding Source are recorded. Empty
placeholder hashes can never pass the verifier.

The four readiness booleans are not approvals by themselves. A releasable
manifest must hash-bind three records under `publicReleaseProfile.reviewEvidence`:
the byte-for-byte two-build replay, the independent Windows runtime matrix, and
the human Corresponding Source review. Those records are re-read from the
compliance tree and tied to `publicReleaseProfile.reviewedBuildCommit`, the
source/build locks, and the published runtime ZIP hash before packaging can
start. The reviewed-build commit is deliberately separate from the later clean
release commit: committing the review records must not create an impossible
self-referential Git hash. The release commit is still required to be clean,
must descend from the reviewed-build commit, and is recorded independently in
the distribution record.

The approved Windows screen-capture backend is `gdigrab`, validated in an
interactive desktop session and through a decoded GIF output. `ddagrab` remains
experimental because the reviewed host opened the DXGI device but did not
deliver a first frame within either bounded attempt, so it is not enabled as an
automatic fallback. `h264_mf` is approved with its software path and automatic
software fallback; hardware encoding remains host-dependent.

The Windows review also hash-binds a commit-named evidence bundle. The verifier
requires the exact five input digests and the exact name, file name, size, and
SHA-256 mapping for all six distributed-test reports to match that independent
bundle; syntactically valid substitute hashes or file names fail closed.

## Internal evidence package

```powershell
$env:GIFP_DISTRIBUTION_CHANNEL = 'internal'
$env:GIFP_FFMPEG_RUNTIME_PROFILE = 'internal-gpl' # optional; this is the internal default
$env:GIFP_FFMPEG_DIR = 'D:\ffmpeg-9.0-full_build-shared'
npm run package:exe
```

The output name contains `internal` and remains non-redistributable. It still
includes a machine-readable distribution record, a deterministic Windows
dependency inventory, immutable FFmpeg provenance, packaged-file hashes, the
unsigned-Alpha policy, and an external archive checksum.

## Public Alpha gates

`public-alpha` additionally requires:

- explicit `GIFP_FFMPEG_RUNTIME_PROFILE=public-lgpl`; the internal GPL
  manifest can never be selected implicitly or approved by editing one flag;
- a clean 40-character Git commit and a mandatory fresh Tauri build;
- an explicitly selected GIFP project license, its file, and its SHA-256;
- a reviewed complete FFmpeg Corresponding Source archive, digest, and review
  record tied to the exact binary, FFmpeg commit, and build-recipe commit;
- the local deterministic FFmpeg runtime ZIP whose filename, size, and SHA-256
  exactly match the immutable `binaryAsset` manifest entry;
- zero unresolved license entries in the deterministic dependency manifest;
- complete collected license text for every shipped dependency; the current
  Windows closure is 269/269 (164 unique texts), including 10 exact-version,
  source-commit, and SHA-256-pinned reviewed overlays for crates whose packaged
  cache did not expose a license file;
- a valid allowlisted Authenticode signer, or `NotSigned` plus the explicit
  unsigned-Alpha override;
- an artifact name containing `alpha`, archive checksums, and the policy file.

Required environment values are intentionally explicit:

```powershell
$env:GIFP_DISTRIBUTION_CHANNEL = 'public-alpha'
$env:GIFP_FFMPEG_RUNTIME_PROFILE = 'public-lgpl'
$env:GIFP_FFMPEG_DIR = 'F:\path\to\the-pinned-runtime'
$env:GIFP_PROJECT_LICENSE_ID = 'the-reviewed-license-identifier'
$env:GIFP_PROJECT_LICENSE_FILE = 'F:\path\to\LICENSE.txt'
$env:GIFP_PROJECT_LICENSE_SHA256 = '64-hex-digest'
$env:GIFP_FFMPEG_BINARY_ARCHIVE = 'F:\path\to\GIFP-FFmpeg-Windows-x64-LGPL-shared.zip'
$env:GIFP_FFMPEG_CORRESPONDING_SOURCE_ARCHIVE = 'F:\path\to\complete-source-bundle.tar.zst'
$env:GIFP_FFMPEG_CORRESPONDING_SOURCE_SHA256 = '64-hex-digest'
$env:GIFP_FFMPEG_CORRESPONDING_SOURCE_RECORD = 'F:\path\to\SOURCE-REVIEW.json'

# Only when the executable is exactly NotSigned and the release is visibly Alpha:
$env:GIFP_ALLOW_UNSIGNED_ALPHA = '1'

# Alternatively, for a signed build:
$env:GIFP_ALLOWED_SIGNER_THUMBPRINT = 'reviewed-certificate-thumbprint'

npm run package:exe
```

## Formal public gates

`public` inherits every LGPL runtime, Corresponding Source, clean-build,
license-text, and first-tier Quality gate from `public-alpha`. It then fails
closed unless the executable has Authenticode status `Valid` and its normalized
certificate thumbprint exactly matches `GIFP_ALLOWED_SIGNER_THUMBPRINT`.
`GIFP_ALLOW_UNSIGNED_ALPHA` is forbidden on this channel.

```powershell
$env:GIFP_DISTRIBUTION_CHANNEL = 'public'
$env:GIFP_FFMPEG_RUNTIME_PROFILE = 'public-lgpl'
$env:GIFP_ALLOWED_SIGNER_THUMBPRINT = 'reviewed-certificate-thumbprint'
# Supply the same public runtime/source/license/Quality inputs documented above.
npm run package:exe
```

The formal artifact is named `GIFP-<version>` without an Alpha suffix. Its
`DISTRIBUTION.json` records `channel: public`, `redistributable: true`, the
validated signer, and `PUBLIC RELEASE - AUTHENTICODE SIGNED`.

The source review record has schema version 1, type
`gifp-public-ffmpeg-corresponding-source-review`, and must identify the reviewer,
review time, immutable distribution URL, archive digest, exact FFmpeg commit,
exact build-recipe commit, clean GIFP Git commit, and the pinned binary-asset digest. Setting
`completeCorrespondingSourceReviewed` to `true` is a human attestation, not an
automatic substitute for reviewing the contents.

For either runtime, the FFmpeg repository alone is not a complete source
bundle. Public review must cover the exact source archives for every statically
linked external library, the GIFP build recipe, source lock, builder identity,
configuration, generated component inventory, PE imports, and runtime hashes.

## Output evidence

Each successful package contains:

- `DISTRIBUTION.json`: application, Git, signature, dependency, FFmpeg, and
  channel facts;
- `FILES-SHA256.txt`: SHA-256 for every other packaged file;
- `VERIFY-GIFP.ps1`: a fail-closed end-user check for the complete file
  inventory, expected version/channel/redistributable state, executable digest,
  live Authenticode status, and the release-bound allowlisted signer;
- `THIRD_PARTY-MANIFEST.json`: stable Windows runtime/build dependency inventory;
- `THIRD_PARTY_LICENSES/DEPENDENCIES`: deterministic component-to-license-text
  mapping plus SHA-deduplicated real text files; missing text stays explicit,
  and reviewed overlays retain source type/URL, VCS commit URL, and text hash;
- `FFmpeg-PROVENANCE.json` and `FFmpeg-BUILDINFO.txt`;
- notices, policies, and reviewed license materials.

The release directory also contains `*-SHA256SUMS.txt`. Before publication,
verify the archive hash independently and run the packaged semantic E2E against
the exact clean commit recorded in `DISTRIBUTION.json`. After extraction, run
`powershell -ExecutionPolicy Bypass -File .\VERIFY-GIFP.ps1`; every section
must print `[PASS]`. Any mismatch prints `[FAIL]` and returns exit code 1.
