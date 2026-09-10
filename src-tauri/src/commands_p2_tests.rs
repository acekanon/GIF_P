//! Real-process A/B pilot, kept separate from the canonical Quality Lab corpus.
use super::*;
use serde_json::json;

#[derive(Deserialize)]
struct PilotManifest {
    schema_version: u16,
    corpus_id: String,
    fixtures: Vec<PilotFixture>,
}

#[derive(Deserialize)]
struct PilotFixture {
    id: String,
    input: String,
    filter: String,
    pixel_format: String,
    width: u32,
    fps: u32,
    duration: f64,
    caption: bool,
    alpha: bool,
    tags: Vec<String>,
}

fn pilot_manifest() -> PilotManifest {
    serde_json::from_str(include_str!("../../bench/p2-sticker-manifest.json")).unwrap()
}

fn prepare_fixture(ffmpeg: &Path, folder: &Path, fixture: &PilotFixture) -> PathBuf {
    let input = folder.join(format!("{}.mkv", fixture.id));
    let output = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
        .arg(&fixture.input)
        .arg("-vf")
        .arg(&fixture.filter)
        .args(["-c:v", "ffv1", "-pix_fmt"])
        .arg(&fixture.pixel_format)
        .arg(&input)
        .output()
        .expect("create fixture");
    assert!(
        output.status.success(),
        "{}: {}",
        fixture.id,
        String::from_utf8_lossy(&output.stderr)
    );
    input
}

fn request_for_fixture(
    input: &Path,
    folder: &Path,
    fixture: &PilotFixture,
    mode: &str,
) -> GifRequest {
    serde_json::from_value(json!({
        "schema_version": ENCODE_REQUEST_SCHEMA_VERSION,
        "input_path": input, "output_dir": folder,
        "width": fixture.width, "fps": fixture.fps, "colors": 128,
        "dither": "sierra2_4a", "optimize_level": 3, "lossy": 24,
        "start_seconds": 0.0, "end_seconds": fixture.duration,
        "encoder": "ffmpeg_fast", "filter_style": "none", "loop_output": true,
        "crop_enabled": false, "crop_left": 0.0, "crop_top": 0.0,
        "crop_right": 0.0, "crop_bottom": 0.0, "deleted_frames": [],
        "generation_mode": mode, "target_max_attempts": 6,
        "target_constraint": "hard_cap", "perceptual_focus": if fixture.caption { "text_ui" } else { "auto" },
        "meme_overlay": fixture.caption.then(|| json!({
            "top_text": "收到！", "bottom_text": "小字也要清楚", "style": "classic",
            "font_size": 32, "text_align": "center", "position": "split"
        }))
    })).unwrap()
}

fn measured_export(request: GifRequest, limit: usize) -> (GifResult, u64) {
    let task_scope = ConversionTaskScope::register(None).unwrap();
    task_scope.activate();
    let started = Instant::now();
    let result = convert_animation_with_cache_limit(request, limit).expect("pilot export");
    let wall_us = started.elapsed().as_micros() as u64;
    let profile = result
        .pipeline_profile
        .as_ref()
        .expect("pipeline measurement");
    let accounted: u64 = profile.stages.iter().map(|stage| stage.elapsed_us).sum();
    assert!(accounted <= profile.elapsed_us);
    assert!(profile.elapsed_us - accounted <= profile.stages.len() as u64);
    assert!(profile.palette_cache.retained_bytes <= limit);
    (result, wall_us)
}

#[test]
fn p2_corpus_covers_caption_alpha_lowlight_and_portrait_without_external_media() {
    let manifest = pilot_manifest();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.fixtures.len(), 4);
    let mut ids = HashSet::new();
    for fixture in &manifest.fixtures {
        assert!(ids.insert(&fixture.id));
        assert!(fixture.width >= 32 && fixture.width <= 320);
        assert!(fixture.duration <= 3.0 && fixture.duration > 0.0);
        assert!(!fixture.filter.is_empty());
    }
    assert!(manifest.fixtures.iter().any(|fixture| fixture.caption));
    assert!(manifest.fixtures.iter().any(|fixture| fixture.alpha));
    for tag in [
        "low-light",
        "portrait",
        "periodic-loop",
        "small-text",
        "thin-lines",
    ] {
        assert!(manifest
            .fixtures
            .iter()
            .any(|fixture| fixture.tags.iter().any(|value| value == tag)));
    }
}

