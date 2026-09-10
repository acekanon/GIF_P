#!/usr/bin/env python3
"""Verify and safely unpack the locked GIFP public FFmpeg source set.

This program intentionally has no download code.  It is run inside the pinned
builder after the source cache has been mounted read-only.  The exact archive
bytes remain the build inputs; the extracted tree is disposable build state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


EXPECTED_PROFILE = "gifp-windows-x64-lgpl-shared"
EXPECTED_TARGET = "x86_64-w64-mingw32"
EXPECTED_BUILDER_IMAGE = (
    "ghcr.io/btbn/ffmpeg-builds/base-win64@"
    "sha256:80f095930d8ec013bbc5205522a7ba0dc45e4c554e9f2b4b1e0818c1876e5e87"
)
EXPECTED_SOURCE_IDS = {
    "ffmpeg",
    "zlib",
    "libwebp",
    "libvpx",
    "freetype",
    "dlg",
    "harfbuzz",
    "fribidi",
    "libunibreak",
    "libass",
    "ffmpeg-builds-recipe",
}
EXPECTED_SUBMODULES = {
    "dlg": {
        "parentSourceId": "freetype",
        "parentCommit": "5336c0d4da22a13dab3389eb153b12672fdf841c",
        "path": "subprojects/dlg",
        "gitlinkCommit": "395ccad2c1e0daae535c4d20bb0a3f2424648e17",
    }
}
FORBIDDEN_CONFIG_COMPONENTS = {
    ("filter", "eq"),
    ("filter", "hqdn3d"),
    ("encoder", "libx264"),
    ("encoder", "libx264rgb"),
}
REQUIRED_CONFIG_COMPONENTS = {
    "protocol": {"file", "pipe"},
    "parser": {
        "av1",
        "gif",
        "h264",
        "hevc",
        "mpeg4video",
        "mpegvideo",
        "vp8",
        "vp9",
    },
    "indev": {"gdigrab", "lavfi"},
    "demuxer": {
        "mov",
        "matroska",
        "gif",
        "apng",
        "image2",
        "image2pipe",
        "webp_anim",
        "image_webp_pipe",
        "image_png_pipe",
        "image_jpeg_pipe",
        "image_gif_pipe",
        "nut",
        "rawvideo",
    },
    "decoder": {
        "h264",
        "hevc",
        "av1",
        "vp8",
        "vp9",
        "mpeg4",
        "gif",
        "png",
        "apng",
        "webp",
        "webp_anim",
        "mjpeg",
        "rawvideo",
        "wrapped_avframe",
        "bmp",
        "libvpx_vp9",
        "prores",
        "dnxhd",
        "mpeg2video",
        "vc1",
    },
    "encoder": {
        "gif",
        "png",
        "mjpeg",
        "apng",
        "rawvideo",
        "wrapped_avframe",
        "libwebp_anim",
        "libvpx_vp9",
        "h264_mf",
    },
    "muxer": {"gif", "webp", "apng", "mp4", "webm", "image2", "nut", "rawvideo", "null"},
    "filter": {
        "alphaextract",
        "ass",
        "atadenoise",
        "bilateral",
        "color",
        "colorbalance",
        "concat",
        "crop",
        "curves",
        "ddagrab",
        "drawgrid",
        "format",
        "fps",
        "gradfun",
        "hflip",
        "hue",
        "hwdownload",
        "lutyuv",
        "metadata",
        "pad",
        "palettegen",
        "paletteuse",
        "rotate",
        "scale",
        "select",
        "setpts",
        "setsar",
        "signalstats",
        "split",
        "transpose",
        "trim",
        "unsharp",
        "vflip",
        "vignette",
    },
}


class PreparationError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PreparationError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PreparationError(f"{label} is not valid JSON: {error}") from error
    require(isinstance(value, dict), f"{label} must be a JSON object")
    return value


def validate_lock(lock: dict[str, Any]) -> list[dict[str, Any]]:
    require(lock.get("schemaVersion") == 1, "Unsupported source-lock schema")
    require(lock.get("profile") == EXPECTED_PROFILE, "Unexpected source-lock profile")
    require(lock.get("target") == EXPECTED_TARGET, "Unexpected source-lock target")
    builder = lock.get("builder")
    require(isinstance(builder, dict), "Source lock has no builder object")
    require(builder.get("image") == EXPECTED_BUILDER_IMAGE, "Builder image digest is not the audited value")
    require(
        builder.get("manifestDigest") == EXPECTED_BUILDER_IMAGE.rsplit("@", 1)[1],
        "Builder manifest digest disagrees with the pinned image",
    )
    require(
        builder.get("networkPolicy") == "release-build-must-run-with-network-none",
        "Offline release-build policy is missing",
    )
    sources = lock.get("sources")
    require(isinstance(sources, list) and sources, "Source-lock inventory is empty")
    ids = {source.get("id") for source in sources if isinstance(source, dict)}
    require(ids == EXPECTED_SOURCE_IDS, f"Unexpected source id set: {sorted(str(value) for value in ids)}")
    require(len(ids) == len(sources), "Source ids are duplicated")
    by_id = {source["id"]: source for source in sources}
    for source_id, expected in EXPECTED_SUBMODULES.items():
        source = by_id[source_id]
        require(source.get("submodule") == expected, f"Locked submodule metadata is mismatched: {source_id}")
        require(source.get("commit") == expected["gitlinkCommit"], f"Locked submodule commit is mismatched: {source_id}")
        require(
            by_id[expected["parentSourceId"]].get("commit") == expected["parentCommit"],
            f"Locked submodule parent commit is mismatched: {source_id}",
        )
    return sources


def read_configure_args(path: Path) -> list[str]:
    args: list[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line and not line.startswith("#"):
            require("\x00" not in line, "NUL found in configure argument")
            args.append(line)
    require(args, "FFmpeg configure argument file is empty")
    return args


def validate_configure_policy(lock: dict[str, Any], configure_args: list[str]) -> None:
    policy = lock.get("licensePolicy")
    require(isinstance(policy, dict), "Source lock has no license policy")
    arg_set = set(configure_args)
    for required in policy.get("requiredConfigureFlags", []):
        require(required in arg_set, f"Required configure flag is missing: {required}")
    for forbidden in policy.get("forbiddenConfigureFlags", []):
        require(forbidden not in arg_set, f"Forbidden configure flag is present: {forbidden}")
    require("--disable-everything" in arg_set, "Fail-closed --disable-everything is required")
    require(
        "--extra-version=gifp-n9.0" in arg_set,
        "The archive build must carry the deterministic git-identity suffix",
    )
    for flag in ("--enable-d3d11va", "--enable-mediafoundation", "--enable-shared", "--disable-static"):
        require(flag in arg_set, f"Required public-runtime configure flag is missing: {flag}")
    enabled_components: dict[str, set[str]] = {}
    for argument in configure_args:
        if not argument.startswith("--enable-") or "=" not in argument:
            continue
        category = argument[len("--enable-") :].split("=", 1)[0]
        values = argument.split("=", 1)[1].split(",")
        enabled_components.setdefault(category, set()).update(values)
        for value in values:
            require(
                (category, value) not in FORBIDDEN_CONFIG_COMPONENTS,
                f"Forbidden FFmpeg component enabled: {category}={value}",
            )
    for category, required_values in REQUIRED_CONFIG_COMPONENTS.items():
        missing = required_values - enabled_components.get(category, set())
        require(not missing, f"Required FFmpeg {category} closure is missing: {sorted(missing)}")


def safe_archive_name(name: str, archive_root: str) -> str:
    require(name != "", "Archive contains an empty member name")
    require("\\" not in name, f"Archive member uses a backslash: {name}")
    require(not name.startswith("/"), f"Archive member is absolute: {name}")
    normalized = posixpath.normpath(name.rstrip("/"))
    require(normalized not in ("", ".", ".."), f"Archive member path is invalid: {name}")
    require(not normalized.startswith("../"), f"Archive member escapes its root: {name}")
    parts = PurePosixPath(normalized).parts
    require(parts and parts[0] == archive_root, f"Archive member is outside {archive_root}: {name}")
    return normalized


def validate_link(member: tarfile.TarInfo, normalized_name: str, archive_root: str) -> None:
    if not (member.issym() or member.islnk()):
        return
    require(member.linkname != "", f"Archive link has no target: {member.name}")
    require("\\" not in member.linkname, f"Archive link target uses a backslash: {member.name}")
    require(not member.linkname.startswith("/"), f"Archive link target is absolute: {member.name}")
    if member.issym():
        target = posixpath.normpath(posixpath.join(posixpath.dirname(normalized_name), member.linkname))
    else:
        target = posixpath.normpath(member.linkname)
    require(
        target == archive_root or target.startswith(f"{archive_root}/"),
        f"Archive link escapes {archive_root}: {member.name} -> {member.linkname}",
    )


def verify_archive(source: dict[str, Any], archive: Path) -> list[tarfile.TarInfo]:
    require(archive.is_file(), f"Locked source archive is missing: {archive.name}")
    expected_size = source.get("sizeBytes")
    require(isinstance(expected_size, int) and archive.stat().st_size == expected_size, f"Size mismatch: {archive.name}")
    expected_hash = source.get("sha256")
    require(isinstance(expected_hash, str) and sha256_file(archive) == expected_hash, f"SHA-256 mismatch: {archive.name}")
    archive_root = source.get("archiveRoot")
    require(
        isinstance(archive_root, str)
        and archive_root not in ("", ".", "..")
        and "/" not in archive_root
        and "\\" not in archive_root
        and PurePosixPath(archive_root).name == archive_root,
        "Unsafe archive root",
    )
    try:
        with tarfile.open(archive, mode="r:*") as bundle:
            members = bundle.getmembers()
    except (tarfile.TarError, OSError) as error:
        raise PreparationError(f"Unable to inspect {archive.name}: {error}") from error
    require(members, f"Source archive is empty: {archive.name}")
    normalized_names: set[str] = set()
    for member in members:
        require(
            member.isfile() or member.isdir() or member.issym() or member.islnk(),
            f"Unsupported special file in {archive.name}: {member.name}",
        )
        normalized = safe_archive_name(member.name, archive_root)
        validate_link(member, normalized, archive_root)
        normalized_names.add(normalized)
    require(archive_root in normalized_names, f"Archive root is missing: {archive_root}")
    for license_path in source.get("licenseFiles", []):
        expected = f"{archive_root}/{license_path}"
        require(expected in normalized_names, f"Locked license file is missing: {source['id']}/{license_path}")
    return members


def normalize_mtimes(root: Path, epoch: int) -> None:
    paths = [root, *root.rglob("*")]
    for path in paths:
        try:
            os.utime(path, (epoch, epoch), follow_symlinks=False)
        except (NotImplementedError, OSError) as error:
            if path.is_symlink():
                continue
            raise PreparationError(f"Unable to normalize mtime for {path}: {error}") from error


def extract_source(
    source: dict[str, Any], archive: Path, output: Path, license_output: Path | None, epoch: int
) -> dict[str, Any]:
    members = verify_archive(source, archive)
    source_id = source["id"]
    destination = output / source_id
    require(not destination.exists(), f"Prepared source destination already exists: {destination}")
    with tempfile.TemporaryDirectory(prefix=f".{source_id}-", dir=output) as temporary:
        temporary_path = Path(temporary)
        try:
            with tarfile.open(archive, mode="r:*") as bundle:
                # Every member and link target was checked above.  The data
                # filter adds Python's own metadata and path safety checks.
                try:
                    bundle.extractall(temporary_path, members=members, filter="data")
                except TypeError:
                    bundle.extractall(temporary_path, members=members)
        except (tarfile.TarError, OSError) as error:
            raise PreparationError(f"Unable to extract {archive.name}: {error}") from error
        extracted_root = temporary_path / source["archiveRoot"]
        require(extracted_root.is_dir(), f"Extracted source root is missing: {source['archiveRoot']}")
        extracted_root.rename(destination)
    normalize_mtimes(destination, epoch)
    if license_output is not None:
        component_license_root = license_output / source_id
        for relative in source["licenseFiles"]:
            source_license = destination / PurePosixPath(relative)
            target = component_license_root / PurePosixPath(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_license, target, follow_symlinks=True)
        normalize_mtimes(component_license_root, epoch)
    facts = {
        "id": source_id,
        "commit": source["commit"],
        "archiveFile": source["archiveFile"],
        "sizeBytes": source["sizeBytes"],
        "sha256": source["sha256"],
        "licenseExpression": source["licenseExpression"],
        "licenseFiles": source["licenseFiles"],
        "preparedPath": str(destination),
    }
    if "submodule" in source:
        facts["submodule"] = source["submodule"]
    return facts


def ensure_empty_directory(path: Path, label: str) -> None:
    if path.exists():
        require(path.is_dir(), f"{label} is not a directory: {path}")
        require(not any(path.iterdir()), f"{label} must be empty: {path}")
    else:
        path.mkdir(parents=True)


def materialize_locked_submodules(sources: list[dict[str, Any]], output: Path, epoch: int) -> None:
    for source in sources:
        submodule = source.get("submodule")
        if not isinstance(submodule, dict):
            continue
        source_tree = output / source["id"]
        parent_tree = output / submodule["parentSourceId"]
        target = parent_tree / PurePosixPath(submodule["path"])
        require(source_tree.is_dir(), f"Prepared submodule source is missing: {source['id']}")
        require(target.is_dir(), f"Prepared submodule mount point is missing: {submodule['path']}")
        require(not any(target.iterdir()), f"Prepared submodule mount point is not empty: {submodule['path']}")
        shutil.copytree(source_tree, target, dirs_exist_ok=True, symlinks=True)
        normalize_mtimes(target, epoch)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--licenses-output", type=Path)
    parser.add_argument("--configure-args", required=True, type=Path)
    parser.add_argument("--source-date-epoch", required=True, type=int)
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    require(options.source_date_epoch == 1785786727, "Unexpected SOURCE_DATE_EPOCH")
    lock_path = options.lock.resolve(strict=True)
    cache = options.cache.resolve(strict=True)
    require(cache.is_dir(), f"Source cache is not a directory: {cache}")
    configure_path = options.configure_args.resolve(strict=True)
    lock = load_json(lock_path, "FFmpeg public source lock")
    sources = validate_lock(lock)
    validate_configure_policy(lock, read_configure_args(configure_path))
    output = options.output.resolve()
    ensure_empty_directory(output, "Prepared-source output")
    license_output = options.licenses_output.resolve() if options.licenses_output else None
    if license_output is not None:
        ensure_empty_directory(license_output, "License output")
    facts = []
    for source in sources:
        archive_file = source.get("archiveFile")
        require(
            isinstance(archive_file, str) and Path(archive_file).name == archive_file,
            f"Unsafe archive filename for {source.get('id')}",
        )
        facts.append(
            extract_source(
                source,
                cache / archive_file,
                output,
                license_output,
                options.source_date_epoch,
            )
        )
    materialize_locked_submodules(sources, output, options.source_date_epoch)
    manifest = {
        "schemaVersion": 1,
        "profile": lock["profile"],
        "target": lock["target"],
        "builderImage": lock["builder"]["image"],
        "sourceDateEpoch": options.source_date_epoch,
        "sourceLockSha256": sha256_file(lock_path),
        "sources": facts,
    }
    manifest_path = output / "prepared-sources.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.utime(manifest_path, (options.source_date_epoch, options.source_date_epoch))
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (PreparationError, OSError) as error:
        print(f"prepare_sources.py: {error}", file=sys.stderr)
        raise SystemExit(1) from error
