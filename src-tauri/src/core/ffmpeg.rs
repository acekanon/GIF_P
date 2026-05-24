use std::{
    env,
    path::PathBuf,
    process::Command,
};

use super::AppError;

#[derive(Clone, Debug)]
pub struct FfmpegTools {
    pub ffmpeg: PathBuf,
}

pub fn locate_tools() -> Result<FfmpegTools, AppError> {
    let ffmpeg = locate_binary("ffmpeg")?;
    Ok(FfmpegTools { ffmpeg })
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
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
    }

    if command_is_available(&exe_name) {
        return Ok(PathBuf::from(exe_name));
    }

    Err(AppError::MissingDependency(format!(
        "{name} was not found. Install FFmpeg and make sure it is available on PATH."
    )))
}

fn command_is_available(command: &str) -> bool {
    Command::new(command)
        .arg("-version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}