#[test]
fn p2_palette_reuse_is_limited_to_gif_target_search() {
    let fixture = &pilot_manifest().fixtures[0];
    let mut request = request_for_fixture(
        Path::new("source.mkv"),
        Path::new("."),
        fixture,
        "target_size",
    );
    assert_eq!(palette_cache_limit_for(&request), PALETTE_CACHE_LIMIT_BYTES);
    request.output_format = "webp".into();
    assert_eq!(palette_cache_limit_for(&request), 0);
    request.output_format = "gif".into();
    for mode in ["fast_gif", "best_gif"] {
        request.generation_mode = mode.into();
        assert_eq!(palette_cache_limit_for(&request), 0);
    }
}

#[test]
#[ignore = "requires real FFmpeg; run in release with GIFP_P2_REPORT_PATH set"]
fn p2_real_palette_cache_and_pipeline_pilot() {
    let ffmpeg = locate_ffmpeg().expect("locate FFmpeg");
    let executable = if ffmpeg.is_file() {
        ffmpeg.clone()
    } else {
        let name = if cfg!(windows) {
            ffmpeg.with_extension("exe")
        } else {
            ffmpeg.clone()
        };
        env::split_paths(&env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(&name))
            .find(|candidate| candidate.is_file())
            .expect("resolve FFmpeg PATH alias for provenance")
    };
    let ffmpeg_sha256 = format!("{:x}", Sha256::digest(fs::read(executable).unwrap()));
    let report_path =
        PathBuf::from(env::var_os("GIFP_P2_REPORT_PATH").expect("set GIFP_P2_REPORT_PATH"));
    let parent = report_path.parent().unwrap();
    fs::create_dir_all(parent).unwrap();
    let work = parent.join(format!(
        "media-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir(&work).unwrap();
    let manifest = pilot_manifest();
    let mut rows = Vec::new();
    let mut total_hits = 0;
    for fixture in &manifest.fixtures {
        let input = prepare_fixture(&ffmpeg, &work, fixture);
        let input_sha = format!("{:x}", Sha256::digest(fs::read(&input).unwrap()));
        // Warm runtime discovery and derive a known deliverable cap at these exact dimensions/FPS.
        let (warmup, _) =
            measured_export(request_for_fixture(&input, &work, fixture, "fast_gif"), 0);
        let cap = warmup.size_bytes.max(1024);
        for mode in ["fast_gif", "best_gif", "target_size"] {
            let mut request = request_for_fixture(&input, &work, fixture, mode);
            if mode == "target_size" {
                request.target_size_bytes = Some(cap);
            }
            let optimized_limit = palette_cache_limit_for(&request);
            for round in 0..3 {
                // Alternate order to reduce systematic warm-cache/order bias.
                let (baseline, optimized) = if round % 2 == 0 {
                    let baseline = measured_export(request.clone(), 0);
                    let optimized = measured_export(request.clone(), optimized_limit);
                    (baseline, optimized)
                } else {
                    let optimized = measured_export(request.clone(), optimized_limit);
                    let baseline = measured_export(request.clone(), 0);
                    (baseline, optimized)
                };
                let (baseline_result, baseline_wall_us) = baseline;
                let (optimized_result, optimized_wall_us) = optimized;
                let baseline_path = Path::new(&baseline_result.output_path);
                let optimized_path = Path::new(&optimized_result.output_path);
                let baseline_bytes = fs::read(baseline_path).unwrap();
                let optimized_bytes = fs::read(optimized_path).unwrap();
                assert_eq!(
                    baseline_bytes, optimized_bytes,
                    "{} {mode} round {round}: file bytes changed",
                    fixture.id
                );
                assert_eq!(
                    read_gif_timeline_contract(baseline_path, true).unwrap(),
                    read_gif_timeline_contract(optimized_path, true).unwrap()
                );
                assert_eq!(optimized_result.output_width, fixture.width);
                assert_eq!(optimized_result.output_fps, fixture.fps);
                if mode == "target_size" {
                    assert!(optimized_result.size_bytes <= cap);
                }
                let rgba = decode_media_rgba(&ffmpeg, optimized_path).expect("decode final GIF");
                assert!(!rgba.is_empty());
                let has_transparency = rgba.chunks_exact(4).any(|pixel| pixel[3] < 255);
                assert_eq!(
                    has_transparency, fixture.alpha,
                    "{}: alpha contract",
                    fixture.id
                );
                let hits = optimized_result
                    .pipeline_profile
                    .as_ref()
                    .unwrap()
                    .palette_cache
                    .hits;
                total_hits += hits;
                println!(
                    "P2 {} {mode} round {round}: {} -> {} ms, hits={hits}, identical {} bytes",
                    fixture.id,
                    baseline_wall_us / 1000,
                    optimized_wall_us / 1000,
                    optimized_bytes.len()
                );
                rows.push(json!({
                    "fixture": fixture.id, "tags": fixture.tags, "source_sha256": input_sha,
                    "mode": mode, "round": round, "first": if round % 2 == 0 { "baseline" } else { "optimized" },
                    "baseline_wall_us": baseline_wall_us, "optimized_wall_us": optimized_wall_us,
                    "bytes_identical": true, "output_sha256": format!("{:x}", Sha256::digest(&optimized_bytes)),
                    "decoded_rgba_sha256": format!("{:x}", Sha256::digest(&rgba)),
                    "baseline": baseline_result, "optimized": optimized_result
                }));
                fs::write(
                    &report_path,
                    serde_json::to_vec_pretty(&json!({
                        "status": "in_progress", "corpus_id": manifest.corpus_id, "rows": rows
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
        }
    }
    assert!(
        total_hits > 0,
        "pilot must exercise reuse, not merely compare cache misses"
    );
    fs::write(report_path, serde_json::to_vec_pretty(&json!({
        "schema_version": 1, "status": "passed", "corpus_id": manifest.corpus_id,
        "build_profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "manifest_sha256": format!("{:x}", Sha256::digest(include_bytes!("../../bench/p2-sticker-manifest.json"))),
        "ffmpeg_sha256": ffmpeg_sha256,
        "executor_sha256": format!("{:x}", Sha256::digest(fs::read(env::current_exe().unwrap()).unwrap())),
        "commands_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("commands.rs"))),
        "pipeline_source_sha256": format!("{:x}", Sha256::digest(include_bytes!("export_pipeline.rs"))),
        "palette_cache_limit_bytes": PALETTE_CACHE_LIMIT_BYTES, "cache_hits": total_hits,
        "scope": "synthetic paired regression pilot; identical file bytes; not a first-tier claim",
        "rows": rows
    })).unwrap()).unwrap();
}

#[test]
#[ignore = "requires real FFmpeg"]
fn p2_real_palette_cache_separates_source_windows_and_transforms() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let work = OwnedTempDir::create("gifp-p2-cache-contract").unwrap();
    let fixture = pilot_manifest().fixtures.remove(0);
    let input = prepare_fixture(&ffmpeg, work.path(), &fixture);
    let task_id = format!("p2-cache-contract-{}", std::process::id());
    let task_scope = ConversionTaskScope::register(Some(&task_id)).unwrap();
    task_scope.activate();
    let scope = PipelineScope::start(PALETTE_CACHE_LIMIT_BYTES);
    let base = "scale=160:-1,palettegen=max_colors=128";
    let changed = "scale=160:-1,negate,palettegen=max_colors=128";
    let a = work.path().join("a.png");
    let b = work.path().join("b.png");
    let c = work.path().join("c.png");
    let d = work.path().join("d.png");
    generate_palette_cached(&ffmpeg, &input, &[], base, &a).unwrap();
    generate_palette_cached(&ffmpeg, &input, &[], base, &b).unwrap();
    generate_palette_cached(&ffmpeg, &input, &[], changed, &c).unwrap();
    generate_palette_cached(&ffmpeg, &input, &["-t".into(), "0.4".into()], base, &d).unwrap();
    assert_eq!(fs::read(&a).unwrap(), fs::read(b).unwrap());
    assert_ne!(fs::read(c).unwrap(), fs::read(d).unwrap());
    let replacement = prepare_fixture(&ffmpeg, work.path(), &pilot_manifest().fixtures[2]);
    fs::copy(replacement, &input).unwrap();
    let changed_source = work.path().join("changed-source.png");
    generate_palette_cached(&ffmpeg, &input, &[], base, &changed_source).unwrap();
    assert_ne!(fs::read(a).unwrap(), fs::read(changed_source).unwrap());
    let cache = scope.report().palette_cache;
    assert_eq!(cache.hits, 1);
    assert_eq!(cache.misses, 4);
    assert!(cache.retained_bytes < PALETTE_CACHE_LIMIT_BYTES);
    current_conversion_task()
        .unwrap()
        .cancelled
        .store(true, Ordering::Release);
    let cancelled_output = work.path().join("cancelled.png");
    assert!(generate_palette_cached(&ffmpeg, &input, &[], base, &cancelled_output).is_err());
    assert!(
        !cancelled_output.exists(),
        "cancelled cache hits must not write a palette"
    );
}

#[test]
#[ignore = "requires real FFmpeg; set GIFP_SOURCE_PROBE_REPORT_PATH"]
fn source_probe_real_paired_exports() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let report_path =
        PathBuf::from(env::var_os("GIFP_SOURCE_PROBE_REPORT_PATH").expect("set report path"));
    let parent = report_path.parent().unwrap();
    fs::create_dir_all(parent).unwrap();
    let work = parent.join(format!(
        "media-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir(&work).unwrap();
    let mut rows = Vec::new();
    for fixture in pilot_manifest().fixtures {
        let input = prepare_fixture(&ffmpeg, &work, &fixture);
        let request = request_for_fixture(&input, &work, &fixture, "best_gif");
        let run = |reuse| {
            let id = format!(
                "probe-pilot-{}-{}",
                std::process::id(),
                OUTPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            let task = ConversionTaskScope::register(Some(&id)).unwrap();
            task.activate();
            let start = Instant::now();
            let result = convert_animation_with_probe_policy(request.clone(), 0, reuse).unwrap();
            (result, start.elapsed().as_micros() as u64)
        };
        let _warmup = run(false);
        for round in 0..3 {
            let (baseline, optimized) = if round % 2 == 0 {
                let baseline = run(false);
                (baseline, run(true))
            } else {
                let optimized = run(true);
                (run(false), optimized)
            };
            let (baseline, baseline_us) = baseline;
            let (optimized, optimized_us) = optimized;
            let bytes = fs::read(&optimized.output_path).unwrap();
            assert_eq!(
                fs::read(&baseline.output_path).unwrap(),
                bytes,
                "{} {round}",
                fixture.id
            );
            assert_eq!(optimized.output_width, fixture.width);
            assert_eq!(optimized.output_fps, fixture.fps);
            let profile = optimized.pipeline_profile.as_ref().unwrap();
            assert!(profile.source_probe_cache.hits > 0);
            assert!(profile.source_probe_cache.retained_bytes <= 65536);
            let accounted: u64 = profile.stages.iter().map(|stage| stage.elapsed_us).sum();
            assert!(profile.elapsed_us >= accounted && profile.elapsed_us - accounted <= 8);
            println!(
                "PROBE {} {round}: {} -> {} ms; {} hits; identical {} bytes",
                fixture.id,
                baseline_us / 1000,
                optimized_us / 1000,
                profile.source_probe_cache.hits,
                bytes.len()
            );
            rows.push(json!({"fixture":fixture.id,"round":round,"baseline_us":baseline_us,"optimized_us":optimized_us,
                "source_sha256":format!("{:x}",Sha256::digest(fs::read(&input).unwrap())),
                "output_sha256":format!("{:x}",Sha256::digest(&bytes)), "baseline":baseline,"optimized":optimized}));
            fs::write(
                &report_path,
                serde_json::to_vec_pretty(&json!({"status":"in_progress","rows":rows})).unwrap(),
            )
            .unwrap();
        }
    }
    fs::write(report_path,serde_json::to_vec_pretty(&json!({
        "status":"passed","build_profile":if cfg!(debug_assertions){"debug"}else{"release"},
        "task_id_registered":true,"mode":"best_gif","paired_runs":12,
        "manifest_sha256":format!("{:x}",Sha256::digest(include_bytes!("../../bench/p2-sticker-manifest.json"))),
        "commands_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("commands.rs"))),
        "pipeline_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("export_pipeline.rs"))),
        "executor_sha256":format!("{:x}",Sha256::digest(fs::read(env::current_exe().unwrap()).unwrap())),
        "rows":rows
    })).unwrap()).unwrap();
}

#[test]
#[ignore = "requires real FFmpeg"]
fn source_probe_real_identity_rotation_and_cancellation() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let ffprobe = locate_ffprobe().unwrap();
    let work = OwnedTempDir::create("gifp-source-probe-contract").unwrap();
    let fixture = pilot_manifest().fixtures.remove(0);
    let input = prepare_fixture(&ffmpeg, work.path(), &fixture);
    let id = format!("probe-contract-{}", std::process::id());
    let task = ConversionTaskScope::register(Some(&id)).unwrap();
    task.activate();
    let scope = PipelineScope::start(0);
    assert_eq!(
        probe_display_dimensions(&ffprobe, &input).unwrap(),
        (320, 180)
    );
    assert!((fast_media_duration(&ffprobe, &input).unwrap() - 2.0).abs() < 0.01);
    assert!(!fast_source_has_alpha_plane(&ffprobe, &input).unwrap());
    assert_eq!(scope.report().source_probe_cache.hits, 2);
    assert_eq!(scope.report().source_probe_cache.misses, 1);
    let alpha = prepare_fixture(&ffmpeg, work.path(), &pilot_manifest().fixtures[1]);
    fs::copy(alpha, &input).unwrap();
    assert_eq!(
        probe_display_dimensions(&ffprobe, &input).unwrap(),
        (256, 256)
    );
    assert!(fast_source_has_alpha_plane(&ffprobe, &input).unwrap());
    let mp4 = work.path().join("plain.mp4");
    let rotated = work.path().join("rotated.mp4");
    let output = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=s=160x96:r=10:d=1",
            "-c:v",
            "libx264",
        ])
        .arg(&mp4)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = Command::new(&ffmpeg)
        .args(["-v", "error", "-display_rotation", "90", "-i"])
        .arg(&mp4)
        .args(["-c", "copy"])
        .arg(&rotated)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        probe_display_dimensions(&ffprobe, &rotated).unwrap(),
        (96, 160)
    );
    assert!((fast_media_duration(&ffprobe, &rotated).unwrap() - 1.0).abs() < 0.01);
    let retained = scope.report().source_probe_cache.retained_bytes;
    fs::write(&input, b"invalid-media").unwrap();
    assert!(source_probe_json(&ffprobe, &input).is_err());
    assert!(source_probe_json(&ffprobe, &input).is_err());
    assert_eq!(scope.report().source_probe_cache.retained_bytes, retained);
    current_conversion_task()
        .unwrap()
        .cancelled
        .store(true, Ordering::Release);
    assert!(matches!(
        source_probe_json(&ffprobe, &rotated),
        Err(AppError::Cancelled(_))
    ));
}

#[test]
#[ignore = "requires real FFmpeg; set GIFP_VALIDATION_BUDGET_REPORT_PATH"]
fn validation_budget_real_prescreen_pairs() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let report_path =
        PathBuf::from(env::var_os("GIFP_VALIDATION_BUDGET_REPORT_PATH").expect("set report path"));
    let root = report_path.parent().unwrap();
    fs::create_dir_all(root).unwrap();
    let work = root.join(format!(
        "media-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
    ));
    fs::create_dir(&work).unwrap();
    let mut rows = Vec::new();
    for width in [32_u16, 48, 64] {
        let height = 32_u16;
        let mut palette = vec![0_u8; 768];
        palette[..6].copy_from_slice(&[83, 214, 138, 243, 179, 107]);
        let frames = (0..12_usize)
            .map(|index| {
                let mut indices =
                    vec![GIF_TRANSPARENT_INDEX; usize::from(width) * usize::from(height)];
                let left = (index * 3) % (usize::from(width) - 4);
                for y in 10..14 {
                    for x in left..left + 4 {
                        indices[y * usize::from(width) + x] = (index % 2) as u8;
                    }
                }
                IndexedGifFrame {
                    left: 0,
                    top: 0,
                    width,
                    height,
                    delay_cs: if index % 2 == 0 { 6 } else { 8 },
                    disposal: IndexedGifDisposal::Background,
                    transparent_index: Some(GIF_TRANSPARENT_INDEX),
                    local_palette_rgb: None,
                    indices,
                }
            })
            .collect();
        let plan = IndexedGifPlan {
            width,
            height,
            global_palette_rgb: palette,
            repeat: IndexedGifRepeat::Infinite,
            frames,
        };
        let seed = work.join(format!("seed-{width}.gif"));
        let mut bytes = Vec::new();
        write_indexed_gif(&mut bytes, &plan).unwrap();
        fs::write(&seed, bytes).unwrap();
        let mut converged = false;
        for _ in 0..8 {
            let result = postprocess_transparent_gif_with_rust(&ffmpeg, &seed, true).unwrap();
            if !result.published {
                converged = true;
                break;
            }
            assert!(result.report.decoded_pixel_parity_verified);
        }
        assert!(converged, "fixture should reach a non-improving candidate");
        let seed_bytes = fs::read(&seed).unwrap();
        for round in 0..3 {
            let run = |enabled| {
                let file = work.join(format!("{width}-{round}-{enabled}.gif"));
                fs::write(&file, &seed_bytes).unwrap();
                let id = format!(
                    "prescreen-{}-{}",
                    std::process::id(),
                    OUTPUT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                );
                let task = ConversionTaskScope::register(Some(&id)).unwrap();
                task.activate();
                let pipeline = PipelineScope::start(0);
                let start = Instant::now();
                let result =
                    postprocess_transparent_gif_with_policy(&ffmpeg, &file, true, enabled).unwrap();
                let elapsed = start.elapsed().as_micros() as u64;
                assert!(!result.published);
                assert_eq!(fs::read(&file).unwrap(), seed_bytes);
                assert_eq!(result.report.decoded_pixel_parity_verified, !enabled);
                assert_eq!(result.report.decoded_rgba_sha256.is_some(), !enabled);
                (result.report, elapsed, pipeline.report(), file)
            };
            let (baseline, optimized) = if round % 2 == 0 {
                let b = run(false);
                (b, run(true))
            } else {
                let o = run(true);
                (run(false), o)
            };
            let validation_calls = |p: &PipelineProfile| {
                p.stages
                    .iter()
                    .find(|s| s.stage == "candidate_validation")
                    .unwrap()
                    .calls
            };
            assert_eq!(
                validation_calls(&baseline.2),
                validation_calls(&optimized.2) + 1
            );
            println!(
                "PRESCREEN {width} {round}: {} -> {} ms, one decode skipped",
                baseline.1 / 1000,
                optimized.1 / 1000
            );
            rows.push(json!({"width":width,"round":round,"baseline_us":baseline.1,"optimized_us":optimized.1,
                "baseline_report":baseline.0,"optimized_report":optimized.0,"baseline_profile":baseline.2,"optimized_profile":optimized.2,
                "baseline_path":baseline.3,"optimized_path":optimized.3,"sha256":format!("{:x}",Sha256::digest(&seed_bytes))}));
        }
    }
    fs::write(report_path,serde_json::to_vec_pretty(&json!({"status":"passed","build_profile":if cfg!(debug_assertions){"debug"}else{"release"},
        "scope":"transparent postprocess only; already optimized synthetic inputs; not end-to-end export timing",
        "commands_source_sha256":format!("{:x}",Sha256::digest(include_bytes!("commands.rs"))),"rows":rows})).unwrap()).unwrap();
}

#[test]
#[ignore = "requires real FFmpeg"]
fn validation_budget_real_sampling_sentinel() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let work = OwnedTempDir::create("gifp-validation-budget").unwrap();
    let input = work.path().join("long.mkv");
    let output = Command::new(&ffmpeg)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=s=16x16:r=30:d=40",
            "-c:v",
            "ffv1",
        ])
        .arg(&input)
        .output()
        .unwrap();
    assert!(output.status.success());
    let limited = decode_rgba_frames(&ffmpeg, &input, 16, 16, 40.0).unwrap_err();
    assert!(limited.contains("frame count 901"), "{limited}");
    assert_eq!(
        decode_rgba_frames(&ffmpeg, &input, 16, 16, 30.0)
            .unwrap()
            .len(),
        16 * 16 * 4 * 900
    );
    let short = decode_rgba_frames_with_prefix(
        &ffmpeg,
        &input,
        &["-t".into(), "1".into()],
        None,
        16,
        16,
        60.0,
    )
    .unwrap();
    assert_eq!(
        short.len(),
        16 * 16 * 4 * 30,
        "short inputs must not be rejected by a duration estimate"
    );
}

