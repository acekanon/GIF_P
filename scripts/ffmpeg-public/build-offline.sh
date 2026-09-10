#!/usr/bin/env bash
# Build the Windows x64 public FFmpeg runtime from an already verified cache.
# This script is designed to run only through build-public-runtime.ps1, with
# Docker networking disabled and all inputs mounted read-only.
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

readonly EXPECTED_BUILDER_IMAGE='ghcr.io/btbn/ffmpeg-builds/base-win64@sha256:80f095930d8ec013bbc5205522a7ba0dc45e4c554e9f2b4b1e0818c1876e5e87'
readonly EXPECTED_SOURCE_DATE_EPOCH='1785786727'
readonly TARGET='x86_64-w64-mingw32'
readonly PREFIX='/work/prefix'
readonly SOURCE_ROOT='/work/sources'
readonly BUILD_ROOT='/work/build'
readonly RUNTIME_ROOT='/out/runtime'
readonly EVIDENCE_ROOT='/out/evidence'
readonly CORRESPONDING_ROOT='/out/corresponding-source'
readonly RUNTIME_LICENSE='/out/RUNTIME-LICENSES.txt'
readonly RUNTIME_ARCHIVE='/out/GIFP-FFmpeg-Windows-x64-LGPL-shared.zip'

die() {
    echo "build-offline.sh: $*" >&2
    exit 1
}

mount_options() {
    local mount_path="$1"
    awk -v wanted="$mount_path" '$2 == wanted { value=$4 } END { print value }' /proc/mounts
}

require_mount_mode() {
    local mount_path="$1"
    local required="$2"
    local options
    options="$(mount_options "$mount_path")"
    [[ -n "$options" ]] || die "required mount is absent: $mount_path"
    case ",$options," in
        *",$required,"*) ;;
        *) die "$mount_path must be mounted $required (actual options: $options)" ;;
    esac
}

require_tool() {
    command -v "$1" >/dev/null 2>&1 || die "pinned builder is missing required tool: $1"
}

require_empty_directory() {
    local path="$1"
    [[ -d "$path" ]] || die "required directory is absent: $path"
    [[ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]] || die "directory must be empty: $path"
}

require_mount_mode /sources ro
require_mount_mode /recipe ro
require_mount_mode /lock ro
require_mount_mode /work rw
require_mount_mode /out rw
require_empty_directory /work
require_empty_directory /out

[[ "${GIFP_BUILDER_IMAGE:-}" == "$EXPECTED_BUILDER_IMAGE" ]] || die "builder identity environment does not match the audited digest"
[[ "${SOURCE_DATE_EPOCH:-}" == "$EXPECTED_SOURCE_DATE_EPOCH" ]] || die "SOURCE_DATE_EPOCH must be $EXPECTED_SOURCE_DATE_EPOCH"
[[ "${TZ:-}" == 'UTC' ]] || die "TZ must be UTC"
[[ "${LC_ALL:-}" == 'C' ]] || die "LC_ALL must be C"

for tool in python3 sha256sum tar make cmake meson ninja pkg-config autoreconf nasm wine tee awk sed grep find sort xargs touch; do
    require_tool "$tool"
done
for tool in gcc g++ gcc-ar gcc-ranlib nm strip windres objdump; do
    require_tool "${TARGET}-${tool}"
done

mkdir -p "$BUILD_ROOT" "$PREFIX" /work/home /work/cache /work/xdg-runtime "$RUNTIME_ROOT" "$EVIDENCE_ROOT" \
    "$CORRESPONDING_ROOT/sources" "$CORRESPONDING_ROOT/recipe" "$CORRESPONDING_ROOT/licenses"
chmod 700 /work/xdg-runtime
exec > >(tee "$EVIDENCE_ROOT/build.log") 2>&1

build_exit_status=1
finish_build_record() {
    local status=$?
    build_exit_status=$status
    python3 - "$EVIDENCE_ROOT/build-status.json" "$status" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps({"schemaVersion": 1, "exitCode": int(sys.argv[2])}, indent=2) + "\n",
    encoding="utf-8",
)
PY
}
trap finish_build_record EXIT

python3 - /lock/build-recipe.lock.json /lock/sources.lock.json /recipe \
    "$EXPECTED_BUILDER_IMAGE" "$EVIDENCE_ROOT/build-recipe-verification.json" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

