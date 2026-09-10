use super::*;

#[test]
fn new_compression_flags_reject_non_gif_before_source_access() {
    for (temporal, lzw) in [(true, false), (false, true), (true, true)] {
        let mut request = tests::request_with_speed(1.0);
        request.output_format = "webp".into();
        request.temporal_stability = temporal;
        request.lzw_search = lzw;
        let error = convert_animation_unprofiled(request).unwrap_err();
        assert!(matches!(error, AppError::InvalidInput(_)));
        assert!(error.to_string().contains("GIF"));
    }
}

#[test]
#[ignore = "real FFmpeg production export; run with GIFP_FFMPEG_DIR"]
fn native_export_invokes_new_routes_with_processed_source_reference() {
    let ffmpeg = locate_ffmpeg().expect("FFmpeg runtime");
    let temp = OwnedTempDir::create("gifp-advanced-integration").expect("temp");
    let input = temp.path().join("source.mkv");
    let source = Command::new(&ffmpeg)
        .args([
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=128x96:rate=12:duration=1",
            "-c:v",
            "ffv1",
            "-pix_fmt",
            "bgr0",
        ])
        .arg(&input)
        .output_for_conversion_task()
        .expect("source process");
    assert!(source.status.success());
    let original_hash = Sha256::digest(fs::read(&input).unwrap());
    for (name, speed, crop) in [("plain", 1.0, false), ("processed", 2.0, true)] {
        let output = temp.path().join(name);
        fs::create_dir_all(&output).unwrap();
        let mut request = tests::request_with_speed(speed);
        request.input_path = input.to_string_lossy().into_owned();
        request.output_dir = output.to_string_lossy().into_owned();
        request.width = 96;
        request.fps = 12;
        request.colors = 64;
        request.encoder = "ffmpeg_fast".into();
        request.generation_mode = "fast_gif".into();
        request.filter_style = if crop { "vivid" } else { "none" }.into();
        request.start_seconds = 0.0;
        request.end_seconds = 1.0;
        request.crop_enabled = crop;
        request.crop_left = if crop { 10.0 } else { 0.0 };
        request.crop_right = 0.0;
        request.crop_top = 0.0;
        request.crop_bottom = 0.0;
        request.temporal_stability = true;
        request.lzw_search = true;
        let result = convert_animation_unprofiled(request).expect("production export");
        let report = result
            .advanced_compression_report
            .as_ref()
            .expect("real report");
        assert_eq!(
            report.reference_kind, "prequantized_source",
            "{name}: {report:?}"
        );
        assert_eq!(report.stages.len(), 2);
        assert_eq!(report.stages[0].method, "temporal_stability");
        assert_eq!(report.stages[1].method, "lzw_cost_search");
        assert!(report.after_bytes <= report.before_bytes);
        assert_eq!(
            fs::metadata(&result.output_path).unwrap().len(),
            result.size_bytes
        );
        assert_eq!(result.output_width, 96);
        assert_eq!(result.output_fps, 12);
        println!("{name}: {}", serde_json::to_string(report).unwrap());
    }
    assert_eq!(Sha256::digest(fs::read(input).unwrap()), original_hash);
}
