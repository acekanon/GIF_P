use super::*;

fn fixture_project(asset_path: &Path) -> EditProject {
    serde_json::from_value(serde_json::json!({
        "schemaVersion": 1, "id": "native-audit", "name": "Native audit", "revision": 7,
        "canvas": { "width": 96, "height": 64, "fps": 25, "background": "#FFFFFF" },
        "assets": [{ "id": "source", "path": asset_path.to_string_lossy(), "name": "Source", "kind": "video", "width": 96, "height": 64, "durationUs": 400000 }],
        "clips": [{ "id": "clip-0", "assetId": "source", "inUs": 0, "outUs": 400000, "rate": 1.0, "reverse": false, "holdUs": 0, "fit": "contain", "crop": { "left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0 } }],
        "layers": [], "output": { "loop": true, "maxBytes": null, "smartLossless": true }
    })).expect("fixture project contract")
}

fn test_runtime() -> Option<(PathBuf, PathBuf)> {
    let configured = env::var_os("GIFP_PROJECT_TEST_FFMPEG").map(PathBuf::from);
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../release/GIFP-5.7.27/ffmpeg.exe");
    let ffmpeg = configured.or_else(|| bundled.is_file().then_some(bundled))?;
    let ffprobe = ffmpeg.parent()?.join(if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    });
    ffprobe.is_file().then_some((ffmpeg, ffprobe))
}

fn source_fixture(ffmpeg: &Path, directory: &Path) -> PathBuf {
    let path = directory.join("source.mkv");
    let mut command = ffmpeg_command(ffmpeg);
    command.args([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x64:rate=25:duration=0.4",
    ]);
    lossless_output(&mut command, &path, 10);
    run_project_command(&mut command, "create source fixture").expect("generate source fixture");
    path
}

fn decoded_hashes(ffmpeg: &Path, path: &Path, width: usize, height: usize) -> Vec<String> {
    let output = run_project_command(
        ffmpeg_command(ffmpeg).arg("-i").arg(path).args([
            "-map",
            "0:v:0",
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "-",
        ]),
        "decode timeline hashes",
    )
    .expect("decode timeline");
    let bytes_per_frame = width * height * 3;
    assert_eq!(output.stdout.len() % bytes_per_frame, 0);
    output
        .stdout
        .chunks_exact(bytes_per_frame)
        .map(|frame| format!("{:x}", Sha256::digest(frame)))
        .collect()
}

fn render_hashes(
    project: &EditProject,
    ffmpeg: &Path,
    ffprobe: &Path,
    directory: &Path,
) -> Vec<String> {
    fs::create_dir_all(directory).expect("create render output");
    let duration = validate_project(project, true).expect("valid fixture");
    let timeline = render_timeline(
        project,
        &project.canvas,
        duration,
        ffmpeg,
        ffprobe,
        directory,
    )
    .expect("render timeline");
    decoded_hashes(
        ffmpeg,
        &timeline,
        project.canvas.width as usize,
        project.canvas.height as usize,
    )
}

#[test]
fn project_contract_roundtrips_duration_and_rejects_invalid_data() {
    let mut project = fixture_project(Path::new("missing-source.mkv"));
    project.clips[0].duration_us = Some(333_333);
    assert_eq!(
        validate_project(&project, false).expect("duration"),
        333_333
    );
    let value = serde_json::to_value(&project).expect("serialize");
    assert_eq!(value["clips"][0]["durationUs"], 333_333);
    assert_eq!(value["output"]["smartLossless"], true);
    assert!(value["canvas"].get("fps").is_some());
    project.clips[0].crop.left = 0.6;
    project.clips[0].crop.right = 0.4;
    assert!(validate_project(&project, false).is_err());
    project.clips[0].crop.left = 0.0;
    project.clips[0].crop.right = 0.0;
    project.clips[0].rate = f64::NAN;
    assert!(validate_project(&project, false).is_err());
    project.clips[0].rate = 1.0;
    project.assets.push(project.assets[0].clone());
    assert!(validate_project(&project, false).is_err());
}

#[test]
fn project_new_compression_options_are_compatible_and_reach_encoder_requests() {
    let mut project = fixture_project(Path::new("source.mkv"));
    assert!(!project.output.temporal_stability);
    assert!(!project.output.lzw_search);
    project.output.temporal_stability = true;
    project.output.lzw_search = true;
    let request = gif_request(
        &project,
        &project.canvas,
        Path::new("timeline.mkv"),
        Path::new("output"),
        400000,
        256,
    )
    .unwrap();
    assert!(request.temporal_stability && request.lzw_search);
    let value = serde_json::to_value(&project).unwrap();
    assert_eq!(value["output"]["temporalStability"], true);
    assert_eq!(value["output"]["lzwSearch"], true);
    let mut invalid = value;
    invalid["output"]["lzwSearch"] = serde_json::json!("true");
    assert!(serde_json::from_value::<EditProject>(invalid).is_err());
}

#[test]
#[ignore = "real composed project export through both new compression routes"]
fn native_project_new_compression_routes_use_composited_source() {
    let (ffmpeg, _) = test_runtime().expect("FFmpeg runtime");
    let temp = OwnedTempDir::create("gifp-project-advanced-compression").unwrap();
    let source = source_fixture(&ffmpeg, temp.path());
    let mut project = fixture_project(&source);
    project.output.smart_lossless = false;
    project.output.temporal_stability = true;
    project.output.lzw_search = true;
    let output = temp.path().join("export");
    let id = format!("advanced-project-{}", unique_output_token());
    let scope = ConversionTaskScope::register(Some(&id)).unwrap();
    scope.activate();
    let result = render_edit_project_active(ProjectRenderRequest {
        project,
        output_dir: output.to_string_lossy().into_owned(),
        task_id: id,
        preview: false,
        preview_frame_us: None,
    })
    .expect("actual project export");
    let report = result
        .result
        .advanced_compression_report
        .as_ref()
        .expect("project report");
    assert_eq!(report.reference_kind, "prequantized_source", "{report:?}");
    assert_eq!(report.stages.len(), 2);
    assert_eq!(
        (result.width, result.height, result.duration_us),
        (96, 64, 400000)
    );
    assert_eq!(
        fs::metadata(&result.output_path).unwrap().len(),
        result.bytes
    );
    println!("project: {}", serde_json::to_string(report).unwrap());
}

#[test]
fn project_frame_boundaries_do_not_accumulate_rounding() {
    for fps in [1, 12, 24, 25, 30, 59, 60] {
        for frame in 0..10_000_u64 {
            let time = (frame as f64 * 1_000_000.0 / f64::from(fps)).round() as u64;
            assert_eq!(boundary_frame(time, fps), frame, "fps {fps}, time {time}");
        }
    }
    assert_eq!(boundary_frame(33333, 30), 1);
    assert_eq!(boundary_frame(66667, 30), 2);
    assert_eq!(boundary_frame(100000, 30), 3);
}

#[test]
fn project_copied_frame_span_preserves_nominal_rate_only_for_grid_rounding() {
    let mut clip = fixture_project(Path::new("source.mov")).clips.remove(0);
    clip.out_us = 133333;
    clip.duration_us = Some(133334);
    assert_eq!(
        clip_sampling_ratio(&clip, 30),
        1.0,
        "four copied frames retain their rate at a new grid phase"
    );
    clip.duration_us = Some(133335);
    assert_eq!(
        clip_sampling_ratio(&clip, 30),
        133335.0 / 133333.0,
        "outside floor/ceil frame span remains explicit stretching"
    );
    clip.duration_us = Some(200000);
    assert_eq!(clip_sampling_ratio(&clip, 30), 200000.0 / 133333.0);
    clip.out_us = 133000;
    clip.duration_us = Some(133334);
    assert_eq!(
        clip_sampling_ratio(&clip, 30),
        133334.0 / 133000.0,
        "source interval must itself qualify as rounded whole frames"
    );
    clip.out_us = 266667;
    clip.rate = 2.0;
    assert_eq!(
        clip_sampling_ratio(&clip, 30),
        0.5,
        "source rounding is converted through playback rate"
    );
    clip.out_us = 400000;
    clip.rate = 1.0;
    clip.duration_us = Some(400001);
    assert_eq!(
        clip_sampling_ratio(&clip, 30),
        400001.0 / 400000.0,
        "an exact 12-frame span has no floor/ceil ambiguity"
    );
}

#[test]
fn project_save_is_atomic_durable_and_allows_missing_asset_relink() {
    let temp = OwnedTempDir::create("gifp-project-save-test").expect("temp");
    let path = temp.path().join("project.gifp-project.json");
    let mut project = fixture_project(Path::new("Z:/not-mounted/source.mkv"));
    save_project_to_path(project.clone(), path.clone()).expect("save missing source project");
    assert_eq!(
        read_project_from_path(path.clone())
            .expect("reopen")
            .project
            .revision,
        7
    );
    project.revision = 8;
    project.name = "单帧编辑工程".into();
    save_project_to_path(project, path.clone()).expect("replace project");
    let restored = read_project_from_path(path).expect("reopen updated project");
    assert_eq!(restored.project.name, "单帧编辑工程");
    assert_eq!(restored.project.revision, 8);
    assert_eq!(
        fs::read_dir(temp.path()).expect("list saved files").count(),
        1
    );
    let gifp_path = temp.path().join("project.gifp");
    save_project_to_path(restored.project.clone(), gifp_path.clone())
        .expect("save native gifp extension");
    assert_eq!(
        read_project_from_path(gifp_path)
            .expect("reopen gifp extension")
            .project
            .name,
        "单帧编辑工程"
    );
    assert!(save_project_to_path(restored.project, temp.path().join("source.mp4")).is_err());
}

#[cfg(windows)]
#[test]
fn native_project_picker_contract_keeps_owner_unicode_and_modal_flags() {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        OFN_ALLOWMULTISELECT, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
    };
    use windows_sys::Win32::UI::Shell::{BIF_EDITBOX, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS};
    let owner = 0x123456_isize;
    let name = "单帧工程 🐾.gifp";
    let expected_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut save =
        native_picker::FilePicker::new(native_picker::FileKind::SaveProject, owner, name)
            .expect("owned save picker");
    let save_options = save.options();
    let save_owner = save_options.hwndOwner as isize;
    let save_flags = save_options.Flags;
    assert_eq!(save_owner, owner);
    assert_ne!(save_flags & OFN_OVERWRITEPROMPT, 0);
    assert_ne!(save_flags & OFN_NOCHANGEDIR, 0);
    assert_eq!(save_flags & OFN_ALLOWMULTISELECT, 0);
    // The FilePicker remains in scope while examining its retained UTF-16 buffers.
    assert_eq!(
        unsafe { std::slice::from_raw_parts(save_options.lpstrFile, expected_name.len()) },
        expected_name
    );
    assert_eq!(
        unsafe { std::slice::from_raw_parts(save_options.lpstrDefExt, 5) },
        &[103, 105, 102, 112, 0]
    );
    let mut open = native_picker::FilePicker::new(native_picker::FileKind::OpenProject, owner, "")
        .expect("owned open picker");
    let open_options = open.options();
    assert_eq!(open_options.hwndOwner as isize, owner);
    assert_ne!(open_options.Flags & OFN_FILEMUSTEXIST, 0);
    assert_eq!(open_options.Flags & OFN_ALLOWMULTISELECT, 0);
    let expected_filter: Vec<u16> =
        "GIFP Project (*.gifp;*.gifp-project.json;*.json)\0*.gifp;*.gifp-project.json;*.json\0\0"
            .encode_utf16()
            .collect();
    assert_eq!(
        unsafe { std::slice::from_raw_parts(open_options.lpstrFilter, expected_filter.len()) },
        expected_filter
    );
    let mut media = native_picker::FilePicker::new(native_picker::FileKind::OpenMedia, owner, "")
        .expect("owned media picker");
    let media_options = media.options();
    assert_eq!(media_options.hwndOwner as isize, owner);
    assert_ne!(media_options.Flags & OFN_ALLOWMULTISELECT, 0);
    let mut display_name = [0_u16; 260];
    let folder_title: Vec<u16> = "Select GIF output folder\0".encode_utf16().collect();
    let folder = native_picker::directory_options(owner, &mut display_name, &folder_title)
        .expect("owned folder picker");
    assert_eq!(folder.hwndOwner as isize, owner);
    assert_eq!(
        folder.ulFlags,
        BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX
    );
    assert!(native_picker::FilePicker::new(native_picker::FileKind::OpenProject, 0, "").is_err());
    assert!(native_picker::directory_options(0, &mut display_name, &folder_title).is_err());
}

#[cfg(windows)]
#[test]
fn native_project_picker_distinguishes_cancel_errors_and_unicode_multiselect() {
    assert!(!native_picker::file_dialog_completed(false, 0).expect("cancel"));
    assert!(native_picker::file_dialog_completed(true, 0).expect("selected"));
    assert!(native_picker::file_dialog_completed(false, 0x3003).is_err());
    assert!(native_picker::file_dialog_completed(false, 0xffff).is_err());
    let single: Vec<u16> = "D:\\素材 文件\\动图 🐾.gif\0\0".encode_utf16().collect();
    assert_eq!(
        native_picker::selected_paths(&single, false).expect("single path"),
        vec![PathBuf::from("D:\\素材 文件\\动图 🐾.gif")]
    );
    assert_eq!(
        native_picker::selected_paths(&single, true).expect("one multi-select result"),
        vec![PathBuf::from("D:\\素材 文件\\动图 🐾.gif")]
    );
    let multiple: Vec<u16> = "D:\\素材 文件\0第一段.mp4\0第二段 🐾.gif\0\0"
        .encode_utf16()
        .collect();
    assert_eq!(
        native_picker::selected_paths(&multiple, true).expect("multiple paths"),
        vec![
            PathBuf::from("D:\\素材 文件\\第一段.mp4"),
            PathBuf::from("D:\\素材 文件\\第二段 🐾.gif")
        ]
    );
    assert!(native_picker::selected_paths(&[0], true).is_err());
    assert!(native_picker::selected_paths(&[65, 66], false).is_err());
}

#[cfg(windows)]
#[test]
fn native_project_picker_worker_uses_a_dedicated_sta_thread() {
    use windows_sys::Win32::System::Com::{CoGetApartmentType, APTTYPE_MAINSTA, APTTYPE_STA};
    let caller = std::thread::current().id();
    let (worker, apartment) = native_picker::on_sta_thread(|| {
        let mut apartment = -1;
        let mut qualifier = 0;
        let result = unsafe { CoGetApartmentType(&mut apartment, &mut qualifier) };
        if result < 0 {
            return Err(AppError::Internal(format!(
                "COM apartment probe failed: {result}"
            )));
        }
        Ok((std::thread::current().id(), apartment))
    })
    .expect("STA picker worker");
    assert_ne!(worker, caller);
    assert!(matches!(apartment, APTTYPE_STA | APTTYPE_MAINSTA));
}

#[test]
fn project_keyframes_are_linear_and_text_is_not_filter_code() {
    let layer: ProjectLayer = serde_json::from_value(serde_json::json!({
        "kind": "text", "id": "text", "name": "text", "startUs": 0, "endUs": 400000,
        "visible": true, "locked": false,
        "transform": { "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0 },
        "keyframes": [
            { "timeUs": 0, "transform": { "x": 0.1, "y": 0.3, "scale": 1.0, "rotation": 0.0, "opacity": 0.0 } },
            { "timeUs": 400000, "transform": { "x": 0.9, "y": 0.7, "scale": 2.0, "rotation": 90.0, "opacity": 1.0 } }
        ],
        "text": "{\\pos(0,0)} hello\n中文", "fontSize": 18, "color": "#FFFFFF", "strokeColor": "#000000", "strokeWidth": 1
    })).expect("text layer");
    let base = layer.base();
    assert!((key_value(base, 200000.0, |t| t.x) - 0.5).abs() < 1e-10);
    assert!((key_value(base, 200000.0, |t| t.opacity) - 0.5).abs() < 1e-10);
    let project = fixture_project(Path::new("missing.mkv"));
    let ass = text_ass(&layer, &project.canvas, &project.canvas, 10);
    assert!(ass.contains("\\{\\\\pos(0,0)\\}"));
    assert!(ass.contains("\\N中文"));
    assert_eq!(
        ass.lines()
            .filter(|line| line.starts_with("Dialogue:"))
            .count(),
        10
    );
}

#[test]
fn native_project_single_frame_edit_preserves_neighbors_duration_and_hashes() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-frames-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let project = fixture_project(&source);
    let baseline = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("whole"));
    assert_eq!(baseline.len(), 10);
    let mut isolated = project.clone();
    isolated.clips = (0..10)
        .map(|n| {
            let mut clip = project.clips[0].clone();
            clip.id = format!("frame-{n}");
            clip.in_us = n * 40000;
            clip.out_us = (n + 1) * 40000;
            clip.duration_us = Some(40000);
            clip
        })
        .collect();
    let split = render_hashes(&isolated, &ffmpeg, &ffprobe, &temp.path().join("split"));
    assert_eq!(
        split, baseline,
        "isolating every frame must not alter neighbors"
    );
    let mut deleted = isolated.clone();
    deleted.clips.remove(4);
    let removed = render_hashes(&deleted, &ffmpeg, &ffprobe, &temp.path().join("delete"));
    let mut expected_deleted = baseline.clone();
    expected_deleted.remove(4);
    assert_eq!(
        removed, expected_deleted,
        "deleting one frame must remove only its sample"
    );
    let mut duplicated = isolated.clone();
    let mut duplicate = duplicated.clips[4].clone();
    duplicate.id = "duplicate".into();
    duplicated.clips.insert(5, duplicate);
    let repeated = render_hashes(
        &duplicated,
        &ffmpeg,
        &ffprobe,
        &temp.path().join("duplicate"),
    );
    let mut expected_duplicated = baseline.clone();
    expected_duplicated.insert(5, baseline[4].clone());
    assert_eq!(repeated, expected_duplicated);
    let mut frozen = isolated.clone();
    frozen.clips[4].hold_us = 120000;
    let held = render_hashes(&frozen, &ffmpeg, &ffprobe, &temp.path().join("freeze"));
    let mut expected_held = baseline.clone();
    expected_held.splice(4..5, std::iter::repeat_n(baseline[4].clone(), 3));
    assert_eq!(held, expected_held);
    let mut reversed = project.clone();
    reversed.clips[0].reverse = true;
    let reverse = render_hashes(&reversed, &ffmpeg, &ffprobe, &temp.path().join("reverse"));
    assert_eq!(reverse, baseline.iter().rev().cloned().collect::<Vec<_>>());
    if let Ok(audit_dir) = env::var("GIFP_PROJECT_AUDIT_DIR") {
        fs::create_dir_all(&audit_dir).expect("create audit");
        fs::write(
            Path::new(&audit_dir).join("timeline-hashes.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "fps": 25, "width": 96, "height": 64,
                "baseline": baseline, "isolated": split, "deleted": removed,
                "duplicated": repeated, "frozen": held, "reversed": reverse
            }))
            .expect("audit json"),
        )
        .expect("write audit");
    }
}

