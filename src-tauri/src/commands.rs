use crate::core::{locate_tools, AppError};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use std::io::Write;

#[derive(Clone, Debug, Deserialize)]
pub struct GifRequest {
    pub input_path: String,
    pub output_dir: String,
    pub width: u32,
    pub fps: u32,
    pub colors: u16,
    pub dither: String,
    pub optimize_level: u8,
    pub lossy: u8,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub encoder: String,
    pub filter_style: String,
    pub loop_output: bool,
    pub crop_enabled: bool,
    pub crop_left: f64,
    pub crop_top: f64,
    pub crop_right: f64,
    pub crop_bottom: f64,
    pub deleted_frames: Vec<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GifResult {
    pub input_path: String,
    pub output_path: String,
    pub size_bytes: u64,
    pub encoder_used: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScreenRegion {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ScreenRecordRequest {
    pub output_dir: String,
    pub fps: u32,
    pub region_enabled: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub capture_backend: String,
}

#[derive(Debug)]
struct RecordingSession {
    child: Child,
    output_path: PathBuf,
    temp_dir: Option<PathBuf>,
    stop_path: Option<PathBuf>,
    fps: u32,
    backend: String,
}

static RECORDING: OnceLock<Mutex<Option<RecordingSession>>> = OnceLock::new();

fn recording_state() -> &'static Mutex<Option<RecordingSession>> {
    RECORDING.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub async fn select_videos() -> Result<Vec<String>, AppError> {
    if !cfg!(windows) {
        return Ok(Vec::new());
    }

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select videos'
$dialog.Filter = 'Video Files (*.mp4;*.mov;*.mkv;*.webm)|*.mp4;*.mov;*.mkv;*.webm'
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $dialog.FileNames | ForEach-Object { Write-Output $_ }
}
"#;

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-STA")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|err| AppError::Internal(err.to_string()))?;

    if !output.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

#[tauri::command]
pub async fn select_output_dir() -> Result<Option<String>, AppError> {
    if !cfg!(windows) {
        return Ok(None);
    }

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select GIF output folder'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
"#;

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-STA")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|err| AppError::Internal(err.to_string()))?;

    if !output.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string))
}

#[tauri::command]
pub async fn select_screen_region() -> Result<Option<ScreenRegion>, AppError> {
    if !cfg!(windows) {
        return Ok(None);
    }

    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = $bounds
$form.TopMost = $true
$form.Opacity = 0.22
$form.BackColor = [System.Drawing.Color]::Black
$form.Cursor = [System.Windows.Forms.Cursors]::Cross
$form.KeyPreview = $true

$script:start = $null
$script:current = $null
$script:done = $false
$script:cancel = $false

$form.Add_KeyDown({
  if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
    $script:cancel = $true
    $form.Close()
  }
})
$form.Add_MouseDown({
  $script:start = New-Object System.Drawing.Point($_.X, $_.Y)
  $script:current = $script:start
  $form.Invalidate()
})
$form.Add_MouseMove({
  if ($script:start -ne $null) {
    $script:current = New-Object System.Drawing.Point($_.X, $_.Y)
    $form.Invalidate()
  }
})
$form.Add_MouseUp({
  if ($script:start -ne $null) {
    $script:current = New-Object System.Drawing.Point($_.X, $_.Y)
    $script:done = $true
    $form.Close()
  }
})
$form.Add_Paint({
  if ($script:start -ne $null -and $script:current -ne $null) {
    $x = [Math]::Min($script:start.X, $script:current.X)
    $y = [Math]::Min($script:start.Y, $script:current.Y)
    $w = [Math]::Abs($script:start.X - $script:current.X)
    $h = [Math]::Abs($script:start.Y - $script:current.Y)
    $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 127, 215, 202))
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 242, 140, 152), 4)
    $_.Graphics.FillRectangle($brush, $rect)
    $_.Graphics.DrawRectangle($pen, $rect)
    $brush.Dispose()
    $pen.Dispose()
  }
})

