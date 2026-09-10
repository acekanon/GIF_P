use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("Invalid input: {0}")]
    InvalidInput(String),
    #[error("Unsupported video: {0}")]
    UnsupportedVideo(String),
    #[error("Missing dependency: {0}")]
    MissingDependency(String),
    #[error("Decode failed: {0}")]
    DecodeFailed(String),
    #[error("Encode failed: {0}")]
    EncodeFailed(String),
    #[error("GIFP_RETRYABLE_RECORDING:{0}")]
    RetryableRecording(String),
    #[error("GIFP_TASK_CANCELLED:{0}")]
    Cancelled(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
