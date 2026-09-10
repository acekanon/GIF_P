use serde::{Deserialize, Serialize};

/// Wire-format version for backend capability discovery.
///
/// Keep this independent from the application version. Additive fields may keep
/// the same version; incompatible enum or field changes require a new version.
pub const BACKEND_CAPABILITY_SCHEMA_VERSION: u16 = 1;
pub const ENCODE_REQUEST_SCHEMA_VERSION: u16 = 1;

/// The three stable product-level choices exposed since GIFP 3.1.
///
/// This is deliberately separate from a concrete encoder backend. The
/// orchestrator is free to resolve `BestGif` or `TargetSize` to a different
/// available backend without changing the UI contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EncodeMode {
    FastGif,
    BestGif,
    TargetSize,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    Gif,
    Webp,
    Avif,
    Apng,
    Mp4,
    Webm,
    LivePhoto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    Encoder,
    PostProcessor,
}

/// How a backend is expected to reach the user.
///
/// `Sidecar` describes a binary discovered beside the application. It does not
/// by itself grant redistribution rights; the separate license fields remain
/// authoritative for release decisions.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Distribution {
    System,
    Sidecar,
    ExternalOnly,
    BuiltIn,
}

/// Runtime availability of a backend on the current machine.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BackendStatus {
    Available {
        executable_path: Option<String>,
        version: Option<String>,
    },
    Unavailable {
        reason: String,
    },
    Planned {
        reason: String,
    },
}

impl BackendStatus {
    pub fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }
}

/// Feature flags used by the orchestrator when resolving a product mode.
///
/// These fields describe backend behavior rather than product promises. In
/// particular, `size_search_compatible` means the backend has deterministic,
/// tunable controls suitable for repeated measurement; the target-size search
/// itself belongs to the GIFP optimizer.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct BackendFeatures {
    pub gif_encoding: bool,
    pub postprocessing: bool,
    pub perceptual_quantization: bool,
    pub size_search_compatible: bool,
    pub alpha: bool,
    pub variable_frame_delays: bool,
    pub partial_frame_rectangles: bool,
    pub stdin_frame_stream: bool,
    pub palette_controls: bool,
    pub per_frame_palettes: bool,
    #[serde(default)]
    pub subtitle_overlay: bool,
    #[serde(default)]
    pub background_keying: bool,
    #[serde(default)]
    pub production_filter_chain: bool,
    #[serde(default)]
    pub production_io_chain: bool,
    #[serde(default)]
    pub screen_capture_chain: bool,
}

/// Stable capability DTO returned to the frontend.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BackendCapability {
    pub schema_version: u16,
    pub id: String,
    pub display_name: String,
    pub kind: BackendKind,
    pub status: BackendStatus,
    pub distribution: Distribution,
    pub license: String,
    pub license_notice: Option<String>,
    pub experimental: bool,
    pub user_opt_in_required: bool,
    pub modes: Vec<EncodeMode>,
    pub formats: Vec<OutputFormat>,
    pub features: BackendFeatures,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_modes_have_stable_wire_names() {
        assert_eq!(
            serde_json::to_string(&[
                EncodeMode::FastGif,
                EncodeMode::BestGif,
                EncodeMode::TargetSize,
            ])
            .expect("serialize modes"),
            r#"["fast_gif","best_gif","target_size"]"#
        );
    }

    #[test]
    fn delivery_formats_have_stable_wire_names() {
        assert_eq!(
            serde_json::to_string(&[
                OutputFormat::Gif,
                OutputFormat::Webp,
                OutputFormat::Avif,
                OutputFormat::Apng,
                OutputFormat::Mp4,
                OutputFormat::Webm,
                OutputFormat::LivePhoto,
            ])
            .expect("serialize formats"),
            r#"["gif","webp","avif","apng","mp4","webm","live_photo"]"#
        );
    }

    #[test]
    fn available_status_is_tagged_and_reports_availability() {
        let status = BackendStatus::Available {
            executable_path: Some("C:/tools/ffmpeg.exe".to_string()),
            version: Some("ffmpeg version test".to_string()),
        };
        let value = serde_json::to_value(&status).expect("serialize status");

        assert!(status.is_available());
        assert_eq!(value["state"], "available");
        assert_eq!(value["executable_path"], "C:/tools/ffmpeg.exe");
    }

    #[test]
    fn missing_optional_fields_round_trip_as_null() {
        let capability = BackendCapability {
            schema_version: BACKEND_CAPABILITY_SCHEMA_VERSION,
            id: "rust.perceptual".to_string(),
            display_name: "GIFP Rust perceptual encoder".to_string(),
            kind: BackendKind::Encoder,
            status: BackendStatus::Planned {
                reason: "scheduled for GIFP 3.2".to_string(),
            },
            distribution: Distribution::BuiltIn,
            license: "GIFP project license".to_string(),
            license_notice: None,
            experimental: true,
            user_opt_in_required: false,
            modes: vec![EncodeMode::BestGif],
            formats: vec![OutputFormat::Gif],
            features: BackendFeatures::default(),
        };

        let encoded = serde_json::to_string(&capability).expect("serialize capability");
        let decoded: BackendCapability =
            serde_json::from_str(&encoded).expect("deserialize capability");
        assert_eq!(decoded, capability);
    }
}