#[test]
fn native_project_crop_text_and_animated_media_layers_render_real_pixels() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-layers-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let mut project = fixture_project(&source);
    let baseline = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("baseline"));
    project.clips[0].crop.left = 0.25;
    project.clips[0].crop.right = 0.25;
    project.clips[0].fit = "cover".into();
    let cropped = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("crop"));
    assert_eq!(cropped.len(), 10);
    assert_ne!(cropped, baseline);
    let base = serde_json::json!({
        "id": "caption", "name": "Caption", "startUs": 120000, "endUs": 160000,
        "visible": true, "locked": false,
        "transform": { "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 12.0, "opacity": 1.0 }, "keyframes": [],
        "kind": "text", "text": "A 单帧", "fontSize": 18,
        "color": "#FFFFFF", "strokeColor": "#000000", "strokeWidth": 2
    });
    project
        .layers
        .push(serde_json::from_value(base).expect("caption"));
    let text = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("text"));
    assert_ne!(text[3], cropped[3]);
    for index in (0..10).filter(|n| *n != 3) {
        assert_eq!(
            text[index], cropped[index],
            "single-frame text changed neighbor {index}"
        );
    }
    project.layers.push(serde_json::from_value(serde_json::json!({
        "kind": "media", "id": "pip", "name": "Animated overlay", "assetId": "source", "width": 0.3,
        "startUs": 200000, "endUs": 360000, "visible": true, "locked": false,
        "transform": { "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0 },
        "keyframes": [
            { "timeUs": 0, "transform": { "x": 0.3, "y": 0.3, "scale": 0.8, "rotation": 0.0, "opacity": 0.7 } },
            { "timeUs": 160000, "transform": { "x": 0.7, "y": 0.7, "scale": 1.2, "rotation": 25.0, "opacity": 1.0 } }
        ]
    })).expect("media layer"));
    let media = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("media"));
    assert_eq!(media.len(), 10);
    assert_eq!(&media[0..5], &text[0..5]);
    assert!(media[5..9]
        .iter()
        .zip(&text[5..9])
        .any(|(actual, previous)| actual != previous));
    assert_eq!(media[9], text[9]);
}

