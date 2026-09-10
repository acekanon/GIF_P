use super::contracts::{
    BackendCapability, BackendFeatures, BackendKind, BackendStatus, Distribution, EncodeMode,
    OutputFormat, BACKEND_CAPABILITY_SCHEMA_VERSION,
};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug)]
struct ToolSpec {
    binary: &'static str,
    version_args: &'static [&'static str],
}

const FFMPEG: ToolSpec = ToolSpec {
    binary: "ffmpeg",
    version_args: &["-version"],
};

const GIFSICLE: ToolSpec = ToolSpec {
    binary: "gifsicle",
    version_args: &["--version"],
};

static H264_ENCODER_CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<FfmpegH264Encoder>>>> =
    OnceLock::new();
static H264_MF_HARDWARE_CACHE: OnceLock<Mutex<HashMap<PathBuf, bool>>> = OnceLock::new();

// Windows' software H.264 Media Foundation transform rejects the otherwise
// valid 16x16 probe with MF_E_INVALIDMEDIATYPE on supported systems. Exercise
// a small but realistic timeline so the capability probe measures the encoder
// instead of an implementation-specific minimum frame size.
const MEDIA_FOUNDATION_PROBE_SOURCE: &str = "color=c=black:s=64x64:r=25:d=0.2";
const MEDIA_FOUNDATION_PROBE_FRAMES: &str = "5";
static FFMPEG_FEATURE_CACHE: OnceLock<Mutex<HashMap<PathBuf, FfmpegProbeFeatures>>> =
    OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DiscoverySource {
    AppNeighbor,
    Path,
}

#[derive(Clone, Debug)]
struct FoundTool {
    path: PathBuf,
    source: DiscoverySource,
}

#[derive(Clone, Debug)]
struct ToolProbe {
    status: BackendStatus,
    source: Option<DiscoverySource>,
    ffmpeg_features: Option<FfmpegProbeFeatures>,
}

#[derive(Clone, Copy, Debug, Default)]
struct FfmpegProbeFeatures {
    baseline_palette_filters: bool,
    diff_rectangle: bool,
    per_frame_palettes: bool,
    animated_webp: bool,
    animated_avif: bool,
    apng: bool,
    h264_mp4: bool,
    live_photo_pair: bool,
    vp9_webm: bool,
    subtitle_overlay: bool,
    background_keying: bool,
    production_filter_chain: bool,
    production_io_chain: bool,
    screen_capture_chain: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FfmpegH264Encoder {
    Libx264,
    MediaFoundation,
}

impl FfmpegH264Encoder {
    pub(crate) const fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::Libx264 => "libx264",
            Self::MediaFoundation => "h264_mf",
        }
    }
}

/// Discover the GIFP backend set in stable priority order.
///
/// External tools are searched beside the current executable, then in its
/// `bin` and `sidecars` directories, and finally on `PATH`. Discovery never
/// invokes a shell. A located tool is considered available only when its
/// version command exits successfully.
pub fn discover_backends() -> Vec<BackendCapability> {
    discover_backends_with_probe(probe_tool)
}

fn discover_backends_with_probe<F>(mut probe: F) -> Vec<BackendCapability>
where
    F: FnMut(ToolSpec) -> ToolProbe,
{
    let ffmpeg = probe(FFMPEG);
    let gifsicle = probe(GIFSICLE);
    let ffmpeg_available = ffmpeg.status.is_available()
        && ffmpeg.ffmpeg_features.is_some_and(|features| {
            features.production_filter_chain && features.production_io_chain
        });
    let ffmpeg_diff_rectangles = ffmpeg
        .ffmpeg_features
        .is_some_and(|features| features.diff_rectangle);

    vec![
        ffmpeg_capability(ffmpeg),
        optimizer_capability(gifsicle),
        rust_perceptual_capability(ffmpeg_available, ffmpeg_diff_rectangles),
        rust_indexed_writer_capability(ffmpeg_available),
    ]
}