#[test]
#[ignore = "requires Gifsicle on PATH and GIFP_NATIVE_GIFSICLE_REPORT_PATH"]
fn native_gifsicle_end_to_end_and_existing_artifacts() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let backends = discover_backends();
    let (tool, _) = available_backend_executable(&backends, "gif.optimizer.external")
        .expect("Gifsicle must be on PATH");
    let report_path =
        PathBuf::from(env::var_os("GIFP_NATIVE_GIFSICLE_REPORT_PATH").expect("set report path"));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let prior: Value = serde_json::from_slice(
        &fs::read(root.join("audits/2026-09-07-p2-gifsicle/run/report.json")).unwrap(),
    )
    .unwrap();
    let work = report_path
        .parent()
        .unwrap()
        .join(format!("media-{}", std::process::id()));
    fs::create_dir_all(&work).unwrap();
    let mut rows = Vec::new();
    for (index, row) in prior["rows"].as_array().unwrap().iter().enumerate() {
        let source = Path::new(row["path"].as_str().unwrap());
        let staged = work.join(format!("existing-{index}.gif"));
        fs::copy(source, &staged).unwrap();
        let report = gifsicle_adapter::optimize(&ffmpeg, &tool, &staged, None).unwrap();
        let selected = report.status == "optimized";
        assert_eq!(selected, row["eligible"].as_bool().unwrap());
        let expected = if selected {
            row["candidate_sha256"].as_str().unwrap()
        } else {
            row["source_sha256"].as_str().unwrap()
        };
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(&staged).unwrap())),
            expected
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(source).unwrap())),
            row["source_sha256"].as_str().unwrap()
        );
        rows.push(json!({"id":row["id"],"report":report,"path":staged}));
    }
    let mut exports = Vec::new();
    let mut target_checks = Vec::new();
    for fixture in pilot_manifest().fixtures {
        let input = prepare_fixture(&ffmpeg, &work, &fixture);
        let mut request = request_for_fixture(&input, &work, &fixture, "best_gif");
        let baseline = convert_animation_inner(request.clone()).unwrap();
        assert!(baseline.postprocess_report.is_none());
        request.smaller_gif = true;
        request.task_id = Some(format!("native-opt-{}-{}", std::process::id(), fixture.id));
        let optimized = convert_animation_inner(request).unwrap();
        let inspection =
            verify_delivery_output(Path::new(&optimized.output_path), AnimationFormat::Gif)
                .unwrap();
        assert_eq!(optimized.output_frame_count, inspection.frame_count);
        assert_eq!(optimized.output_width, inspection.width);
        assert_eq!(optimized.output_fps, fixture.fps);
        assert_eq!(
            optimized.size_bytes,
            fs::metadata(&optimized.output_path).unwrap().len()
        );
        assert!(optimized.size_bytes <= baseline.size_bytes);
        gifsicle_adapter::verify_equivalent(
            &ffmpeg,
            Path::new(&baseline.output_path),
            Path::new(&optimized.output_path),
        )
        .unwrap();
        if optimized.postprocess_report.as_ref().unwrap().status == "optimized" {
            assert!(
                optimized.perceptual_report.is_none()
                    && optimized.palette_report.is_none()
                    && optimized.indexed_gif_writer_report.is_none()
            );
        }
        if fixture.id == "alpha-panels" {
            assert!(optimized.indexed_gif_writer_report.is_some());
        }
        if fixture.id == "small-caption" {
            let fast =
                convert_animation_inner(request_for_fixture(&input, &work, &fixture, "fast_gif"))
                    .unwrap();
            let mut target = request_for_fixture(&input, &work, &fixture, "target_size");
            target.target_size_bytes = Some(fast.size_bytes);
            target.smaller_gif = true;
            let result = convert_animation_inner(target).unwrap();
            assert!(result.size_bytes <= fast.size_bytes);
            assert_eq!(result.output_width, fixture.width);
            assert_eq!(result.output_fps, fixture.fps);
            let expected = (result.size_bytes as f64 / fast.size_bytes as f64 - 1.0) * 100.0;
            assert!((result.target_deviation_percent.unwrap() - expected).abs() < 0.000001);
            target_checks.push(json!({"cap":fast.size_bytes,"result":result}));
        }
        if fixture.id == "lowlight-texture" {
            let failure_dir = work.join("unreachable");
            fs::create_dir(&failure_dir).unwrap();
            let mut impossible = request_for_fixture(&input, &failure_dir, &fixture, "target_size");
            impossible.target_size_bytes = Some(1024);
            impossible.target_max_attempts = 1;
            impossible.smaller_gif = true;
            assert!(convert_animation_inner(impossible).is_err());
            assert_eq!(fs::read_dir(failure_dir).unwrap().count(), 0);
        }
        exports.push(json!({"fixture":fixture.id,"baseline":baseline,"optimized":optimized}));
    }
    fs::write(
        report_path,
        serde_json::to_vec_pretty(&json!({"status":"passed","existing":rows,"exports":exports,"target_checks":target_checks,
        "gifsicle_sha256":format!("{:x}",Sha256::digest(fs::read(&tool).unwrap()))}))
        .unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "requires real FFmpeg and Gifsicle"]