#[test]
fn native_project_single_frame_layers_at_30_and_60_fps_touch_only_one_sample() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-subframe-layer-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    for fps in [30, 60] {
        let mut project = fixture_project(&source);
        project.canvas.fps = fps;
        let baseline = render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("base-{fps}")),
        );
        let start = (2_000_000.0 / f64::from(fps)).round() as u64;
        let end = (3_000_000.0 / f64::from(fps)).round() as u64;
        for kind in ["text", "media"] {
            let mut value = serde_json::json!({
                "kind": kind, "id": "one-frame", "name": "Only this frame",
                "startUs": start, "endUs": end, "visible": true, "locked": false,
                "transform": { "x": 0.5, "y": 0.5, "scale": 1.0, "rotation": 0.0, "opacity": 1.0 }, "keyframes": []
            });
            if kind == "text" {
                value["text"] = serde_json::json!("FRAME");
                value["fontSize"] = serde_json::json!(20);
                value["color"] = serde_json::json!("#FFFFFF");
                value["strokeColor"] = serde_json::json!("#000000");
                value["strokeWidth"] = serde_json::json!(2);
            } else {
                value["assetId"] = serde_json::json!("source");
                value["width"] = serde_json::json!(0.5);
            }
            project.layers = vec![serde_json::from_value(value).expect("single frame layer")];
            let actual = render_hashes(
                &project,
                &ffmpeg,
                &ffprobe,
                &temp.path().join(format!("{kind}-{fps}")),
            );
            assert_eq!(actual.len(), baseline.len());
            assert_ne!(
                actual[2], baseline[2],
                "{kind} at {fps} fps did not appear on its selected frame"
            );
            for index in (0..actual.len()).filter(|index| *index != 2) {
                assert_eq!(
                    actual[index], baseline[index],
                    "{kind} at {fps} fps changed neighbor {index}"
                );
            }
        }
    }
}