fn ffmpeg_capability(probe: ToolProbe) -> BackendCapability {
    let detected = probe.ffmpeg_features.unwrap_or_default();
    let production_ready = detected.production_filter_chain && detected.production_io_chain;
    let distribution = match probe.source {
        Some(DiscoverySource::AppNeighbor) => Distribution::Sidecar,
        _ => Distribution::System,
    };
    let status = if probe.status.is_available() && !production_ready {
        BackendStatus::Unavailable {
            reason: "FFmpeg was found, but it is missing part of GIFP's production filter or media I/O closure, including the GIF parser. Use the bundled GIFP runtime.".to_string(),
        }
    } else {
        probe.status
    };

    let mut formats = Vec::new();
    if production_ready {
        formats.push(OutputFormat::Gif);
        if detected.animated_webp {
            formats.push(OutputFormat::Webp);
        }
        if detected.animated_avif {
            formats.push(OutputFormat::Avif);
        }
        if detected.apng {
            formats.push(OutputFormat::Apng);
        }
        if detected.h264_mp4 {
            formats.push(OutputFormat::Mp4);
        }
        if detected.vp9_webm {
            formats.push(OutputFormat::Webm);
        }
    }
    if production_ready && detected.live_photo_pair {
        // Live Photo is a paired JPEG + H.264 MOV delivery. FFmpeg supplies
        // the media encodes; GIFP's built-in metadata finalizer supplies the
        // Apple pairing and timed-still contracts.
        formats.push(OutputFormat::LivePhoto);
    }

    let modes = if production_ready {
        vec![
            EncodeMode::FastGif,
            EncodeMode::BestGif,
            EncodeMode::TargetSize,
        ]
    } else {
        Vec::new()
    };

    BackendCapability {
        schema_version: BACKEND_CAPABILITY_SCHEMA_VERSION,
        id: "ffmpeg.animation".to_string(),
        display_name: "FFmpeg animation delivery".to_string(),
        kind: BackendKind::Encoder,
        status,
        distribution,
        license: "FFmpeg LGPL/GPL terms depend on build configuration".to_string(),
        license_notice: Some(
            "Inspect the discovered FFmpeg build configuration before redistributing it."
                .to_string(),
        ),
        experimental: false,
        user_opt_in_required: false,
        modes,
        formats,
        features: BackendFeatures {
            gif_encoding: production_ready,
            postprocessing: false,
            perceptual_quantization: false,
            size_search_compatible: production_ready,
            alpha: production_ready,
            variable_frame_delays: production_ready,
            partial_frame_rectangles: production_ready && detected.diff_rectangle,
            stdin_frame_stream: false,
            palette_controls: detected.baseline_palette_filters,
            per_frame_palettes: detected.per_frame_palettes,
            subtitle_overlay: detected.subtitle_overlay,
            background_keying: detected.background_keying,
            production_filter_chain: detected.production_filter_chain,
            production_io_chain: detected.production_io_chain,
            screen_capture_chain: detected.screen_capture_chain,
        },
    }
}

fn optimizer_capability(probe: ToolProbe) -> BackendCapability {
    let status = probe.status;
    let available = matches!(&status, BackendStatus::Available { .. });
    BackendCapability {
        schema_version: BACKEND_CAPABILITY_SCHEMA_VERSION,
        id: "gif.optimizer.external".to_string(),
        display_name: "GIF post-processing optimizer (external gifsicle)".to_string(),
        kind: BackendKind::PostProcessor,
        status,
        distribution: Distribution::ExternalOnly,
        license: "GPL-2.0-or-later".to_string(),
        license_notice: Some(
            "External-only experimental integration; verify upstream or commercial distribution terms before bundling."
                .to_string(),
        ),
        experimental: true,
        user_opt_in_required: true,
        modes: Vec::new(),
        formats: vec![OutputFormat::Gif],
        features: BackendFeatures {
            gif_encoding: false,
            postprocessing: available,
            perceptual_quantization: false,
            size_search_compatible: available,
            alpha: available,
            variable_frame_delays: available,
            partial_frame_rectangles: available,
            stdin_frame_stream: false,
            palette_controls: false,
            per_frame_palettes: false,
            subtitle_overlay: false,
            background_keying: false,
            production_filter_chain: false,
            production_io_chain: false,
            screen_capture_chain: false,
        },
    }
}

fn rust_perceptual_capability(
    ffmpeg_available: bool,
    ffmpeg_diff_rectangles: bool,
) -> BackendCapability {
    BackendCapability {
        schema_version: BACKEND_CAPABILITY_SCHEMA_VERSION,
        id: "rust.perceptual".to_string(),
        display_name: "GIFP perceptual timeline + OKLab palette".to_string(),
        kind: BackendKind::Encoder,
        status: if ffmpeg_available {
            BackendStatus::Available {
                executable_path: None,
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }
        } else {
            BackendStatus::Unavailable {
                reason: "The built-in scheduler is present, but its GIF adapter requires a working FFmpeg backend."
                    .to_string(),
            }
        },
        distribution: Distribution::BuiltIn,
        license: "GIFP project license (not yet selected)".to_string(),
        license_notice: Some(
            "The built-in scheduler and weighted OKLab palette planner inherit the future GIFP project licensing decision; FFmpeg currently performs source decoding/transforms, palette mapping, and GIF writing."
                .to_string(),
        ),
        experimental: true,
        user_opt_in_required: false,
        modes: vec![EncodeMode::BestGif],
        formats: vec![OutputFormat::Gif],
        features: BackendFeatures {
            gif_encoding: true,
            postprocessing: false,
            perceptual_quantization: true,
            size_search_compatible: false,
            alpha: false,
            variable_frame_delays: true,
            partial_frame_rectangles: ffmpeg_diff_rectangles,
            stdin_frame_stream: false,
            palette_controls: true,
            per_frame_palettes: false,
            subtitle_overlay: false,
            background_keying: false,
            production_filter_chain: false,
            production_io_chain: false,
            screen_capture_chain: false,
        },
    }
}