[void]$form.ShowDialog()
if (-not $script:cancel -and $script:done -and $script:start -ne $null -and $script:current -ne $null) {
  $x = [Math]::Min($script:start.X, $script:current.X) + $bounds.X
  $y = [Math]::Min($script:start.Y, $script:current.Y) + $bounds.Y
  $w = [Math]::Abs($script:start.X - $script:current.X)
  $h = [Math]::Abs($script:start.Y - $script:current.Y)
  if ($w -ge 120 -and $h -ge 120) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output "$x,$y,$w,$h"
  }
}
"#;

    let output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-STA")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|err| AppError::Internal(err.to_string()))?;

    if !output.status.success() {
        return Err(AppError::Internal(
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return Ok(None);
    };
    let values: Vec<i32> = line
        .split(',')
        .filter_map(|part| part.trim().parse::<i32>().ok())
        .collect();
    if values.len() != 4 {
        return Ok(None);
    }

    Ok(Some(ScreenRegion {
        x: values[0],
        y: values[1],
        width: values[2].max(0) as u32,
        height: values[3].max(0) as u32,
    }))
}

#[tauri::command]
pub async fn convert_gif(request: GifRequest) -> Result<GifResult, AppError> {
    let input_text = request.input_path.trim().trim_matches(|ch| ch == '"' || ch == '\'');
    let input = Path::new(input_text);
    if !input.exists() || !input.is_file() {
        return Err(AppError::InvalidInput(format!(
            "Input file does not exist: {}",
            input.display()
        )));
    }
    if !is_video_file(input) {
        return Err(AppError::UnsupportedVideo(format!(
            "Unsupported video: {}",
            input.display()
        )));
    }

    let output_dir = if request.output_dir.trim().is_empty() {
        input.parent().unwrap_or_else(|| Path::new(".")).to_path_buf()
    } else {
        PathBuf::from(request.output_dir.trim())
    };
    fs::create_dir_all(&output_dir).map_err(|err| AppError::Internal(err.to_string()))?;

    let tools = locate_tools()?;
    let output = next_output_path(input, &output_dir);
    let encoder_used = choose_encoder(&request);
    encode_with_palette(&tools.ffmpeg, input, &output, &request, encoder_used)?;
    let size_bytes = fs::metadata(&output).map(|meta| meta.len()).unwrap_or(0);

    Ok(GifResult {
        input_path: input.to_string_lossy().to_string(),
        output_path: output.to_string_lossy().to_string(),
        size_bytes,
        encoder_used: encoder_used.to_string(),
        status: "done".to_string(),
    })
}

#[tauri::command]
pub async fn start_screen_recording(request: ScreenRecordRequest) -> Result<String, AppError> {
    let mut state = recording_state()
        .lock()
        .map_err(|_| AppError::Internal("Recording state is locked".to_string()))?;
    if state.is_some() {
        return Err(AppError::InvalidInput("Screen recording is already running".to_string()));
    }

    let tools = locate_tools()?;
    let output_dir = if request.output_dir.trim().is_empty() {
        std::env::temp_dir().join("GIF_P_recordings")
    } else {
        PathBuf::from(request.output_dir.trim())
    };
    fs::create_dir_all(&output_dir).map_err(|err| AppError::Internal(err.to_string()))?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    let output_path = output_dir.join(format!("gifp-record-{now}.mp4"));
    let fps_value = request.fps.clamp(5, 30);
    let fps = fps_value.to_string();

    if request.capture_backend == "psgrab" {
        let temp_dir = std::env::temp_dir().join(format!("gif_p_screen_{now}"));
        fs::create_dir_all(&temp_dir).map_err(|err| AppError::Internal(err.to_string()))?;
        let stop_path = temp_dir.join("stop.txt");
        let frame_pattern = temp_dir.join("frame_{0:D6}.jpg");
        let region_enabled = if request.region_enabled { "$true" } else { "$false" };
        let width = request.width.clamp(120, 3840);
        let height = request.height.clamp(120, 2160);
        let script = format!(
            r#"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$dir = '{}'
$stop = '{}'
$pattern = '{}'
$fps = {}
$region = {}
$x = {}
$y = {}
$w = {}
$h = {}
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if (-not $region) {{
  $x = $bounds.X
  $y = $bounds.Y
  $w = $bounds.Width
  $h = $bounds.Height
}}
$delay = [Math]::Max(1, [int](1000 / $fps))
$i = 0
while (-not (Test-Path -LiteralPath $stop)) {{
  $bmp = New-Object Drawing.Bitmap $w, $h
  $g = [Drawing.Graphics]::FromImage($bmp)
  try {{
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
    $name = [String]::Format($pattern, $i)
    $bmp.Save($name, [Drawing.Imaging.ImageFormat]::Jpeg)
  }} finally {{
    $g.Dispose()
    $bmp.Dispose()
  }}
  $i += 1
  Start-Sleep -Milliseconds $delay
}}
"#,
            escape_ps_path(&temp_dir),
            escape_ps_path(&stop_path),
            escape_ps_path(&frame_pattern),
            fps_value,
            region_enabled,
            request.x,
            request.y,
            width,
            height,
        );

        let mut child = Command::new("powershell")
            .arg("-NoProfile")
            .arg("-STA")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-Command")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| AppError::EncodeFailed(format!("Failed to start screenshot recording: {err}")))?;
        std::thread::sleep(std::time::Duration::from_millis(450));
        if let Ok(Some(status)) = child.try_wait() {
            return Err(AppError::EncodeFailed(format!(
                "Screenshot recording backend exited immediately ({status})."
            )));
        }
        *state = Some(RecordingSession {
            child,
            output_path: output_path.clone(),
            temp_dir: Some(temp_dir),
            stop_path: Some(stop_path),
            fps: fps_value,
            backend: "psgrab".to_string(),
        });
        return Ok(output_path.to_string_lossy().to_string());
    }

    let mut command = Command::new(&tools.ffmpeg);
    command.arg("-y").arg("-hide_banner");
    if request.capture_backend == "ddagrab" {
        let mut source = format!("ddagrab=framerate={fps}");
        if request.region_enabled {
            let width = request.width.clamp(120, 3840);
            let height = request.height.clamp(120, 2160);
            source.push_str(&format!(
                ":offset_x={}:offset_y={}:video_size={}x{}",
                request.x, request.y, width, height
            ));
        }
        command
            .arg("-f")
            .arg("lavfi")
            .arg("-i")
            .arg(source)
            .arg("-vf")
            .arg("hwdownload,format=bgra");
    } else {
        command
            .arg("-f")
            .arg("gdigrab")
            .arg("-framerate")
            .arg(&fps);
        if request.region_enabled {
            let width = request.width.clamp(120, 3840).to_string();
            let height = request.height.clamp(120, 2160).to_string();
            command
                .arg("-offset_x")
                .arg(request.x.to_string())
                .arg("-offset_y")
                .arg(request.y.to_string())
                .arg("-video_size")
                .arg(format!("{width}x{height}"));
        }
        command.arg("-i").arg("desktop");
    }

    command
        .arg("-an")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg(&output_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|err| AppError::EncodeFailed(format!("Failed to start screen recording: {err}")))?;
    std::thread::sleep(std::time::Duration::from_millis(450));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(AppError::EncodeFailed(format!(
            "Screen recording backend exited immediately ({status}). Try another recording backend."
        )));
    }
    *state = Some(RecordingSession {
        child,
        output_path: output_path.clone(),
        temp_dir: None,
        stop_path: None,
        fps: fps_value,
        backend: request.capture_backend,
    });
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn stop_screen_recording() -> Result<String, AppError> {
    let mut session = {
        let mut state = recording_state()
            .lock()
            .map_err(|_| AppError::Internal("Recording state is locked".to_string()))?;
        state
            .take()
            .ok_or_else(|| AppError::InvalidInput("No screen recording is running".to_string()))?
    };

    if session.backend == "psgrab" {
        if let Some(stop_path) = &session.stop_path {
            let _ = fs::write(stop_path, "stop");
        }
        let _ = session.child.wait();
        encode_screenshot_sequence(&session)?;
    } else {
        if let Some(stdin) = session.child.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        let _ = session.child.wait();
    }
    let size = fs::metadata(&session.output_path).map(|meta| meta.len()).unwrap_or(0);
    if !session.output_path.exists() || size < 2048 {
        return Err(AppError::EncodeFailed(
            "Screen recording did not create a usable video file. Try another recording backend."
                .to_string(),
        ));
    }
    if let Some(temp_dir) = &session.temp_dir {
        let _ = fs::remove_dir_all(temp_dir);
    }
    Ok(session.output_path.to_string_lossy().to_string())
}

fn encode_screenshot_sequence(session: &RecordingSession) -> Result<(), AppError> {
    let Some(temp_dir) = &session.temp_dir else {
        return Ok(());
    };
    let frame_count = fs::read_dir(temp_dir)
        .map_err(|err| AppError::Internal(err.to_string()))?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("jpg"))
                .unwrap_or(false)
        })
        .count();
    if frame_count < 2 {
        return Err(AppError::EncodeFailed(
            "Screenshot recording did not capture enough frames.".to_string(),
        ));
    }

    let tools = locate_tools()?;
    let pattern = temp_dir.join("frame_%06d.jpg");
    let output = Command::new(&tools.ffmpeg)
        .arg("-y")
        .arg("-hide_banner")
        .arg("-framerate")
        .arg(session.fps.to_string())
        .arg("-i")
        .arg(pattern)
        .arg("-vf")
        .arg("scale=trunc(iw/2)*2:trunc(ih/2)*2")
        .arg("-an")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-crf")
        .arg("18")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg(&session.output_path)
        .output()
        .map_err(|err| AppError::EncodeFailed(err.to_string()))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AppError::EncodeFailed(format!(
            "Failed to encode screenshot sequence: {detail}"
        )));
    }
    Ok(())
}

