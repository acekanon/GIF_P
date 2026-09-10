use std::{
    collections::HashMap,
    env,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const UNKNOWN_COMMIT: &str = "unknown";

fn git_output_bytes(repository: &Path, arguments: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(output.stdout)
}

fn git_output(repository: &Path, arguments: &[&str]) -> Option<String> {
    String::from_utf8(git_output_bytes(repository, arguments)?)
        .ok()
        .map(|value| value.trim().to_string())
}

fn valid_object_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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

fn tracked_tree_snapshot(repository: &Path, commit: &str) -> Option<(String, bool)> {
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

fn emit_git_rerun_inputs(repository: &Path) -> bool {
    // Once any rerun-if-changed directive is emitted Cargo stops its default
    // whole-package scan. Bind the embedded provenance to the real worktree
    // HEAD/index/ref files and every tracked source input instead of a
    // manifest-relative `.git` path (which is not the worktree Git directory).
    let mut git_paths = vec![
        "HEAD".to_string(),
        "index".to_string(),
        "packed-refs".to_string(),
    ];
    if let Some(symbolic_head) =
        git_output(repository, &["symbolic-ref", "-q", "HEAD"]).filter(|value| !value.is_empty())
    {
        git_paths.push(symbolic_head);
    }
    let mut complete = true;
    for git_path in git_paths {
        if let Some(path) = git_output(
            repository,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                &git_path,
            ],
        )
        .filter(|value| !value.is_empty())
        {
            println!("cargo:rerun-if-changed={path}");
        } else {
            complete = false;
        }
    }

    let mut tracked_count = 0_usize;
    if let Some(output) = git_output_bytes(repository, &["ls-files", "-z"]) {
        for relative in output
            .split(|byte| *byte == 0)
            .filter(|value| !value.is_empty())
        {
            if let Ok(relative) = std::str::from_utf8(relative) {
                let path: PathBuf = repository.join(relative);
                println!("cargo:rerun-if-changed={}", path.display());
                tracked_count += 1;
            }
        }
    } else {
        complete = false;
    }
    complete && tracked_count > 0
}

fn valid_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn main() {
    println!("cargo:rerun-if-env-changed=GIFP_RELEASE_EXPECTED_GIT_COMMIT");
    println!("cargo:rerun-if-env-changed=GIFP_RELEASE_EXPECTED_GIT_TREE_HASH");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let repository_hint = Path::new(&manifest_dir);
    let repository_root = git_output(repository_hint, &["rev-parse", "--show-toplevel"]);
    let commit = repository_root
        .as_deref()
        .and_then(|root| git_output(Path::new(root), &["rev-parse", "HEAD"]))
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| valid_commit(value))
        .unwrap_or_else(|| UNKNOWN_COMMIT.to_string());
    let git_watch_inputs_complete = repository_root
        .as_deref()
        .is_some_and(|root| emit_git_rerun_inputs(Path::new(root)));
    let tracked_tree = repository_root
        .as_deref()
        .and_then(|root| tracked_tree_snapshot(Path::new(root), &commit));
    let status_dirty = repository_root
        .as_deref()
        .and_then(|root| {
            Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["status", "--porcelain=v1", "--untracked-files=all"])
                .output()
                .ok()
        })
        .filter(|output| output.status.success())
        .is_none_or(|output| !output.stdout.is_empty());
    let dirty = status_dirty || !tracked_tree.as_ref().is_some_and(|(_, clean)| *clean);

    if let Ok(expected) = env::var("GIFP_RELEASE_EXPECTED_GIT_COMMIT") {
        let expected = expected.trim().to_ascii_lowercase();
        assert!(
            valid_commit(&expected),
            "GIFP_RELEASE_EXPECTED_GIT_COMMIT must be a full 40-character commit"
        );
        assert_eq!(
            commit, expected,
            "release build source commit does not match GIFP_RELEASE_EXPECTED_GIT_COMMIT"
        );
        assert!(
            !dirty,
            "release build source worktree is dirty; refusing to embed ambiguous provenance"
        );
        assert!(
            git_watch_inputs_complete,
            "release build could not bind Cargo reruns to Git HEAD/index/tracked inputs"
        );
    }
    if let Ok(expected_tree) = env::var("GIFP_RELEASE_EXPECTED_GIT_TREE_HASH") {
        let expected_tree = expected_tree.trim().to_ascii_lowercase();
        assert!(
            valid_object_hash(&expected_tree),
            "GIFP_RELEASE_EXPECTED_GIT_TREE_HASH must be a full Git object hash"
        );
        assert_eq!(
            tracked_tree.as_ref().map(|(hash, _)| hash),
            Some(&expected_tree),
            "release build tracked-tree hash does not match its frozen input inventory"
        );
    }

    println!("cargo:rustc-env=GIFP_BUILD_GIT_COMMIT={commit}");
    println!(
        "cargo:rustc-env=GIFP_BUILD_GIT_DIRTY={}",
        if dirty { "true" } else { "false" }
    );
    println!(
        "cargo:rustc-env=GIFP_BUILD_GIT_TREE_HASH={}",
        tracked_tree
            .as_ref()
            .map(|(hash, _)| hash.as_str())
            .unwrap_or("unknown")
    );
    tauri_build::build()
}