fn rust_indexed_writer_capability(ffmpeg_available: bool) -> BackendCapability {
    BackendCapability {
        schema_version: BACKEND_CAPABILITY_SCHEMA_VERSION,
        id: "rust.indexed_gif.experimental".to_string(),
        display_name: "GIFP Rust Indexed GIF Writer".to_string(),
        kind: BackendKind::Encoder,
        status: if ffmpeg_available {
            BackendStatus::Available {
                executable_path: None,
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }
        } else {
            BackendStatus::Unavailable {
                reason: "The built-in indexed writer and regional quantizer pipeline requires a working FFmpeg backend for source decoding, transforms, and the verified comparison baseline."
                    .to_string(),
            }
        },
        distribution: Distribution::BuiltIn,
        license: "GIFP project license + image-gif MIT OR Apache-2.0".to_string(),
        license_notice: Some(
            "Experimental opt-in path. image-gif handles GIF serialization/LZW; GIFP owns regional quantization and change rectangles, while FFmpeg handles source transforms and the verified palette-mapping baseline."
                .to_string(),
        ),
        experimental: true,
        user_opt_in_required: true,
        modes: vec![EncodeMode::BestGif],
        formats: vec![OutputFormat::Gif],
        features: BackendFeatures {
            gif_encoding: true,
            postprocessing: false,
            perceptual_quantization: true,
            size_search_compatible: false,
            alpha: false,
            variable_frame_delays: true,
            partial_frame_rectangles: true,
            stdin_frame_stream: false,
            palette_controls: true,
            per_frame_palettes: false,
            subtitle_overlay: false,
            background_keying: false,
            production_filter_chain: false,
            production_io_chain: false,
            screen_capture_chain: false,
        },
    }
}

fn probe_tool(spec: ToolSpec) -> ToolProbe {
    let Some(found) = find_tool(spec.binary) else {
        return ToolProbe {
            status: BackendStatus::Unavailable {
                reason: format!(
                    "{} was not found beside the application or on PATH.",
                    executable_name(spec.binary)
                ),
            },
            source: None,
            ffmpeg_features: None,
        };
    };

    let path_text = found.path.to_string_lossy().to_string();
    match Command::new(&found.path).args(spec.version_args).output() {
        Ok(output) if output.status.success() => {
            let version = first_version_line(&output.stdout, &output.stderr);
            let ffmpeg_features =
                (spec.binary == FFMPEG.binary).then(|| probe_ffmpeg_filters(&found.path));
            successful_tool_probe(path_text, found.source, version, ffmpeg_features)
        }
        Ok(output) => ToolProbe {
            status: BackendStatus::Unavailable {
                reason: format!(
                    "{} was found at {} but its version check exited with {}.",
                    spec.binary, path_text, output.status
                ),
            },
            source: Some(found.source),
            ffmpeg_features: None,
        },
        Err(error) => ToolProbe {
            status: BackendStatus::Unavailable {
                reason: format!(
                    "{} was found at {} but could not be started: {}",
                    spec.binary, path_text, error
                ),
            },
            source: Some(found.source),
            ffmpeg_features: None,
        },
    }
}

fn successful_tool_probe(
    executable_path: String,
    source: DiscoverySource,
    version: Option<String>,
    ffmpeg_features: Option<FfmpegProbeFeatures>,
) -> ToolProbe {
    // FFmpeg's detailed `-h` probes are capability hints, not an availability
    // gate. A transient or restricted help response must not block the common
    // GIF -> GIF path when the executable itself passed its version check. The
    // encoder command remains the authoritative validation and will return its
    // real stderr if the discovered build genuinely lacks a required option.
    ToolProbe {
        status: BackendStatus::Available {
            executable_path: Some(executable_path),
            version,
        },
        source: Some(source),
        ffmpeg_features,
    }
}

fn probe_ffmpeg_filters(ffmpeg: &Path) -> FfmpegProbeFeatures {
    let cache_key = fs::canonicalize(ffmpeg).unwrap_or_else(|_| ffmpeg.to_path_buf());
    let Ok(mut cache) = FFMPEG_FEATURE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    else {
        return probe_ffmpeg_features_uncached(ffmpeg);
    };
    if let Some(cached) = cache.get(&cache_key).copied() {
        return cached;
    }
    // Capability discovery is process-wide and cacheable. Keep the cache lock
    // while probing so parallel conversions cannot launch duplicate probe sets
    // or publish a transient partial result after one task is cancelled.
    let probed = probe_ffmpeg_features_uncached(ffmpeg);
    cache.insert(cache_key, probed);
    probed
}