fn escape_ps_path(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

fn is_video_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("mp4" | "mov" | "mkv" | "webm")
    )
}

fn choose_encoder(request: &GifRequest) -> &'static str {
    match request.encoder.as_str() {
        "clean_opt" => "clean_opt",
        "pngquant_opt" => "pngquant_opt",
        "hybrid" if request.fps <= 15 && request.colors >= 96 => "pngquant_opt",
        "hybrid" => "ffmpeg_fast",
        _ => "ffmpeg_fast",
    }
}

fn encode_with_palette(
    ffmpeg: &Path,
    input: &Path,
    output: &Path,
    request: &GifRequest,
    encoder: &str,
) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let temp_dir = std::env::temp_dir().join(format!("gif_p_{now}"));
    fs::create_dir_all(&temp_dir).map_err(|err| AppError::Internal(err.to_string()))?;
    let palette = temp_dir.join("palette.png");

    let source_args = source_time_args(request);
    let palette_filter = palette_filter(request, encoder);
    let gif_filter = gif_filter(request, encoder);
    let palette_arg = palette.to_string_lossy().to_string();

    run_ffmpeg(
        ffmpeg,
        input,
        &source_args,
        &["-vf", &palette_filter, "-frames:v", "1", "-update", "1"],
        &palette,
    )?;

    let loop_value = if request.loop_output { "0" } else { "-1" };
    run_ffmpeg(
        ffmpeg,
        input,
        &source_args,
        &["-i", &palette_arg, "-lavfi", &gif_filter, "-loop", loop_value],
        output,
    )?;

    let _ = fs::remove_dir_all(&temp_dir);
    Ok(())
}