#[test]
fn native_project_frame_splices_at_30_and_60_fps_preserve_source_samples() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-rational-frames-test").expect("temp");
    for fps in [30, 60] {
        // MOV carries a rational 1/fps timebase, unlike millisecond-rounded MKV.
        let source = temp.path().join(format!("source-{fps}.mov"));
        let mut command = ffmpeg_command(&ffmpeg);
        command
            .args(["-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size=96x64:rate={fps}"))
            .args(["-frames:v", "6", "-c:v", "rawvideo", "-pix_fmt", "rgb24"])
            .arg(&source);
        run_project_command(&mut command, "create rational frame source").expect("rational source");
        let boundary = |n: u64| (n as f64 * 1_000_000.0 / f64::from(fps)).round() as u64;
        let mut project = fixture_project(&source);
        project.canvas.fps = fps;
        project.assets[0].duration_us = boundary(6);
        project.clips[0].out_us = boundary(6);
        let baseline = render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("baseline-{fps}")),
        );
        assert_eq!(baseline.len(), 6);
        let source_clip = project.clips[0].clone();
        project.clips = (0..6)
            .map(|n| {
                let mut clip = source_clip.clone();
                clip.id = format!("frame-{n}");
                clip.in_us = boundary(n);
                clip.out_us = boundary(n + 1);
                clip.duration_us = Some(boundary(n + 1) - boundary(n));
                clip
            })
            .collect();
        assert_eq!(
            render_hashes(
                &project,
                &ffmpeg,
                &ffprobe,
                &temp.path().join(format!("isolated-{fps}"))
            ),
            baseline
        );
        let mut duplicate = project.clips[0].clone();
        duplicate.id = "duplicate".into();
        project.clips.insert(1, duplicate);
        for (n, clip) in project.clips.iter_mut().enumerate() {
            clip.duration_us = Some(boundary(n as u64 + 1) - boundary(n as u64));
        }
        let actual = render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("duplicated-{fps}")),
        );
        let mut expected = baseline;
        expected.insert(1, expected[0].clone());
        assert_eq!(
            actual, expected,
            "duplicate at {fps} fps changed a neighboring source sample"
        );
    }
}