fn probe_ffmpeg_features_uncached(ffmpeg: &Path) -> FfmpegProbeFeatures {
    let palettegen = command_help(ffmpeg, &["-hide_banner", "-h", "filter=palettegen"]);
    let paletteuse = command_help(ffmpeg, &["-hide_banner", "-h", "filter=paletteuse"]);
    let gif_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=gif"]);
    let gif_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=gif"]);
    let webp_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=libwebp_anim"]);
    let webp_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=webp"]);
    let avif_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=libaom-av1"]);
    let avif_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=avif"]);
    let apng_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=apng"]);
    let apng_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=apng"]);
    let mp4_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=mp4"]);
    let mov_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=mov"]);
    let mjpeg_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=mjpeg"]);
    let image2_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=image2"]);
    let vp9_encoder = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=libvpx-vp9"]);
    let webm_muxer = command_help(ffmpeg, &["-hide_banner", "-h", "muxer=webm"]);
    let ass_filter = command_help(ffmpeg, &["-hide_banner", "-h", "filter=ass"]);
    let build_configuration = command_help(ffmpeg, &["-hide_banner", "-buildconf"]);
    let filter_inventory = command_help(ffmpeg, &["-hide_banner", "-filters"]);
    let decoder_inventory = command_help(ffmpeg, &["-hide_banner", "-decoders"]);
    let encoder_inventory = command_help(ffmpeg, &["-hide_banner", "-encoders"]);
    let demuxer_inventory = command_help(ffmpeg, &["-hide_banner", "-demuxers"]);
    let muxer_inventory = command_help(ffmpeg, &["-hide_banner", "-muxers"]);
    let protocol_inventory = command_help(ffmpeg, &["-hide_banner", "-protocols"]);
    let device_inventory = command_help(ffmpeg, &["-hide_banner", "-devices"]);
    let hardware_inventory = command_help(ffmpeg, &["-hide_banner", "-hwaccels"]);
    let baseline_palette_filters = palettegen.contains("max_colors")
        && palettegen.contains("stats_mode")
        && palettegen.contains("reserve_transparent")
        && paletteuse.contains("dither")
        && paletteuse.contains("bayer_scale")
        && paletteuse.contains("alpha_threshold")
        && gif_encoder.contains("gifflags")
        && gif_encoder.contains("global_palette")
        && gif_muxer.contains("loop");
    let production_filter_chain = [
        "alphaextract",
        "atadenoise",
        "bilateral",
        "colorbalance",
        "concat",
        "crop",
        "curves",
        "drawgrid",
        "format",
        "fps",
        "gradfun",
        "hflip",
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
    ]
    .into_iter()
    .all(|name| table_inventory_has(&filter_inventory, name));
    let background_keying = ["colorkey", "despill"]
        .into_iter()
        .all(|name| table_inventory_has(&filter_inventory, name));
    let production_io_chain = ["file", "pipe"]
        .into_iter()
        .all(|name| plain_inventory_has(&protocol_inventory, name))
        && [
            "mov",
            "matroska",
            "gif",
            "apng",
            "image2",
            "image2pipe",
            "webp_anim",
            "webp_pipe",
            "png_pipe",
            "jpeg_pipe",
            "gif_pipe",
            "nut",
            "rawvideo",
        ]
        .into_iter()
        .all(|name| table_inventory_has(&demuxer_inventory, name))
        && [
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
            "libvpx-vp9",
            "prores",
            "dnxhd",
            "mpeg2video",
            "vc1",
        ]
        .into_iter()
        .all(|name| table_inventory_has(&decoder_inventory, name))
        && ["gif", "png", "mjpeg", "rawvideo", "wrapped_avframe"]
            .into_iter()
            .all(|name| table_inventory_has(&encoder_inventory, name))
        && ["gif", "image2", "nut", "rawvideo", "null"]
            .into_iter()
            .all(|name| table_inventory_has(&muxer_inventory, name))
        && table_inventory_has(&device_inventory, "lavfi")
        && build_configuration_has_gif_parser(&build_configuration);
    let screen_capture_chain = production_io_chain
        && table_inventory_has(&device_inventory, "gdigrab")
        && table_inventory_has(&filter_inventory, "ddagrab")
        && plain_inventory_has(&hardware_inventory, "d3d11va");
    let h264_encoder_available = probe_h264_encoder(ffmpeg).is_some();
    FfmpegProbeFeatures {
        baseline_palette_filters,
        diff_rectangle: baseline_palette_filters
            && paletteuse.contains("diff_mode")
            && paletteuse.contains("rectangle"),
        per_frame_palettes: baseline_palette_filters
            && palettegen.contains("single")
            && paletteuse.contains("new"),
        animated_webp: table_inventory_has(&demuxer_inventory, "webp_anim")
            && table_inventory_has(&decoder_inventory, "webp")
            && table_inventory_has(&decoder_inventory, "webp_anim")
            && table_inventory_has(&encoder_inventory, "libwebp_anim")
            && webp_encoder.contains("Encoder libwebp_anim")
            && webp_encoder.contains("Supported pixel formats:")
            && ["bgra", "yuv420p", "yuva420p"]
                .into_iter()
                .all(|pixel_format| webp_encoder.contains(pixel_format))
            && webp_encoder.contains("-lossless")
            && webp_encoder.contains("-quality")
            && webp_muxer.contains("loop"),
        animated_avif: avif_encoder.contains("Encoder libaom-av1")
            && avif_encoder.contains("still-picture")
            && avif_muxer.contains("Muxer avif")
            && avif_muxer.contains("loop"),
        apng: apng_encoder.contains("Encoder apng") && apng_muxer.contains("plays"),
        h264_mp4: h264_encoder_available && mp4_muxer.contains("faststart"),
        live_photo_pair: h264_encoder_available
            && mov_muxer.contains("use_metadata_tags")
            && mov_muxer.contains("movie_timescale")
            && mjpeg_encoder.contains("Encoder mjpeg")
            && image2_muxer.contains("image2"),
        vp9_webm: vp9_encoder.contains("libvpx-vp9") && webm_muxer.contains("Default video codec"),
        subtitle_overlay: ass_filter.contains("Filter ass")
            && ass_filter.contains("libass")
            && ass_filter.contains("alpha"),
        background_keying,
        production_filter_chain,
        production_io_chain,
        screen_capture_chain,
    }
}