fn native_gifsicle_failure_loop_pixel_and_cancel_contracts() {
    let ffmpeg = locate_ffmpeg().unwrap();
    let (tool, _) =
        available_backend_executable(&discover_backends(), "gif.optimizer.external").unwrap();
    let work = OwnedTempDir::create("gifp-native-opt-contract").unwrap();
    let make = |name: &str, color: u8, delay: u16, repeat: Option<gif::Repeat>| {
        let path = work.path().join(name);
        let mut data = Vec::new();
        {
            let mut encoder =
                gif::Encoder::new(&mut data, 16, 16, &[255, 0, 0, 0, 0, 255]).unwrap();
            if let Some(repeat) = repeat {
                encoder.set_repeat(repeat).unwrap();
            }
            let frame = gif::Frame {
                width: 16,
                height: 16,
                delay,
                buffer: std::borrow::Cow::Owned(vec![color; 256]),
                ..gif::Frame::default()
            };
            encoder.write_frame(&frame).unwrap();
        }
        fs::write(&path, data).unwrap();
        path
    };
    let source = make("source.gif", 0, 8, None);
    for candidate in [
        make("pixel.gif", 1, 8, None),
        make("delay.gif", 0, 9, None),
        make("loop.gif", 0, 8, Some(gif::Repeat::Infinite)),
    ] {
        assert!(gifsicle_adapter::verify_equivalent(&ffmpeg, &source, &candidate).is_err());
    }
    let bytes = fs::read(&source).unwrap();
    assert_eq!(
        gifsicle_adapter::optional(&ffmpeg, None, &source, None)
            .unwrap()
            .status,
        "unavailable"
    );
    assert_eq!(
        gifsicle_adapter::optional(&ffmpeg, Some(&ffmpeg), &source, None)
            .unwrap()
            .status,
        "retained"
    );
    assert_eq!(fs::read(&source).unwrap(), bytes);
    for repeat in [
        None,
        Some(gif::Repeat::Finite(1)),
        Some(gif::Repeat::Finite(3)),
        Some(gif::Repeat::Infinite),
    ] {
        let file = make(&format!("repeat-{:?}.gif", repeat), 0, 8, repeat);
        gifsicle_adapter::verify_equivalent(&ffmpeg, &file, &file).unwrap();
    }
    let id = format!("native-gifsicle-cancel-{}", std::process::id());
    let task = ConversionTaskScope::register(Some(&id)).unwrap();
    task.activate();
    assert!(cancel_conversion_task(id).unwrap());
    assert!(matches!(
        gifsicle_adapter::optional(&ffmpeg, Some(&tool), &source, None),
        Err(AppError::Cancelled(_))
    ));
    assert_eq!(fs::read(&source).unwrap(), bytes);
}
