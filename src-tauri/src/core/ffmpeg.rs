use crate::commands::ConversionCommandExt;
use crate::webp_container::probe_webp_animation_path;
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

use super::AppError;

pub fn locate_ffmpeg() -> Result<PathBuf, AppError> {
    locate_binary("ffmpeg")
}

pub fn locate_ffprobe() -> Result<PathBuf, AppError> {
    locate_binary("ffprobe")
}

/// Pin finite animation demuxing before an input is added.
///
/// Animated WebP uses a different FFmpeg demuxer from static WebP. WebP-only
/// options are added only after the RIFF header has been identified as an
/// animation, so ordinary still images keep FFmpeg's automatic image demuxing.
#[cfg(test)]
fn apply_animation_demux_policy(command: &mut Command, input: &Path) {
    command.args(animation_demux_args(input));
}

pub fn animation_demux_args(input: &Path) -> &'static [&'static str] {
    let extension = input
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("gif") => &["-ignore_loop", "1"],
        Some("webp") if probe_webp_animation_path(input).unwrap_or(false) => &[
            "-f",
            "webp_anim",
            "-ignore_loop",
            "1",
            "-min_delay",
            "0",
            "-default_delay",
            "100",
            "-max_webp_delay",
            "16777215",
            "-usebgcolor",
            "0",
        ],
        _ => &[],
    }
}

fn locate_binary(name: &str) -> Result<PathBuf, AppError> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    if let Ok(current_exe) = env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            for candidate in [
                dir.join(&exe_name),
                dir.join("bin").join(&exe_name),
                dir.join("sidecars").join(&exe_name),
            ] {
                if candidate.is_file() && command_is_available(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }

    if command_is_available(&PathBuf::from(&exe_name)) {
        return Ok(PathBuf::from(exe_name));
    }

    Err(AppError::MissingDependency(format!(
        "{name} was not found. Install FFmpeg and make sure it is available on PATH."
    )))
}

fn command_is_available(command: &std::path::Path) -> bool {
    Command::new(command)
        .arg("-version")
        .output_for_conversion_task()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn args_for_path(path: &Path) -> Vec<String> {
        let mut command = Command::new("ffmpeg");
        apply_animation_demux_policy(&mut command, path);
        command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect()
    }

    fn args_for(path: &str) -> Vec<String> {
        args_for_path(Path::new(path))
    }

    fn vp8x_probe_fixture(flags: u8) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        bytes.extend_from_slice(&10_u32.to_le_bytes());
        bytes.extend_from_slice(&[flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let riff_size = u32::try_from(bytes.len() - 8).unwrap();
        bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
        bytes
    }

    #[test]
    fn does_not_apply_animation_options_to_unclassified_webp() {
        assert!(args_for("timeline.WeBp").is_empty());
    }

    #[test]
    fn pins_ffmpeg_9_options_only_for_confirmed_animated_webp() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("gifp-webp-demux-{}-{unique}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let animated = root.join("animated.webp");
        let still = root.join("still.webp");
        std::fs::write(&animated, vp8x_probe_fixture(0x02)).unwrap();
        std::fs::write(&still, vp8x_probe_fixture(0x00)).unwrap();

        assert_eq!(
            args_for_path(&animated),
            [
                "-f",
                "webp_anim",
                "-ignore_loop",
                "1",
                "-min_delay",
                "0",
                "-default_delay",
                "100",
                "-max_webp_delay",
                "16777215",
                "-usebgcolor",
                "0",
            ]
        );
        assert!(args_for_path(&still).is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_gif_finite_without_webp_only_options() {
        assert_eq!(args_for("timeline.gif"), ["-ignore_loop", "1"]);
        assert!(args_for("timeline.mp4").is_empty());
    }
}