#[test]
fn native_project_current_frame_preview_matches_composited_timeline_sample() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-current-frame-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let mut project = fixture_project(&source);
    project.clips[0].reverse = true;
    project.clips[0].crop.left = 0.1;
    project.clips[0].fit = "cover".into();
    let transform = serde_json::json!({"x":0.5,"y":0.5,"scale":1.0,"rotation":0.0,"opacity":1.0});
    let keyframes = serde_json::json!([
        {"timeUs":0,"transform":{"x":0.3,"y":0.3,"scale":0.8,"rotation":0.0,"opacity":0.7}},
        {"timeUs":400000,"transform":{"x":0.7,"y":0.7,"scale":1.2,"rotation":25.0,"opacity":1.0}}
    ]);
    project.layers = vec![
        serde_json::from_value(serde_json::json!({
            "kind":"text","id":"caption","name":"Animated text","startUs":0,"endUs":400000,
            "visible":true,"locked":false,"transform":transform,"keyframes":keyframes,
            "text":"帧 A","fontSize":18,"color":"#FFFFFF","strokeColor":"#000000","strokeWidth":2
        })).expect("caption"),
        serde_json::from_value(serde_json::json!({
            "kind":"media","id":"pip","name":"Animated overlay","startUs":0,"endUs":400000,
            "visible":true,"locked":false,"transform":transform,"keyframes":keyframes,"assetId":"source","width":0.3
        })).expect("media")
    ];
    let all = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("full"));
    let snapshot_dir = temp.path().join("snapshots");
    fs::create_dir_all(&snapshot_dir).expect("snapshot directory");
    let preview = frame_preview_project(&project, 120000, &ffmpeg, &ffprobe, &snapshot_dir)
        .expect("freeze project sample");
    let frame = render_hashes(&preview, &ffmpeg, &ffprobe, &temp.path().join("frame"));
    assert_eq!(
        frame,
        vec![all[3].clone()],
        "current-frame preview differs from the same edited full timeline frame"
    );
    assert_eq!(preview.revision, project.revision);
    assert_eq!(preview.id, project.id);
    assert_eq!(preview.clips.len(), 1);
    assert_eq!(preview.clips[0].hold_us, 40000);
    let reverse_boundary =
        frame_preview_project(&project, 200000, &ffmpeg, &ffprobe, &snapshot_dir)
            .expect("reverse frame-boundary preview");
    assert_eq!(
        render_hashes(
            &reverse_boundary,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("reverse-boundary")
        ),
        vec![all[5].clone()],
        "reverse preview must retain the source interval's exclusive end"
    );
}

#[test]
fn native_project_private_encode_does_not_finish_cancellable_task() {
    let id = format!("project-staging-test-{}", unique_output_token());
    let scope = ConversionTaskScope::register(Some(&id)).expect("task");
    scope.activate();
    let temp = OwnedTempDir::create("gifp-project-staging-test").expect("temp");
    let source = temp.path().join("source");
    let output = temp.path().join("private.gif");
    fs::write(&source, b"test").expect("source");
    {
        let _staging = StagingEncodeGuard::enter();
        let staged = stage_publish_file(&source, &output).expect("stage");
        finish_final_staged_publish(&staged, &output, false).expect("private publish");
    }
    assert!(cancel_conversion_task(id.clone()).expect("cancel after private encode"));
    let request = ProjectRenderRequest {
        project: fixture_project(Path::new("missing.mkv")),
        output_dir: temp.path().to_string_lossy().into_owned(),
        task_id: id,
        preview: false,
        preview_frame_us: None,
    };
    assert!(matches!(
        render_edit_project_active(request),
        Err(AppError::Cancelled(_))
    ));
    assert!(!is_staging_project_encode());
}

#[test]
fn native_project_cancellation_during_render_publishes_no_output() {
    let Some((ffmpeg, _)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-cancellation-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let mut project = fixture_project(&source);
    project.canvas.width = 1280;
    project.canvas.height = 800;
    let output_dir = temp.path().join("exports");
    let task_id = format!("project-cancel-{}", unique_output_token());
    let worker_id = task_id.clone();
    let worker_output = output_dir.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        let scope = ConversionTaskScope::register(Some(&worker_id)).expect("register worker");
        scope.activate();
        ready_tx.send(()).expect("notify registered");
        render_edit_project_active(ProjectRenderRequest {
            project,
            output_dir: worker_output.to_string_lossy().into_owned(),
            task_id: worker_id,
            preview: false,
            preview_frame_us: None,
        })
    });
    ready_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("worker registered");
    std::thread::sleep(Duration::from_millis(80));
    assert!(cancel_conversion_task(task_id).expect("cancel active rendering"));
    assert!(matches!(
        worker.join().expect("join worker"),
        Err(AppError::Cancelled(_))
    ));
    assert!(
        !output_dir.exists()
            || fs::read_dir(output_dir)
                .expect("output listing")
                .next()
                .is_none()
    );
}

