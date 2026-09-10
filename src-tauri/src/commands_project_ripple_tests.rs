use super::*;

fn verify_ripple_suite(
    mut fixture: serde_json::Value,
    ffmpeg: &Path,
    ffprobe: &Path,
    directory: &Path,
) -> Vec<String> {
    fs::create_dir_all(directory).expect("suite directory");
    let fps = fixture["fps"].as_u64().expect("suite fps");
    let source = directory.join("source.mov");
    let mut command = ffmpeg_command(ffmpeg);
    command
        .args(["-f", "lavfi", "-i"])
        .arg(format!("testsrc2=size=96x64:rate={fps}:duration=1"))
        .args(["-frames:v", "10", "-c:v", "rawvideo", "-pix_fmt", "rgb24"])
        .arg(&source);
    run_project_command(&mut command, "generate exact-frame ripple source").expect("source");
    let bind_source = |value: &mut serde_json::Value| {
        value["assets"][0]["path"] = serde_json::json!(source.to_string_lossy());
        serde_json::from_value::<EditProject>(value.clone()).expect("shared project contract")
    };
    let baseline = bind_source(&mut fixture["baseline"]);
    let baseline_hashes = render_hashes(&baseline, ffmpeg, ffprobe, &directory.join("baseline"));
    assert_eq!(baseline_hashes.len(), 10);
    let mut failures = Vec::new();
    let mut plain = baseline.clone();
    plain.layers = vec![serde_json::from_value(serde_json::json!({
        "kind":"media", "id":"plain-clock", "name":"Plain source", "assetId":"source",
        "startUs":0, "endUs":validate_project(&baseline, true).expect("baseline duration"),
        "visible":true, "locked":false, "width":1.0, "keyframes":[],
        "transform":{"x":0.5,"y":0.5,"scale":1.0,"rotation":0.0,"opacity":1.0}
    }))
    .expect("ordinary full-canvas media layer")];
    let plain_hashes = render_hashes(&plain, ffmpeg, ffprobe, &directory.join("plain-cfr"));
    let original_hashes = decoded_hashes(ffmpeg, &source, 96, 64);
    if plain_hashes != original_hashes {
        failures.push(format!(
            "{fps}fps: ordinary zero-offset media does not preserve source samples"
        ));
    }
    for case in fixture["cases"].as_array_mut().expect("cases") {
        let name = case["name"].as_str().expect("name").to_owned();
        let project = bind_source(&mut case["project"]);
        // Exercise durable JSON before rendering, including media offsets and freeze state.
        let saved_path = directory.join(format!("{name}.gifp"));
        save_project_to_path(project, saved_path.clone()).expect("save edited project");
        let reopened = read_project_from_path(saved_path)
            .expect("reopen edited project")
            .project;
        let hashes = render_hashes(&reopened, ffmpeg, ffprobe, &directory.join(&name));
        let expected: Vec<_> = case["expectedFrames"]
            .as_array()
            .expect("expected frames")
            .iter()
            .map(|index| baseline_hashes[index.as_u64().expect("frame index") as usize].clone())
            .collect();
        if hashes != expected {
            let different: Vec<_> = hashes
                .iter()
                .zip(&expected)
                .enumerate()
                .filter_map(|(index, (actual, wanted))| (actual != wanted).then_some(index))
                .collect();
            failures.push(format!(
                "{fps}fps {name}: differing samples {different:?}; actual/expected counts {}/{}",
                hashes.len(),
                expected.len()
            ));
        }
        let sample_dir = directory.join(format!("{name}-sample"));
        fs::create_dir_all(&sample_dir).expect("sample directory");
        let at = (4_000_000.0 / fps as f64).round() as u64;
        let preview = frame_preview_project(&reopened, at, ffmpeg, ffprobe, &sample_dir)
            .expect("precise ripple frame");
        let preview_hashes = render_hashes(
            &preview,
            ffmpeg,
            ffprobe,
            &directory.join(format!("{name}-preview")),
        );
        if preview_hashes != vec![hashes[4].clone()] {
            failures.push(format!(
                "{fps}fps {name}: precise preview differs from sample 4"
            ));
        }
    }
    failures
}

#[test]
fn native_project_ripple_from_typescript_preserves_composite_samples() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-ripple-contract").expect("temp");
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test/fixtures/project-ripple.json"))
            .expect("TypeScript fixture JSON");
    let mut failures = Vec::new();
    for suite in fixture["suites"].as_array().expect("suites") {
        let fps = suite["fps"].as_u64().expect("fps");
        failures.extend(verify_ripple_suite(
            suite.clone(),
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("fps-{fps}")),
        ));
    }
    if !failures.is_empty() {
        let preserved = temp.into_path();
        panic!(
            "{}\nDiagnostic renders preserved at {}",
            failures.join("\n"),
            preserved.display()
        );
    }
}