pub(crate) fn probe_screen_capture_chain(ffmpeg: &Path) -> bool {
    probe_ffmpeg_filters(ffmpeg).screen_capture_chain
}

#[cfg(test)]
fn filter_inventory_has(inventory: &str, filter: &str) -> bool {
    table_inventory_has(inventory, filter)
}

fn table_inventory_has(inventory: &str, component: &str) -> bool {
    inventory.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let _flags = fields.next();
        fields
            .next()
            .is_some_and(|names| names.split(',').any(|name| name == component))
    })
}

fn plain_inventory_has(inventory: &str, component: &str) -> bool {
    inventory.lines().any(|line| line.trim() == component)
}

fn configure_has_flag(configuration: &str, flag: &str) -> bool {
    configuration
        .split_whitespace()
        .map(|token| token.trim_matches(|character| matches!(character, '\'' | '"')))
        .any(|token| token == flag)
}

fn configure_list_has(configuration: &str, option_prefix: &str, component: &str) -> bool {
    configuration
        .split_whitespace()
        .map(|token| token.trim_matches(|character| matches!(character, '\'' | '"')))
        .filter_map(|token| token.strip_prefix(option_prefix))
        .flat_map(|values| values.split(','))
        .any(|value| value.trim_matches(|character| matches!(character, '\'' | '"')) == component)
}

fn build_configuration_has_gif_parser(configuration: &str) -> bool {
    if configuration.trim().is_empty()
        || configure_has_flag(configuration, "--disable-parsers")
        || configure_list_has(configuration, "--disable-parser=", "gif")
    {
        return false;
    }
    if configure_has_flag(configuration, "--enable-everything")
        || configure_list_has(configuration, "--enable-parser=", "gif")
    {
        return true;
    }
    !configure_has_flag(configuration, "--disable-everything")
}

pub(crate) fn probe_h264_encoder(ffmpeg: &Path) -> Option<FfmpegH264Encoder> {
    let cache_key = fs::canonicalize(ffmpeg).unwrap_or_else(|_| ffmpeg.to_path_buf());
    if let Some(cached) = H264_ENCODER_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).copied())
    {
        return cached;
    }

    let libx264 = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=libx264"]);
    let media_foundation = command_help(ffmpeg, &["-hide_banner", "-h", "encoder=h264_mf"]);
    let probed = match h264_encoder_from_help(&libx264, &media_foundation) {
        Some(FfmpegH264Encoder::MediaFoundation)
            if !media_foundation_encoder_works(ffmpeg, false) =>
        {
            None
        }
        value => value,
    };
    if let Ok(mut cache) = H264_ENCODER_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(cache_key, probed);
    }
    probed
}

pub(crate) fn probe_h264_media_foundation_hardware(ffmpeg: &Path) -> bool {
    let cache_key = fs::canonicalize(ffmpeg).unwrap_or_else(|_| ffmpeg.to_path_buf());
    if let Some(cached) = H264_MF_HARDWARE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).copied())
    {
        return cached;
    }
    let works = media_foundation_encoder_works(ffmpeg, true);
    if let Ok(mut cache) = H264_MF_HARDWARE_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cache.insert(cache_key, works);
    }
    works
}