recipe_lock_path = Path(sys.argv[1])
source_lock_path = Path(sys.argv[2])
recipe_root = Path(sys.argv[3])
expected_builder = sys.argv[4]
output = Path(sys.argv[5])
expected_paths = {
    "scripts/ffmpeg-public/README.md",
    "scripts/ffmpeg-public/build-offline.sh",
    "scripts/ffmpeg-public/build-public-runtime.ps1",
    "scripts/ffmpeg-public/fetch-sources.ps1",
    "scripts/ffmpeg-public/ffmpeg-configure.args",
    "scripts/ffmpeg-public/ffmpeg-metadata-filter-avformat.patch",
    "scripts/ffmpeg-public/prepare_sources.py",
    "scripts/ffmpeg-public/verify-source-cache.mjs",
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


lock = json.loads(recipe_lock_path.read_text(encoding="utf-8"))
if lock.get("schemaVersion") != 1 or lock.get("profile") != "gifp-windows-x64-lgpl-shared":
    raise SystemExit("Unexpected build-recipe lock schema or profile")
if lock.get("builderImage") != expected_builder:
    raise SystemExit("Build-recipe lock builder image mismatch")
source_descriptor = lock.get("sourceLock", {})
if source_descriptor.get("sizeBytes") != source_lock_path.stat().st_size:
    raise SystemExit("Build-recipe lock source-lock size mismatch")
if source_descriptor.get("sha256") != digest(source_lock_path):
    raise SystemExit("Build-recipe lock source-lock hash mismatch")
entries = lock.get("inputs")
if not isinstance(entries, list) or {entry.get("path") for entry in entries} != expected_paths:
    raise SystemExit("Build-recipe lock input set is incomplete or unreviewed")
facts = []
for entry in entries:
    relative = entry["path"]
    name = Path(relative).name
    if relative != f"scripts/ffmpeg-public/{name}":
        raise SystemExit(f"Unsafe build-recipe path: {relative}")
    path = recipe_root / name
    if not path.is_file():
        raise SystemExit(f"Locked build-recipe input is missing: {relative}")
    size = path.stat().st_size
    sha256 = digest(path)
    if size != entry.get("sizeBytes") or sha256 != entry.get("sha256"):
        raise SystemExit(f"Locked build-recipe input mismatch: {relative}")
    facts.append({"path": relative, "sizeBytes": size, "sha256": sha256})
output.write_text(
    json.dumps(
        {
            "schemaVersion": 1,
            "profile": lock["profile"],
            "builderImage": lock["builderImage"],
            "sourceLock": source_descriptor,
            "inputs": facts,
        },
        indent=2,
        sort_keys=True,
    )
    + "\n",
    encoding="utf-8",
)
PY

export TZ=UTC
export LC_ALL=C
export LANG=C
export LANGUAGE=C
export PYTHONHASHSEED=0
export ZERO_AR_DATE=1
export ARFLAGS=crD
export HOME=/work/home
export XDG_CACHE_HOME=/work/cache
export XDG_RUNTIME_DIR=/work/xdg-runtime
export WINEPREFIX=/work/wine
export WINEDEBUG=-all
export FFBUILD_TOOLCHAIN="$TARGET"
export CC="${TARGET}-gcc"
export CXX="${TARGET}-g++"
export LD="${TARGET}-ld"
export AR="${TARGET}-gcc-ar"
export RANLIB="${TARGET}-gcc-ranlib"
export NM="${TARGET}-nm"
export STRIP="${TARGET}-strip"
export WINDRES="${TARGET}-windres"
export OBJDUMP="${TARGET}-objdump"
export PKG_CONFIG=pkg-config
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export CPPFLAGS="-I$PREFIX/include"
export CFLAGS="-O2 -pipe -D_FORTIFY_SOURCE=2 -fstack-protector-strong -ffile-prefix-map=/work=. -fdebug-prefix-map=/work=."
export CXXFLAGS="$CFLAGS -static-libgcc -static-libstdc++"
export LDFLAGS="-L$PREFIX/lib -static-libgcc -static-libstdc++ -Wl,--no-insert-timestamp"
export LIBS="-Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"
export PATH="$PREFIX/bin:$PATH"

echo "Builder: $GIFP_BUILDER_IMAGE"
echo "SOURCE_DATE_EPOCH: $SOURCE_DATE_EPOCH"
echo "Jobs: ${GIFP_BUILD_JOBS:-$(nproc)}"
readonly JOBS="${GIFP_BUILD_JOBS:-$(nproc)}"
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || die "GIFP_BUILD_JOBS must be a positive integer"

cat > /work/toolchain.cmake <<EOF
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_SYSTEM_VERSION 10.0)
set(CMAKE_C_COMPILER ${TARGET}-gcc)
set(CMAKE_CXX_COMPILER ${TARGET}-g++)
set(CMAKE_RC_COMPILER ${TARGET}-windres)
set(CMAKE_RANLIB ${TARGET}-gcc-ranlib)
set(CMAKE_AR ${TARGET}-gcc-ar)
set(CMAKE_SYSROOT /opt/ct-ng/${TARGET}/sysroot)
set(CMAKE_FIND_ROOT_PATH /opt/ct-ng /opt/ct-ng/${TARGET}/sysroot ${PREFIX})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF

python3 /recipe/prepare_sources.py \
    --lock /lock/sources.lock.json \
    --cache /sources \
    --output "$SOURCE_ROOT" \
    --licenses-output "$CORRESPONDING_ROOT/licenses" \
    --configure-args /recipe/ffmpeg-configure.args \
    --source-date-epoch "$SOURCE_DATE_EPOCH" \
    > "$EVIDENCE_ROOT/prepared-sources.stdout.json"

pushd "$SOURCE_ROOT/ffmpeg" >/dev/null
patch --batch --forward --fuzz=0 -p1 < /recipe/ffmpeg-metadata-filter-avformat.patch
grep -Fqx 'enabled metadata_filter    && prepend avfilter_deps "avformat"' configure \
    || die 'FFmpeg metadata filter dependency patch was not applied exactly'
touch -d "@$SOURCE_DATE_EPOCH" configure
popd >/dev/null

cp -p /lock/sources.lock.json "$CORRESPONDING_ROOT/sources.lock.json"
cp -p /lock/build-recipe.lock.json "$CORRESPONDING_ROOT/build-recipe.lock.json"
cp -p /recipe/prepare_sources.py /recipe/ffmpeg-configure.args \
    /recipe/ffmpeg-metadata-filter-avformat.patch /recipe/build-offline.sh \
    /recipe/build-public-runtime.ps1 /recipe/fetch-sources.ps1 /recipe/verify-source-cache.mjs \
    "$CORRESPONDING_ROOT/recipe/"