/// End-to-end candidate search is deliberately opt-in because backend discovery
/// and compression have their own integration costs. Run with the shipped
/// FFmpeg directory on PATH and GIFP_RUN_PROJECT_NATIVE_AUDIT=1.
#[test]
fn native_project_final_gif_preserves_geometry_and_hard_cap_is_atomic() {
    if env::var("GIFP_RUN_PROJECT_NATIVE_AUDIT").as_deref() != Ok("1") {
        return;
    }
    let Some((ffmpeg, _)) = test_runtime() else {
        panic!("native audit requires FFmpeg");
    };
    let temp = OwnedTempDir::create("gifp-project-export-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let output_dir = temp.path().join("exports");
    let mut project = fixture_project(&source);
    let run = |project: EditProject, task_id: String| {
        let scope = ConversionTaskScope::register(Some(&task_id)).expect("task");
        scope.activate();
        render_edit_project_active(ProjectRenderRequest {
            project,
            output_dir: output_dir.to_string_lossy().into_owned(),
            task_id,
            preview: false,
            preview_frame_us: None,
        })
    };
    let result = run(
        project.clone(),
        format!("project-final-{}", unique_output_token()),
    )
    .expect("final export");
    assert_eq!((result.width, result.height), (96, 64));
    assert_eq!(result.result.output_fps, 25);
    assert!((result.duration_us as i64 - 400000).abs() <= 10000);
    assert!(Path::new(&result.output_path).is_file());
    {
        let task_id = format!("project-current-preview-{}", unique_output_token());
        let scope = ConversionTaskScope::register(Some(&task_id)).expect("preview task");
        scope.activate();
        let preview = render_edit_project_active(ProjectRenderRequest {
            project: project.clone(),
            output_dir: String::new(),
            task_id,
            preview: true,
            preview_frame_us: Some(120000),
        })
        .expect("single frame GIF preview");
        assert!(preview.preview);
        assert_eq!(preview.result.output_frame_count, 1);
        assert_eq!((preview.width, preview.height), (96, 64));
        let directory = Path::new(&preview.output_path)
            .parent()
            .expect("preview directory")
            .to_path_buf();
        OwnedTempDir::adopt(directory, "gifp-project-preview-")
            .cleanup()
            .expect("remove test preview");
    }
    let before = fs::read_dir(&output_dir).expect("exports").count();
    project.output.max_bytes = Some(1024);
    let error = run(project, format!("project-cap-{}", unique_output_token()))
        .expect_err("tiny cap should reject this detailed source");
    assert!(error.to_string().contains("无法满足"), "{error}");
    assert_eq!(
        fs::read_dir(&output_dir).expect("exports").count(),
        before,
        "failed hard cap must publish no candidate"
    );
}

#[test]
fn native_project_tail_quantization_keeps_last_frame_pixels_and_lzw() {
    let Some((ffmpeg, _)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-tail-test").expect("temp");
    for (fps, requested, original_delays, expected_cs, forced) in [
        (25, 347_000, vec![4_u16; 9], 35_u64, false),
        (30, 100_001, vec![3, 4, 3, 3], 11, true),
        (60, 50_001, vec![2, 1, 2, 2], 6, true),
    ] {
        let path = temp.path().join(format!("tail-{fps}.gif"));
        let mut encoder = gif::Encoder::new(
            File::create(&path).expect("gif"),
            96,
            64,
            &[0, 0, 0, 255, 255, 255],
        )
        .expect("encoder");
        encoder.set_repeat(gif::Repeat::Infinite).expect("loop");
        for (n, delay) in original_delays.iter().enumerate() {
            let mut pixels = vec![0_u8; 96 * 64];
            pixels[n..n + 200].fill(1);
            encoder
                .write_frame(&gif::Frame {
                    width: 96,
                    height: 64,
                    delay: *delay,
                    dispose: gif::DisposalMethod::Keep,
                    buffer: std::borrow::Cow::Owned(pixels),
                    ..gif::Frame::default()
                })
                .expect("write frame");
        }
        encoder.into_inner().expect("finish gif");
        let before = gif_timing_snapshot(&path).expect("before timing");
        let bytes_before = fs::read(&path).expect("before bytes");
        let before_frames = decoded_hashes(&ffmpeg, &path, 96, 64);
        let corrected = correct_project_gif_tail(&path, requested).expect("correct tail");
        let after = gif_timing_snapshot(&path).expect("after timing");
        let bytes_after = fs::read(&path).expect("after bytes");
        assert_eq!(corrected.duration_us, expected_cs * 10000);
        assert_eq!(corrected.frame_count, original_delays.len() as u64);
        assert_eq!(corrected.forced_minimum_tail, forced);
        assert_eq!(after.non_timing_sha256, before.non_timing_sha256);
        assert_eq!(after.bytes, before.bytes);
        assert_eq!(decoded_hashes(&ffmpeg, &path, 96, 64), before_frames);
        let delay_offset = before.delays.last().expect("last delay").0 as usize;
        for (offset, (original, actual)) in bytes_before.iter().zip(bytes_after.iter()).enumerate()
        {
            if offset != delay_offset && offset != delay_offset + 1 {
                assert_eq!(actual, original, "changed non-delay byte at {offset}");
            }
        }
        assert!(after.delays.last().expect("last delay").1 >= 1);
    }
}

#[test]
fn native_project_partial_347ms_export_reports_corrected_gif_duration() {
    if env::var("GIFP_RUN_PROJECT_NATIVE_AUDIT").as_deref() != Ok("1") {
        return;
    }
    let Some((ffmpeg, _)) = test_runtime() else {
        panic!("native audit requires FFmpeg");
    };
    let temp = OwnedTempDir::create("gifp-project-partial-export-test").expect("temp");
    let source = source_fixture(&ffmpeg, temp.path());
    let mut project = fixture_project(&source);
    project.clips[0].out_us = 347000;
    let task_id = format!("project-partial-{}", unique_output_token());
    let scope = ConversionTaskScope::register(Some(&task_id)).expect("task");
    scope.activate();
    let result = render_edit_project_active(ProjectRenderRequest {
        project,
        output_dir: temp.path().join("exports").to_string_lossy().into_owned(),
        task_id,
        preview: false,
        preview_frame_us: None,
    })
    .expect("partial last-frame export");
    let timing = gif_timing_snapshot(Path::new(&result.output_path)).expect("published timing");
    assert_eq!(result.duration_us, 350000);
    assert_eq!(result.result.output_frame_count, 9);
    assert_eq!(
        timing
            .delays
            .iter()
            .map(|(_, delay)| u64::from(*delay))
            .sum::<u64>(),
        35
    );
    assert_eq!(timing.delays.last().expect("last frame").1, 3);
    assert!((result.result.effective_output_fps.expect("actual fps") - 9.0 / 0.35).abs() < 1e-9);
}

fn media_clock_layer(start: u64, end: u64, offset: u64, frozen: bool) -> ProjectLayer {
    serde_json::from_value(serde_json::json!({
        "kind":"media", "id":format!("clock-{start}-{end}-{offset}-{frozen}"), "name":"Source clock",
        "startUs":start,"endUs":end,"visible":true,"locked":false,
        "transform":{"x":0.5,"y":0.5,"scale":1.0,"rotation":0.0,"opacity":1.0},"keyframes":[],
        "assetId":"source","width":1.0,"sourceOffsetUs":offset,"sourceFrozen":frozen
    })).expect("media source clock")
}

#[test]
fn project_media_source_clock_and_editing_roundtrip_preserve_legacy_defaults() {
    let temp = OwnedTempDir::create("gifp-project-source-clock-save-test").expect("temp");
    let mut legacy = fixture_project(Path::new("missing-source.mkv"));
    assert!(legacy.editing.is_none());
    let mut old_layer =
        serde_json::to_value(media_clock_layer(0, 400000, 0, false)).expect("legacy layer");
    old_layer
        .as_object_mut()
        .expect("layer object")
        .remove("sourceOffsetUs");
    old_layer
        .as_object_mut()
        .expect("layer object")
        .remove("sourceFrozen");
    legacy.layers = vec![serde_json::from_value(old_layer).expect("old layer remains readable")];
    assert!(matches!(
        &legacy.layers[0],
        ProjectLayer::Media {
            source_offset_us,
            source_frozen: false,
            ..
        } if *source_offset_us == 0.0
    ));
    let mut current = legacy.clone();
    current.layers = vec![media_clock_layer(0, 400000, 86000000000, true)];
    current.editing = Some(ProjectEditing {
        layer_timing: LayerTiming::Ripple,
    });
    let path = temp.path().join("source-clock.gifp");
    save_project_to_path(current.clone(), path.clone()).expect("save source clock fields");
    let restored = read_project_from_path(path)
        .expect("restore source clock")
        .project;
    assert!(matches!(
        &restored.layers[0],
        ProjectLayer::Media {
            source_offset_us,
            source_frozen: true,
            ..
        } if *source_offset_us == 86000000000.0
    ));
    assert!(matches!(
        restored.editing,
        Some(ProjectEditing {
            layer_timing: LayerTiming::Ripple
        })
    ));
    let mut invalid_project = serde_json::to_value(&current).expect("project json");
    invalid_project["editing"]["layerTiming"] = serde_json::json!("unknown");
    assert!(serde_json::from_value::<EditProject>(invalid_project).is_err());
    current.layers = vec![media_clock_layer(0, 400000, 86400000001, false)];
    assert!(validate_project(&current, false).is_err());
    assert_eq!(
        media_source_time(200000.0, false, 120000, None, Some(240000)),
        80000.0
    );
    assert_eq!(
        media_source_time(360000.0, true, 120000, None, Some(240000)),
        120000.0
    );
    let unit_slope = [
        MediaTimePoint {
            time_us: 0,
            source_us: 0.5,
        },
        MediaTimePoint {
            time_us: 300000000,
            source_us: 300000000.5,
        },
    ];
    assert_eq!(
        media_clock_at(0.0, false, 30100000.0, Some(&unit_slope)),
        30100000.5
    );
    let integral_ratio = [
        MediaTimePoint {
            time_us: 0,
            source_us: 100000.5,
        },
        MediaTimePoint {
            time_us: 99999999,
            source_us: 90100000.5,
        },
    ];
    assert_eq!(
        media_clock_at(0.0, false, 33333333.0, Some(&integral_ratio)),
        30100000.5
    );
    current.layers = vec![media_clock_layer(0, 400000, 0, false)];
    if let ProjectLayer::Media {
        source_offset_us,
        source_time_map,
        raster_scale_max,
        ..
    } = &mut current.layers[0]
    {
        *source_offset_us = 42.125;
        *source_time_map = Some(vec![
            MediaTimePoint {
                time_us: 0,
                source_us: 42.125,
            },
            MediaTimePoint {
                time_us: 400000,
                source_us: 400042.125,
            },
        ]);
        *raster_scale_max = Some(1.2);
    }
    let map_path = temp.path().join("mapped-source.gifp");
    save_project_to_path(current.clone(), map_path.clone()).expect("save fractional map");
    let mapped = read_project_from_path(map_path)
        .expect("reopen map")
        .project;
    assert_eq!(
        serde_json::to_value(&mapped).unwrap()["layers"][0]["sourceOffsetUs"],
        42.125
    );
    assert_eq!(
        serde_json::to_value(&mapped).unwrap()["layers"][0]["sourceTimeMap"][1]["sourceUs"],
        400042.125
    );
    assert_eq!(
        serde_json::to_value(&mapped).unwrap()["layers"][0]["rasterScaleMax"],
        1.2
    );
    if let ProjectLayer::Media { source_frozen, .. } = &mut current.layers[0] {
        *source_frozen = true;
    }
    assert!(
        validate_project(&current, false).is_err(),
        "frozen and time map cannot coexist"
    );
    current.layers = vec![media_clock_layer(0, 400000, 0, false)];
    if let ProjectLayer::Media { base, .. } = &mut current.layers[0] {
        let mut pose = base.transform.clone();
        pose.x = 0.75;
        pose.scale = 1.8;
        base.transform_samples = Some(vec![
            LayerKeyframe {
                time_us: 0,
                transform: pose.clone(),
            },
            LayerKeyframe {
                time_us: 400000,
                transform: pose,
            },
        ]);
        assert_eq!(
            key_value(base, 200000.0, |pose| pose.x),
            0.75,
            "samples override authored/base poses"
        );
        assert_eq!(
            transform_points(base)
                .iter()
                .map(|key| key.transform.scale)
                .fold(base.transform.scale, f64::max),
            1.8
        );
    }
    let pose_path = temp.path().join("pose-samples.gifp");
    save_project_to_path(current.clone(), pose_path.clone()).expect("save pose samples");
    let posed = read_project_from_path(pose_path)
        .expect("reopen pose samples")
        .project;
    assert_eq!(
        serde_json::to_value(&posed).unwrap()["layers"][0]["transformSamples"][0]["transform"]
            ["scale"],
        1.8
    );
    if let ProjectLayer::Media { base, .. } = &mut current.layers[0] {
        base.transform_samples.as_mut().unwrap()[1].time_us = 0;
    }
    assert!(
        validate_project(&current, false).is_err(),
        "sample times must strictly increase and cover the layer"
    );
}

#[test]
fn native_project_media_source_clock_preserves_offsets_repeats_freezes_and_preview() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-source-clock-test").expect("temp");
    let raw_path = temp.path().join("six-colors.rgb");
    let colors: [[u8; 3]; 6] = [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
    ];
    let mut pixels = Vec::with_capacity(96 * 64 * 3 * colors.len());
    for color in colors {
        for _ in 0..96 * 64 {
            pixels.extend_from_slice(&color);
        }
    }
    fs::write(&raw_path, pixels).expect("multicolor raw fixture");
    let source = temp.path().join("six-colors.mov");
    let mut command = ffmpeg_command(&ffmpeg);
    command
        .args([
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "96x64",
            "-framerate",
            "25",
            "-i",
        ])
        .arg(&raw_path)
        .args(["-c:v", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "6"])
        .arg(&source);
    run_project_command(&mut command, "create media source clock fixture")
        .expect("six-color source");
    let original = decoded_hashes(&ffmpeg, &source, 96, 64);
    assert_eq!(original.len(), 6);
    let mut project = fixture_project(&source);
    project.assets[0].duration_us = 240000;
    project.clips[0].out_us = 240000;
    project.layers = vec![media_clock_layer(0, 240000, 80000, false)];
    let offset = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("offset"));
    assert_eq!(
        offset,
        [2, 3, 4, 5, 0, 1].map(|index| original[index].clone())
    );
    let snapshot_dir = temp.path().join("snapshots");
    fs::create_dir_all(&snapshot_dir).expect("snapshots");
    let preview = frame_preview_project(&project, 160000, &ffmpeg, &ffprobe, &snapshot_dir)
        .expect("offset frame preview");
    assert_eq!(
        render_hashes(
            &preview,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("offset-preview")
        ),
        vec![offset[4].clone()]
    );
    project.layers = vec![media_clock_layer(0, 240000, 60000, false)];
    assert_eq!(
        render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("between-source-frames")
        ),
        [1, 2, 3, 4, 5, 0].map(|index| original[index].clone())
    );
    project.layers = vec![
        media_clock_layer(0, 80000, 40000, false),
        media_clock_layer(80000, 160000, 40000, false),
        media_clock_layer(160000, 240000, 120000, false),
    ];
    assert_eq!(
        render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("duplicated-pieces")
        ),
        [1, 2, 1, 2, 3, 4].map(|index| original[index].clone())
    );
    project.layers = vec![media_clock_layer(0, 240000, 360000, true)];
    let held = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("frozen"));
    assert_eq!(held, vec![original[3].clone(); 6]);
    let preview = frame_preview_project(&project, 80000, &ffmpeg, &ffprobe, &snapshot_dir)
        .expect("frozen frame preview");
    assert_eq!(
        render_hashes(
            &preview,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("frozen-preview")
        ),
        vec![held[2].clone()]
    );
    project.editing = Some(ProjectEditing {
        layer_timing: LayerTiming::Absolute,
    });
    assert_eq!(
        render_hashes(
            &project,
            &ffmpeg,
            &ffprobe,
            &temp.path().join("absolute-setting")
        ),
        held,
        "editing preference itself must not change rendering"
    );
}