fn media_foundation_encoder_works(ffmpeg: &Path, hardware: bool) -> bool {
    let hardware = if hardware { "1" } else { "0" };
    let Ok(mut child) = Command::new(ffmpeg)
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            MEDIA_FOUNDATION_PROBE_SOURCE,
            "-frames:v",
            MEDIA_FOUNDATION_PROBE_FRAMES,
            "-an",
            "-c:v",
            "h264_mf",
            "-rate_control",
            "quality",
            "-quality",
            "50",
            "-hw_encoding",
            hardware,
            "-f",
            "null",
            "-",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn h264_encoder_from_help(
    libx264_help: &str,
    media_foundation_help: &str,
) -> Option<FfmpegH264Encoder> {
    if libx264_help.contains("Encoder libx264") {
        Some(FfmpegH264Encoder::Libx264)
    } else if media_foundation_help.contains("Encoder h264_mf") {
        Some(FfmpegH264Encoder::MediaFoundation)
    } else {
        None
    }
}

fn command_help(command: &Path, args: &[&str]) -> String {
    for attempt in 0..2 {
        if let Ok(output) = Command::new(command).args(args).output() {
            if output.status.success() {
                let help = format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                if !help.trim().is_empty() {
                    return help;
                }
            }
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    String::new()
}

fn find_tool(binary: &str) -> Option<FoundTool> {
    let app_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let path_dirs = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    find_tool_in(binary, app_dir.as_deref(), &path_dirs)
}

fn find_tool_in(binary: &str, app_dir: Option<&Path>, path_dirs: &[PathBuf]) -> Option<FoundTool> {
    let names = executable_names(binary);

    if let Some(app_dir) = app_dir {
        for directory in [
            app_dir.to_path_buf(),
            app_dir.join("bin"),
            app_dir.join("sidecars"),
        ] {
            if let Some(path) = find_named_file(&directory, &names) {
                return Some(FoundTool {
                    path,
                    source: DiscoverySource::AppNeighbor,
                });
            }
        }
    }

    for directory in path_dirs {
        if let Some(path) = find_named_file(directory, &names) {
            return Some(FoundTool {
                path,
                source: DiscoverySource::Path,
            });
        }
    }

    None
}

fn find_named_file(directory: &Path, names: &[String]) -> Option<PathBuf> {
    for name in names {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(fs::canonicalize(&candidate).unwrap_or(candidate));
        }
    }
    None
}

fn executable_names(binary: &str) -> Vec<String> {
    if cfg!(windows) {
        if binary.to_ascii_lowercase().ends_with(".exe") {
            vec![binary.to_string()]
        } else {
            vec![format!("{binary}.exe")]
        }
    } else {
        vec![binary.to_string()]
    }
}

fn executable_name(binary: &str) -> String {
    executable_names(binary)
        .into_iter()
        .next()
        .unwrap_or_else(|| binary.to_string())
}

fn first_version_line(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr].into_iter().find_map(|bytes| {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(240).collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn media_foundation_probe_uses_supported_timeline() {
        assert!(MEDIA_FOUNDATION_PROBE_SOURCE.contains("s=64x64"));
        assert!(MEDIA_FOUNDATION_PROBE_SOURCE.contains("r=25"));
        assert_eq!(MEDIA_FOUNDATION_PROBE_FRAMES, "5");
    }

    fn available_probe(spec: ToolSpec) -> ToolProbe {
        let version = format!("{} test-version", spec.binary);
        ToolProbe {
            status: BackendStatus::Available {
                executable_path: Some(format!("C:/tools/{}", executable_name(spec.binary))),
                version: Some(version),
            },
            source: Some(DiscoverySource::Path),
            ffmpeg_features: (spec.binary == FFMPEG.binary).then_some(FfmpegProbeFeatures {
                baseline_palette_filters: true,
                diff_rectangle: true,
                per_frame_palettes: true,
                animated_webp: true,
                animated_avif: true,
                apng: true,
                h264_mp4: true,
                live_photo_pair: true,
                vp9_webm: true,
                subtitle_overlay: true,
                background_keying: true,
                production_filter_chain: true,
                production_io_chain: true,
                screen_capture_chain: true,
            }),
        }
    }

    #[test]
    fn registry_has_stable_ids_order_and_external_policies() {
        let capabilities = discover_backends_with_probe(available_probe);
        let ids = capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            [
                "ffmpeg.animation",
                "gif.optimizer.external",
                "rust.perceptual",
                "rust.indexed_gif.experimental"
            ]
        );
        assert_eq!(capabilities[0].distribution, Distribution::System);
        assert!(!capabilities[0].experimental);
        assert_eq!(capabilities[1].distribution, Distribution::ExternalOnly);
        assert!(capabilities[1].experimental);
        assert!(capabilities[1].user_opt_in_required);
        assert_eq!(capabilities[1].kind, BackendKind::PostProcessor);
        assert!(capabilities[1].modes.is_empty());
        assert!(matches!(
            capabilities[1].status,
            BackendStatus::Available { .. }
        ));
        assert!(matches!(
            capabilities[2].status,
            BackendStatus::Available {
                executable_path: None,
                ..
            }
        ));
        assert_eq!(capabilities[2].modes, vec![EncodeMode::BestGif]);
        assert!(capabilities[2].features.variable_frame_delays);
        assert!(!capabilities[2].features.alpha);
        assert!(capabilities[2].features.perceptual_quantization);
        assert!(capabilities[2].features.palette_controls);
        assert!(!capabilities[2].features.per_frame_palettes);
        assert!(!capabilities[2].features.size_search_compatible);
        assert!(matches!(
            capabilities[3].status,
            BackendStatus::Available {
                executable_path: None,
                ..
            }
        ));
        assert!(capabilities[3].experimental);
        assert!(capabilities[3].user_opt_in_required);
        assert_eq!(capabilities[3].distribution, Distribution::BuiltIn);
        assert!(capabilities[3].features.gif_encoding);
        assert!(capabilities[3].features.variable_frame_delays);
        assert!(capabilities[3].features.partial_frame_rectangles);
        assert!(!capabilities[3].features.alpha);
        assert!(capabilities[3].features.perceptual_quantization);
    }

    #[test]
    fn perceptual_gif_adapter_is_unavailable_without_ffmpeg() {
        let capabilities = discover_backends_with_probe(|spec| {
            if spec.binary == FFMPEG.binary {
                ToolProbe {
                    status: BackendStatus::Unavailable {
                        reason: "missing in test".to_string(),
                    },
                    source: None,
                    ffmpeg_features: None,
                }
            } else {
                available_probe(spec)
            }
        });

        assert!(matches!(
            capabilities[2].status,
            BackendStatus::Unavailable { ref reason } if reason.contains("requires a working FFmpeg")
        ));
        assert!(matches!(
            capabilities[3].status,
            BackendStatus::Unavailable { ref reason } if reason.contains("requires a working FFmpeg")
        ));
    }

    #[test]
    fn sidecar_ffmpeg_is_reported_as_sidecar() {
        let capability = ffmpeg_capability(ToolProbe {
            status: BackendStatus::Available {
                executable_path: Some("C:/app/ffmpeg.exe".to_string()),
                version: Some("ffmpeg version test".to_string()),
            },
            source: Some(DiscoverySource::AppNeighbor),
            ffmpeg_features: Some(FfmpegProbeFeatures {
                baseline_palette_filters: true,
                diff_rectangle: true,
                per_frame_palettes: true,
                animated_webp: true,
                animated_avif: true,
                apng: true,
                h264_mp4: true,
                live_photo_pair: true,
                vp9_webm: true,
                subtitle_overlay: true,
                background_keying: true,
                production_filter_chain: true,
                production_io_chain: true,
                screen_capture_chain: true,
            }),
        });

        assert_eq!(capability.distribution, Distribution::Sidecar);
    }

    #[test]
    fn incomplete_ffmpeg_help_is_not_advertised_as_export_ready() {
        let capability = ffmpeg_capability(successful_tool_probe(
            "C:/app/ffmpeg.exe".to_string(),
            DiscoverySource::AppNeighbor,
            Some("ffmpeg version test".to_string()),
            Some(FfmpegProbeFeatures::default()),
        ));

        assert!(matches!(
            capability.status,
            BackendStatus::Unavailable { .. }
        ));
        assert!(capability.formats.is_empty());
        assert!(!capability.features.gif_encoding);
        assert!(!capability.features.palette_controls);
    }

    #[test]
    fn live_photo_is_hidden_when_the_pairing_encode_contract_is_incomplete() {
        let capability = ffmpeg_capability(ToolProbe {
            status: BackendStatus::Available {
                executable_path: Some("C:/tools/ffmpeg.exe".to_string()),
                version: Some("ffmpeg version test".to_string()),
            },
            source: Some(DiscoverySource::Path),
            ffmpeg_features: Some(FfmpegProbeFeatures {
                baseline_palette_filters: true,
                diff_rectangle: true,
                per_frame_palettes: true,
                animated_webp: true,
                animated_avif: true,
                apng: true,
                h264_mp4: true,
                live_photo_pair: false,
                vp9_webm: true,
                subtitle_overlay: true,
                background_keying: true,
                production_filter_chain: true,
                production_io_chain: true,
                screen_capture_chain: true,
            }),
        });

        assert!(capability.formats.contains(&OutputFormat::Mp4));
        assert!(!capability.formats.contains(&OutputFormat::LivePhoto));
    }

    #[test]
    fn app_neighbor_search_precedes_path() {
        let token = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = env::temp_dir().join(format!("gifp_registry_{token}"));
        let app_dir = root.join("app");
        let path_dir = root.join("path");
        fs::create_dir_all(&app_dir).expect("create app dir");
        fs::create_dir_all(&path_dir).expect("create path dir");
        let name = executable_name("ffmpeg");
        fs::write(app_dir.join(&name), b"app").expect("create app tool");
        fs::write(path_dir.join(&name), b"path").expect("create path tool");

        let found = find_tool_in("ffmpeg", Some(&app_dir), &[path_dir])
            .expect("find application-neighbor tool");

        assert_eq!(found.source, DiscoverySource::AppNeighbor);
        assert_eq!(found.path, fs::canonicalize(app_dir.join(name)).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_reader_uses_stderr_when_stdout_is_empty() {
        assert_eq!(
            first_version_line(b"\n", b"gifsicle 1.95\nmore output"),
            Some("gifsicle 1.95".to_string())
        );
    }

    #[test]
    fn h264_probe_prefers_x264_but_accepts_lgpl_media_foundation() {
        assert_eq!(
            h264_encoder_from_help(
                "Encoder libx264 [libx264 H.264]",
                "Encoder h264_mf [H264 via MediaFoundation]"
            ),
            Some(FfmpegH264Encoder::Libx264)
        );
        assert_eq!(
            h264_encoder_from_help(
                "Unknown encoder",
                "Encoder h264_mf [H264 via MediaFoundation]"
            ),
            Some(FfmpegH264Encoder::MediaFoundation)
        );
        assert_eq!(
            h264_encoder_from_help("Unknown encoder", "Encoder h264_mf"),
            Some(FfmpegH264Encoder::MediaFoundation)
        );
        assert_eq!(
            h264_encoder_from_help("Unknown encoder", "Unknown encoder"),
            None
        );
    }

    #[test]
    fn filter_inventory_matches_whole_filter_names() {
        let inventory = " T.. atadenoise V->V\n ... lutyuv V->V\n ... scale V->V\n";
        assert!(filter_inventory_has(inventory, "atadenoise"));
        assert!(filter_inventory_has(inventory, "lutyuv"));
        assert!(!filter_inventory_has(inventory, "lut"));
        assert!(table_inventory_has(" D  mov QuickTime / MOV\n", "mov"));
        assert!(table_inventory_has(
            " D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n",
            "mov"
        ));
        assert!(table_inventory_has(
            " D  matroska,webm Matroska / WebM\n",
            "matroska"
        ));
        assert!(!table_inventory_has(
            " D  mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV\n",
            "m"
        ));
        assert!(plain_inventory_has("Input:\nfile\npipe\n", "pipe"));
        assert!(!plain_inventory_has("Input:\nfile\npipeline\n", "pipe"));
    }

    #[test]
    fn gif_parser_gate_rejects_incomplete_fail_closed_builds() {
        assert!(build_configuration_has_gif_parser(
            "configuration: --disable-everything --enable-parser=av1,gif,h264"
        ));
        assert!(build_configuration_has_gif_parser(
            "configuration: --disable-everything --enable-parser='gif,h264'"
        ));
        assert!(!build_configuration_has_gif_parser(
            "configuration: --disable-everything --enable-parser=av1,h264"
        ));
        assert!(!build_configuration_has_gif_parser(
            "configuration: --enable-everything --disable-parser=gif"
        ));
        assert!(!build_configuration_has_gif_parser(
            "configuration: --disable-everything --enable-parser=gif89a"
        ));
        assert!(build_configuration_has_gif_parser(
            "configuration: --enable-gpl --enable-shared"
        ));
        assert!(!build_configuration_has_gif_parser(""));
    }

    #[test]
    fn incomplete_production_closure_is_not_advertised_as_available() {
        let capability = ffmpeg_capability(ToolProbe {
            status: BackendStatus::Available {
                executable_path: Some("C:/app/ffmpeg.exe".to_string()),
                version: Some("ffmpeg version test".to_string()),
            },
            source: Some(DiscoverySource::AppNeighbor),
            ffmpeg_features: Some(FfmpegProbeFeatures {
                baseline_palette_filters: true,
                animated_webp: true,
                apng: true,
                h264_mp4: true,
                vp9_webm: true,
                production_filter_chain: true,
                production_io_chain: false,
                ..FfmpegProbeFeatures::default()
            }),
        });
        assert!(matches!(
            capability.status,
            BackendStatus::Unavailable { .. }
        ));
        assert!(capability.modes.is_empty());
        assert!(capability.formats.is_empty());
        assert!(!capability.features.gif_encoding);
    }

    #[test]
    fn real_ffmpeg_probe_covers_every_option_used_by_the_baseline() {
        let capability = ffmpeg_capability(probe_tool(FFMPEG));
        assert!(
            matches!(capability.status, BackendStatus::Available { .. }),
            "{:?}",
            capability.status
        );
        assert!(capability.features.palette_controls);
        assert!(capability.features.partial_frame_rectangles);
        assert!(capability.features.per_frame_palettes);
        assert!(capability.features.subtitle_overlay);
        assert_eq!(
            capability.formats,
            [
                OutputFormat::Gif,
                OutputFormat::Webp,
                OutputFormat::Avif,
                OutputFormat::Apng,
                OutputFormat::Mp4,
                OutputFormat::Webm,
                OutputFormat::LivePhoto,
            ]
        );
    }
}