if [[ -f /recipe/README.md ]]; then
    cp -p /recipe/README.md "$CORRESPONDING_ROOT/recipe/"
fi

python3 - /lock/sources.lock.json /sources "$CORRESPONDING_ROOT/sources" "$SOURCE_DATE_EPOCH" <<'PY'
import json
import os
import shutil
import sys
from pathlib import Path

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
cache = Path(sys.argv[2])
output = Path(sys.argv[3])
epoch = int(sys.argv[4])
for source in lock["sources"]:
    source_path = cache / source["archiveFile"]
    target = output / source["archiveFile"]
    shutil.copyfile(source_path, target)
    os.utime(target, (epoch, epoch))
PY

cat > "$EVIDENCE_ROOT/toolchain.txt" <<EOF
builder=$GIFP_BUILDER_IMAGE
source_date_epoch=$SOURCE_DATE_EPOCH
target=$TARGET
EOF
{
    "$CC" --version
    "$CXX" --version
    "${TARGET}-ld" --version
    make --version
    autoconf --version
    automake --version
    aclocal --version
    libtoolize --version
    patch --version
    cmake --version
    meson --version
    ninja --version
    python3 --version
    nasm -v
    wine --version
    uname -a
    cat /etc/os-release
} >> "$EVIDENCE_ROOT/toolchain.txt" 2>&1
if command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f='${Package}\t${Version}\n' | LC_ALL=C sort > "$EVIDENCE_ROOT/builder-packages.tsv"
fi

build_zlib() {
    echo '=== zlib ==='
    pushd "$SOURCE_ROOT/zlib" >/dev/null
    CHOST="$TARGET" ./configure --prefix="$PREFIX" --static
    make -j"$JOBS" V=1
    make install
    popd >/dev/null
}

bootstrap_freetype() {
    echo '=== freetype autotools bootstrap ==='
    pushd "$SOURCE_ROOT/freetype" >/dev/null
    ./autogen.sh
    [[ -x builds/unix/configure ]] || die "FreeType autotools bootstrap did not generate builds/unix/configure"
    find . -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
    popd >/dev/null
}

configure_freetype() {
    local build_dir="$1"
    local harfbuzz_mode="$2"
    mkdir -p "$build_dir"
    pushd "$build_dir" >/dev/null
    "$SOURCE_ROOT/freetype/configure" \
        --prefix="$PREFIX" \
        --host="$TARGET" \
        --disable-shared \
        --enable-static \
        --with-zlib=yes \
        --with-bzip2=no \
        --with-png=no \
        --with-brotli=no \
        "--with-harfbuzz=$harfbuzz_mode"
    make -j"$JOBS" V=1
    make install
    popd >/dev/null
}

build_harfbuzz() {
    echo '=== harfbuzz ==='
    meson setup "$BUILD_ROOT/harfbuzz" "$SOURCE_ROOT/harfbuzz" \
        --cross-file=/cross.meson \
        --wrap-mode=nofallback \
        --prefix="$PREFIX" \
        --buildtype=release \
        --default-library=static \
        -Dfreetype=enabled \
        -Dzlib=enabled \
        -Dpng=disabled \
        -Dglib=disabled \
        -Dgobject=disabled \
        -Dcairo=disabled \
        -Dchafa=disabled \
        -Dicu=disabled \
        -Dgraphite2=disabled \
        -Dgdi=enabled \
        -Ddirectwrite=disabled \
        -Dfontations=disabled \
        -Dharfrust=disabled \
        -Dkbts=disabled \
        -Dgpu=disabled \
        -Dgpu_demo=disabled \
        -Dsubset=disabled \
        -Dtests=disabled \
        -Dintrospection=disabled \
        -Ddocs=disabled \
        -Ddoc_tests=false \
        -Dutilities=disabled
    ninja -C "$BUILD_ROOT/harfbuzz" -j"$JOBS" -v
    ninja -C "$BUILD_ROOT/harfbuzz" install
    local pc="$PREFIX/lib/pkgconfig/harfbuzz.pc"
    [[ -f "$pc" ]] || die "harfbuzz.pc was not installed"
    if grep -q '^Libs.private:' "$pc"; then
        sed -i '/^Libs.private:/ s|$| -Wl,-Bstatic -lstdc++ -lwinpthread -Wl,-Bdynamic|' "$pc"
    else
        printf '%s\n' 'Libs.private: -Wl,-Bstatic -lstdc++ -lwinpthread -Wl,-Bdynamic' >> "$pc"
    fi
}

build_fribidi() {
    echo '=== fribidi ==='
    meson setup "$BUILD_ROOT/fribidi" "$SOURCE_ROOT/fribidi" \
        --cross-file=/cross.meson \
        --wrap-mode=nofallback \
        --prefix="$PREFIX" \
        --buildtype=release \
        --default-library=static \
        -Dbin=false -Ddocs=false -Dtests=false
    ninja -C "$BUILD_ROOT/fribidi" -j"$JOBS" -v
    ninja -C "$BUILD_ROOT/fribidi" install
    sed -i 's/^Cflags:/Cflags: -DFRIBIDI_LIB_STATIC/' "$PREFIX/lib/pkgconfig/fribidi.pc"
}