#[test]
fn native_project_media_map_preserves_30_60_frame_phase_at_100ms_source_boundary() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-clock-boundary-test").expect("temp");
    let raw = temp.path().join("colors.rgb");
    let mut pixels = Vec::new();
    for color in [[255u8, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]] {
        for _ in 0..96 * 64 {
            pixels.extend_from_slice(&color);
        }
    }
    fs::write(&raw, pixels).expect("raw fixture");
    let source = temp.path().join("ten-fps.mov");
    let mut command = ffmpeg_command(&ffmpeg);
    command
        .args([
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgb24",
            "-video_size",
            "96x64",
            "-framerate",
            "10",
            "-i",
        ])
        .arg(&raw)
        .args(["-c:v", "rawvideo", "-pix_fmt", "rgb24", "-frames:v", "4"])
        .arg(&source);
    run_project_command(&mut command, "create 100ms boundary source").expect("fixture");
    for (fps, original_offset) in [(30, 33333u64), (60, 66666u64)] {
        let boundary = |n: u64| (n as f64 * 1_000_000.0 / f64::from(fps)).round() as u64;
        let mut original = fixture_project(&source);
        original.canvas.fps = fps;
        original.layers = vec![media_clock_layer(0, 400000, original_offset, false)];
        let baseline = render_hashes(
            &original,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("original-{fps}")),
        );
        let mut edited = original.clone();
        let duration = 400000 - boundary(1);
        edited.clips[0].duration_us = Some(duration);
        edited.layers = vec![media_clock_layer(
            0,
            duration,
            original_offset + boundary(1),
            false,
        )];
        let naive = render_hashes(
            &edited,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("naive-{fps}")),
        );
        assert_ne!(
            naive,
            baseline[1..],
            "fixture must expose the integer-offset phase error"
        );
        let count = boundary_frame(duration, fps);
        let mut points = (0..count)
            .map(|n| MediaTimePoint {
                time_us: boundary(n),
                source_us: (original_offset + boundary(n + 1)) as f64,
            })
            .collect::<Vec<_>>();
        points.push(MediaTimePoint {
            time_us: duration,
            source_us: (original_offset + 400000) as f64,
        });
        if let ProjectLayer::Media {
            source_time_map, ..
        } = &mut edited.layers[0]
        {
            *source_time_map = Some(points);
        }
        let mapped = render_hashes(
            &edited,
            &ffmpeg,
            &ffprobe,
            &temp.path().join(format!("mapped-{fps}")),
        );
        assert_eq!(
            mapped,
            baseline[1..],
            "mapped phase must retain every surviving source sample at {fps}fps"
        );
        let snapshots = temp.path().join(format!("snapshots-{fps}"));
        fs::create_dir_all(&snapshots).unwrap();
        let preview = frame_preview_project(&edited, boundary(1), &ffmpeg, &ffprobe, &snapshots)
            .expect("mapped preview");
        assert_eq!(
            render_hashes(
                &preview,
                &ffmpeg,
                &ffprobe,
                &temp.path().join(format!("preview-{fps}"))
            ),
            vec![mapped[1].clone()]
        );
    }
}