fn source_time_args(request: &GifRequest) -> Vec<String> {
    let start = request.start_seconds.max(0.0);
    let end = request.end_seconds.max(0.0);
    let mut args = Vec::new();
    if start > 0.0 {
        args.push("-ss".to_string());
        args.push(format!("{start:.3}"));
    }
    if end > start {
        args.push("-t".to_string());
        args.push(format!("{:.3}", end - start));
    }
    args
}

fn palette_filter(request: &GifRequest, encoder: &str) -> String {
    let colors = request.colors.clamp(2, 256);
    let stats_mode = if matches!(encoder, "pngquant_opt" | "clean_opt") || request.optimize_level > 3 {
        "full"
    } else {
        "diff"
    };
    format!(
        "{},palettegen=max_colors={colors}:stats_mode={stats_mode}",
        video_filter(request, encoder)
    )
}

fn gif_filter(request: &GifRequest, encoder: &str) -> String {
    let dither = dither_for(request, encoder);
    let diff_mode = if matches!(encoder, "pngquant_opt" | "clean_opt") {
        ""
    } else {
        ":diff_mode=rectangle"
    };
    format!(
        "[0:v]{filter}[x];[x][1:v]paletteuse=dither={dither}{diff_mode}:new=0",
        filter = video_filter(request, encoder),
    )
}

fn video_filter(request: &GifRequest, encoder: &str) -> String {
    let fps = request.fps.clamp(1, 60);
    let width = request.width.clamp(96, 1920);
    let scale_flag = if request.filter_style == "pixel" {
        "neighbor"
    } else {
        "lanczos"
    };
    let mut filters = vec![format!("fps={fps}")];
    if let Some(delete_filter) = deleted_frames_filter(request, fps) {
        filters.push(delete_filter);
    }
    if let Some(crop) = crop_filter(request) {
        filters.push(crop);
    }
    filters.extend(style_filters(&request.filter_style));

    if encoder == "pngquant_opt" {
        let chroma = (1.02 + f64::from(request.lossy.min(100)) / 1000.0).min(1.12);
        filters.push(format!(
            "eq=saturation={chroma:.3}:contrast=1.035:brightness=0.006"
        ));
        filters.push("hqdn3d=0.20:0.20:1.10:1.10".to_string());
        filters.push("unsharp=3:3:0.14:3:3:0".to_string());
    } else if encoder == "clean_opt" {
        filters.push("hqdn3d=1.10:0.90:4.80:3.20".to_string());
        filters.push("gradfun=strength=0.85:radius=12".to_string());
        filters.push("eq=saturation=1.035:contrast=1.015:brightness=0.004".to_string());
    }

    filters.push(format!(
        "scale={width}:-1:flags={scale_flag}:force_original_aspect_ratio=decrease"
    ));
    filters.push("format=rgba".to_string());
    filters.join(",")
}