build_libunibreak() {
    echo '=== libunibreak ==='
    pushd "$SOURCE_ROOT/libunibreak" >/dev/null
    ./bootstrap
    popd >/dev/null
    mkdir -p "$BUILD_ROOT/libunibreak"
    pushd "$BUILD_ROOT/libunibreak" >/dev/null
    "$SOURCE_ROOT/libunibreak/configure" \
        --prefix="$PREFIX" --host="$TARGET" --disable-shared --enable-static --with-pic
    make -j"$JOBS" V=1
    make install
    popd >/dev/null
}

build_libass() {
    echo '=== libass ==='
    CFLAGS="$CFLAGS -Dread_file=libass_internal_read_file" \
    meson setup "$BUILD_ROOT/libass" "$SOURCE_ROOT/libass" \
        --cross-file=/cross.meson \
        --wrap-mode=nofallback \
        --prefix="$PREFIX" \
        --buildtype=release \
        --default-library=static \
        -Dtest=disabled \
        -Dcompare=disabled \
        -Dprofile=disabled \
        -Dfuzz=disabled \
        -Dcheckasm=disabled \
        -Dfontconfig=disabled \
        -Ddirectwrite=enabled \
        -Drequire-system-font-provider=true \
        -Dasm=enabled \
        -Dlibunibreak=enabled \
        -Dlarge-tiles=false
    ninja -C "$BUILD_ROOT/libass" -j"$JOBS" -v
    ninja -C "$BUILD_ROOT/libass" install
}

build_libwebp() {
    echo '=== libwebp ==='
    cmake -S "$SOURCE_ROOT/libwebp" -B "$BUILD_ROOT/libwebp" -G Ninja \
        -DCMAKE_TOOLCHAIN_FILE=/work/toolchain.cmake \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DCMAKE_C_FLAGS="$CFLAGS" \
        -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS" \
        -DCMAKE_SHARED_LINKER_FLAGS="$LDFLAGS" \
        -DBUILD_SHARED_LIBS=OFF \
        -DWEBP_LINK_STATIC=ON \
        -DWEBP_ENABLE_SIMD=ON \
        -DWEBP_BUILD_ANIM_UTILS=OFF \
        -DWEBP_BUILD_CWEBP=OFF \
        -DWEBP_BUILD_DWEBP=OFF \
        -DWEBP_BUILD_GIF2WEBP=OFF \
        -DWEBP_BUILD_IMG2WEBP=OFF \
        -DWEBP_BUILD_VWEBP=OFF \
        -DWEBP_BUILD_WEBPINFO=OFF \
        -DWEBP_BUILD_LIBWEBPMUX=ON \
        -DWEBP_BUILD_WEBPMUX=OFF \
        -DWEBP_BUILD_EXTRAS=OFF \
        -DWEBP_BUILD_FUZZTEST=OFF
    ninja -C "$BUILD_ROOT/libwebp" -j"$JOBS" -v
    ninja -C "$BUILD_ROOT/libwebp" install
}

build_libvpx() {
    echo '=== libvpx ==='
    mkdir -p "$BUILD_ROOT/libvpx"
    pushd "$BUILD_ROOT/libvpx" >/dev/null
    LD="$CC" CROSS="${TARGET}-" "$SOURCE_ROOT/libvpx/configure" \
        --prefix="$PREFIX" \
        --target=x86_64-win64-gcc \
        --disable-shared \
        --enable-static \
        --enable-pic \
        --disable-vp8 \
        --enable-vp9 \
        --enable-vp9-highbitdepth \
        --disable-examples \
        --disable-tools \
        --disable-docs \
        --disable-unit-tests \
        --disable-webm-io
    make -j"$JOBS" V=1
    make install
    "$RANLIB" "$PREFIX/lib/libvpx.a"
    popd >/dev/null
}

