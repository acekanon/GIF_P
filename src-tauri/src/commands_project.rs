//! GIFP 6 project renderer. Edits are compiled from typed data; no user filter
//! strings are accepted. RGB lossless intermediates precede a single GIF palette.
use super::*;
use std::cell::Cell;

const MAX_PROJECT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DURATION_US: u64 = 300_000_000;
const MAX_RENDER_PIXELS: u64 = 600_000_000;
const PREVIEW_DURATION_US: u64 = 15_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectAsset {
    id: String,
    path: String,
    name: String,
    kind: String,
    width: u32,
    height: u32,
    duration_us: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipCrop {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectClip {
    id: String,
    asset_id: String,
    in_us: u64,
    out_us: u64,
    rate: f64,
    reverse: bool,
    hold_us: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_us: Option<u64>,
    fit: String,
    crop: ClipCrop,
}

impl ProjectClip {
    fn duration(&self) -> u64 {
        if self.hold_us > 0 {
            self.hold_us
        } else {
            self.duration_us.unwrap_or_else(|| {
                ((self.out_us.saturating_sub(self.in_us)) as f64 / self.rate).round() as u64
            })
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerTransform {
    x: f64,
    y: f64,
    scale: f64,
    rotation: f64,
    opacity: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LayerKeyframe {
    time_us: u64,
    transform: LayerTransform,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaTimePoint {
    time_us: u64,
    source_us: f64,
}

#[derive(Clone, Debug)]
struct MediaFrameSample {
    time_us: u64,
    transform: LayerTransform,
    keyframes: Vec<LayerKeyframe>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerBase {
    id: String,
    name: String,
    start_us: u64,
    end_us: u64,
    visible: bool,
    locked: bool,
    transform: LayerTransform,
    keyframes: Vec<LayerKeyframe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    transform_samples: Option<Vec<LayerKeyframe>>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    unknown_fields: HashMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ProjectLayer {
    Text {
        #[serde(flatten)]
        base: LayerBase,
        text: String,
        #[serde(rename = "fontSize")]
        font_size: f64,
        color: String,
        #[serde(rename = "strokeColor")]
        stroke_color: String,
        #[serde(rename = "strokeWidth")]
        stroke_width: f64,
    },
    Media {
        #[serde(flatten)]
        base: LayerBase,
        #[serde(rename = "assetId")]
        asset_id: String,
        width: f64,
        #[serde(rename = "sourceOffsetUs", default)]
        source_offset_us: f64,
        #[serde(rename = "sourceFrozen", default)]
        source_frozen: bool,
        #[serde(
            rename = "sourceTimeMap",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_time_map: Option<Vec<MediaTimePoint>>,
        #[serde(
            rename = "rasterScaleMax",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        raster_scale_max: Option<f64>,
        // Internal frame-preview state; never accepted from serialized projects.
        #[serde(skip)]
        render_sample: Option<MediaFrameSample>,
    },
}

impl ProjectLayer {
    fn base(&self) -> &LayerBase {
        match self {
            Self::Text { base, .. } | Self::Media { base, .. } => base,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectCanvas {
    width: u32,
    height: u32,
    fps: u32,
    background: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectOutput {
    #[serde(rename = "loop")]
    loop_output: bool,
    max_bytes: Option<u64>,
    smart_lossless: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum LayerTiming {
    Absolute,
    Ripple,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectEditing {
    layer_timing: LayerTiming,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditProject {
    schema_version: u16,
    id: String,
    name: String,
    revision: u64,
    canvas: ProjectCanvas,
    assets: Vec<ProjectAsset>,
    clips: Vec<ProjectClip>,
    layers: Vec<ProjectLayer>,
    output: ProjectOutput,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    editing: Option<ProjectEditing>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRenderRequest {
    project: EditProject,
    output_dir: String,
    task_id: String,
    preview: bool,
    #[serde(default)]
    preview_frame_us: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRenderResult {
    project_id: String,
    revision: u64,
    output_path: String,
    width: u32,
    height: u32,
    duration_us: u64,
    bytes: u64,
    preview: bool,
    result: GifResult,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileResult {
    path: String,
    project: EditProject,
}

thread_local! {
    static STAGING_PROJECT_ENCODE: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn is_staging_project_encode() -> bool {
    STAGING_PROJECT_ENCODE.get()
}

struct StagingEncodeGuard(bool);

impl StagingEncodeGuard {
    fn enter() -> Self {
        Self(STAGING_PROJECT_ENCODE.replace(true))
    }
}

impl Drop for StagingEncodeGuard {
    fn drop(&mut self) {
        STAGING_PROJECT_ENCODE.set(self.0);
    }
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}

fn io_error(context: &str, error: io::Error) -> AppError {
    if let Err(cancelled) = check_conversion_cancelled() {
        cancelled
    } else {
        AppError::Internal(format!("{context}: {error}"))
    }
}

fn finite_range(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

fn valid_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn validate_transform(transform: &LayerTransform) -> Result<(), AppError> {
    if !finite_range(transform.x, -2.0, 3.0)
        || !finite_range(transform.y, -2.0, 3.0)
        || !finite_range(transform.scale, 0.01, 8.0)
        || !finite_range(transform.rotation, -3600.0, 3600.0)
        || !finite_range(transform.opacity, 0.0, 1.0)
    {
        return Err(invalid("图层变换超出有效范围"));
    }
    Ok(())
}

/// Saving permits empty timelines and missing assets, allowing relinking later.
fn validate_project(project: &EditProject, rendering: bool) -> Result<u64, AppError> {
    if project.schema_version != 1 {
        return Err(invalid("不支持此工程版本；GIFP 6 目前接受 schemaVersion 1"));
    }
    if project.id.is_empty() || project.id.len() > 160 || project.name.len() > 512 {
        return Err(invalid("工程名称或标识无效"));
    }
    let canvas = &project.canvas;
    if !(96..=1920).contains(&canvas.width)
        || !(16..=1920).contains(&canvas.height)
        || !(1..=60).contains(&canvas.fps)
        || !valid_color(&canvas.background)
    {
        return Err(invalid(
            "画布需要宽 96–1920、高 16–1920、帧率 1–60，以及 #RRGGBB 背景色",
        ));
    }
    if project.assets.len() > 128 || project.clips.len() > 2048 || project.layers.len() > 64 {
        return Err(invalid(
            "工程超过 128 个素材、2048 个片段或 64 个图层的上限",
        ));
    }
    if let Some(cap) = project.output.max_bytes {
        if !(1024..=512 * 1024 * 1024).contains(&cap) {
            return Err(invalid("目标体积需要在 1 KiB 到 512 MiB 之间"));
        }
    }
    let mut ids = HashSet::new();
    for asset in &project.assets {
        if asset.id.is_empty()
            || !ids.insert(asset.id.as_str())
            || asset.path.len() > 32768
            || asset.name.len() > 512
            || !matches!(
                asset.kind.as_str(),
                "video" | "gif" | "webp" | "apng" | "image"
            )
            || asset.width == 0
            || asset.height == 0
        {
            return Err(invalid("工程素材信息无效或标识重复"));
        }
    }
    let mut clip_ids = HashSet::new();
    let mut duration = 0_u64;
    for clip in &project.clips {
        if !ids.contains(clip.asset_id.as_str())
            || clip.id.is_empty()
            || !clip_ids.insert(clip.id.as_str())
            || clip.out_us < clip.in_us
            || (clip.hold_us == 0 && clip.out_us == clip.in_us)
            || !finite_range(clip.rate, 0.05, 16.0)
            || !matches!(clip.fit.as_str(), "contain" | "cover")
            || ![
                clip.crop.left,
                clip.crop.top,
                clip.crop.right,
                clip.crop.bottom,
            ]
            .iter()
            .all(|value| finite_range(*value, 0.0, 0.99))
            || clip.crop.left + clip.crop.right >= 0.99
            || clip.crop.top + clip.crop.bottom >= 0.99
            || clip.duration() == 0
            || clip.in_us > 86_400_000_000
            || clip.out_us > 86_400_000_000
        {
            return Err(invalid(format!(
                "片段 {} 的时间、裁剪或素材引用无效",
                clip.id
            )));
        }
        duration = duration
            .checked_add(clip.duration())
            .ok_or_else(|| invalid("工程时长溢出"))?;
        if duration > MAX_DURATION_US {
            return Err(invalid("当前工作台单个工程最多 5 分钟"));
        }
    }
    let mut layer_ids = HashSet::new();
    for layer in &project.layers {
        let base = layer.base();
        if base.id.is_empty()
            || !layer_ids.insert(base.id.as_str())
            || base.end_us <= base.start_us
            || base.end_us > MAX_DURATION_US
            || base.keyframes.len() > 128
            || !base.unknown_fields.is_empty()
        {
            return Err(invalid("图层时间、标识或关键帧数量无效"));
        }
        validate_transform(&base.transform)?;
        let mut last = None;
        for key in &base.keyframes {
            if key.time_us > base.end_us - base.start_us
                || last.is_some_and(|value| key.time_us <= value)
            {
                return Err(invalid("关键帧必须按时间严格递增，并位于图层范围内"));
            }
            last = Some(key.time_us);
            validate_transform(&key.transform)?;
        }
        if let Some(samples) = &base.transform_samples {
            if !(2..=36_002).contains(&samples.len())
                || samples.first().is_none_or(|sample| sample.time_us != 0)
                || samples
                    .last()
                    .is_none_or(|sample| sample.time_us != base.end_us - base.start_us)
                || samples
                    .windows(2)
                    .any(|pair| pair[0].time_us >= pair[1].time_us)
            {
                return Err(invalid("姿态采样必须覆盖图层全长且时间严格递增"));
            }
            for sample in samples {
                validate_transform(&sample.transform)?;
            }
        }
        match layer {
            ProjectLayer::Text {
                text,
                font_size,
                color,
                stroke_color,
                stroke_width,
                ..
            } => {
                if text.len() > 8192
                    || !finite_range(*font_size, 1.0, 512.0)
                    || !finite_range(*stroke_width, 0.0, 32.0)
                    || !valid_color(color)
                    || !valid_color(stroke_color)
                {
                    return Err(invalid("文字图层的内容、字号或颜色无效"));
                }
            }
            ProjectLayer::Media {
                asset_id,
                width,
                source_offset_us,
                source_frozen,
                source_time_map,
                raster_scale_max,
                ..
            } => {
                if !ids.contains(asset_id.as_str()) || !finite_range(*width, 0.01, 2.0) {
                    return Err(invalid("叠加素材引用或宽度无效"));
                }
                if !finite_range(*source_offset_us, 0.0, 86_400_000_000.0) {
                    return Err(invalid("叠加素材源偏移不能超过 24 小时"));
                }
                if raster_scale_max.is_some_and(|scale| !finite_range(scale, 0.01, 8.0)) {
                    return Err(invalid("叠加素材栅格缩放上限无效"));
                }
                if let Some(points) = source_time_map {
                    if *source_frozen
                        || !(2..=36_002).contains(&points.len())
                        || points.first().is_none_or(|point| point.time_us != 0)
                        || points
                            .last()
                            .is_none_or(|point| point.time_us != base.end_us - base.start_us)
                        || points
                            .iter()
                            .any(|point| !finite_range(point.source_us, 0.0, 86_400_000_000.0))
                        || points.windows(2).any(|pair| {
                            pair[0].time_us >= pair[1].time_us
                                || pair[0].source_us >= pair[1].source_us
                        })
                    {
                        return Err(invalid(
                            "素材源时钟映射必须覆盖图层全长且两轴严格递增，不能与冻结同时使用",
                        ));
                    }
                }
            }
        }
    }
    if rendering && duration == 0 {
        return Err(invalid("请先向主轨添加素材"));
    }
    Ok(duration)
}

fn run_project_command(command: &mut Command, context: &str) -> Result<Output, AppError> {
    check_conversion_cancelled()?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output_for_conversion_task()
        .map_err(|err| io_error(context, err))?;
    check_conversion_cancelled()?;
    if !output.status.success() {
        return Err(AppError::EncodeFailed(format!(
            "{context}: {}",
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>()
        )));
    }
    Ok(output)
}

fn ffmpeg_command(ffmpeg: &Path) -> Command {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-filter_threads",
        "1",
        "-filter_complex_threads",
        "1",
    ]);
    command
}

fn lossless_output(command: &mut Command, output: &Path, frames: u64) {
    command
        .args([
            "-an",
            "-sn",
            "-dn",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-pix_fmt",
            "bgr0",
            "-threads",
            "2",
            "-frames:v",
        ])
        .arg(frames.to_string())
        .arg(output);
}

fn asset_for<'a>(project: &'a EditProject, id: &str) -> Result<&'a ProjectAsset, AppError> {
    project
        .assets
        .iter()
        .find(|asset| asset.id == id)
        .ok_or_else(|| invalid(format!("素材 {id} 不存在")))
}

#[derive(Debug)]
struct SourceInfo {
    width: u32,
    height: u32,
    duration_us: Option<u64>,
    start_time_us: f64,
}

fn inspect_source(ffprobe: &Path, path: &Path) -> Result<SourceInfo, AppError> {
    let output = run_project_command(
        Command::new(ffprobe)
            .args(["-v", "error"])
            .args(animation_demux_args(path))
            .args([
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,duration,start_time,start_pts,time_base:stream_side_data=rotation:stream_tags=rotate:format=duration,start_time",
                "-of",
                "json",
            ])
            .arg(path),
        "检查工程素材",
    )?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| invalid(format!("素材探测数据无效: {err}")))?;
    let stream = value["streams"]
        .as_array()
        .and_then(|streams| streams.first())
        .ok_or_else(|| invalid("素材没有可解码画面"))?;
    let mut width = stream["width"].as_u64().unwrap_or(0);
    let mut height = stream["height"].as_u64().unwrap_or(0);
    if width == 0 || height == 0 || width > 16384 || height > 16384 || width * height > 67_108_864 {
        return Err(invalid("素材尺寸无效或超过 64 百万像素"));
    }
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|item| json_f64(item.get("rotation"))))
        .or_else(|| json_f64(stream["tags"].get("rotate")))
        .unwrap_or(0.0)
        .round() as i32;
    if rotation.rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let stream_time_base = stream["time_base"].as_str().and_then(|value| {
        let (num, den) = value.split_once('/')?;
        Some(num.parse::<f64>().ok()? / den.parse::<f64>().ok()?)
    });
    let start_time = stream_time_base
        .and_then(|base| stream["start_pts"].as_i64().map(|pts| pts as f64 * base))
        .or_else(|| json_f64(stream.get("start_time")))
        .or_else(|| json_f64(value["format"].get("start_time")))
        .filter(|time| time.is_finite())
        .unwrap_or(0.0);
    let duration = json_f64(stream.get("duration"))
        .or_else(|| json_f64(value["format"].get("duration")).map(|end| end - start_time.max(0.0)))
        .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
        .map(|seconds| (seconds * 1_000_000.0).round() as u64);
    Ok(SourceInfo {
        width: width as u32,
        height: height as u32,
        duration_us: duration,
        start_time_us: start_time * 1_000_000.0,
    })
}

/// Microsecond representations of exact frame boundaries can be rounded by
/// half a microsecond. Normalize only that tolerance, never an entire frame.
fn boundary_frame(time_us: u64, fps: u32) -> u64 {
    ((time_us as f64 * f64::from(fps) / 1_000_000.0) - f64::from(fps) / 2_000_000.0)
        .ceil()
        .max(0.0) as u64
}

/// A moved N-frame clip can span floor(N/fps) or ceil(N/fps) microseconds
/// depending on its new frame-grid phase. That representational difference
/// must not silently change the user's playback rate or copied source frames.
fn clip_sampling_ratio(clip: &ProjectClip, fps: u32) -> f64 {
    let span = (clip.out_us - clip.in_us) as f64;
    let duration = clip.duration() as f64;
    if clip.duration_us.is_some() {
        let nominal_duration = span / clip.rate;
        let count = (nominal_duration * f64::from(fps) / 1_000_000.0).round();
        let frame_span = count * 1_000_000.0 / f64::from(fps);
        // Two rounded source endpoints can differ from their exact source
        // span by at most 1 us, or 1/rate us after playback-speed conversion.
        if count >= 1.0
            && (duration == frame_span.floor() || duration == frame_span.ceil())
            && (nominal_duration - frame_span).abs() <= 1.0 / clip.rate
        {
            return 1.0 / clip.rate;
        }
    }
    duration / span
}

fn clip_filter(
    clip: &ProjectClip,
    source: &SourceInfo,
    canvas: &ProjectCanvas,
    frames: u64,
    sample_offset_us: f64,
) -> String {
    let fps = canvas.fps;
    let source_start = clip.in_us as f64 / 1_000_000.0;
    let source_end = clip.out_us as f64 / 1_000_000.0;
    // Retiming must retain sub-microsecond rational source timestamps. Rounding
    // a 30 fps source's 66,666.667 us to 66,667 before an upward fps rescale
    // would incorrectly duplicate its preceding frame.
    let mut filters = vec!["setpts=PTS-STARTPTS,settb=1/1000000000".to_string()];
    if clip.hold_us > 0 {
        filters.push(format!("trim=end={:.9}", source_start + 0.000_001));
        // Keep streaming up to the held source sample; fps then retains only
        // the covering frame at zero. No reverse buffer grows with source age.
        filters.push(format!(
            "setpts=ceil(PTS-{:.12}/TB)",
            source_start + 0.000_000_5
        ));
        filters.push(format!(
            "tpad=stop_mode=clone:stop_duration={:.9}",
            frames as f64 / f64::from(fps) + 1.0
        ));
    } else {
        let ratio = clip_sampling_ratio(clip, fps);
        let sample_start = if clip.reverse {
            // Sample the desired original times before reversing the uniformly
            // sampled frames. This preserves VFR source timing; reversing a
            // raw VFR stream would assign the wrong durations to its pictures.
            source_end
                - (sample_offset_us / 1_000_000.0
                    + frames.saturating_sub(1) as f64 / f64::from(fps))
                    / ratio
                - 0.000_000_5
        } else {
            source_start + sample_offset_us / 1_000_000.0 / ratio + 0.000_000_5
        };
        filters.push(format!("trim=end={source_end:.9}"));
        filters.push(format!(
            "setpts=ceil((PTS-{sample_start:.12}/TB)*{ratio:.17})"
        ));
        filters.push(format!(
            "tpad=stop_mode=clone:stop_duration={:.9}",
            frames as f64 / f64::from(fps) + 1.0
        ));
    }
    filters.push(format!(
        "fps=fps={fps}:round=up:start_time=0,trim=end_frame={frames},setpts=N/({fps}*TB)"
    ));
    // Integer crop values are derived exclusively from probed geometry.
    let x = ((f64::from(source.width) * clip.crop.left).round() as u32).min(source.width - 1);
    let y = ((f64::from(source.height) * clip.crop.top).round() as u32).min(source.height - 1);
    let width = source
        .width
        .saturating_sub(x)
        .saturating_sub((f64::from(source.width) * clip.crop.right).round() as u32)
        .max(1);
    let height = source
        .height
        .saturating_sub(y)
        .saturating_sub((f64::from(source.height) * clip.crop.bottom).round() as u32)
        .max(1);
    filters.push(format!("format=rgba,crop={width}:{height}:{x}:{y}:exact=1"));
    let w = canvas.width;
    let h = canvas.height;
    if clip.fit == "cover" {
        filters.push(format!(
            "scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}"
        ));
    } else {
        filters.push(format!("scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={}", canvas.background));
    }
    filters.push("setsar=1".into());
    if clip.reverse && clip.hold_us == 0 {
        filters.push(format!("reverse,setpts=N/({fps}*TB)"));
    }
    filters.join(",")
}

fn render_timeline(
    project: &EditProject,
    canvas: &ProjectCanvas,
    duration_us: u64,
    ffmpeg: &Path,
    ffprobe: &Path,
    temp: &Path,
) -> Result<PathBuf, AppError> {
    let mut source_info = HashMap::new();
    let used_ids: HashSet<&str> = project
        .clips
        .iter()
        .map(|clip| clip.asset_id.as_str())
        .chain(
            project
                .layers
                .iter()
                .filter(|layer| layer.base().visible)
                .filter_map(|layer| {
                    if let ProjectLayer::Media { asset_id, .. } = layer {
                        Some(asset_id.as_str())
                    } else {
                        None
                    }
                }),
        )
        .collect();
    for id in used_ids {
        let asset = asset_for(project, id)?;
        let path = Path::new(&asset.path);
        if !path.is_file() || !is_media_source(path) {
            return Err(invalid(format!(
                "素材丢失或格式不支持，请重新关联: {}",
                asset.name
            )));
        }
        source_info.insert(id.to_owned(), inspect_source(ffprobe, path)?);
    }
    let mut start_us = 0_u64;
    let mut concat = String::new();
    let mut part_count = 0;
    let total_frames = boundary_frame(duration_us, canvas.fps).max(1);
    for (index, clip) in project.clips.iter().enumerate() {
        if start_us >= duration_us {
            break;
        }
        let end_us = (start_us + clip.duration()).min(duration_us);
        let first = boundary_frame(start_us, canvas.fps);
        let end = boundary_frame(end_us, canvas.fps);
        let frames = end.saturating_sub(first);
        if frames == 0 {
            start_us = end_us;
            continue;
        }
        let asset = asset_for(project, &clip.asset_id)?;
        let source = &source_info[&clip.asset_id];
        if asset.kind != "image"
            && source.duration_us.is_some_and(|duration| {
                clip.in_us >= duration || (clip.hold_us == 0 && clip.out_us > duration + 10_000)
            })
        {
            return Err(invalid(format!(
                "片段 {} 超出了源素材时长，请重新关联或修剪",
                clip.id
            )));
        }
        if clip.reverse
            && u64::from(canvas.width) * u64::from(canvas.height) * frames * 4 > 768_000_000
        {
            return Err(invalid(
                "倒放片段超出当前 768 MB 解码缓冲预算，请先分割为更短片段",
            ));
        }
        let name = format!("clip-{index:04}.mkv");
        let path = temp.join(&name);
        let offset = (first as f64 * 1_000_000.0 / f64::from(canvas.fps)).round() - start_us as f64;
        let filter = clip_filter(clip, source, canvas, frames, offset);
        let mut command = ffmpeg_command(ffmpeg);
        if asset.kind == "image" {
            command
                .args(["-loop", "1", "-framerate"])
                .arg(canvas.fps.to_string());
        }
        command.args(animation_demux_args(Path::new(&asset.path))).arg("-i").arg(&asset.path)
            .arg("-filter_complex").arg(format!("[0:v]{filter}[clip];color=c={}:s={}x{}:r={}[bg];[bg][clip]overlay=shortest=1:format=rgb[v]", canvas.background, canvas.width, canvas.height, canvas.fps)).args(["-map", "[v]"]);
        lossless_output(&mut command, &path, frames);
        run_project_command(&mut command, "渲染主轨片段")?;
        // Explicit duration avoids accumulating Matroska's millisecond-rounded
        // one-frame duration when hundreds of isolated frames are concatenated.
        concat.push_str(&format!(
            "file '{name}'\nduration {:.12}\n",
            frames as f64 / f64::from(canvas.fps)
        ));
        part_count += 1;
        start_us = end_us;
    }
    if part_count == 0 {
        return Err(invalid("主轨没有可输出画面"));
    }
    let concat_path = temp.join("timeline.ffconcat");
    fs::write(&concat_path, concat).map_err(|err| io_error("写入主轨编排", err))?;
    let timeline = temp.join("timeline.mkv");
    let mut command = ffmpeg_command(ffmpeg);
    command
        .args(["-f", "concat", "-safe", "1", "-i"])
        .arg(&concat_path)
        .args(["-map", "0:v:0", "-c", "copy"])
        .arg(&timeline);
    run_project_command(&mut command, "合成无损主轨")?;
    let mut current = timeline;
    for (index, layer) in project.layers.iter().enumerate() {
        if !layer.base().visible
            || layer.base().start_us >= duration_us
            || boundary_frame(layer.base().start_us, canvas.fps)
                >= boundary_frame(layer.base().end_us, canvas.fps).min(total_frames)
        {
            continue;
        }
        let next = temp.join(format!("layer-{index:03}.mkv"));
        render_layer(
            project,
            layer,
            canvas,
            &source_info,
            ffmpeg,
            ffprobe,
            &current,
            &next,
            temp,
            index,
            total_frames,
        )?;
        current = next;
    }
    Ok(current)
}

fn transform_points(base: &LayerBase) -> &[LayerKeyframe] {
    base.transform_samples.as_deref().unwrap_or(&base.keyframes)
}

fn key_value(base: &LayerBase, local_us: f64, value: impl Fn(&LayerTransform) -> f64) -> f64 {
    let points = transform_points(base);
    if points.is_empty() {
        return value(&base.transform);
    }
    let first = &points[0];
    if local_us <= first.time_us as f64 {
        return value(&first.transform);
    }
    let upper = points.partition_point(|point| point.time_us as f64 <= local_us);
    if upper == points.len() {
        return value(&points[upper - 1].transform);
    }
    let from = &points[upper - 1];
    if local_us == from.time_us as f64 {
        return value(&from.transform);
    }
    let to = &points[upper];
    let p = ((local_us - from.time_us as f64) / (to.time_us - from.time_us) as f64).clamp(0.0, 1.0);
    let from_value = value(&from.transform);
    let to_value = value(&to.transform);
    if from_value == to_value {
        from_value
    } else {
        from_value * (1.0 - p) + to_value * p
    }
}

fn sample_transform(base: &LayerBase, local_us: f64) -> LayerTransform {
    LayerTransform {
        x: key_value(base, local_us, |transform| transform.x),
        y: key_value(base, local_us, |transform| transform.y),
        scale: key_value(base, local_us, |transform| transform.scale),
        rotation: key_value(base, local_us, |transform| transform.rotation),
        opacity: key_value(base, local_us, |transform| transform.opacity),
    }
}

fn media_clock_at(
    offset_us: f64,
    frozen: bool,
    local_us: f64,
    points: Option<&[MediaTimePoint]>,
) -> f64 {
    if frozen {
        return offset_us;
    }
    let Some(points) = points else {
        return offset_us + local_us;
    };
    let upper = points.partition_point(|point| point.time_us as f64 <= local_us);
    if upper == 0 {
        return points[0].source_us;
    }
    if upper == points.len() {
        return points[upper - 1].source_us;
    }
    let from = &points[upper - 1];
    let to = &points[upper];
    let elapsed = local_us - from.time_us as f64;
    let time_span = to.time_us - from.time_us;
    let source_span = to.source_us - from.source_us;
    if source_span == time_span as f64 {
        return from.source_us + elapsed;
    }
    // Match the model's BigInt quotient/remainder arithmetic for integral
    // spans, avoiding a ratio-rounding error at exact decoder boundaries.
    if source_span.fract() == 0.0
        && elapsed.fract() == 0.0
        && source_span >= 0.0
        && elapsed >= 0.0
        && source_span <= 86_400_000_000.0
        && elapsed <= MAX_DURATION_US as f64
    {
        let product = (source_span as u128) * (elapsed as u128);
        let denominator = u128::from(time_span);
        return from.source_us
            + (product / denominator) as f64
            + (product % denominator) as f64 / time_span as f64;
    }
    from.source_us + source_span * (elapsed / time_span as f64)
}

fn media_source_time(
    offset_us: f64,
    frozen: bool,
    local_us: u64,
    points: Option<&[MediaTimePoint]>,
    duration_us: Option<u64>,
) -> f64 {
    let unwrapped = media_clock_at(offset_us, frozen, local_us as f64, points);
    duration_us
        .filter(|duration| *duration > 0)
        .map_or(unwrapped, |duration| unwrapped.rem_euclid(duration as f64))
}

/// Balanced branches keep parser/evaluator depth logarithmic for long maps.
/// Source coordinates use nanosecond PTS; layer coordinates stay microseconds.
fn inverse_media_clock(points: Option<&[MediaTimePoint]>, offset_us: f64, cycle_us: f64) -> String {
    fn branch(points: &[MediaTimePoint], cycle_ns: f64, first: usize, last: usize) -> String {
        if last - first == 1 {
            let from = &points[first];
            let to = &points[last];
            if to.source_us - from.source_us == (to.time_us - from.time_us) as f64 {
                return format!(
                    "({time}+((PTS-500+{cycle_ns:.17})-{source_ns:.17})/1000)",
                    time = from.time_us,
                    source_ns = from.source_us * 1000.0
                );
            }
            return format!(
                "({time}+((PTS-500+{cycle_ns:.17})-{source_ns:.17})*{span}/{source_span:.17})",
                time = from.time_us,
                source_ns = from.source_us * 1000.0,
                span = to.time_us - from.time_us,
                source_span = (to.source_us - from.source_us) * 1000.0
            );
        }
        let middle = (first + last) / 2;
        format!(
            "if(lt(PTS-500+{cycle_ns:.17},{split:.17}),{left},{right})",
            split = points[middle].source_us * 1000.0,
            left = branch(points, cycle_ns, first, middle),
            right = branch(points, cycle_ns, middle, last)
        )
    }
    match points {
        Some(points) => branch(points, cycle_us * 1000.0, 0, points.len() - 1),
        None => format!(
            "((PTS-500+{:.17}-{:.17})/1000)",
            cycle_us * 1000.0,
            offset_us * 1000.0
        ),
    }
}

fn output_frame_time(time_us: u64, fps: u32) -> u64 {
    let mut index = time_us * u64::from(fps) / 1_000_000;
    let boundary = |frame: u64| (frame as f64 * 1_000_000.0 / f64::from(fps)).round() as u64;
    while boundary(index + 1) <= time_us {
        index += 1;
    }
    while boundary(index) > time_us && index > 0 {
        index -= 1;
    }
    boundary(index)
}

/// Find the covering original frame near the requested time, then decode only
/// that frame to RGBA PNG. Seeking is delegated to the source demuxer/keyframes;
/// a late playhead never requires rendering the preceding project timeline.
fn snapshot_asset(
    asset: &ProjectAsset,
    time_us: f64,
    loop_source: bool,
    ffmpeg: &Path,
    ffprobe: &Path,
    temp: &Path,
    token: usize,
) -> Result<ProjectAsset, AppError> {
    if asset.kind == "image" {
        return Ok(asset.clone());
    }
    let path = Path::new(&asset.path);
    if !path.is_file() {
        return Err(invalid(format!("素材丢失，请重新关联: {}", asset.name)));
    }
    let info = inspect_source(ffprobe, path)?;
    let target = info
        .duration_us
        .filter(|duration| *duration > 0)
        .map_or(time_us, |duration| {
            if loop_source {
                let phase = time_us.rem_euclid(duration as f64);
                if phase + 0.5 >= duration as f64 {
                    0.0
                } else {
                    phase
                }
            } else {
                time_us.min(duration.saturating_sub(1) as f64)
            }
        });
    let target_seconds = (target + info.start_time_us) / 1_000_000.0;
    let mut seek_seconds = 0.0;
    if target > 0.0 {
        let interval = format!(
            "{:.9}%{:.9}",
            (target_seconds - 5.0).max(info.start_time_us / 1_000_000.0),
            target_seconds + 0.010
        );
        let output = run_project_command(
            Command::new(ffprobe)
                .args(["-v", "error"])
                .args(animation_demux_args(path))
                .args(["-select_streams", "v:0", "-read_intervals"])
                .arg(interval)
                .args([
                    "-show_entries",
                    "frame=best_effort_timestamp,best_effort_timestamp_time:stream=time_base",
                    "-of",
                    "json",
                ])
                .arg(path),
            "定位原始单帧",
        )?;
        let value: Value = serde_json::from_slice(&output.stdout)
            .map_err(|err| invalid(format!("单帧时间戳无效: {err}")))?;
        let time_base = value["streams"]
            .as_array()
            .and_then(|streams| streams.first())
            .and_then(|stream| stream["time_base"].as_str())
            .and_then(|value| {
                let (num, den) = value.split_once('/')?;
                Some(num.parse::<f64>().ok()? / den.parse::<f64>().ok()?)
            });
        let frame_seconds = value["frames"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|frame| {
                time_base
                    .and_then(|base| {
                        frame["best_effort_timestamp"]
                            .as_i64()
                            .map(|pts| pts as f64 * base)
                    })
                    .or_else(|| {
                        frame["best_effort_timestamp_time"]
                            .as_str()?
                            .parse::<f64>()
                            .ok()
                    })
            })
            .filter(|time| time.is_finite() && *time <= target_seconds + 0.000_000_5)
            .max_by(f64::total_cmp)
            .ok_or_else(|| invalid("此素材无法定位目标原始帧，请重新生成或重新关联素材"))?;
        // -ss is source-relative unless seek_timestamp is requested. Floor
        // only this decoder seek, after the exact covering frame was selected.
        seek_seconds = ((frame_seconds * 1_000_000.0 - info.start_time_us)
            .max(0.0)
            .floor())
            / 1_000_000.0;
    }
    let output = temp.join(format!("snapshot-{token:03}.png"));
    let mut command = ffmpeg_command(ffmpeg);
    command
        .arg("-ss")
        .arg(format!("{seek_seconds:.9}"))
        .args(animation_demux_args(path))
        .arg("-i")
        .arg(path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "format=rgba",
            "-c:v",
            "png",
            "-update",
            "1",
        ])
        .arg(&output);
    run_project_command(&mut command, "解码目标原始帧")?;
    let mut snapshot = asset.clone();
    snapshot.id = format!("preview-snapshot-{token}");
    snapshot.path = output.to_string_lossy().into_owned();
    snapshot.kind = "image".into();
    snapshot.width = info.width;
    snapshot.height = info.height;
    snapshot.duration_us = 0;
    Ok(snapshot)
}

fn frame_preview_project(
    project: &EditProject,
    requested_us: u64,
    ffmpeg: &Path,
    ffprobe: &Path,
    temp: &Path,
) -> Result<EditProject, AppError> {
    let duration = validate_project(project, true)?;
    let time = output_frame_time(
        requested_us.min(duration.saturating_sub(1)),
        project.canvas.fps,
    );
    let frame_duration = (1_000_000.0 / f64::from(project.canvas.fps)).round() as u64;
    let mut start = 0_u64;
    let original_clip = project
        .clips
        .iter()
        .find(|clip| {
            let contains = time < start + clip.duration();
            if !contains {
                start += clip.duration();
            }
            contains
        })
        .ok_or_else(|| invalid("所选帧不在主轨范围内"))?;
    let source_time = if original_clip.hold_us > 0 {
        original_clip.in_us as f64
    } else {
        // Match clip_filter's sampling grid, including the rounded first
        // global frame and subsequent exact rational frame intervals. Rounding
        // the mapped source to u64 here can select the previous 30/60 fps frame.
        let first_frame = boundary_frame(start, project.canvas.fps);
        let selected_frame = boundary_frame(time, project.canvas.fps);
        let first_time = (first_frame as f64 * 1_000_000.0 / f64::from(project.canvas.fps)).round();
        let sampled_local = first_time - start as f64
            + selected_frame.saturating_sub(first_frame) as f64 * 1_000_000.0
                / f64::from(project.canvas.fps);
        let offset = sampled_local / clip_sampling_ratio(original_clip, project.canvas.fps);
        let mapped = if original_clip.reverse {
            original_clip.out_us as f64 - offset - 1.0
        } else {
            original_clip.in_us as f64 + offset
        };
        mapped
            .max(original_clip.in_us as f64)
            .min(original_clip.out_us.saturating_sub(1) as f64)
    };
    let main_asset = snapshot_asset(
        asset_for(project, &original_clip.asset_id)?,
        source_time,
        false,
        ffmpeg,
        ffprobe,
        temp,
        0,
    )?;
    let mut preview = project.clone();
    let mut clip = original_clip.clone();
    clip.asset_id = main_asset.id.clone();
    clip.in_us = 0;
    clip.out_us = 0;
    clip.reverse = false;
    clip.hold_us = frame_duration;
    clip.duration_us = None;
    preview.clips = vec![clip];
    preview.assets = vec![main_asset];
    preview.layers.clear();
    for (index, original_layer) in project.layers.iter().enumerate() {
        let original_base = original_layer.base();
        if !original_base.visible || time < original_base.start_us || time >= original_base.end_us {
            continue;
        }
        let local = time - original_base.start_us;
        let mut layer = original_layer.clone();
        let base = match &mut layer {
            ProjectLayer::Text { base, .. } => base,
            ProjectLayer::Media {
                base,
                asset_id,
                render_sample,
                source_offset_us,
                source_frozen,
                source_time_map,
                ..
            } => {
                *render_sample = Some(MediaFrameSample {
                    time_us: local,
                    transform: original_base.transform.clone(),
                    keyframes: transform_points(original_base).to_vec(),
                });
                let asset = asset_for(project, asset_id)?;
                let source = inspect_source(ffprobe, Path::new(&asset.path))?;
                let source_time = media_source_time(
                    *source_offset_us,
                    *source_frozen,
                    local,
                    source_time_map.as_deref(),
                    source.duration_us,
                );
                let snapshot =
                    snapshot_asset(asset, source_time, true, ffmpeg, ffprobe, temp, index + 1)?;
                *asset_id = snapshot.id.clone();
                // The PNG already represents the requested source phase.
                *source_offset_us = 0.0;
                *source_frozen = false;
                *source_time_map = None;
                if !preview.assets.iter().any(|asset| asset.id == snapshot.id) {
                    preview.assets.push(snapshot);
                }
                base
            }
        };
        base.transform = sample_transform(original_base, local as f64);
        base.keyframes.clear();
        base.transform_samples = None;
        base.start_us = 0;
        base.end_us = frame_duration;
        preview.layers.push(layer);
    }
    Ok(preview)
}

fn key_expression(base: &LayerBase, time: &str, value: impl Fn(&LayerTransform) -> f64) -> String {
    fn branch(
        points: &[LayerKeyframe],
        time: &str,
        value: &impl Fn(&LayerTransform) -> f64,
        first: usize,
        last: usize,
    ) -> String {
        if last - first == 1 {
            let from = &points[first];
            let to = &points[last];
            let from_value = value(&from.transform);
            let to_value = value(&to.transform);
            if from_value == to_value {
                return format!("{from_value:.17}");
            }
            return format!("({from_value:.17}*(1-clip(({time}-{start})/{span},0,1))+{to_value:.17}*clip(({time}-{start})/{span},0,1))",start=from.time_us,span=to.time_us-from.time_us);
        }
        let middle = (first + last) / 2;
        format!(
            "if(lt({time},{split}),{left},{right})",
            split = points[middle].time_us,
            left = branch(points, time, value, first, middle),
            right = branch(points, time, value, middle, last)
        )
    }
    let points = transform_points(base);
    match points.len() {
        0 => format!("{:.17}", value(&base.transform)),
        1 => format!("{:.17}", value(&points[0].transform)),
        _ => format!("if(lte({time},{first_time}),{first_value:.17},if(gte({time},{last_time}),{last_value:.17},{middle}))", first_time=points[0].time_us, first_value=value(&points[0].transform), last_time=points[points.len()-1].time_us, last_value=value(&points[points.len()-1].transform), middle=branch(points,time,&value,0,points.len()-1)),
    }
}

fn ass_time(seconds: f64) -> String {
    // libass receives truncated milliseconds. Put each event boundary strictly
    // before its sample, including exact-centisecond values such as 0.1; a
    // binary floating-point 99.999... ms must not leak text into the next frame.
    let ticks = ((seconds - 0.000_001).max(0.0) * 100.0).floor() as u64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        ticks / 360_000,
        ticks / 6000 % 60,
        ticks / 100 % 60,
        ticks % 100
    )
}

fn ass_color(color: &str) -> String {
    format!("&H{}{}{}&", &color[5..7], &color[3..5], &color[1..3])
}

fn text_ass(
    layer: &ProjectLayer,
    canvas: &ProjectCanvas,
    project_canvas: &ProjectCanvas,
    frames: u64,
) -> String {
    let ProjectLayer::Text {
        base,
        text,
        font_size,
        color,
        stroke_color,
        stroke_width,
    } = layer
    else {
        return String::new();
    };
    let mut ass = format!("[Script Info]\nScriptType: v4.00+\nPlayResX: {}\nPlayResY: {}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n", canvas.width, canvas.height);
    let escaped = escape_ass_text(text);
    let preview_ratio = f64::from(canvas.width) / f64::from(project_canvas.width);
    for n in 0..frames {
        let time_us = (n as f64 * 1_000_000.0 / f64::from(canvas.fps)).round();
        if time_us + 0.5 < base.start_us as f64 || time_us + 0.5 >= base.end_us as f64 {
            continue;
        }
        let local = time_us - base.start_us as f64;
        let x = key_value(base, local, |t| t.x) * f64::from(canvas.width);
        let y = key_value(base, local, |t| t.y) * f64::from(canvas.height);
        let scale = key_value(base, local, |t| t.scale);
        let rotation = key_value(base, local, |t| t.rotation);
        let alpha = ((1.0 - key_value(base, local, |t| t.opacity)) * 255.0).round() as u8;
        let begin = ass_time(time_us / 1_000_000.0);
        let end = ass_time((n + 1) as f64 / f64::from(canvas.fps));
        ass.push_str(&format!("Dialogue: 0,{begin},{end},Default,,0,0,0,,{{\\an5\\pos({x:.4},{y:.4})\\fs{:.4}\\frz{:.4}\\bord{:.4}\\shad0\\1c{}\\3c{}\\alpha&H{alpha:02X}&}}{escaped}\n", font_size * scale * preview_ratio, -rotation, stroke_width * scale * preview_ratio, ass_color(color), ass_color(stroke_color)));
    }
    ass
}

#[allow(clippy::too_many_arguments)]
fn render_layer(
    project: &EditProject,
    layer: &ProjectLayer,
    canvas: &ProjectCanvas,
    sources: &HashMap<String, SourceInfo>,
    ffmpeg: &Path,
    ffprobe: &Path,
    input: &Path,
    output: &Path,
    temp: &Path,
    index: usize,
    frames: u64,
) -> Result<(), AppError> {
    let mut command = ffmpeg_command(ffmpeg);
    command.arg("-i").arg(input);
    match layer {
        ProjectLayer::Text { .. } => {
            // Controlled, relative filename avoids drive-letter/filter quoting.
            let name = format!("text-{index:03}.ass");
            fs::write(
                temp.join(&name),
                text_ass(layer, canvas, &project.canvas, frames),
            )
            .map_err(|err| io_error("准备字幕", err))?;
            command.current_dir(temp).arg("-vf").arg(format!(
                "settb=1/1000000,setpts=round(N*1000000/{}),ass=filename={name}:alpha=1",
                canvas.fps
            ));
        }
        ProjectLayer::Media {
            base,
            asset_id,
            width,
            render_sample,
            source_offset_us,
            source_frozen,
            source_time_map,
            raster_scale_max,
        } => {
            let asset = asset_for(project, asset_id)?;
            let source = &sources[asset_id];
            let mut evaluation = base.clone();
            let sample_seconds = if let Some(sample) = render_sample {
                evaluation.transform = sample.transform.clone();
                evaluation.keyframes = sample.keyframes.clone();
                sample.time_us as f64 / 1_000_000.0
            } else {
                0.0
            };
            let max_scale = transform_points(&evaluation)
                .iter()
                .map(|key| key.transform.scale)
                .fold(evaluation.transform.scale, f64::max)
                .max(raster_scale_max.unwrap_or(0.0));
            let media_width = width * f64::from(canvas.width);
            let media_height = media_width * f64::from(source.height) / f64::from(source.width);
            // Even canvases retain integer-aligned centres when ripple edits
            // split a layer and its remaining keyframes have different bounds.
            let extent = ((media_width.hypot(media_height) * max_scale / 2.0).ceil() as u32)
                .saturating_mul(2)
                .max(2);
            if extent > 4096
                || u64::from(extent) * u64::from(extent) * frames > MAX_RENDER_PIXELS * 2
            {
                return Err(invalid(
                    "叠加图层变换超出当前渲染预算，请减小图层尺寸或缩放",
                ));
            }
            let first_frame = boundary_frame(base.start_us, canvas.fps);
            let active_frames = boundary_frame(base.end_us, canvas.fps)
                .min(frames)
                .saturating_sub(first_frame);
            let first_time_us =
                (first_frame as f64 * 1_000_000.0 / f64::from(canvas.fps)).round() as u64;
            let first_local_us = first_time_us.saturating_sub(base.start_us);
            let phase_us = if asset.kind == "image" {
                0.0
            } else {
                media_source_time(
                    *source_offset_us,
                    *source_frozen,
                    first_local_us,
                    source_time_map.as_deref(),
                    source.duration_us,
                )
            };
            let frozen_asset = if *source_frozen && asset.kind != "image" {
                Some(snapshot_asset(
                    asset,
                    phase_us,
                    true,
                    ffmpeg,
                    ffprobe,
                    temp,
                    index + 1,
                )?)
            } else {
                None
            };
            let render_asset = frozen_asset.as_ref().unwrap_or(asset);
            if render_asset.kind == "image" {
                command
                    .args(["-loop", "1", "-framerate"])
                    .arg(canvas.fps.to_string());
            } else {
                command.args(["-stream_loop", "-1"]);
            }
            command
                .args(animation_demux_args(Path::new(&render_asset.path)))
                .arg("-i")
                .arg(&render_asset.path);
            let (source_end, retime) = if render_asset.kind == "image" {
                (
                    (active_frames + 1) as f64 / f64::from(canvas.fps),
                    "PTS".to_string(),
                )
            } else {
                let first_source = media_clock_at(
                    *source_offset_us,
                    false,
                    first_local_us as f64,
                    source_time_map.as_deref(),
                );
                let cycle = first_source - phase_us;
                let last_global = ((first_frame + active_frames - 1) as f64 * 1_000_000.0
                    / f64::from(canvas.fps))
                .round();
                let last_source = media_clock_at(
                    *source_offset_us,
                    false,
                    last_global - base.start_us as f64,
                    source_time_map.as_deref(),
                );
                let inverse =
                    inverse_media_clock(source_time_map.as_deref(), *source_offset_us, cycle);
                // Each source change belongs to the first integer-microsecond
                // project sample at/after its inverse image. This exactly
                // implements B(n)=round(n*1e6/fps); .5 is that rounding law,
                // not a tolerance applied to source timestamps.
                let global_index = format!(
                    "ceil((ceil({start}+({inverse}))-0.5)*{fps}/1000000)",
                    start = base.start_us,
                    fps = canvas.fps
                );
                (
                    (last_source - cycle) / 1_000_000.0 + 1.0,
                    format!(
                        "floor(({global_index}-{first_frame})*1000000000/{})",
                        canvas.fps
                    ),
                )
            };
            let local_time = format!(
                "(round(t*1000000)-{start}+{sample:.0})",
                start = base.start_us,
                sample = sample_seconds * 1_000_000.0
            );
            let alpha_time = format!(
                "(round(T*1000000)-{start}+{sample:.0})",
                start = base.start_us,
                sample = sample_seconds * 1_000_000.0
            );
            let scale = key_expression(&evaluation, &local_time, |t| t.scale);
            // The project sampler interpolates degrees; convert afterwards so
            // authored curves and persisted per-frame poses use the same math.
            let rotation = format!(
                "({})*{:.17}",
                key_expression(&evaluation, &local_time, |t| t.rotation),
                std::f64::consts::PI / 180.0
            );
            let opacity = key_expression(&evaluation, &alpha_time, |t| t.opacity);
            let x = key_expression(&evaluation, &local_time, |t| t.x);
            let y = key_expression(&evaluation, &local_time, |t| t.y);
            let padding = active_frames as f64 / f64::from(canvas.fps) + 1.0;
            let filter = format!("[0:v]settb=1/1000000,setpts=round(N*1000000/{fps})[base];[1:v]setpts=PTS-STARTPTS,settb=1/1000000000,trim=end={source_end:.12},setpts='{retime}',tpad=stop_mode=clone:stop_duration={padding:.9},fps=fps={fps}:round=up:start_time=0,trim=end_frame={active_frames},settb=1/1000000,setpts=round((N+{first_frame})*1000000/{fps}),format=rgba,scale=w='max(1,round({media_width:.9}*({scale})))':h=-1:eval=frame:flags=lanczos,pad={extent}:{extent}:(ow-iw)/2:(oh-ih)/2:color=black@0:eval=frame,rotate=angle='{rotation}':ow={extent}:oh={extent}:c=none,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({opacity})'[overlay];[base][overlay]overlay=x='{}*({x})-overlay_w/2':y='{}*({y})-overlay_h/2':eval=frame:eof_action=pass:repeatlast=0:enable='gte(round(t*1000000),{start_us})*lt(round(t*1000000),{end_us})':format=rgb[v]", canvas.width, canvas.height, fps=canvas.fps, start_us=base.start_us, end_us=base.end_us);
            let filter_path = temp.join(format!("media-clock-{index:03}.ffgraph"));
            fs::write(&filter_path, filter).map_err(|error| io_error("写入素材时钟滤镜", error))?;
            command
                .arg("-/filter_complex")
                .arg(filter_path)
                .args(["-map", "[v]"]);
        }
    }
    lossless_output(&mut command, output, frames);
    run_project_command(&mut command, "渲染文字或叠加图层")?;
    Ok(())
}

fn gif_request(
    project: &EditProject,
    canvas: &ProjectCanvas,
    input: &Path,
    output_dir: &Path,
    duration_us: u64,
    colors: u16,
) -> Result<GifRequest, AppError> {
    serde_json::from_value(serde_json::json!({
        "schema_version": ENCODE_REQUEST_SCHEMA_VERSION,
        "input_path": input.to_string_lossy(), "output_dir": output_dir.to_string_lossy(),
        "width": canvas.width, "fps": canvas.fps, "colors": colors,
        "dither": "sierra2_4a", "optimize_level": 3, "lossy": 0,
        "start_seconds": 0.0, "end_seconds": duration_us as f64 / 1_000_000.0,
        "encoder": "ffmpeg_fast", "filter_style": "none", "loop_output": project.output.loop_output,
        "crop_enabled": false, "crop_left": 0.0, "crop_top": 0.0, "crop_right": 0.0, "crop_bottom": 0.0,
        "deleted_frames": [], "deleted_ranges": [], "playback_speed": 1.0,
        "frame_timing_mode": "compact", "output_format": "gif", "generation_mode": "fast_gif",
        "smart_lossless": project.output.smart_lossless,
        "gif_merge_frames": false, "gif_compact_palette": false
    })).map_err(|error| AppError::Internal(format!("构建工程编码请求: {error}")))
}

#[derive(Debug)]
struct GifTimingSnapshot {
    delays: Vec<(u64, u16)>,
    non_timing_sha256: [u8; 32],
    bytes: u64,
}

struct GifTimingReader {
    input: std::io::BufReader<File>,
    cursor: u64,
    digest: Sha256,
}

impl GifTimingReader {
    fn read(&mut self, buffer: &mut [u8], hash: bool) -> Result<(), AppError> {
        self.input
            .read_exact(buffer)
            .map_err(|error| io_error("读取 GIF 时序", error))?;
        self.cursor += buffer.len() as u64;
        if hash {
            self.digest.update(buffer);
        }
        Ok(())
    }

    fn byte(&mut self) -> Result<u8, AppError> {
        let mut value = [0_u8; 1];
        self.read(&mut value, true)?;
        Ok(value[0])
    }

    fn skip(&mut self, mut count: usize) -> Result<(), AppError> {
        let mut buffer = [0_u8; 256];
        while count > 0 {
            let size = count.min(buffer.len());
            self.read(&mut buffer[..size], true)?;
            count -= size;
        }
        Ok(())
    }

    fn sub_blocks(&mut self) -> Result<(), AppError> {
        loop {
            check_conversion_cancelled()?;
            let size = self.byte()?;
            if size == 0 {
                return Ok(());
            }
            self.skip(usize::from(size))?;
        }
    }
}

/// Parses block boundaries without allocating pixel or LZW buffers. Hashing
/// every byte except the two delay bytes of each GCE proves that a later timing
/// correction leaves every palette, disposal flag, image and LZW byte intact.
fn gif_timing_snapshot(path: &Path) -> Result<GifTimingSnapshot, AppError> {
    let mut reader = GifTimingReader {
        input: std::io::BufReader::with_capacity(
            64 * 1024,
            File::open(path).map_err(|error| io_error("打开 GIF 时序", error))?,
        ),
        cursor: 0,
        digest: Sha256::new(),
    };
    let mut header = [0_u8; 13];
    reader.read(&mut header, true)?;
    if !matches!(&header[..6], b"GIF87a" | b"GIF89a") {
        return Err(invalid("GIF 时序校验缺少有效文件头"));
    }
    if header[10] & 0x80 != 0 {
        reader.skip(3 * (1_usize << ((header[10] & 7) + 1)))?;
    }
    let mut pending = None;
    let mut delays = Vec::new();
    loop {
        check_conversion_cancelled()?;
        match reader.byte()? {
            0x21 => {
                let label = reader.byte()?;
                if label == 0xf9 {
                    if reader.byte()? != 4 || pending.is_some() {
                        return Err(invalid("GIF 图形控制扩展无效"));
                    }
                    let mut block = [0_u8; 5];
                    let offset = reader.cursor + 1;
                    reader.read(&mut block, false)?;
                    if block[4] != 0 {
                        return Err(invalid("GIF 图形控制扩展缺少结束标记"));
                    }
                    pending = Some((offset, u16::from_le_bytes([block[1], block[2]])));
                    block[1..3].fill(0);
                    reader.digest.update(block);
                } else {
                    reader.sub_blocks()?;
                }
            }
            0x2c => {
                let mut descriptor = [0_u8; 9];
                reader.read(&mut descriptor, true)?;
                if descriptor[8] & 0x80 != 0 {
                    reader.skip(3 * (1_usize << ((descriptor[8] & 7) + 1)))?;
                }
                if !(2..=8).contains(&reader.byte()?) {
                    return Err(invalid("GIF LZW 字长无效"));
                }
                reader.sub_blocks()?;
                delays.push(
                    pending
                        .take()
                        .ok_or_else(|| invalid("GIF 帧缺少独立时序控制"))?,
                );
                if delays.len() > 36_000 {
                    return Err(invalid("GIF 时序校验超过帧数预算"));
                }
            }
            0x3b => {
                let mut trailing = [0_u8; 1];
                if delays.is_empty()
                    || pending.is_some()
                    || reader
                        .input
                        .read(&mut trailing)
                        .map_err(|error| io_error("验证 GIF 结束位置", error))?
                        != 0
                {
                    return Err(invalid("GIF 时序校验发现不完整或额外的数据"));
                }
                return Ok(GifTimingSnapshot {
                    delays,
                    non_timing_sha256: reader.digest.finalize().into(),
                    bytes: reader.cursor,
                });
            }
            _ => return Err(invalid("GIF 时序校验发现未知数据块")),
        }
    }
}

struct ProjectGifTiming {
    duration_us: u64,
    frame_count: u64,
    forced_minimum_tail: bool,
}

fn correct_project_gif_tail(path: &Path, duration_us: u64) -> Result<ProjectGifTiming, AppError> {
    check_conversion_cancelled()?;
    let before = gif_timing_snapshot(path)?;
    let last_index = before.delays.len() - 1;
    let preceding: u64 = before.delays[..last_index]
        .iter()
        .map(|(_, delay)| u64::from(*delay))
        .sum();
    let requested_cs = duration_us.saturating_add(5000) / 10_000;
    let last_delay = requested_cs.saturating_sub(preceding).max(1);
    let last_delay =
        u16::try_from(last_delay).map_err(|_| invalid("GIF 最后一帧的延时超过格式上限"))?;
    let (offset, previous_delay) = before.delays[last_index];
    if previous_delay != last_delay {
        check_conversion_cancelled()?;
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| io_error("打开 GIF 尾帧延时", error))?;
        file.seek(io::SeekFrom::Start(offset))
            .and_then(|_| file.write_all(&last_delay.to_le_bytes()))
            .and_then(|()| file.sync_data())
            .map_err(|error| io_error("写入 GIF 尾帧延时", error))?;
        check_conversion_cancelled()?;
    }
    let after = gif_timing_snapshot(path)?;
    if before.bytes != after.bytes
        || before.non_timing_sha256 != after.non_timing_sha256
        || before.delays.len() != after.delays.len()
        || before.delays[..last_index] != after.delays[..last_index]
        || after.delays[last_index] != (offset, last_delay)
    {
        return Err(AppError::EncodeFailed(
            "GIF 尾帧校时改变了非时序数据，结果未发布".into(),
        ));
    }
    check_conversion_cancelled()?;
    Ok(ProjectGifTiming {
        duration_us: (preceding + u64::from(last_delay)) * 10_000,
        frame_count: after.delays.len() as u64,
        forced_minimum_tail: requested_cs <= preceding,
    })
}

#[tauri::command]
pub async fn render_edit_project(
    request: ProjectRenderRequest,
) -> Result<ProjectRenderResult, AppError> {
    if request.task_id.trim().is_empty() {
        return Err(invalid("工程渲染需要 taskId"));
    }
    let task_scope = ConversionTaskScope::register(Some(&request.task_id))?;
    tauri::async_runtime::spawn_blocking(move || {
        task_scope.activate();
        render_edit_project_active(request)
    })
    .await
    .map_err(|error| AppError::Internal(format!("工程渲染线程失败: {error}")))?
}

fn render_edit_project_active(
    request: ProjectRenderRequest,
) -> Result<ProjectRenderResult, AppError> {
    let result = render_edit_project_unchecked(request);
    if result.is_err() {
        // Backend discovery can wrap an interrupted probe as a dependency
        // error; the project task still owns the authoritative cancellation.
        check_conversion_cancelled()?;
    }
    result
}

fn render_edit_project_unchecked(
    request: ProjectRenderRequest,
) -> Result<ProjectRenderResult, AppError> {
    let _active = ActiveConversionGuard::start();
    let started = Instant::now();
    check_conversion_cancelled()?;
    let total_duration = validate_project(&request.project, true)?;
    let project = &request.project;
    if !request.preview && request.preview_frame_us.is_some() {
        return Err(invalid("previewFrameUs 仅适用于单帧预览"));
    }
    let frame_preview = request.preview_frame_us.is_some();
    let mut canvas = project.canvas.clone();
    let duration_us = if frame_preview {
        (1_000_000.0 / f64::from(canvas.fps)).round() as u64
    } else if request.preview {
        let ratio = (640.0 / f64::from(canvas.width.max(canvas.height))).min(1.0);
        canvas.width = (f64::from(canvas.width) * ratio).round().max(96.0) as u32;
        canvas.height = (f64::from(project.canvas.height) * f64::from(canvas.width)
            / f64::from(project.canvas.width))
        .round()
        .max(16.0) as u32;
        total_duration.min(PREVIEW_DURATION_US)
    } else {
        total_duration
    };
    let frames = boundary_frame(duration_us, canvas.fps).max(1);
    if u64::from(canvas.width) * u64::from(canvas.height) * frames > MAX_RENDER_PIXELS {
        return Err(invalid(
            "工程超过本轮 6 亿像素帧渲染预算，请缩短时间轴或显式调整画布",
        ));
    }
    let ffmpeg = locate_ffmpeg()?;
    let ffprobe = locate_ffprobe()?;
    let temp = OwnedTempDir::create("gifp-project-render")?;
    let frozen_project = request
        .preview_frame_us
        .map(|time| frame_preview_project(project, time, &ffmpeg, &ffprobe, temp.path()))
        .transpose()?;
    let project = frozen_project.as_ref().unwrap_or(project);
    let preview_directory = if request.preview {
        Some(OwnedTempDir::create("gifp-project-preview")?)
    } else {
        None
    };
    let output_dir = if let Some(directory) = &preview_directory {
        directory.path().to_path_buf()
    } else {
        if request.output_dir.trim().is_empty() {
            return Err(invalid("请先选择工程导出文件夹"));
        }
        PathBuf::from(&request.output_dir)
    };
    prepare_writable_output_directory(&output_dir, "工程导出")?;
    let timeline = render_timeline(
        project,
        &canvas,
        duration_us,
        &ffmpeg,
        &ffprobe,
        temp.path(),
    )?;
    let cap = if request.preview {
        None
    } else {
        project.output.max_bytes
    };
    let mut chosen = None;
    let mut smallest = u64::MAX;
    let color_counts: &[u16] = if cap.is_some() {
        &[256, 192, 128, 96, 64, 48, 32, 16]
    } else {
        &[256]
    };
    for (attempt, colors) in color_counts.iter().enumerate() {
        check_conversion_cancelled()?;
        let encode_request = gif_request(
            project,
            &canvas,
            &timeline,
            temp.path(),
            duration_us,
            *colors,
        )?;
        let mut result = {
            let _staging = StagingEncodeGuard::enter();
            convert_animation_inner_active(encode_request)?
        };
        smallest = smallest.min(result.size_bytes);
        if cap.is_none_or(|limit| result.size_bytes <= limit) {
            result.attempts = (attempt + 1) as u8;
            chosen = Some(result);
            break;
        }
        fs::remove_file(&result.output_path)
            .map_err(|err| io_error("移除超出目标体积的候选", err))?;
    }
    let mut result = chosen.ok_or_else(|| invalid(format!("保持 {}×{} / {} fps 时无法满足 {} 字节上限；本轮最小 {} 字节。请提高体积上限或自行修改画布。", canvas.width, canvas.height, canvas.fps, cap.unwrap_or(0), smallest)))?;
    let timing = correct_project_gif_tail(Path::new(&result.output_path), duration_us)?;
    result.output_frame_count = timing.frame_count;
    result.effective_output_fps =
        Some(timing.frame_count as f64 * 1_000_000.0 / timing.duration_us as f64);
    if let Some(report) = result.indexed_gif_writer_report.as_mut() {
        report.total_delay_cs = timing.duration_us / 10_000;
    }
    if timing.forced_minimum_tail {
        result.warnings.push(format!(
            "GIF 延时以 10 毫秒为单位；已保留最后一帧至少 10 毫秒，成品总时长为 {} 毫秒。",
            timing.duration_us / 1000
        ));
    }
    let probe = inspect_source(&ffprobe, Path::new(&result.output_path))?;
    if probe.width != canvas.width
        || probe.height != canvas.height
        || result.output_fps != canvas.fps
    {
        return Err(AppError::EncodeFailed(
            "工程编码改变了画布或帧率，结果未发布".into(),
        ));
    }
    result.target_size_bytes = cap;
    if cap.is_some() {
        result.status = "target_met".into();
    }
    result.target_deviation_percent =
        cap.map(|limit| (result.size_bytes as f64 / limit as f64 - 1.0) * 100.0);
    if result.attempts > 1 {
        result
            .warnings
            .push("为满足体积上限已减少调色板颜色；画布和帧率保持不变。".into());
    }
    if request.preview && !frame_preview && total_duration > duration_us {
        result
            .warnings
            .push("预览仅渲染前 15 秒；完整导出包含整个工程。".into());
    }
    let output_path = next_output_path(Path::new("GIFP-6-project"), &output_dir);
    let staged_source = PathBuf::from(&result.output_path);
    publish_file_after_owned_temp_cleanup(&staged_source, temp, &output_path, false)?;
    if let Some(directory) = preview_directory {
        let _ = directory.into_path();
    }
    result.output_path = output_path.to_string_lossy().into_owned();
    result.elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    result.input_path = format!("project:{}@{}", project.id, project.revision);
    Ok(ProjectRenderResult {
        project_id: project.id.clone(),
        revision: project.revision,
        output_path: result.output_path.clone(),
        width: canvas.width,
        height: canvas.height,
        duration_us: timing.duration_us,
        bytes: result.size_bytes,
        preview: request.preview,
        result,
    })
}

fn project_dialog_owner(window: &tauri::Window) -> Result<isize, AppError> {
    #[cfg(windows)]
    {
        let handle = window
            .hwnd()
            .map_err(|error| {
                AppError::Internal(format!("无法将工程文件选择器绑定到主窗口: {error}"))
            })?
            .0 as isize;
        if handle == 0 {
            return Err(AppError::Internal("工程文件选择器的主窗口句柄无效".into()));
        }
        Ok(handle)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err(invalid("当前工程文件选择器仅支持 Windows"))
    }
}

fn project_dialog(
    save: bool,
    default_name: &str,
    owner_hwnd: isize,
) -> Result<Option<PathBuf>, AppError> {
    #[cfg(not(windows))]
    {
        let _ = (save, default_name, owner_hwnd);
        return Err(invalid("当前工程文件选择器仅支持 Windows"));
    }
    #[cfg(windows)]
    {
        let default_name = default_name.to_owned();
        native_picker::on_sta_thread(move || {
            let kind = if save {
                native_picker::FileKind::SaveProject
            } else {
                native_picker::FileKind::OpenProject
            };
            let paths = native_picker::FilePicker::new(kind, owner_hwnd, &default_name)?.show()?;
            Ok(paths.and_then(|paths| paths.into_iter().next()))
        })
    }
}

pub(super) async fn select_media(window: tauri::Window) -> Result<Vec<String>, AppError> {
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        let owner = project_dialog_owner(&window)?;
        tauri::async_runtime::spawn_blocking(move || {
            native_picker::on_sta_thread(move || {
                let paths =
                    native_picker::FilePicker::new(native_picker::FileKind::OpenMedia, owner, "")?
                        .show()?;
                Ok(paths
                    .unwrap_or_default()
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect())
            })
        })
        .await
        .map_err(|error| AppError::Internal(format!("素材选择线程失败: {error}")))?
    }
}

pub(super) async fn select_directory(window: tauri::Window) -> Result<Option<String>, AppError> {
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(None)
    }
    #[cfg(windows)]
    {
        let owner = project_dialog_owner(&window)?;
        tauri::async_runtime::spawn_blocking(move || {
            native_picker::on_sta_thread(move || {
                native_picker::directory(owner)
                    .map(|path| path.map(|path| path.to_string_lossy().into_owned()))
            })
        })
        .await
        .map_err(|error| AppError::Internal(format!("文件夹选择线程失败: {error}")))?
    }
}

#[cfg(windows)]
mod native_picker {
    use super::*;
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, GetSaveFileNameW, FNERR_BUFFERTOOSMALL,
        OFN_ALLOWMULTISELECT, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY, OFN_NOCHANGEDIR,
        OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListEx, BIF_EDITBOX, BIF_NEWDIALOGSTYLE,
        BIF_RETURNONLYFSDIRS, BROWSEINFOW, GPFIDL_DEFAULT,
    };

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, AppError> {
            // This is a dedicated OS thread, never a reused runtime worker with
            // an unknown COM apartment. S_OK and S_FALSE both require cleanup.
            let result =
                unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
            if result < 0 {
                return Err(AppError::Internal(format!(
                    "初始化本机文件选择器失败 (HRESULT 0x{:08X})",
                    result as u32
                )));
            }
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    pub(super) fn on_sta_thread<T, F>(action: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, AppError> + Send + 'static,
    {
        std::thread::Builder::new()
            .name("gifp-native-file-picker".into())
            .spawn(move || {
                let _apartment = ComApartment::initialize()?;
                action()
            })
            .map_err(|error| io_error("启动本机文件选择器", error))?
            .join()
            .map_err(|_| AppError::Internal("本机文件选择器线程异常退出".into()))?
    }

    #[derive(Clone, Copy)]
    pub(super) enum FileKind {
        OpenProject,
        SaveProject,
        OpenMedia,
    }

    pub(super) struct FilePicker {
        kind: FileKind,
        owner: isize,
        filename: Vec<u16>,
        filter: Vec<u16>,
        title: Vec<u16>,
        extension: Vec<u16>,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    impl FilePicker {
        pub(super) fn new(
            kind: FileKind,
            owner: isize,
            default_name: &str,
        ) -> Result<Self, AppError> {
            if owner == 0 {
                return Err(AppError::Internal(
                    "本机文件选择器需要有效的主窗口句柄".into(),
                ));
            }
            if default_name.contains('\0') {
                return Err(invalid("默认文件名包含无效字符"));
            }
            let mut filename = vec![
                0_u16;
                if matches!(kind, FileKind::OpenMedia) {
                    131_072
                } else {
                    32_768
                }
            ];
            let initial = wide(default_name);
            if initial.len() > filename.len() {
                return Err(invalid("默认文件名过长"));
            }
            filename[..initial.len()].copy_from_slice(&initial);
            let (title, filter, extension) = match kind {
                FileKind::OpenProject => ("Open GIFP Project", "GIFP Project (*.gifp;*.gifp-project.json;*.json)\0*.gifp;*.gifp-project.json;*.json\0\0", "gifp"),
                FileKind::SaveProject => ("Save GIFP Project", "GIFP Project (*.gifp;*.gifp-project.json;*.json)\0*.gifp;*.gifp-project.json;*.json\0\0", "gifp"),
                FileKind::OpenMedia => ("Select videos", "Media Files (*.mp4;*.mov;*.mkv;*.webm;*.gif;*.png;*.apng;*.jpg;*.jpeg;*.webp)\0*.mp4;*.mov;*.mkv;*.webm;*.gif;*.png;*.apng;*.jpg;*.jpeg;*.webp\0\0", ""),
            };
            Ok(Self {
                kind,
                owner,
                filename,
                filter: filter.encode_utf16().collect(),
                title: wide(title),
                extension: wide(extension),
            })
        }

        pub(super) fn options(&mut self) -> OPENFILENAMEW {
            let action_flags = match self.kind {
                FileKind::SaveProject => OFN_OVERWRITEPROMPT,
                FileKind::OpenProject => OFN_FILEMUSTEXIST,
                FileKind::OpenMedia => OFN_FILEMUSTEXIST | OFN_ALLOWMULTISELECT,
            };
            OPENFILENAMEW {
                lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
                hwndOwner: self.owner as *mut c_void,
                lpstrFilter: self.filter.as_ptr(),
                nFilterIndex: 1,
                lpstrFile: self.filename.as_mut_ptr(),
                nMaxFile: self.filename.len() as u32,
                lpstrTitle: self.title.as_ptr(),
                lpstrDefExt: self.extension.as_ptr(),
                Flags: OFN_EXPLORER
                    | OFN_PATHMUSTEXIST
                    | OFN_NOCHANGEDIR
                    | OFN_HIDEREADONLY
                    | action_flags,
                ..Default::default()
            }
        }

        pub(super) fn show(mut self) -> Result<Option<Vec<PathBuf>>, AppError> {
            let mut options = self.options();
            // Every pointer in options refers to a stable heap buffer retained
            // by self for the complete modal call. hwndOwner belongs to GIFP.
            let success = unsafe {
                if matches!(self.kind, FileKind::SaveProject) {
                    GetSaveFileNameW(&mut options)
                } else {
                    GetOpenFileNameW(&mut options)
                }
            };
            // Query immediately after a failed call; zero means user cancel.
            let error = if success == 0 {
                unsafe { CommDlgExtendedError() }
            } else {
                0
            };
            if !file_dialog_completed(success != 0, error)? {
                return Ok(None);
            }
            selected_paths(&self.filename, matches!(self.kind, FileKind::OpenMedia)).map(Some)
        }
    }

    pub(super) fn file_dialog_completed(success: bool, error: u32) -> Result<bool, AppError> {
        if success {
            return Ok(true);
        }
        if error == 0 {
            return Ok(false);
        }
        if error == FNERR_BUFFERTOOSMALL {
            return Err(invalid("选中的文件过多或路径过长，请分批选择"));
        }
        Err(AppError::Internal(format!(
            "本机文件选择器失败 (CommDlgExtendedError 0x{error:04X})"
        )))
    }

    pub(super) fn selected_paths(buffer: &[u16], multiple: bool) -> Result<Vec<PathBuf>, AppError> {
        if !buffer.contains(&0) {
            return Err(invalid("本机文件选择器返回了未终止的路径"));
        }
        let parts: Vec<_> = buffer
            .split(|unit| *unit == 0)
            .take_while(|part| !part.is_empty())
            .map(OsString::from_wide)
            .collect();
        let Some(first) = parts.first() else {
            return Err(invalid("本机文件选择器未返回文件路径"));
        };
        if !multiple || parts.len() == 1 {
            return Ok(vec![PathBuf::from(first)]);
        }
        let directory = PathBuf::from(first);
        Ok(parts
            .into_iter()
            .skip(1)
            .map(|name| directory.join(name))
            .collect())
    }

    struct ShellItemList(*mut c_void);

    impl Drop for ShellItemList {
        fn drop(&mut self) {
            unsafe {
                CoTaskMemFree(self.0);
            }
        }
    }

    pub(super) fn directory_options(
        owner: isize,
        display_name: &mut [u16; 260],
        title: &[u16],
    ) -> Result<BROWSEINFOW, AppError> {
        if owner == 0 {
            return Err(AppError::Internal(
                "本机文件夹选择器需要有效的主窗口句柄".into(),
            ));
        }
        Ok(BROWSEINFOW {
            hwndOwner: owner as *mut c_void,
            pszDisplayName: display_name.as_mut_ptr(),
            lpszTitle: title.as_ptr(),
            ulFlags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX,
            ..Default::default()
        })
    }

    pub(super) fn directory(owner: isize) -> Result<Option<PathBuf>, AppError> {
        let title = wide("Select GIF output folder");
        let mut display_name = [0_u16; 260];
        let options = directory_options(owner, &mut display_name, &title)?;
        // The dialog and the PIDL are created/released on this same STA thread.
        let item = unsafe { SHBrowseForFolderW(&options) };
        if item.is_null() {
            return Ok(None);
        }
        let _item_owner = ShellItemList(item.cast());
        let mut path = vec![0_u16; 32_768];
        let success = unsafe {
            SHGetPathFromIDListEx(item, path.as_mut_ptr(), path.len() as u32, GPFIDL_DEFAULT)
        };
        if success == 0 {
            return Err(invalid("无法读取所选文件夹的文件系统路径"));
        }
        selected_paths(&path, false).map(|paths| paths.into_iter().next())
    }
}

fn save_project_to_path(
    project: EditProject,
    path: PathBuf,
) -> Result<ProjectFileResult, AppError> {
    validate_project(&project, false)?;
    if !path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("json") || extension.eq_ignore_ascii_case("gifp")
    }) {
        return Err(invalid(
            "工程文件必须使用 .gifp、.gifp-project.json 或 .json 扩展名",
        ));
    }
    let mut bytes = serde_json::to_vec_pretty(&project)
        .map_err(|err| invalid(format!("工程 JSON 编码失败: {err}")))?;
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        bytes = serde_json::to_vec(&project)
            .map_err(|err| invalid(format!("工程 JSON 编码失败: {err}")))?;
    }
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err(invalid("工程文件超过 8 MiB"));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    prepare_writable_output_directory(parent, "保存工程")?;
    let temp = OwnedTempDir::create("gifp-project-save")?;
    let staged = temp.path().join("project.json");
    let mut file = File::create(&staged).map_err(|err| io_error("创建工程暂存文件", err))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|err| io_error("写入工程暂存文件", err))?;
    drop(file);
    publish_file_atomically(&staged, &path, true)?;
    let path = fs::canonicalize(&path).unwrap_or(path);
    Ok(ProjectFileResult {
        path: path.to_string_lossy().into_owned(),
        project,
    })
}

#[tauri::command]
pub async fn save_edit_project(
    window: tauri::Window,
    project: EditProject,
    path: Option<String>,
) -> Result<Option<ProjectFileResult>, AppError> {
    let path = path.filter(|path| !path.trim().is_empty());
    // Retrieve the OS handle before entering the blocking worker; saving to an
    // existing project path remains independent of a native dialog.
    let owner = path
        .is_none()
        .then(|| project_dialog_owner(&window))
        .transpose()?;
    tauri::async_runtime::spawn_blocking(move || {
        validate_project(&project, false)?;
        let path = match path {
            Some(path) => PathBuf::from(path),
            None => {
                let safe_name: String = project
                    .name
                    .chars()
                    .filter(|ch| {
                        !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
                            && !ch.is_control()
                    })
                    .take(100)
                    .collect();
                let owner = owner
                    .ok_or_else(|| AppError::Internal("工程文件选择器缺少主窗口句柄".into()))?;
                let Some(path) = project_dialog(true, &format!("{safe_name}.gifp"), owner)? else {
                    return Ok(None);
                };
                path
            }
        };
        save_project_to_path(project, path).map(Some)
    })
    .await
    .map_err(|err| AppError::Internal(format!("保存工程线程失败: {err}")))?
}

fn read_project_from_path(path: PathBuf) -> Result<ProjectFileResult, AppError> {
    let metadata = fs::metadata(&path).map_err(|err| io_error("打开工程文件", err))?;
    if !metadata.is_file() || metadata.len() > MAX_PROJECT_BYTES {
        return Err(invalid("工程需要是不超过 8 MiB 的 JSON 文件"));
    }
    let bytes = fs::read(&path).map_err(|err| io_error("读取工程", err))?;
    let project: EditProject =
        serde_json::from_slice(&bytes).map_err(|err| invalid(format!("工程 JSON 无效: {err}")))?;
    validate_project(&project, false)?;
    Ok(ProjectFileResult {
        path: path.to_string_lossy().into_owned(),
        project,
    })
}

#[tauri::command]
pub async fn open_edit_project(
    window: tauri::Window,
) -> Result<Option<ProjectFileResult>, AppError> {
    let owner = project_dialog_owner(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = project_dialog(false, "", owner)? else {
            return Ok(None);
        };
        read_project_from_path(path).map(Some)
    })
    .await
    .map_err(|err| AppError::Internal(format!("打开工程线程失败: {err}")))?
}

#[cfg(test)]
#[path = "commands_project_tests.rs"]
mod tests;