fn crop_filter(request: &GifRequest) -> Option<String> {
    if !request.crop_enabled {
        return None;
    }
    let left = request.crop_left.clamp(0.0, 45.0);
    let top = request.crop_top.clamp(0.0, 45.0);
    let right = request.crop_right.clamp(0.0, 45.0);
    let bottom = request.crop_bottom.clamp(0.0, 45.0);
    if left + right >= 90.0 || top + bottom >= 90.0 {
        return None;
    }
    if left + top + right + bottom < 0.01 {
        return None;
    }

    let width = (100.0 - left - right) / 100.0;
    let height = (100.0 - top - bottom) / 100.0;
    let x = left / 100.0;
    let y = top / 100.0;
    Some(format!(
        "crop=w='floor(iw*{width:.4}/2)*2':h='floor(ih*{height:.4}/2)*2':x='floor(iw*{x:.4}/2)*2':y='floor(ih*{y:.4}/2)*2'"
    ))
}

fn deleted_frames_filter(request: &GifRequest, fps: u32) -> Option<String> {
    if request.deleted_frames.is_empty() {
        return None;
    }

    let start_offset = request.start_seconds.max(0.0);
    let end_limit = if request.end_seconds > start_offset {
        Some(request.end_seconds - start_offset)
    } else {
        None
    };
    let tolerance = (0.52 / f64::from(fps.max(1))).max(0.018);
    let mut times: Vec<f64> = request
        .deleted_frames
        .iter()
        .map(|time| time - start_offset)
        .filter(|time| time.is_finite() && *time >= 0.0)
        .filter(|time| end_limit.map(|end| *time <= end).unwrap_or(true))
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup_by(|a, b| (*a - *b).abs() < tolerance);
    if times.is_empty() {
        return None;
    }

    let expr = times
        .iter()
        .map(|time| {
            let from = (time - tolerance).max(0.0);
            let to = time + tolerance;
            format!("between(t\\,{from:.3}\\,{to:.3})")
        })
        .collect::<Vec<_>>()
        .join("+");
    Some(format!("select='not({expr})'"))
}

fn style_filters(style: &str) -> Vec<String> {
    match style {
        "vivid" => vec!["eq=saturation=1.18:contrast=1.06:brightness=0.01".to_string()],
        "gb" => vec![
            "hue=s=0".to_string(),
            "eq=contrast=1.14:brightness=0.02".to_string(),
            "curves=r='0/0.08 .45/.38 1/.86':g='0/.18 .55/.72 1/1':b='0/.10 .5/.28 1/.65'".to_string(),
        ],
        "gba_lcd" => vec![
            "eq=saturation=1.14:contrast=1.04:brightness=0.02".to_string(),
            "drawgrid=width=3:height=3:thickness=1:color=black@0.10".to_string(),
        ],
        "crt" => vec![
            "eq=saturation=1.08:contrast=1.10".to_string(),
            "drawgrid=width=1:height=3:thickness=1:color=black@0.18".to_string(),
            "vignette=PI/5".to_string(),
        ],
        "pixel" => vec![
            "scale=iw/2:ih/2:flags=neighbor,scale=iw*2:ih*2:flags=neighbor".to_string(),
        ],
        _ => Vec::new(),
    }
}

fn dither_for(request: &GifRequest, encoder: &str) -> &'static str {
    if encoder == "clean_opt" {
        return "none";
    }
    if encoder == "pngquant_opt" {
        return "sierra2_4a";
    }
    match request.dither.as_str() {
        "none" => "none",
        "bayer" => "bayer",
        "floyd_steinberg" => "floyd_steinberg",
        "sierra2_4a" => "sierra2_4a",
        _ => "sierra2_4a",
    }
}

fn run_ffmpeg(
    ffmpeg: &Path,
    input: &Path,
    source_args: &[String],
    extra_args: &[&str],
    output: &Path,
) -> Result<(), AppError> {
    let mut command = Command::new(ffmpeg);
    command.arg("-y").arg("-hide_banner");
    command.args(source_args);
    command.arg("-i").arg(input);
    command.args(extra_args);
    command.arg(output);

    let result = command
        .output()
        .map_err(|err| AppError::EncodeFailed(err.to_string()))?;
    if !result.status.success() {
        return Err(AppError::EncodeFailed(
            String::from_utf8_lossy(&result.stderr).to_string(),
        ));
    }
    Ok(())
}

fn next_output_path(input: &Path, output_dir: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("video");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    output_dir.join(format!("{stem}-gifp-{timestamp}.gif"))
}