normalize_pc_runtime_links() {
    python3 - "$PREFIX" <<'PY'
import sys
from pathlib import Path

prefix = Path(sys.argv[1])
replacement = "-Wl,-Bstatic -lwinpthread -Wl,-Bdynamic"
for pc in sorted(prefix.rglob("*.pc")):
    lines = []
    for line in pc.read_text(encoding="utf-8").splitlines():
        if line.startswith(("Libs:", "Libs.private:")):
            line = line.replace("-lpthread", replacement).replace("-pthread", replacement)
        lines.append(line)
    pc.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

assert_component() {
    local macro="$1"
    local expected="$2"
    grep -Eq "^#define[[:space:]]+$macro[[:space:]]+$expected$" config_components.h \
        || die "FFmpeg component assertion failed: $macro must be $expected"
}

assert_components_enabled() {
    local macro
    for macro in "$@"; do
        assert_component "$macro" 1
    done
}

build_ffmpeg() {
    echo '=== FFmpeg ==='
    mkdir -p "$BUILD_ROOT/ffmpeg"
    pushd "$BUILD_ROOT/ffmpeg" >/dev/null
    mapfile -t configure_args < <(sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
        -e '/^$/d' -e '/^#/d' /recipe/ffmpeg-configure.args)
    "$SOURCE_ROOT/ffmpeg/configure" "${configure_args[@]}" \
        --cc="$CC" --cxx="$CXX" --ld="$CC" --ar="$AR" --ranlib="$RANLIB" \
        --nm="$NM" --strip="$STRIP" --windres="$WINDRES"

    assert_component CONFIG_EQ_FILTER 0
    assert_component CONFIG_HQDN3D_FILTER 0
    assert_component CONFIG_LIBX264_ENCODER 0
    assert_component CONFIG_LIBX264RGB_ENCODER 0
    assert_component CONFIG_H264_MF_ENCODER 1
    assert_component CONFIG_ASS_FILTER 1
    assert_component CONFIG_LUTYUV_FILTER 1
    assert_component CONFIG_BILATERAL_FILTER 1
    assert_component CONFIG_ATADENOISE_FILTER 1
    assert_component CONFIG_COLOR_FILTER 1
    assert_component CONFIG_LIBWEBP_ANIM_ENCODER 1
    assert_component CONFIG_LIBVPX_VP9_ENCODER 1
    assert_component CONFIG_GIF_ENCODER 1
    assert_component CONFIG_APNG_ENCODER 1
    grep -Eq '^#define[[:space:]]+CONFIG_D3D11VA[[:space:]]+1$' config.h \
        || die 'FFmpeg library assertion failed: CONFIG_D3D11VA must be 1'

    assert_components_enabled \
        CONFIG_FILE_PROTOCOL CONFIG_PIPE_PROTOCOL \
        CONFIG_AV1_PARSER CONFIG_GIF_PARSER CONFIG_H264_PARSER CONFIG_HEVC_PARSER \
        CONFIG_MPEG4VIDEO_PARSER CONFIG_MPEGVIDEO_PARSER CONFIG_VP8_PARSER CONFIG_VP9_PARSER \
        CONFIG_GDIGRAB_INDEV CONFIG_LAVFI_INDEV \
        CONFIG_MOV_DEMUXER CONFIG_MATROSKA_DEMUXER CONFIG_GIF_DEMUXER CONFIG_APNG_DEMUXER \
        CONFIG_IMAGE2_DEMUXER CONFIG_IMAGE2PIPE_DEMUXER CONFIG_WEBP_ANIM_DEMUXER \
        CONFIG_IMAGE_WEBP_PIPE_DEMUXER CONFIG_IMAGE_PNG_PIPE_DEMUXER \
        CONFIG_IMAGE_JPEG_PIPE_DEMUXER CONFIG_IMAGE_GIF_PIPE_DEMUXER \
        CONFIG_NUT_DEMUXER CONFIG_RAWVIDEO_DEMUXER \
        CONFIG_H264_DECODER CONFIG_HEVC_DECODER CONFIG_AV1_DECODER CONFIG_VP8_DECODER \
        CONFIG_VP9_DECODER CONFIG_MPEG4_DECODER CONFIG_GIF_DECODER CONFIG_PNG_DECODER \
        CONFIG_APNG_DECODER CONFIG_WEBP_DECODER CONFIG_WEBP_ANIM_DECODER CONFIG_MJPEG_DECODER \
        CONFIG_RAWVIDEO_DECODER CONFIG_WRAPPED_AVFRAME_DECODER CONFIG_BMP_DECODER \
        CONFIG_LIBVPX_VP9_DECODER CONFIG_PRORES_DECODER CONFIG_DNXHD_DECODER \
        CONFIG_MPEG2VIDEO_DECODER CONFIG_VC1_DECODER \
        CONFIG_GIF_ENCODER CONFIG_PNG_ENCODER CONFIG_MJPEG_ENCODER CONFIG_APNG_ENCODER \
        CONFIG_RAWVIDEO_ENCODER CONFIG_WRAPPED_AVFRAME_ENCODER CONFIG_LIBWEBP_ANIM_ENCODER \
        CONFIG_LIBVPX_VP9_ENCODER CONFIG_H264_MF_ENCODER \
        CONFIG_GIF_MUXER CONFIG_WEBP_MUXER CONFIG_APNG_MUXER CONFIG_MP4_MUXER \
        CONFIG_WEBM_MUXER CONFIG_IMAGE2_MUXER CONFIG_NUT_MUXER CONFIG_RAWVIDEO_MUXER CONFIG_NULL_MUXER \
        CONFIG_ALPHAEXTRACT_FILTER CONFIG_ASS_FILTER CONFIG_ATADENOISE_FILTER CONFIG_BILATERAL_FILTER \
        CONFIG_COLOR_FILTER CONFIG_COLORBALANCE_FILTER CONFIG_CONCAT_FILTER CONFIG_CROP_FILTER \
        CONFIG_CURVES_FILTER CONFIG_DDAGRAB_FILTER CONFIG_DRAWGRID_FILTER CONFIG_FORMAT_FILTER \
        CONFIG_FPS_FILTER CONFIG_GRADFUN_FILTER CONFIG_HFLIP_FILTER CONFIG_HUE_FILTER \
        CONFIG_HWDOWNLOAD_FILTER CONFIG_LUTYUV_FILTER CONFIG_METADATA_FILTER CONFIG_PAD_FILTER \
        CONFIG_PALETTEGEN_FILTER CONFIG_PALETTEUSE_FILTER CONFIG_ROTATE_FILTER CONFIG_SCALE_FILTER \
        CONFIG_SELECT_FILTER CONFIG_SETPTS_FILTER CONFIG_SETSAR_FILTER CONFIG_SIGNALSTATS_FILTER \
        CONFIG_SPLIT_FILTER CONFIG_TRANSPOSE_FILTER CONFIG_TRIM_FILTER CONFIG_UNSHARP_FILTER \
        CONFIG_VFLIP_FILTER CONFIG_VIGNETTE_FILTER

    cp -p config.h config_components.h ffbuild/config.log "$EVIDENCE_ROOT/"
    printf '%s\n' "${configure_args[@]}" > "$EVIDENCE_ROOT/ffmpeg-configure.expanded.args"
    make -j"$JOBS" V=1
    make install
    popd >/dev/null
}

build_zlib
bootstrap_freetype
echo '=== freetype bootstrap ==='
configure_freetype "$BUILD_ROOT/freetype-bootstrap" no
build_harfbuzz
echo '=== freetype with harfbuzz ==='
configure_freetype "$BUILD_ROOT/freetype-final" yes
build_fribidi
build_libunibreak
build_libass
build_libwebp
build_libvpx
normalize_pc_runtime_links

pkg-config --static --print-errors --exists zlib freetype2 harfbuzz fribidi libunibreak libass libwebp libwebpmux vpx
pkg-config --static --libs zlib freetype2 harfbuzz fribidi libunibreak libass libwebp libwebpmux vpx \
    > "$EVIDENCE_ROOT/external-link-closure.txt"
build_ffmpeg

shopt -s nullglob
runtime_files=("$PREFIX/bin/ffmpeg.exe" "$PREFIX/bin/ffprobe.exe" "$PREFIX/bin/"*.dll)
[[ -f "$PREFIX/bin/ffmpeg.exe" && -f "$PREFIX/bin/ffprobe.exe" ]] || die "FFmpeg programs were not installed"
(( ${#runtime_files[@]} >= 3 )) || die "No shared FFmpeg DLLs were installed"
for binary in "${runtime_files[@]}"; do
    [[ -f "$binary" ]] || die "Expected runtime file is absent: $binary"
    "$STRIP" --strip-unneeded "$binary"
    touch -d "@$SOURCE_DATE_EPOCH" "$binary"
    cp -p "$binary" "$RUNTIME_ROOT/"
done
python3 - /lock/sources.lock.json "$CORRESPONDING_ROOT/licenses" "$RUNTIME_LICENSE" <<'PY'
import json
import sys
from pathlib import Path

lock = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
licenses = Path(sys.argv[2])
output = Path(sys.argv[3])
chunks = [
    b"GIFP Public FFmpeg Runtime License Bundle\n",
    b"Generated only from the immutable source lock and exact source license files.\n",
]
for source in lock["sources"]:
    if source["role"] != "runtime-source":
        continue
    heading = (
        f"\n{'=' * 78}\n"
        f"Component: {source['id']}\n"
        f"License expression: {source['licenseExpression']}\n"
        f"Repository: {source['repository']}\n"
        f"Commit: {source['commit']}\n"
    ).encode("utf-8")
    chunks.append(heading)
    for relative in source["licenseFiles"]:
        chunks.append(f"\n--- {source['id']}/{relative} ---\n".encode("utf-8"))
        payload = (licenses / source["id"] / relative).read_bytes()
        chunks.append(payload)
        if not payload.endswith(b"\n"):
            chunks.append(b"\n")
output.write_bytes(b"".join(chunks))
PY
touch -d "@$SOURCE_DATE_EPOCH" "$RUNTIME_LICENSE"

export WINEPATH="$RUNTIME_ROOT"
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -version > "$EVIDENCE_ROOT/ffmpeg-version.txt" 2>&1
wine "$RUNTIME_ROOT/ffprobe.exe" -hide_banner -version > "$EVIDENCE_ROOT/ffprobe-version.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -buildconf > "$EVIDENCE_ROOT/ffmpeg-buildconf.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -filters > "$EVIDENCE_ROOT/ffmpeg-filters.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -encoders > "$EVIDENCE_ROOT/ffmpeg-encoders.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -decoders > "$EVIDENCE_ROOT/ffmpeg-decoders.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -formats > "$EVIDENCE_ROOT/ffmpeg-formats.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -demuxers > "$EVIDENCE_ROOT/ffmpeg-demuxers.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -muxers > "$EVIDENCE_ROOT/ffmpeg-muxers.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -protocols > "$EVIDENCE_ROOT/ffmpeg-protocols.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -devices > "$EVIDENCE_ROOT/ffmpeg-devices.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -hwaccels > "$EVIDENCE_ROOT/ffmpeg-hwaccels.txt" 2>&1
wine "$RUNTIME_ROOT/ffmpeg.exe" -hide_banner -h encoder=h264_mf > "$EVIDENCE_ROOT/h264-mf-help.txt" 2>&1

grep -Fq -- '--disable-gpl' "$EVIDENCE_ROOT/ffmpeg-buildconf.txt" || die "Runtime buildconf lost --disable-gpl"
grep -Fq -- '--disable-version3' "$EVIDENCE_ROOT/ffmpeg-buildconf.txt" || die "Runtime buildconf lost --disable-version3"
grep -Fq -- '--disable-nonfree' "$EVIDENCE_ROOT/ffmpeg-buildconf.txt" || die "Runtime buildconf lost --disable-nonfree"
python3 - "$EVIDENCE_ROOT/ffmpeg-buildconf.txt" <<'PY'
import shlex
import sys
from pathlib import Path

required = "--enable-parser=av1,gif,h264,hevc,mpeg4video,mpegvideo,vp8,vp9"
arguments = shlex.split(Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace"))
if required not in arguments:
    raise SystemExit("Runtime buildconf lost the required GIF parser closure")
PY
if grep -Fq -- '--enable-libx264' "$EVIDENCE_ROOT/ffmpeg-buildconf.txt"; then
    die "Runtime unexpectedly enabled libx264"
fi
grep -Fq 'Encoder h264_mf' "$EVIDENCE_ROOT/h264-mf-help.txt" || die "h264_mf help probe failed"

python3 - "$EVIDENCE_ROOT" <<'PY'
import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])


def table_names(filename: str) -> set[str]:
    names: set[str] = set()
    for raw_line in (root / filename).read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        fields = line.split(None, 2)
        if len(fields) < 2 or not re.fullmatch(r"[A-Z.]+", fields[0]):
            continue
        name_field = fields[1]
        if name_field == "=":
            continue
        if name_field == "d":
            if len(fields) < 3:
                continue
            name_field = fields[2].split(None, 1)[0]
        for name in name_field.split(","):
            if re.fullmatch(r"[a-z0-9_.-]+", name):
                names.add(name)
    return names


def simple_names(filename: str) -> set[str]:
    names: set[str] = set()
    for raw_line in (root / filename).read_text(encoding="utf-8", errors="replace").splitlines():
        value = raw_line.strip()
        if re.fullmatch(r"[a-z0-9_]+", value):
            names.add(value)
    return names


expected = {
    "protocols": {
        "file",
        "pipe",
    },
    "demuxers": {
        "mov", "matroska", "gif", "apng", "image2", "image2pipe", "webp_anim",
        "webp_pipe", "png_pipe", "jpeg_pipe", "gif_pipe", "nut", "rawvideo",
    },
    "decoders": {
        "h264", "hevc", "av1", "vp8", "vp9", "mpeg4", "gif", "png", "apng",
        "webp", "webp_anim", "mjpeg", "rawvideo", "wrapped_avframe", "bmp",
        "libvpx-vp9", "prores", "dnxhd", "mpeg2video", "vc1",
    },
    "encoders": {
        "gif", "png", "mjpeg", "apng", "rawvideo", "wrapped_avframe",
        "libwebp_anim", "libvpx-vp9", "h264_mf",
    },
    "muxers": {"gif", "webp", "apng", "mp4", "webm", "image2", "nut", "rawvideo", "null"},
    "devices": {"lavfi", "gdigrab"},
    "filters": {
        "alphaextract", "ass", "atadenoise", "bilateral", "color", "colorbalance",
        "concat", "crop", "curves", "ddagrab", "drawgrid", "format", "fps", "gradfun",
        "hflip", "hue", "hwdownload", "lutyuv", "metadata", "pad", "palettegen",
        "paletteuse", "rotate", "scale", "select", "setpts", "setsar", "signalstats",
        "split", "transpose", "trim", "unsharp", "vflip", "vignette",
    },
    "hwaccels": {"d3d11va"},
}
actual = {
    "protocols": simple_names("ffmpeg-protocols.txt"),
    "demuxers": table_names("ffmpeg-demuxers.txt"),
    "decoders": table_names("ffmpeg-decoders.txt"),
    "encoders": table_names("ffmpeg-encoders.txt"),
    "muxers": table_names("ffmpeg-muxers.txt"),
    "devices": table_names("ffmpeg-devices.txt"),
    "filters": table_names("ffmpeg-filters.txt"),
    "hwaccels": simple_names("ffmpeg-hwaccels.txt"),
}
missing = {category: sorted(values - actual[category]) for category, values in expected.items()}
missing = {category: values for category, values in missing.items() if values}
forbidden = {
    "filters": sorted({"eq", "hqdn3d"} & actual["filters"]),
    "encoders": sorted({"libx264", "libx264rgb"} & actual["encoders"]),
}
forbidden = {category: values for category, values in forbidden.items() if values}
facts = {
    "schemaVersion": 1,
    "expected": {category: sorted(values) for category, values in expected.items()},
    "actual": {category: sorted(values) for category, values in actual.items()},
    "missing": missing,
    "forbidden": forbidden,
}
(root / "runtime-inventory-verification.json").write_text(
    json.dumps(facts, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
if missing or forbidden:
    raise SystemExit(f"Runtime inventory closure failed: missing={missing}, forbidden={forbidden}")
PY

declare -A packaged_dlls=()
for binary in "$RUNTIME_ROOT"/*.dll; do
    packaged_dlls["$(basename "$binary" | tr '[:upper:]' '[:lower:]')"]=1
done

is_windows_system_dll() {
    local name="$1"
    [[ "$name" =~ ^api-ms-win-.*\.dll$ || "$name" =~ ^ext-ms-win-.*\.dll$ ]] && return 0
    case "$name" in
        advapi32.dll|avicap32.dll|bcrypt.dll|cfgmgr32.dll|comctl32.dll|comdlg32.dll|crypt32.dll|d3d11.dll|dwrite.dll|dwmapi.dll|dxgi.dll|dxva2.dll|gdi32.dll|imm32.dll|kernel32.dll|mf.dll|mfplat.dll|mfreadwrite.dll|mfuuid.dll|msvcrt.dll|normaliz.dll|ntdll.dll|ole32.dll|oleaut32.dll|powrprof.dll|propsys.dll|psapi.dll|rpcrt4.dll|secur32.dll|setupapi.dll|shell32.dll|shlwapi.dll|strmiids.dll|ucrtbase.dll|user32.dll|usp10.dll|uuid.dll|version.dll|winmm.dll|ws2_32.dll) return 0 ;;
        *) return 1 ;;
    esac
}

: > "$EVIDENCE_ROOT/pe-imports.tsv"
for binary in "$RUNTIME_ROOT"/*; do
    while IFS= read -r imported; do
        [[ -n "$imported" ]] || continue
        imported_lower="$(printf '%s' "$imported" | tr '[:upper:]' '[:lower:]')"
        printf '%s\t%s\n' "$(basename "$binary")" "$imported" >> "$EVIDENCE_ROOT/pe-imports.tsv"
        if [[ -n "${packaged_dlls[$imported_lower]:-}" ]] || is_windows_system_dll "$imported_lower"; then
            continue
        fi
        die "unapproved PE runtime dependency: $(basename "$binary") -> $imported"
    done < <("$OBJDUMP" -p "$binary" | awk '/DLL Name:/ { print $3 }')
done

python3 - "$EVIDENCE_ROOT/pe-imports.tsv" "$EVIDENCE_ROOT/pe-imports.json" <<'PY'
import json
import sys
from pathlib import Path

rows = []
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    binary, imported = line.split("\t", 1)
    rows.append({"binary": binary, "import": imported})
Path(sys.argv[2]).write_text(json.dumps({"schemaVersion": 1, "imports": rows}, indent=2) + "\n", encoding="utf-8")
PY

(cd "$RUNTIME_ROOT" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    > "$EVIDENCE_ROOT/runtime.sha256"
(cd /out && sha256sum RUNTIME-LICENSES.txt) > "$EVIDENCE_ROOT/runtime-licenses.sha256"
(cd "$CORRESPONDING_ROOT/sources" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    > "$EVIDENCE_ROOT/corresponding-sources.sha256"
(cd "$CORRESPONDING_ROOT/recipe" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    > "$EVIDENCE_ROOT/recipe.sha256"
sha256sum /lock/sources.lock.json /lock/build-recipe.lock.json \
    /recipe/README.md \
    /recipe/ffmpeg-configure.args /recipe/ffmpeg-metadata-filter-avformat.patch \
    /recipe/prepare_sources.py \
    /recipe/build-offline.sh /recipe/build-public-runtime.ps1 /recipe/fetch-sources.ps1 \
    /recipe/verify-source-cache.mjs \
    > "$EVIDENCE_ROOT/build-inputs.sha256"

python3 - "$EVIDENCE_ROOT/build-metadata.json" /lock/sources.lock.json \
    /lock/build-recipe.lock.json "$EXPECTED_BUILDER_IMAGE" "$SOURCE_DATE_EPOCH" "$TARGET" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

def digest(path: str) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

Path(sys.argv[1]).write_text(json.dumps({
    'schemaVersion': 1,
    'profile': 'gifp-windows-x64-lgpl-shared',
    'builderImage': sys.argv[4],
    'sourceDateEpoch': int(sys.argv[5]),
    'sourceLockSha256': digest(sys.argv[2]),
    'buildRecipeLockSha256': digest(sys.argv[3]),
    'networkPolicy': 'docker --network=none; source/recipe/lock mounts read-only',
    'runtimeLinkage': 'FFmpeg shared DLLs; audited external libraries linked statically',
    'target': sys.argv[6],
}, indent=2, sort_keys=True) + '\n', encoding='utf-8')
PY
find "$RUNTIME_ROOT" "$CORRESPONDING_ROOT" "$RUNTIME_LICENSE" -exec touch -d "@$SOURCE_DATE_EPOCH" {} +
python3 - "$SOURCE_DATE_EPOCH" "$RUNTIME_ROOT" "$RUNTIME_LICENSE" "$RUNTIME_ARCHIVE" <<'PY'
import sys
import time
import zipfile
from pathlib import Path

epoch = int(sys.argv[1])
runtime_root = Path(sys.argv[2])
license_path = Path(sys.argv[3])
archive_path = Path(sys.argv[4])
timestamp = time.gmtime(epoch)[:6]
entries = [(path, f"runtime/{path.name}") for path in sorted(runtime_root.iterdir(), key=lambda item: item.name)]
entries.append((license_path, license_path.name))
with zipfile.ZipFile(
    archive_path,
    mode="w",
    compression=zipfile.ZIP_DEFLATED,
    compresslevel=9,
    strict_timestamps=True,
) as archive:
    for source, archive_name in entries:
        if not source.is_file():
            raise SystemExit(f"Runtime archive input is not a file: {source}")
        info = zipfile.ZipInfo(archive_name, date_time=timestamp)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100644 & 0xFFFF) << 16
        archive.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
PY
touch -d "@$SOURCE_DATE_EPOCH" "$RUNTIME_ARCHIVE"
(cd /out && sha256sum "$(basename "$RUNTIME_ARCHIVE")") \
    > "$EVIDENCE_ROOT/runtime-archive.sha256"
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
    -cf /out/GIFP-FFmpeg-Corresponding-Source.tar -C /out corresponding-source
touch -d "@$SOURCE_DATE_EPOCH" /out/GIFP-FFmpeg-Corresponding-Source.tar
(cd /out && sha256sum GIFP-FFmpeg-Corresponding-Source.tar) \
    > "$EVIDENCE_ROOT/corresponding-source-archive.sha256"

echo 'Public FFmpeg runtime build completed; target-Windows Media Foundation encode smoke remains a release gate.'