#[test]
fn native_project_media_frozen_preview_normalizes_nonzero_source_pts() {
    let Some((ffmpeg, ffprobe)) = test_runtime() else {
        return;
    };
    let temp = OwnedTempDir::create("gifp-project-clock-origin-test").expect("temp");
    let ordinary = source_fixture(&ffmpeg, temp.path());
    let shifted = temp.path().join("offset-pts.mkv");
    let mut command = ffmpeg_command(&ffmpeg);
    command
        .arg("-i")
        .arg(&ordinary)
        .args(["-c", "copy", "-output_ts_offset", "10"])
        .arg(&shifted);
    run_project_command(&mut command, "create nonzero PTS fixture").expect("shifted source");
    let info = inspect_source(&ffprobe, &shifted).expect("probe origin");
    assert!((info.start_time_us - 10_000_000.0).abs() < 1.0);
    let expected = decoded_hashes(&ffmpeg, &ordinary, 96, 64);
    let mut project = fixture_project(&shifted);
    project.layers = vec![media_clock_layer(0, 400000, 80000, true)];
    let full = render_hashes(&project, &ffmpeg, &ffprobe, &temp.path().join("full"));
    assert_eq!(full, vec![expected[2].clone(); 10]);
    let snapshots = temp.path().join("snapshots");
    fs::create_dir_all(&snapshots).unwrap();
    let preview = frame_preview_project(&project, 120000, &ffmpeg, &ffprobe, &snapshots)
        .expect("nonzero PTS preview");
    assert_eq!(
        render_hashes(&preview, &ffmpeg, &ffprobe, &temp.path().join("preview")),
        vec![full[3].clone()]
    );
}

#[path = "commands_project_ripple_tests.rs"]
mod ripple_contract;
