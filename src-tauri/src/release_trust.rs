use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseTrustStatus {
    Verified,
    Blocked,
    Unverified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseContext {
    Development,
    Packaged,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeIntegrityStatus {
    Verified,
    Failed,
    Unverified,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReleaseTrustReport {
    pub schema_version: u32,
    pub context: ReleaseContext,
    pub status: ReleaseTrustStatus,
    pub manifest_path: String,
    pub manifest_found: bool,
    pub expected_product_version: String,
    pub reported_product_version: Option<String>,
    pub product_version_matches: Option<bool>,
    pub actual_executable_name: String,
    pub reported_executable_name: Option<String>,
    pub executable_name_matches: Option<bool>,
    pub actual_executable_sha256: Option<String>,
    pub reported_executable_sha256: Option<String>,
    pub executable_sha256_matches: Option<bool>,
    pub source_dirty: Option<bool>,
    pub channel: Option<String>,
    pub signature_status: Option<String>,
    pub signature_trusted: Option<bool>,
    pub public_release_blockers: Vec<String>,
    pub runtime_integrity_status: RuntimeIntegrityStatus,
    pub runtime_files_checked: usize,
    pub runtime_failures: Vec<String>,
    pub reasons: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DistributionManifest {
    product: ManifestProduct,
    source: ManifestSource,
    application: ManifestApplication,
    #[serde(default)]
    public_release_blockers: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestProduct {
    version: String,
    channel: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSource {
    dirty: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestApplication {
    file_name: String,
    sha256: String,
    product_version: String,
    signature_status: String,
}

struct ReleaseFacts<'a> {
    manifest_path: &'a Path,
    executable_name: &'a str,
    executable_sha256: Option<&'a str>,
    expected_version: &'a str,
    manifest_json: Option<&'a str>,
    manifest_read_error: Option<&'a str>,
}

fn normalize_hash(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn is_trusted_signature(status: &str) -> bool {
    status.eq_ignore_ascii_case("valid")
}

fn evaluate_release_trust(facts: ReleaseFacts<'_>) -> ReleaseTrustReport {
    let mut report = ReleaseTrustReport {
        schema_version: 1,
        context: ReleaseContext::Development,
        status: ReleaseTrustStatus::Unverified,
        manifest_path: facts.manifest_path.to_string_lossy().into_owned(),
        manifest_found: facts.manifest_json.is_some() || facts.manifest_read_error.is_some(),
        expected_product_version: facts.expected_version.to_owned(),
        reported_product_version: None,
        product_version_matches: None,
        actual_executable_name: facts.executable_name.to_owned(),
        reported_executable_name: None,
        executable_name_matches: None,
        actual_executable_sha256: facts.executable_sha256.map(str::to_owned),
        reported_executable_sha256: None,
        executable_sha256_matches: None,
        source_dirty: None,
        channel: None,
        signature_status: None,
        signature_trusted: None,
        public_release_blockers: Vec::new(),
        runtime_integrity_status: RuntimeIntegrityStatus::Unverified,
        runtime_files_checked: 0,
        runtime_failures: Vec::new(),
        reasons: Vec::new(),
    };

    if let Some(error) = facts.manifest_read_error {
        report.context = ReleaseContext::Packaged;
        report
            .reasons
            .push(format!("DISTRIBUTION.json could not be read: {error}"));
        return report;
    }

    let Some(manifest_json) = facts.manifest_json else {
        report.reasons.push(
            "No adjacent DISTRIBUTION.json; this is treated as a development build.".to_owned(),
        );
        return report;
    };
    report.context = ReleaseContext::Packaged;

    let manifest: DistributionManifest = match serde_json::from_str(manifest_json) {
        Ok(value) => value,
        Err(error) => {
            report
                .reasons
                .push(format!("DISTRIBUTION.json is invalid: {error}"));
            return report;
        }
    };

    let reported_version = manifest.product.version.trim().to_owned();
    let application_version = manifest.application.product_version.trim();
    let version_matches =
        reported_version == facts.expected_version && application_version == facts.expected_version;
    let name_matches = manifest
        .application
        .file_name
        .eq_ignore_ascii_case(facts.executable_name);
    let reported_hash = normalize_hash(&manifest.application.sha256);
    let hash_matches = facts
        .executable_sha256
        .map(|actual| normalize_hash(actual) == reported_hash)
        .unwrap_or(false);
    let signature_trusted = is_trusted_signature(&manifest.application.signature_status);
    let channel_supported = matches!(
        manifest.product.channel.as_str(),
        "internal" | "public-alpha" | "public"
    );

    report.reported_product_version = Some(reported_version);
    report.product_version_matches = Some(version_matches);
    report.reported_executable_name = Some(manifest.application.file_name);
    report.executable_name_matches = Some(name_matches);
    report.reported_executable_sha256 = Some(reported_hash);
    report.executable_sha256_matches = Some(hash_matches);
    report.source_dirty = Some(manifest.source.dirty);
    report.channel = Some(manifest.product.channel.clone());
    report.signature_status = Some(manifest.application.signature_status);
    report.signature_trusted = Some(signature_trusted);
    report.public_release_blockers = manifest.public_release_blockers;

    if !version_matches {
        report
            .reasons
            .push("Product version does not match this application build.".to_owned());
    }
    if !name_matches {
        report
            .reasons
            .push("Executable file name does not match the distribution record.".to_owned());
    }
    if !hash_matches {
        report
            .reasons
            .push("Executable SHA256 does not match the distribution record.".to_owned());
    }
    if !channel_supported {
        report
            .reasons
            .push("Distribution channel is not recognized.".to_owned());
    }

    if !version_matches || !name_matches || !hash_matches || !channel_supported {
        return report;
    }

    if manifest.source.dirty {
        report
            .reasons
            .push("The release was built from a dirty source tree.".to_owned());
    }
    if !signature_trusted {
        report
            .reasons
            .push("The recorded Authenticode signature is not valid.".to_owned());
    }
    if !report.public_release_blockers.is_empty() {
        report.reasons.push(format!(
            "{} public release blocker(s) remain.",
            report.public_release_blockers.len()
        ));
    }

    report.status = if manifest.source.dirty
        || !signature_trusted
        || !report.public_release_blockers.is_empty()
    {
        ReleaseTrustStatus::Blocked
    } else {
        ReleaseTrustStatus::Verified
    };
    report
}

#[derive(Debug, PartialEq, Eq)]
struct RuntimeIntegrityResult {
    status: RuntimeIntegrityStatus,
    files_checked: usize,
    failures: Vec<String>,
}

fn is_safe_relative_path(value: &str) -> bool {
    if value.is_empty()
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\0')
        || value.contains(':')
    {
        return false;
    }
    let normalized = value.replace('\\', "/");
    normalized
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

fn runtime_inventory_entry(line: &str) -> Option<(&str, &str)> {
    let separator = line.find(char::is_whitespace)?;
    let hash = &line[..separator];
    let path = line[separator..].trim_start();
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) || path.is_empty() {
        return None;
    }
    Some((hash, path))
}

fn is_media_runtime_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or_default();
    name.eq_ignore_ascii_case("ffmpeg.exe")
        || name.eq_ignore_ascii_case("ffprobe.exe")
        || name.to_ascii_lowercase().ends_with(".dll")
}

fn verify_runtime_integrity<F>(
    inventory_text: Result<&str, String>,
    mut read_hash: F,
) -> RuntimeIntegrityResult
where
    F: FnMut(&str) -> Result<String, String>,
{
    let inventory_text = match inventory_text {
        Ok(value) => value,
        Err(error) => {
            return RuntimeIntegrityResult {
                status: RuntimeIntegrityStatus::Failed,
                files_checked: 0,
                failures: vec![format!("FILES-SHA256.txt could not be read: {error}")],
            };
        }
    };

    let mut files_checked = 0;
    let mut failures = Vec::new();
    let mut ffmpeg_found = false;
    let mut ffprobe_found = false;
    let mut seen = std::collections::HashSet::new();

    for (index, line) in inventory_text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some((expected_hash, relative_path)) = runtime_inventory_entry(trimmed) else {
            if trimmed.to_ascii_lowercase().contains(".dll")
                || trimmed.to_ascii_lowercase().contains("ffmpeg.exe")
                || trimmed.to_ascii_lowercase().contains("ffprobe.exe")
            {
                failures.push(format!(
                    "Invalid runtime inventory entry on line {}.",
                    index + 1
                ));
            }
            continue;
        };
        if !is_media_runtime_path(relative_path) {
            continue;
        }
        files_checked += 1;
        let normalized_key = relative_path.replace('\\', "/").to_ascii_lowercase();
        if !seen.insert(normalized_key) {
            failures.push(format!("Duplicate runtime inventory path: {relative_path}"));
            continue;
        }
        if !is_safe_relative_path(relative_path) {
            failures.push(format!("Unsafe runtime inventory path: {relative_path}"));
            continue;
        }

        let file_name = relative_path
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        ffmpeg_found |= file_name.eq_ignore_ascii_case("ffmpeg.exe");
        ffprobe_found |= file_name.eq_ignore_ascii_case("ffprobe.exe");

        match read_hash(relative_path) {
            Ok(actual_hash) if normalize_hash(&actual_hash) == normalize_hash(expected_hash) => {}
            Ok(_) => failures.push(format!("Runtime SHA256 mismatch: {relative_path}")),
            Err(error) => failures.push(format!(
                "Runtime file unavailable: {relative_path} ({error})"
            )),
        }
    }

    if !ffmpeg_found {
        failures.push("Runtime inventory does not contain ffmpeg.exe.".to_owned());
    }
    if !ffprobe_found {
        failures.push("Runtime inventory does not contain ffprobe.exe.".to_owned());
    }

    RuntimeIntegrityResult {
        status: if failures.is_empty() {
            RuntimeIntegrityStatus::Verified
        } else {
            RuntimeIntegrityStatus::Failed
        },
        files_checked,
        failures,
    }
}

fn apply_runtime_integrity(report: &mut ReleaseTrustReport, result: RuntimeIntegrityResult) {
    report.runtime_integrity_status = result.status;
    report.runtime_files_checked = result.files_checked;
    report.runtime_failures = result.failures;
    if report.runtime_integrity_status == RuntimeIntegrityStatus::Failed {
        report.status = ReleaseTrustStatus::Blocked;
        report.reasons.push(format!(
            "Media runtime integrity failed with {} issue(s).",
            report.runtime_failures.len()
        ));
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub fn get_release_trust() -> ReleaseTrustReport {
    let expected_version = env!("CARGO_PKG_VERSION");
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return evaluate_release_trust(ReleaseFacts {
                manifest_path: Path::new("DISTRIBUTION.json"),
                executable_name: "",
                executable_sha256: None,
                expected_version,
                manifest_json: None,
                manifest_read_error: Some(&format!(
                    "Current executable could not be located: {error}"
                )),
            });
        }
    };
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let manifest_path = executable
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("DISTRIBUTION.json");
    let executable_hash = sha256_file(&executable);

    let mut report = match fs::read_to_string(&manifest_path) {
        Ok(json) => evaluate_release_trust(ReleaseFacts {
            manifest_path: &manifest_path,
            executable_name,
            executable_sha256: executable_hash.as_deref().ok(),
            expected_version,
            manifest_json: Some(&json),
            manifest_read_error: executable_hash.as_ref().err().map(String::as_str),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            evaluate_release_trust(ReleaseFacts {
                manifest_path: &manifest_path,
                executable_name,
                executable_sha256: executable_hash.as_deref().ok(),
                expected_version,
                manifest_json: None,
                manifest_read_error: None,
            })
        }
        Err(error) => evaluate_release_trust(ReleaseFacts {
            manifest_path: &manifest_path,
            executable_name,
            executable_sha256: executable_hash.as_deref().ok(),
            expected_version,
            manifest_json: None,
            manifest_read_error: Some(&error.to_string()),
        }),
    };

    if report.manifest_found {
        let package_root = executable.parent().unwrap_or_else(|| Path::new("."));
        let inventory_path = package_root.join("FILES-SHA256.txt");
        let inventory_text = fs::read_to_string(&inventory_path);
        let runtime_result = verify_runtime_integrity(
            inventory_text.as_deref().map_err(|error| error.to_string()),
            |relative_path| sha256_file(&package_root.join(relative_path.replace('\\', "/"))),
        );
        apply_runtime_integrity(&mut report, runtime_result);
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn manifest(overrides: &str) -> String {
        format!(
            r#"{{
              "product": {{ "version": "5.7.18", "channel": "public-alpha" }},
              "source": {{ "dirty": false }},
              "application": {{
                "fileName": "GIFP.exe", "sha256": "{HASH}",
                "productVersion": "5.7.18", "signatureStatus": "Valid"
              }},
              "publicReleaseBlockers": {overrides}
            }}"#
        )
    }

    fn facts<'a>(json: Option<&'a str>) -> ReleaseFacts<'a> {
        ReleaseFacts {
            manifest_path: Path::new("C:/GIFP/DISTRIBUTION.json"),
            executable_name: "gifp.exe",
            executable_sha256: Some(HASH),
            expected_version: "5.7.18",
            manifest_json: json,
            manifest_read_error: None,
        }
    }

    #[test]
    fn missing_manifest_is_a_safe_development_report() {
        let report = evaluate_release_trust(facts(None));
        assert_eq!(report.context, ReleaseContext::Development);
        assert_eq!(report.status, ReleaseTrustStatus::Unverified);
        assert!(!report.manifest_found);
    }

    #[test]
    fn verifies_matching_clean_signed_release() {
        let json = manifest("[]");
        let report = evaluate_release_trust(facts(Some(&json)));
        assert_eq!(report.context, ReleaseContext::Packaged);
        assert_eq!(report.status, ReleaseTrustStatus::Verified);
        assert_eq!(report.executable_name_matches, Some(true));
        assert_eq!(report.executable_sha256_matches, Some(true));
        assert!(report.reasons.is_empty());
    }

    #[test]
    fn identity_mismatch_is_unverified() {
        let json = manifest("[]").replace(HASH, &"b".repeat(64));
        let report = evaluate_release_trust(facts(Some(&json)));
        assert_eq!(report.status, ReleaseTrustStatus::Unverified);
        assert_eq!(report.executable_sha256_matches, Some(false));
    }

    #[test]
    fn release_policy_blockers_are_reported() {
        let json = manifest(r#"["QUALITY_EVIDENCE_REQUIRED"]"#)
            .replace("\"dirty\": false", "\"dirty\": true")
            .replace("\"Valid\"", "\"NotSigned\"");
        let report = evaluate_release_trust(facts(Some(&json)));
        assert_eq!(report.status, ReleaseTrustStatus::Blocked);
        assert_eq!(report.source_dirty, Some(true));
        assert_eq!(report.signature_trusted, Some(false));
        assert_eq!(
            report.public_release_blockers,
            vec!["QUALITY_EVIDENCE_REQUIRED"]
        );
    }

    #[test]
    fn malformed_manifest_does_not_panic() {
        let report = evaluate_release_trust(facts(Some("not json")));
        assert_eq!(report.status, ReleaseTrustStatus::Unverified);
        assert!(report.manifest_found);
        assert_eq!(report.context, ReleaseContext::Packaged);
    }

    #[test]
    fn runtime_inventory_verifies_required_binaries_and_dlls() {
        let inventory =
            format!("{HASH}  ffmpeg.exe\n{HASH}  ffprobe.exe\n{HASH}  runtime/codec.dll\n");
        let result = verify_runtime_integrity(Ok(&inventory), |_| Ok(HASH.to_owned()));
        assert_eq!(result.status, RuntimeIntegrityStatus::Verified);
        assert_eq!(result.files_checked, 3);
        assert!(result.failures.is_empty());
    }

    #[test]
    fn runtime_inventory_blocks_missing_and_tampered_files() {
        let inventory =
            format!("{HASH}  ffmpeg.exe\n{HASH}  ffprobe.exe\n{HASH}  runtime/codec.dll\n");
        let result = verify_runtime_integrity(Ok(&inventory), |path| match path {
            "ffmpeg.exe" => Err("not found".to_owned()),
            "runtime/codec.dll" => Ok("b".repeat(64)),
            _ => Ok(HASH.to_owned()),
        });
        assert_eq!(result.status, RuntimeIntegrityStatus::Failed);
        assert_eq!(result.files_checked, 3);
        assert_eq!(result.failures.len(), 2);

        let json = manifest("[]");
        let mut report = evaluate_release_trust(facts(Some(&json)));
        apply_runtime_integrity(&mut report, result);
        assert_eq!(report.status, ReleaseTrustStatus::Blocked);
        assert_eq!(
            report.runtime_integrity_status,
            RuntimeIntegrityStatus::Failed
        );
        assert_eq!(report.runtime_failures.len(), 2);
    }

    #[test]
    fn runtime_inventory_rejects_unsafe_paths_without_reading_them() {
        let inventory =
            format!("{HASH}  ffmpeg.exe\n{HASH}  ffprobe.exe\n{HASH}  ../outside.dll\n");
        let mut read_paths = Vec::new();
        let result = verify_runtime_integrity(Ok(&inventory), |path| {
            read_paths.push(path.to_owned());
            Ok(HASH.to_owned())
        });
        assert_eq!(result.status, RuntimeIntegrityStatus::Failed);
        assert_eq!(read_paths, vec!["ffmpeg.exe", "ffprobe.exe"]);
        assert!(result.failures[0].contains("Unsafe"));
    }
}
