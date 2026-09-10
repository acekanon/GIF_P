use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fs::File,
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
};

pub(crate) const BUILD_PROVENANCE_CONTRACT_ID: &str = "gifp.build_provenance.v1";
pub(crate) const BUILD_PROVENANCE_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct GitSnapshot {
    pub(crate) commit: Option<String>,
    pub(crate) dirty: Option<bool>,
    pub(crate) tree_hash: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct EmbeddedBuildProvenance {
    pub(crate) git_commit: Option<String>,
    pub(crate) git_dirty: Option<bool>,
    pub(crate) git_tree_hash: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct BuildProvenanceEvidence {
    pub(crate) schema_version: u16,
    pub(crate) contract_id: String,
    pub(crate) run_id: String,
    pub(crate) executor_start_sha256: String,
    pub(crate) executor_end_sha256: String,
    pub(crate) embedded_build: EmbeddedBuildProvenance,
    pub(crate) runtime_start: GitSnapshot,
    pub(crate) runtime_end: GitSnapshot,
    pub(crate) passed: bool,
    pub(crate) violations: Vec<String>,
}

pub(crate) fn valid_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn valid_object_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn git_output_bytes(repository: &Path, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

fn git_hash_bytes(repository: &Path, bytes: &[u8]) -> Option<String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["hash-object", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.as_mut()?.write_all(bytes).ok()?;
    drop(child.stdin.take());
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| valid_object_hash(value))
}

fn git_hash_paths(repository: &Path, paths: &[String]) -> Option<Vec<String>> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["hash-object", "--stdin-paths"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    {
        let stdin = child.stdin.as_mut()?;
        for path in paths {
            stdin.write_all(path.as_bytes()).ok()?;
            stdin.write_all(b"\n").ok()?;
        }
    }
    drop(child.stdin.take());
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let hashes = String::from_utf8(output.stdout)
        .ok()?
        .lines()
        .map(|value| value.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    (hashes.len() == paths.len() && hashes.iter().all(|value| valid_object_hash(value)))
        .then_some(hashes)
}

pub(crate) fn tracked_tree_snapshot(repository: &Path, commit: &str) -> Option<(String, bool)> {
    let output = git_output_bytes(repository, &["ls-files", "-v", "-z"])?;
    let mut paths = Vec::new();
    let mut flags_clean = true;
    for record in output
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
    {
        if record.len() < 3 || record[1] != b' ' || record[0] != b'H' {
            flags_clean = false;
        }
        paths.push(std::str::from_utf8(record.get(2..)?).ok()?.to_string());
    }
    if paths.is_empty() {
        return None;
    }
    let actual_hashes = git_hash_paths(repository, &paths)?;
    let tree_output =
        git_output_bytes(repository, &["ls-tree", "-r", "-z", "--full-tree", commit])?;
    let mut expected_hashes = HashMap::new();
    for record in tree_output
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
    {
        let tab = record.iter().position(|byte| *byte == b'\t')?;
        let metadata = std::str::from_utf8(&record[..tab]).ok()?;
        let mut fields = metadata.split_ascii_whitespace();
        let _mode = fields.next()?;
        let object_type = fields.next()?;
        let object_hash = fields.next()?.to_ascii_lowercase();
        if object_type != "blob" || !valid_object_hash(&object_hash) {
            continue;
        }
        let path = std::str::from_utf8(&record[tab + 1..]).ok()?.to_string();
        expected_hashes.insert(path, object_hash);
    }
    let mut canonical = Vec::new();
    let mut clean = flags_clean;
    for (relative, actual) in paths.iter().zip(actual_hashes) {
        if expected_hashes.get(relative) != Some(&actual) {
            clean = false;
        }
        canonical.extend_from_slice(relative.as_bytes());
        canonical.push(0);
        canonical.extend_from_slice(actual.as_bytes());
        canonical.push(0);
    }
    Some((git_hash_bytes(repository, &canonical)?, clean))
}

pub(crate) fn embedded_build_provenance() -> EmbeddedBuildProvenance {
    let git_commit = option_env!("GIFP_BUILD_GIT_COMMIT")
        .map(str::trim)
        .filter(|value| valid_commit(value))
        .map(str::to_string);
    let git_dirty = match option_env!("GIFP_BUILD_GIT_DIRTY").map(str::trim) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let git_tree_hash = option_env!("GIFP_BUILD_GIT_TREE_HASH")
        .map(str::trim)
        .filter(|value| valid_object_hash(value))
        .map(str::to_string);
    EmbeddedBuildProvenance {
        git_commit,
        git_dirty,
        git_tree_hash,
    }
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| {
        format!(
            "Failed to open provenance executor {}: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    // Windows console binaries commonly start the main thread with a 1 MiB
    // stack. A 1 MiB local read buffer overflows before the first fixture is
    // prepared, so keep the streaming buffer deliberately small.
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            format!(
                "Failed to hash provenance executor {}: {error}",
                path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn current_executor_sha256() -> Result<String, String> {
    let executable = env::current_exe()
        .map_err(|error| format!("Failed to resolve Quality Lab executor: {error}"))?;
    sha256_file(&executable)
}

pub(crate) fn evaluate_build_provenance(
    run_id: &str,
    runtime_start: GitSnapshot,
    runtime_end: GitSnapshot,
    executor_start_sha256: String,
    executor_end_sha256: String,
) -> BuildProvenanceEvidence {
    let embedded_build = embedded_build_provenance();
    let mut violations = Vec::new();
    let embedded_commit = embedded_build.git_commit.as_deref();
    let embedded_tree = embedded_build.git_tree_hash.as_deref();
    let start_commit = runtime_start.commit.as_deref();
    let end_commit = runtime_end.commit.as_deref();
    let start_tree = runtime_start.tree_hash.as_deref();
    let end_tree = runtime_end.tree_hash.as_deref();

    if embedded_commit.is_none() {
        violations.push("executor has no full compile-time Git commit".to_string());
    }
    if embedded_build.git_dirty != Some(false) {
        violations.push("executor was compiled from a dirty or unknown worktree".to_string());
    }
    if embedded_tree.is_none() {
        violations.push("executor has no compile-time tracked-tree hash".to_string());
    }
    if start_commit.is_none() || runtime_start.dirty.is_none() {
        violations.push("runtime start Git state is unavailable".to_string());
    } else if runtime_start.dirty != Some(false) {
        violations.push("runtime start worktree is dirty".to_string());
    }
    if end_commit.is_none() || runtime_end.dirty.is_none() {
        violations.push("runtime end Git state is unavailable".to_string());
    } else if runtime_end.dirty != Some(false) {
        violations.push("runtime end worktree is dirty".to_string());
    }
    if start_commit != end_commit || runtime_start.dirty != runtime_end.dirty {
        violations.push("runtime Git state changed while Quality Lab was running".to_string());
    }
    if start_tree.is_none() || end_tree.is_none() {
        violations.push("runtime tracked-tree hash is unavailable".to_string());
    } else if start_tree != end_tree {
        violations
            .push("runtime tracked source tree changed while Quality Lab was running".to_string());
    }
    if embedded_commit != start_commit || embedded_commit != end_commit {
        violations.push(
            "compile-time and runtime Git commits do not identify the same source".to_string(),
        );
    }
    if embedded_tree != start_tree || embedded_tree != end_tree {
        violations.push(
            "compile-time and runtime tracked trees do not identify the same source".to_string(),
        );
    }
    for (label, sha256) in [
        ("start", executor_start_sha256.as_str()),
        ("end", executor_end_sha256.as_str()),
    ] {
        if sha256.len() == 64
            && sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            continue;
        }
        violations.push(format!("Quality Lab executor {label} SHA-256 is invalid"));
    }
    if executor_start_sha256 != executor_end_sha256 {
        violations.push("Quality Lab executor changed while the run was active".to_string());
    }

    BuildProvenanceEvidence {
        schema_version: BUILD_PROVENANCE_SCHEMA_VERSION,
        contract_id: BUILD_PROVENANCE_CONTRACT_ID.to_string(),
        run_id: run_id.to_string(),
        executor_start_sha256,
        executor_end_sha256,
        embedded_build,
        runtime_start,
        runtime_end,
        passed: violations.is_empty(),
        violations,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn clean(commit: &str) -> GitSnapshot {
        GitSnapshot {
            commit: Some(commit.to_string()),
            dirty: Some(false),
            tree_hash: embedded_build_provenance()
                .git_tree_hash
                .or_else(|| Some("d".repeat(40))),
        }
    }

    #[test]
    fn runtime_state_changes_are_fail_closed() {
        let embedded = embedded_build_provenance();
        let commit = embedded.git_commit.unwrap_or_else(|| "a".repeat(40));
        let evidence = evaluate_build_provenance(
            "run",
            clean(&commit),
            clean(&"b".repeat(40)),
            "c".repeat(64),
            "c".repeat(64),
        );
        assert!(!evidence.passed);
        assert!(evidence
            .violations
            .iter()
            .any(|value| value.contains("changed while Quality Lab was running")));
    }

    #[test]
    fn dirty_runtime_end_is_fail_closed() {
        let embedded = embedded_build_provenance();
        let commit = embedded.git_commit.unwrap_or_else(|| "a".repeat(40));
        let mut end = clean(&commit);
        end.dirty = Some(true);
        let evidence =
            evaluate_build_provenance("run", clean(&commit), end, "c".repeat(64), "c".repeat(64));
        assert!(!evidence.passed);
        assert!(evidence
            .violations
            .iter()
            .any(|value| value.contains("runtime end worktree is dirty")));
    }

    #[test]
    fn current_executor_hash_is_a_valid_streamed_sha256() {
        let digest = current_executor_sha256().expect("hash current test executor");
        assert_eq!(digest.len(), 64);
        assert!(digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }

    #[test]
    fn assume_unchanged_cannot_hide_a_tracked_source_mutation() {
        let token = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "gifp-provenance-assume-unchanged-{}-{token}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create repository");
        let run = |arguments: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(arguments)
                .output()
                .expect("run git");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                arguments,
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        run(&["init", "-q"]);
        run(&["config", "user.name", "GIFP Test"]);
        run(&["config", "user.email", "gifp-test@example.invalid"]);
        fs::write(root.join("tracked.txt"), "original\n").expect("write tracked file");
        run(&["add", "tracked.txt"]);
        run(&["commit", "-q", "-m", "fixture"]);
        let commit = run(&["rev-parse", "HEAD"]);
        assert!(tracked_tree_snapshot(&root, &commit).is_some_and(|(_, clean)| clean));

        run(&["update-index", "--assume-unchanged", "tracked.txt"]);
        fs::write(root.join("tracked.txt"), "mutated\n").expect("mutate tracked file");
        assert!(tracked_tree_snapshot(&root, &commit).is_some_and(|(_, clean)| !clean));

        let _ = fs::remove_dir_all(&root);
    }
}
