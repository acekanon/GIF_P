# GIFP 6.1.0 third-party notices

GIFP is freeware by acekanon. That price and product license do not replace the
licenses of bundled open-source components.

GIFP has two explicitly separated FFmpeg runtime profiles. The internal profile
is the Gyan.dev Windows x64 GPL shared build of FFmpeg
`9.0-full_build-www.gyan.dev`, licensed `GPL-3.0-or-later`; packages using it
are not approved for public redistribution. The public profile uses GIFP's
reproducible Windows x64 shared build recipe, licensed `LGPL-2.1-or-later`,
with GPL, nonfree, and version3 components disabled. Its n9.0 runtime is
currently pending build and review. A public package is distributable only after its exact runtime archive and
complete Corresponding Source are published together and all release gates
pass. Both profiles are distributed as separate FFmpeg/FFprobe executables and
their shared libraries; GIFP invokes FFmpeg as an external program.

The exact binary release, FFmpeg commit, build-recipe commit, configuration,
file sizes and SHA-256 hashes are recorded in `FFmpeg-PROVENANCE.json` and
`FFmpeg-BUILDINFO.txt`. The applicable license bundle is included under
`THIRD_PARTY_LICENSES`, and source provenance is recorded in
`FFmpeg-SOURCE-INFO.txt`. A redistributable public package also includes
`FFmpeg-SOURCE-OFFER.txt` and is released beside its Corresponding Source
archive.

FFmpeg licensing depends on its exact build configuration. The portable
packaging script accepts only the tracked, reviewed Windows runtime inventory
and rejects `--enable-nonfree`. It verifies FFmpeg, FFprobe, every required
shared library, and the license file before packaging.

The default preview packaging channel does not certify public redistribution.
It writes `redistributable: false` and records public release blockers. The
separate `public-alpha` channel requires the explicit `public-lgpl` runtime
profile and fail-closes unless the GIFP project license, reviewed complete
Corresponding Source, third-party
dependency/license-text evidence, clean source commit, and signature policy all
pass. Do not publish a package whose `DISTRIBUTION.json` does not explicitly
say `redistributable: true`. A source URL by itself is not represented as a
reviewed complete Corresponding Source archive.

`THIRD_PARTY-MANIFEST.json` inventories the resolved Windows Cargo and npm
closure. `THIRD_PARTY_LICENSES/DEPENDENCIES` maps each component to the actual
license/notice bytes found in the reviewed package sources and stores duplicate
texts once by SHA-256. When a package cache omits those bytes, the tracked
overlay manifest accepts them only for an exact package version, registry
integrity, upstream VCS commit URL, reviewed source type/URL, and local text
SHA-256. Repository files must use the exact reviewed revision; canonical
license texts use an approved authority and are fixed by their full content
hash. A license expression without collected license text remains an
unresolved release blocker rather than being treated as proof of compliance.

The optional `gif.optimizer.external` backend is never bundled by GIFP:

- gifsicle is GPL-2.0-or-later; GIFP can optionally invoke a separately installed
  copy for GIF post-processing. It is not included in the product package.

gifski is not a GIFP runtime or user-selectable external backend. It may be used
separately as an offline research benchmark, but it is not linked, invoked, or
distributed by the product. Upstream gifski licensing remains
AGPL-3.0-or-later or commercial for anyone running that independent benchmark.

The built-in experimental `rust.indexed_gif.experimental` backend includes:

- `gif` / `image-rs/image-gif` 0.14.2, licensed MIT OR Apache-2.0, for GIF
  container serialization and LZW integration;
- `weezl` 0.1.12, licensed MIT OR Apache-2.0, as the LZW implementation selected
  by `gif` 0.14.2.

GIFP disables `image-gif`'s optional color quantizer. GIFP owns the palette,
indexed pixels, timing, rectangles, transparency and disposal decisions; the
bundled crates do not change the separate FFmpeg redistribution obligations.

The offline Quality Lab performance sampler uses `sysinfo` 0.38.4, licensed
MIT, to read resident memory and parent-process relationships. GIFP enables only
its `system` feature and disables default component, disk, network, and user
inventory features. The dependency is pinned to preserve the project's Rust
1.88 minimum toolchain contract.

This notice is informational and is not legal advice. The license files shipped
beside a portable build remain authoritative for those third-party binaries.
