import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputQualityReport } from "../tauri";
import GifpV3 from "./GifpV3";
import { PRODUCT_VERSION } from "../version";
import { readSessionDraft, writeSessionDraft, type SessionDraftData } from "./sessionPersistence";

const mocks = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `https://assets.local/${encodeURIComponent(path)}`),
  onDragDropEvent: vi.fn(async () => vi.fn()),
  selectVideos: vi.fn<() => Promise<string[]>>(),
  selectOutputDir: vi.fn<() => Promise<string | null>>(),
  openDirectory: vi.fn<() => Promise<void>>(),
  selectScreenRegion: vi.fn(),
  convertGif: vi.fn(),
  convertAnimation: vi.fn(),
  cancelConversionTask: vi.fn(),
  evaluateOutputQuality: vi.fn(),
  inspectMedia: vi.fn(),
  listEncoderCapabilities: vi.fn(),
  getRuntimeResourceSnapshot: vi.fn(),
  getReleaseTrust: vi.fn(),
  generateMediaThumbnails: vi.fn(),
  generateFramePage: vi.fn(),
  mergeGif: vi.fn(),
  startScreenRecording: vi.fn(),
  stopScreenRecording: vi.fn<() => Promise<string>>(),
  trackMediaRegion: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: mocks.convertFileSrc,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));

vi.mock("../tauri", () => ({
  selectVideos: mocks.selectVideos,
  selectOutputDir: mocks.selectOutputDir,
  openDirectory: mocks.openDirectory,
  selectScreenRegion: mocks.selectScreenRegion,
  convertGif: mocks.convertGif,
  convertAnimation: mocks.convertAnimation,
  cancelConversionTask: mocks.cancelConversionTask,
  evaluateOutputQuality: mocks.evaluateOutputQuality,
  inspectMedia: mocks.inspectMedia,
  listEncoderCapabilities: mocks.listEncoderCapabilities,
  getRuntimeResourceSnapshot: mocks.getRuntimeResourceSnapshot,
  getReleaseTrust: mocks.getReleaseTrust,
  generateMediaThumbnails: mocks.generateMediaThumbnails,
  generateFramePage: mocks.generateFramePage,
  mergeGif: mocks.mergeGif,
  startScreenRecording: mocks.startScreenRecording,
  stopScreenRecording: mocks.stopScreenRecording,
  trackMediaRegion: mocks.trackMediaRegion,
}));

type TauriWindow = Window & { __TAURI_INTERNALS__?: object };

type PresentedDevSnapshot = {
  url: string;
  format: string;
  label: string;
  outputPath?: string;
  snapshot?: {
    sourceAspect?: number;
    outputAspect?: number;
    startSeconds: number;
    endSeconds: number;
    playbackSpeed: number;
    outputFps: number;
    deletedFrameIndices: number[];
  };
};

function presentedDevSnapshot() {
  return (window as Window & {
    __GIFP_V3_DEV__?: { snapshot: () => { presentedExport?: PresentedDevSnapshot } };
  }).__GIFP_V3_DEV__?.snapshot().presentedExport;
}

function useTauriRuntime() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
}

function savedSessionDraft(): SessionDraftData {
  return {
    mode: "editor",
    assets: [{
      id: "saved-asset",
      path: "C:/media/recover-me.gif",
      name: "recover-me.gif",
      kind: "gif",
      duration: 3.2,
      pathAvailability: { state: "unchecked" },
    }],
    activeAssetId: "saved-asset",
    activeAssetPath: "C:/media/recover-me.gif",
    mergePaths: [],
    outputDir: "C:/exports",
    editor: {
      presetId: "custom",
      encoder: "pngquant_opt",
      deliveryIntent: "smart",
      deliveryFormatPreference: "gif",
      targetPlatform: "modern_web",
      playbackSpeed: 2,
      cropEnabled: true,
      crop: { left: 5, top: 10, right: 5, bottom: 10 },
      loopOutput: true,
      width: 360,
      fps: 12,
      colors: 96,
      dither: "sierra2_4a",
      lossy: 24,
      optimizeLevel: 3,
      generationMode: "best_gif",
      targetSizeMb: 2,
      bayerScale: 2,
      alphaThreshold: 128,
      perceptualFocus: "text_ui",
      filter: "vivid",
      outputFormat: "gif",
      startSeconds: 0.4,
      endSeconds: 2.8,
      selectedFrameTimes: [0.8],
      deletedFrameTimes: [1.2],
      memeOverlay: null,
    },
  };
}

async function chooseAnimatedOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: RegExp,
) {
  let radioGroup = screen.queryByRole("radiogroup", { name: label });
  if (!radioGroup && ["交付意图", "目标平台", "输出格式"].includes(label)) {
    await openSection(user, label === "输出格式" ? "智能输出" : "交付与文件");
    radioGroup = screen.queryByRole("radiogroup", { name: label });
  }
  if (radioGroup) {
    const radio = within(radioGroup).getByRole("radio", { name: optionName });
    await user.click(radio);
    return radio.closest("label") ?? radio;
  }
  const triggerLabel = label === "输出格式" ? "主输出格式" : label;
  const trigger = screen.getByRole("button", { name: new RegExp(`^${triggerLabel}`) });
  if (trigger.getAttribute("aria-expanded") !== "true") await user.click(trigger);
  await user.click(screen.getByRole("option", { name: optionName }));
  return trigger;
}

async function openSection(user: ReturnType<typeof userEvent.setup>, title: string) {
  let trigger = screen.queryByRole("button", { name: new RegExp(`^${title}`) });
  if (!trigger) {
    const advanced = screen.getByRole("button", { name: /手动覆盖/ });
    await user.click(advanced);
    trigger = await screen.findByRole("button", { name: new RegExp(`^${title}`) });
  }
  if (trigger.getAttribute("aria-expanded") !== "true") await user.click(trigger);
  return trigger;
}

const temporalMetricsFixture = {
  sampled_pixel_count: 4096,
  sampled_static_pixel_count: 3072,
  mean_oklab_error: 0.01,
  p95_oklab_error: 0.03,
  edge_weighted_mean_oklab_error: 0.011,
  multiscale_low_frequency_oklab_error: 0.009,
  multiscale_banding_score: 0.006,
  edge_gradient_error: 0.007,
  static_temporal_residual: 0.002,
  multiscale_static_temporal_residual: 0.0015,
};

function exportResult(
  outputPath: string,
  sizeBytes: number,
  outputWidth: number,
  outputFormat?: "gif" | "webp" | "avif" | "apng" | "mp4" | "webm" | "live_photo",
) {
  return {
    input_path: "C:/media/clip.mp4",
    output_path: outputPath,
    size_bytes: sizeBytes,
    encoder_used: outputFormat ? `ffmpeg.${outputFormat}` : "ffmpeg.gif",
    status: "done",
    backend_id: "ffmpeg.animation",
    backend_version: "ffmpeg test",
    fallback_reason: null,
    palette_strategy: outputFormat && outputFormat !== "gif" ? "not_applicable" : "diff_rectangle",
    attempts: 1,
    elapsed_ms: 250,
    output_width: outputWidth,
    output_fps: 12,
    output_frame_count: 24,
    output_colors: outputFormat && outputFormat !== "gif" ? 0 : 64,
    output_format: outputFormat,
    output_codec: outputFormat ?? "gif",
    output_has_alpha: false,
    target_size_bytes: null,
    target_deviation_percent: null,
    warnings: [],
  };
}

function temporalStatusResult(
  status: "candidate_selected" | "selection_gate_rejected" | "quality_gate_rejected" | "candidate_failed",
  fallbackReason: string,
) {
  return {
    input_path: "C:/media/temporal-status.mp4",
    output_path: "C:/media/temporal-status-GIFP.gif",
    size_bytes: 102_400,
    encoder_used: "rust_perceptual_oklab_ffmpeg",
    status: "done",
    backend_id: "rust.perceptual",
    backend_version: "4.0.0",
    fallback_reason: null,
    palette_strategy: "perceptual_vfr+oklab_global+rust_writer",
    attempts: 1,
    elapsed_ms: 320,
    output_width: 96,
    output_fps: 12,
    effective_output_fps: 12,
    output_frame_count: 12,
    output_colors: 32,
    output_format: "gif",
    output_codec: "gif",
    output_has_alpha: false,
    target_size_bytes: null,
    target_deviation_percent: null,
    warnings: [],
    indexed_gif_writer_report: {
      status: "fallback_ffmpeg",
      fallback_reason: null,
      local_palette_frame_count: 0,
      disposal_candidate_count: 0,
      regional_quantizer_report: {
        quantizer_id: "rust.oklab.regional_ordered.v2",
        quantizer_version: "4.0.0",
        gate_id: "multiscale_banding_proxy_v4",
        status: "encoded",
        fallback_reason: null,
        quality_gate_passed: true,
        selected_route_id: status === "candidate_selected" ? "temporal_hysteresis" : "regional_ordered",
        secondary_choice_count: 64,
        secondary_choice_by_class: [8, 16, 40, 0],
        temporal_selection: {
          selector_id: "rust.oklab.temporal_hysteresis.v1",
          selector_version: "4.0.0",
          gate_id: "temporal_pareto_v1",
          max_hold_frames: 2,
          status,
          fallback_reason: fallbackReason,
          quality_gate_passed: status !== "quality_gate_rejected" && status !== "candidate_failed",
          selection_gate_passed: status === "candidate_selected",
          baseline: {
            metrics: temporalMetricsFixture,
            serialized_bytes: 102_400,
            indices_sha256: "1".repeat(64),
            artifact_sha256: "2".repeat(64),
            temporal_hold_count: 0,
            temporal_hold_by_class: [0, 0, 0, 0],
          },
          candidate: status === "candidate_failed" ? null : {
            metrics: temporalMetricsFixture,
            serialized_bytes: 103_424,
            indices_sha256: "3".repeat(64),
            artifact_sha256: "4".repeat(64),
            temporal_hold_count: 12,
            temporal_hold_by_class: [4, 4, 4, 0],
          },
        },
      },
      segment_palette_report: null,
    },
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  localStorage.clear();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  mocks.selectVideos.mockResolvedValue([]);
  mocks.selectOutputDir.mockResolvedValue(null);
  mocks.openDirectory.mockResolvedValue(undefined);
  mocks.cancelConversionTask.mockResolvedValue(true);
  mocks.selectScreenRegion.mockResolvedValue(null);
  mocks.convertAnimation.mockResolvedValue({
    input_path: "C:/media/clip.mp4",
    output_path: "C:/media/clip-GIFP.gif",
    size_bytes: 1_500_000,
    encoder_used: "ffmpeg.gif",
    status: "target_under",
    backend_id: "ffmpeg.gif",
    backend_version: "ffmpeg test",
    fallback_reason: "感知后端未启用，已使用 FFmpeg 高质量基线。",
    palette_strategy: "diff_rectangle",
    attempts: 8,
    elapsed_ms: 1_240,
    output_width: 420,
    output_fps: 15,
    output_frame_count: 48,
    output_colors: 112,
    target_size_bytes: 1_572_864,
    target_deviation_percent: -4.6,
    warnings: ["透明边缘已按 Alpha 阈值处理。"],
    target_optimizer_report: {
      optimizer_id: "gifp.target_size.pareto.v6",
      optimizer_version: "4.0.0",
      selection_policy: "hard_cap_constraint_first_numeric_plus_route_probe_v3",
      constraint: "hard_cap",
      preference: "balanced",
      target_bytes: 1_572_864,
      tolerance_percent: 5,
      max_attempts: 8,
      numeric_attempt_count: 4,
      route_attempt_count: 4,
      selected_attempt: 4,
      route_probe_id: "ffmpeg_palette_dither_timeline_reinvest_correction_v2",
      selected_route_id: "baseline",
      observations: [
        { attempt: 1, width: 560, fps: 18, colors: 224, bayer_scale: 4, size_bytes: 3_000_000, symmetric_deviation_percent: 62.42, under_target: false, within_tolerance: false, pareto_frontier: false, selected: false },
        { attempt: 2, width: 460, fps: 18, colors: 224, bayer_scale: 4, size_bytes: 2_100_000, symmetric_deviation_percent: 28.71, under_target: false, within_tolerance: false, pareto_frontier: false, selected: false },
        { attempt: 3, width: 420, fps: 15, colors: 160, bayer_scale: 4, size_bytes: 1_650_000, symmetric_deviation_percent: 4.79, under_target: false, within_tolerance: false, pareto_frontier: false, selected: false },
        { attempt: 4, width: 420, fps: 15, colors: 112, bayer_scale: 4, size_bytes: 1_500_000, symmetric_deviation_percent: 4.74, under_target: true, within_tolerance: true, pareto_frontier: true, selected: true },
      ],
      recommendations: [
        { role: "clearest", attempt: 4 },
        { role: "smoothest", attempt: 4 },
        { role: "smallest", attempt: 4 },
      ],
      route_observations: [
        { route_id: "baseline", timeline: "cfr", width: 420, fps: 15, colors: 112, dither: "bayer", palette_stats_mode: "diff", size_bytes: 1_500_000, symmetric_deviation_percent: 4.74, under_target: true, within_tolerance: true, selected: true, kept_frame_count: null, dropped_frame_count: null, timeline_verified: true, status: "encoded", failure_reason: null },
        { route_id: "sierra_quality", timeline: "cfr", width: 420, fps: 15, colors: 112, dither: "sierra2_4a", palette_stats_mode: "diff", size_bytes: 1_510_000, symmetric_deviation_percent: 4.08, under_target: true, within_tolerance: true, selected: false, kept_frame_count: null, dropped_frame_count: null, timeline_verified: true, status: "encoded", failure_reason: null },
        { route_id: "alternate_stats", timeline: "cfr", width: 420, fps: 15, colors: 112, dither: "bayer", palette_stats_mode: "full", size_bytes: 1_460_000, symmetric_deviation_percent: 7.45, under_target: true, within_tolerance: false, selected: false, kept_frame_count: null, dropped_frame_count: null, timeline_verified: true, status: "encoded", failure_reason: null },
        { route_id: "perceptual_timeline", timeline: "perceptual_drop_hold", width: 420, fps: 15, colors: 112, dither: "bayer", palette_stats_mode: "diff", size_bytes: 1_320_000, symmetric_deviation_percent: 17.46, under_target: true, within_tolerance: false, selected: false, kept_frame_count: 32, dropped_frame_count: 16, timeline_verified: true, status: "encoded", failure_reason: null },
        { route_id: "perceptual_reinvest", timeline: "perceptual_drop_hold", width: 460, fps: 15, colors: 112, dither: "bayer", palette_stats_mode: "diff", size_bytes: 1_550_000, symmetric_deviation_percent: 1.46, under_target: true, within_tolerance: true, selected: false, kept_frame_count: 32, dropped_frame_count: 16, timeline_verified: true, prediction: { model_id: "spatial_area_color_v1", source_route_id: "perceptual_timeline", source_size_bytes: 1_320_000, predicted_size_bytes: 1_500_000, actual_to_predicted_ratio: 1.033, correction_pass: 0 }, status: "encoded", failure_reason: null },
      ],
    },
  });
  mocks.evaluateOutputQuality.mockResolvedValue({
    status: "measured",
    metric_model: "VMAF NEG v0.6.1 · float SSIM",
    sample_duration_seconds: 3.2,
    compared_frames: 96,
    vmaf_mean: 91.4,
    vmaf_p05: 84.2,
    ssim_mean: 0.974,
    ms_ssim_mean: 0.962,
    elapsed_ms: 840,
    message: null,
  });
  mocks.inspectMedia.mockResolvedValue({
    codec: "h264",
    width: 640,
    height: 360,
    duration: 3.2,
    frame_count: 48,
    animated: true,
    has_alpha: false,
  });
  mocks.listEncoderCapabilities.mockResolvedValue([]);
  mocks.getRuntimeResourceSnapshot.mockResolvedValue({
    sampled_at_ms: 1_700_000_000_000,
    cpu_usage_percent: 12,
    app_cpu_usage_percent: 3,
    logical_cpu_count: 16,
    physical_cpu_count: 8,
    total_memory_bytes: 32 * 1024 ** 3,
    used_memory_bytes: 8 * 1024 ** 3,
    app_memory_bytes: 256 * 1024 ** 2,
    active_conversion_jobs: 0,
    gpu_backend: "unavailable",
    gpus: [],
    gpu_unavailable_reason: "测试环境没有 GPU 采样接口。",
  });
  mocks.trackMediaRegion.mockResolvedValue({
    model_id: "gifp.zero-mean-template.v1",
    frames_analyzed: 3,
    average_confidence: 0.74,
    low_confidence_frames: 1,
    keyframes: [
      { time_seconds: 0, x_percent: 28, y_percent: 24, width_percent: 28, height_percent: 24, confidence: 1 },
      { time_seconds: 1.6, x_percent: 34, y_percent: 28, width_percent: 28, height_percent: 24, confidence: 0.48 },
      { time_seconds: 3.2, x_percent: 40, y_percent: 31, width_percent: 28, height_percent: 24, confidence: 0.75 },
    ],
  });
  mocks.getReleaseTrust.mockResolvedValue({
    schema_version: 1,
    context: "development",
    status: "unverified",
    manifest_path: "DISTRIBUTION.json",
    manifest_found: false,
    expected_product_version: PRODUCT_VERSION,
    reported_product_version: null,
    product_version_matches: null,
    actual_executable_name: "gif_p.exe",
    reported_executable_name: null,
    executable_name_matches: null,
    actual_executable_sha256: null,
    reported_executable_sha256: null,
    executable_sha256_matches: null,
    source_dirty: null,
    channel: null,
    signature_status: null,
    signature_trusted: null,
    public_release_blockers: [],
    runtime_integrity_status: "unverified",
    runtime_files_checked: 0,
    runtime_failures: [],
    reasons: ["No adjacent DISTRIBUTION.json; this is treated as a development build."],
  });
  mocks.startScreenRecording.mockResolvedValue(undefined);
  mocks.stopScreenRecording.mockResolvedValue("C:/captures/recording.mp4");
  mocks.generateMediaThumbnails.mockResolvedValue([]);
  mocks.generateFramePage.mockImplementation(async (request: {
    start_seconds: number;
    end_seconds: number;
    playback_speed: number;
    fps: number;
    page_start: number;
    page_size: number;
  }) => {
    const totalFrames = Math.max(0, Math.round(
      ((request.end_seconds - request.start_seconds) / request.playback_speed) * request.fps,
    ));
    const count = Math.min(request.page_size, Math.max(0, totalFrames - request.page_start));
    return {
      total_frames: totalFrames,
      page_start: request.page_start,
      page_size: count,
      frames: Array.from({ length: count }, (_, offset) => {
        const index = request.page_start + offset;
        return {
          index,
          time: request.start_seconds + (index * request.playback_speed) / request.fps,
          path: `C:/frame-pages/frame-${index}.jpg`,
        };
      }),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

describe("GIFP 2.3 feature parity", () => {
  it.each([true, false])("reports the actual postprocessing outcome: verified=%s", async (verified) => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/postprocessed.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce({
      ...exportResult("C:/exports/postprocessed.gif", verified ? 5000 : 6000, 420),
      postprocess_report: {status: verified ? "optimized" : "not_smaller", before_bytes:6000,after_bytes:verified ? 5000 : 6000,verified,elapsed_ms:200,reason:null},
    });
    render(<GifpV3 />);
    await user.click(screen.getByRole("button",{name:/^添加素材/}));
    await screen.findAllByText("postprocessed.mp4");
    await user.click(screen.getByRole("button",{name:/^生成 (?!3 个|全部)/}));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    await openSection(user,"编码报告");
    const report = await screen.findByRole("region",{name:"编码结果报告"});
    expect(within(report).getByText("无损后处理")).toBeVisible();
    expect(within(report).getByText(verified ? /^已验证并缩小/ : "保留原输出 · 候选未缩小文件")).toBeVisible();
  });

  it("offers built-in index compression without external tools and reports actual adoption", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/index-compression.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce({ ...exportResult("C:/exports/index.gif", 800, 10),
      advanced_compression_report: { algorithm_version: "1", status: "optimized", before_bytes: 1100, after_bytes: 1000, adopted: true, verified: true, reference_kind: "gif_only", elapsed_ms: 10, estimated_peak_bytes: 20000,
        stages: [{ method: "lzw_cost_search", status: "adopted", before_bytes: 1100, candidate_bytes: 1000, writer_control_bytes: 1080, algorithm_saved_bytes: 80, adopted: true, verified: true, compression_probes: 3, changed_pixels: 20, elapsed_ms: 10 }] },
      gif_cleanup_report: { status: "optimized", before_bytes: 1200, after_bytes: 1000, verified: true, merged_frames: 3, removed_palette_entries: 220, merge_requested: true, palette_requested: true, elapsed_ms: 5, reason: null },
      index_compression_report: { gentle: true, algorithm: "gifp.index_reuse.v1", status: "optimized", before_bytes: 1000, after_bytes: 800, verified: true, threshold: 4, max_channel_error: 4, worst_frame_rmse: 1.1, candidates_tested: 3, elapsed_ms: 10, reason: null } });
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "快速生成" }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    let dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    const toggle = within(dialog).getByRole("switch", { name: "索引压缩" });
    expect(toggle).toBeEnabled(); expect(toggle).not.toBeChecked();
    await user.click(within(dialog).getByRole("switch", { name: "合并重复帧" }));
    await user.click(within(dialog).getByRole("switch", { name: "调色表整理" }));
    await user.click(within(dialog).getByRole("switch", { name: "跨帧稳定优化" }));
    await user.click(within(dialog).getByRole("switch", { name: "LZW 成本搜索" }));
    await user.click(toggle);
    await user.click(within(dialog).getByRole("switch", { name: "温和模式" }));
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toMatchObject({index_compression:true,index_compression_gentle:true,gif_merge_frames:true,gif_compact_palette:true,temporal_stability:true,lzw_search:true});
    await screen.findByText("新压缩阶段已采用 · 减少 9.1%（有损）；索引压缩（温和）已采用 · 减少 20.0%（有损）");
    await user.click(within(dialog).getByText("新算法候选与画质参考"));
    const compressionReport = within(dialog).getByRole("region", { name: "新压缩算法报告" });
    expect(within(compressionReport).getByText("画质参考：编码后的 GIF；未验证相对源画面的画质")).toBeVisible();
    expect(within(compressionReport).getByText("算法增量节省 80 B")).toBeVisible();
    expect(screen.getByText("无损整理已采用 · 合并 3 帧 · 减少 16.7%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "调整设置" }));
    dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /网页动效/ }));
    expect(within(dialog).queryByRole("switch", { name: "索引压缩" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(2));
    expect(mocks.convertAnimation.mock.calls[1][0]).toMatchObject({ output_format: "webp" });
    for (const field of ["index_compression","index_compression_gentle","gif_merge_frames","gif_compact_palette","temporal_stability","lzw_search"]) expect(mocks.convertAnimation.mock.calls[1][0][field]).toBeUndefined();
  });

  it("keeps lossless postprocessing opt-in and sends it only for GIF", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.listEncoderCapabilities.mockResolvedValue([{id:"gif.optimizer.external",status:{state:"available",executable_path:"C:/tools/gifsicle.exe",version:"1.96"},formats:["gif"]}]);
    mocks.selectVideos.mockResolvedValue(["C:/media/optional.mp4"]);
    render(<GifpV3 />);
    await user.click(screen.getByRole("button",{name:/^快速生成$/}));
    await user.click(screen.getByRole("button",{name:/先添加素材/}));
    let dialog = await screen.findByRole("dialog",{name:"快速生成"});
    await user.click(within(dialog).getByRole("button",{name:/更多设置/}));
    const toggle = within(dialog).getByRole("switch",{name:"更小优先"});
    expect(toggle).not.toBeChecked();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    await user.click(within(dialog).getByRole("button",{name:"开始生成"}));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0].smaller_gif).toBe(true);
    await user.click(await screen.findByRole("button",{name:"调整设置"}));
    dialog = await screen.findByRole("dialog",{name:"快速生成"});
    await user.click(within(dialog).getByRole("button",{name:/网页动效/}));
    expect(within(dialog).queryByRole("switch",{name:"更小优先"})).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button",{name:"开始生成"}));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(2));
    expect(mocks.convertAnimation.mock.calls[1][0].output_format).toBe("webp");
    expect(mocks.convertAnimation.mock.calls[1][0].smaller_gif).not.toBe(true);
  });

  it("explains an unavailable postprocessor while allowing ordinary export", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/no-tool.mp4"]);
    render(<GifpV3 />);
    await user.click(screen.getByRole("button",{name:/^快速生成$/}));
    await user.click(screen.getByRole("button",{name:/先添加素材/}));
    const dialog = await screen.findByRole("dialog",{name:"快速生成"});
    await user.click(within(dialog).getByRole("button",{name:/更多设置/}));
    expect(within(dialog).getByRole("switch",{name:"更小优先"})).toBeDisabled();
    await user.click(within(dialog).getByRole("button",{name:"开始生成"}));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0].smaller_gif).not.toBe(true);
  });

  it("starts a quick export immediately without opening technical settings or walking confirmation steps", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/one-click.mp4"]);
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    expect(within(dialog).queryByRole("slider")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /下一步/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /更多设置/ })).toHaveAttribute("aria-expanded", "false");
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toMatchObject({ output_format: "gif", width: 480, fps: 12, generation_mode: "best_gif", target_size_bytes: null });
  });

  it("exports meme text through the quick card while preserving crop, trim, and an entered size cap", async () => {
    useTauriRuntime();
    writeSessionDraft(localStorage, savedSessionDraft());
    const user = userEvent.setup();
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "恢复上次任务" }));
    await waitFor(() => expect(screen.getByText(/已恢复上一次任务：recover-me.gif/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: "GIF表情包制作" }));
    await user.click(screen.getByRole("button", { name: "收到！" }));
    await user.click(screen.getByText("单张与高级编辑", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /快速导出表情包/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    expect(within(dialog).getByText(/含表情文字/)).toBeVisible();
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).toHaveTextContent("360 × 180 · 12 FPS");
    await user.click(within(dialog).getByRole("switch", { name: "限制文件大小" }));
    const cap = within(dialog).getByLabelText("快速生成最大输出体积（MB）");
    await user.clear(cap);
    await user.type(cap, "0.5");
    // Clicking the primary action must commit the number before building the request.
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toMatchObject({
      input_path: "C:/media/recover-me.gif", output_format: "gif", width: 360, fps: 12,
      playback_speed: 2, start_seconds: 0.4, end_seconds: 2.8,
      crop_left: 5, crop_top: 10, crop_right: 5, crop_bottom: 10,
      generation_mode: "target_size", target_size_bytes: 524288,
      meme_overlay: expect.objectContaining({ bottom_text: "收到！", font_size: 44 }),
    });
  });

  it.each([[800, 48], [16, 2]])("preserves a meme's editor dimensions %i px and %i FPS when opening and leaving advanced controls", async (savedWidth, savedFps) => {
    useTauriRuntime();
    const draft = savedSessionDraft();
    draft.editor.width = savedWidth;
    draft.editor.fps = savedFps;
    writeSessionDraft(localStorage, draft);
    const user = userEvent.setup();
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "恢复上次任务" }));
    await waitFor(() => expect(screen.getByText(/已恢复上一次任务：recover-me.gif/)).toBeVisible());
    await user.click(screen.getByRole("button", { name: "GIF表情包制作" }));
    await user.click(screen.getByText("单张与高级编辑", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: /快速导出表情包/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    const widthInput = within(dialog).getByRole("spinbutton", { name: "快速生成固定宽度" });
    expect(widthInput).toHaveValue(savedWidth);
    expect(within(dialog).getByRole("slider", { name: "快速生成帧率" })).toHaveValue(String(savedFps));
    expect(within(dialog).queryByRole("slider", { name: "快速生成缩放比例" })).not.toBeInTheDocument();
    await user.click(widthInput);
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toMatchObject({ width: savedWidth, fps: savedFps });
  });

  it("exports a meme set with independent captions and retries only the failed frozen request", async () => {
    useTauriRuntime();
    writeSessionDraft(localStorage, savedSessionDraft());
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/one.gif", 1000, 10))
      .mockRejectedValueOnce(new Error("second failed"))
      .mockResolvedValueOnce(exportResult("C:/exports/two.gif", 1200, 12));
    const user = userEvent.setup();
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "恢复上次任务" }));
    await screen.findByText(/已恢复上一次任务：recover-me.gif/);
    await user.click(screen.getByRole("button", { name: "GIF表情包制作" }));
    await user.click(screen.getByRole("button", { name: "收到！" }));
    await user.click(screen.getByRole("button", { name: "复制当前" }));
    await user.click(screen.getByRole("button", { name: "好耶" }));
    await user.click(screen.getByRole("button", { name: "生成整组 2" }));
    await screen.findByRole("button", { name: "重试失败 1" });
    expect(mocks.convertAnimation).toHaveBeenCalledTimes(2);
    const requests = mocks.convertAnimation.mock.calls.map(call => call[0]);
    expect(requests.map(request => request.meme_overlay.bottom_text)).toEqual(["收到！", "好耶"]);
    expect(requests[0]).toMatchObject({ input_path: "C:/media/recover-me.gif", width: 360, fps: 12, crop_left: 5, start_seconds: 0.4, end_seconds: 2.8 });
    await user.click(screen.getByRole("button", { name: "重试失败 1" }));
    await screen.findByRole("button", { name: "重新生成整组 2" });
    const { task_id: _firstId, ...failedRequest } = requests[1];
    const { task_id: _retryId, ...retryRequest } = mocks.convertAnimation.mock.calls[2][0];
    expect(retryRequest).toEqual(failedRequest);
    expect(mocks.convertAnimation).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: "打开文件夹" }));
    expect(mocks.openDirectory).toHaveBeenCalledWith("C:/exports");
    await user.click(screen.getByRole("button", { name: "救命" }));
    expect(screen.getByRole("button", { name: "生成未完成 1" })).toBeEnabled();
  });

  it("cancels a meme set without publishing a late item or dispatching the next", async () => {
    useTauriRuntime();
    writeSessionDraft(localStorage, savedSessionDraft());
    let resolveConversion: (value: ReturnType<typeof exportResult>) => void = () => undefined;
    mocks.convertAnimation.mockImplementationOnce(() => new Promise(resolve => { resolveConversion = resolve; }));
    const user = userEvent.setup();
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "恢复上次任务" }));
    await screen.findByText(/已恢复上一次任务：recover-me.gif/);
    await user.click(screen.getByRole("button", { name: "GIF表情包制作" }));
    await user.click(screen.getByRole("button", { name: "复制当前" }));
    await user.click(screen.getByRole("button", { name: "生成整组 2" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("下方文字")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "停止生成" }));
    await act(async () => { resolveConversion(exportResult("C:/exports/late.gif", 1000, 10)); });
    await screen.findByRole("button", { name: "生成整组 2" });
    expect(mocks.convertAnimation).toHaveBeenCalledTimes(1);
    expect(mocks.cancelConversionTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "打开文件夹" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "选择表情" })).getAllByText("已停止")).toHaveLength(2);
  });

  it("does not reuse another asset's meme draft when switching sources", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: "GIF表情包制作" }));
    await user.click(screen.getByRole("button", { name: "收到！" }));
    expect(screen.getByLabelText("下方文字")).toHaveValue("收到！");
    await user.click(screen.getByRole("button", { name: /clip-02.mp4 视频/ }));
    expect(screen.getByLabelText("下方文字")).toHaveValue("然后重做了整个项目");
  });

  it("keeps an entered cap when reselecting the GIF purpose and never presents an old result as a successful retry", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/retry-card.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/first.gif", 420_000, 480));
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("switch", { name: "质量评分" }));
    await user.click(within(dialog).getByRole("switch", { name: "限制文件大小" }));
    const cap = within(dialog).getByLabelText("快速生成最大输出体积（MB）");
    await user.clear(cap);
    await user.type(cap, "1.5");
    await user.click(within(dialog).getByRole("button", { name: /聊天动图/ }));
    expect(within(dialog).getByRole("switch", { name: "限制文件大小" })).toBeChecked();
    expect(cap).toHaveValue(1.5);
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    expect(await within(dialog).findByText("已生成")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "调整设置" }));
    mocks.convertAnimation.mockRejectedValueOnce(new Error("target_size_unreachable"));
    await user.click(within(dialog).getByRole("button", { name: "开始生成" }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText(/生成失败/)).toBeVisible();
    expect(within(dialog).queryByText("已生成")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "打开目录" })).not.toBeInTheDocument();
  });

  it("offers and restores the last desktop task without silently replacing the current session", async () => {
    useTauriRuntime();
    writeSessionDraft(localStorage, savedSessionDraft(), Date.now() - 60_000);
    const user = userEvent.setup();
    render(<GifpV3 />);

    expect(screen.getByRole("region", { name: "恢复上一次任务" })).toBeVisible();
    expect(screen.getByText(/1 个素材/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "恢复上次任务" }));

    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledWith("C:/media/recover-me.gif"));
    await waitFor(() => expect(screen.getByText(/已恢复上一次任务：recover-me.gif/)).toBeVisible());
    expect((window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { activePath: string; playbackSpeed: number; cropEnabled: boolean; assets: Array<{ id: string }> } } }).__GIFP_V3_DEV__?.snapshot()).toMatchObject({
      activePath: "C:/media/recover-me.gif",
      playbackSpeed: 2,
      cropEnabled: true,
      assets: [expect.objectContaining({ id: "saved-asset" })],
    });
  });

  it("can discard the saved task and keeps it cleared until a new asset is added", async () => {
    useTauriRuntime();
    writeSessionDraft(localStorage, savedSessionDraft());
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "放弃恢复" }));
    expect(screen.queryByRole("region", { name: "恢复上一次任务" })).not.toBeInTheDocument();
    expect(readSessionDraft(localStorage)).toEqual({ status: "empty" });
  });

  it("retries media inspection without losing the asset identity", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/retry-probe.mp4"]);
    mocks.inspectMedia
      .mockRejectedValueOnce(new Error("Input file does not exist"))
      .mockResolvedValueOnce({
        codec: "h264", width: 1280, height: 720, duration: 4.5,
        frame_count: 90, animated: true, has_alpha: false,
      });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    const recovery = await screen.findByRole("group", { name: "retry-probe.mp4 素材恢复" });
    const before = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { assets: Array<{ id: string }> } } }).__GIFP_V3_DEV__?.snapshot().assets[0]?.id;
    await user.click(within(recovery).getByRole("button", { name: /重新读取/ }));

    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("group", { name: "retry-probe.mp4 素材恢复" })).not.toBeInTheDocument());
    const snapshot = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { assets: Array<{ id: string; dimensions?: string }> } } }).__GIFP_V3_DEV__?.snapshot();
    expect(snapshot?.assets[0]).toMatchObject({ id: before, dimensions: "1280 × 720" });
  });

  it("relinks a missing asset in place and ignores a late probe from the old path", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos
      .mockResolvedValueOnce(["C:/missing/old-source.mp4"])
      .mockResolvedValueOnce(["D:/moved/new-source.mp4"]);
    let resolveOldRetry: (value: {
      codec: string; width: number; height: number; duration: number;
      frame_count: number; animated: boolean; has_alpha: boolean;
    }) => void = () => undefined;
    mocks.inspectMedia
      .mockRejectedValueOnce(new Error("Input file does not exist"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldRetry = resolve; }))
      .mockResolvedValueOnce({
        codec: "h264", width: 1920, height: 1080, duration: 6,
        frame_count: 120, animated: true, has_alpha: false,
      });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    const recovery = await screen.findByRole("group", { name: "old-source.mp4 素材恢复" });
    const before = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { assets: Array<{ id: string }> } } }).__GIFP_V3_DEV__?.snapshot().assets[0]?.id;
    await user.click(within(recovery).getByRole("button", { name: /重新读取/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(2));
    await user.click(within(recovery).getByRole("button", { name: /重新定位/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(3));

    let snapshot = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { activePath: string; assets: Array<{ id: string; dimensions?: string }> } } }).__GIFP_V3_DEV__?.snapshot();
    await waitFor(() => {
      snapshot = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { activePath: string; assets: Array<{ id: string; dimensions?: string }> } } }).__GIFP_V3_DEV__?.snapshot();
      expect(snapshot).toMatchObject({ activePath: "D:/moved/new-source.mp4", assets: [expect.objectContaining({ id: before, dimensions: "1920 × 1080" })] });
    });
    resolveOldRetry({
      codec: "h264", width: 320, height: 240, duration: 1,
      frame_count: 10, animated: true, has_alpha: false,
    });
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(3));
    expect((window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { assets: Array<{ dimensions?: string }> } } }).__GIFP_V3_DEV__?.snapshot().assets[0]?.dimensions).toBe("1920 × 1080");
  });

  it("retries timeline thumbnails without probing the media again", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/timeline-retry.gif"]);
    mocks.inspectMedia.mockResolvedValueOnce({
      codec: "gif", width: 640, height: 360, duration: 3.2,
      frame_count: 48, animated: true, has_alpha: false,
    });
    mocks.generateMediaThumbnails
      .mockRejectedValueOnce(new Error("thumbnail worker failed"))
      .mockResolvedValueOnce([{ time: 0.2, path: "C:/temp/retried-frame.jpg" }]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    const recovery = await screen.findByRole("group", { name: "timeline-retry.gif 素材恢复" });
    await user.click(within(recovery).getByRole("button", { name: /重试关键帧/ }));

    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledTimes(2));
    expect(mocks.inspectMedia).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("group", { name: "timeline-retry.gif 素材恢复" })).not.toBeInTheDocument());
    const snapshot = (window as Window & { __GIFP_V3_DEV__?: { snapshot: () => { assets: Array<{ thumbnailUrl?: string }> } } }).__GIFP_V3_DEV__?.snapshot();
    expect(snapshot?.assets[0]?.thumbnailUrl).toContain("retried-frame.jpg");
  });

  it("keeps the three product generation modes in GIFP 3.2 alpha", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    const options = within(screen.getByRole("radiogroup", { name: "生成方式" })).getAllByRole("radio");
    expect(options.map((option) => option.closest("label")?.textContent)).toEqual([
      expect.stringContaining("快速 GIF"),
      expect.stringContaining("最佳 GIF"),
      expect.stringContaining("精确体积"),
    ]);
  });

  it("restores the four GIF algorithms and forwards the selected route", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/opaque.gif"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("opaque.gif")).length).toBeGreaterThan(0);
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));

    await openSection(user, "编码覆盖");
    const trigger = screen.getByRole("button", { name: /^高级编码算法/ });
    await user.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("保持原貌"),
      expect.stringContaining("色彩增强"),
      expect.stringContaining("自动选择"),
      expect.stringContaining("降噪平滑"),
    ]);
    await user.click(screen.getByRole("option", { name: /自动选择/ }));
    await user.click(screen.getByRole("button", { name: "关闭手动覆盖" }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      output_format: "gif",
      encoder: "hybrid",
    }));
  });

  it("keeps the advanced format menu compact and restores its GIF algorithm selector", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await openSection(user, "编码覆盖");
    const algorithm = screen.getByRole("button", { name: /^高级编码算法/ });
    expect(algorithm).toHaveTextContent("色彩增强");
    await user.click(algorithm);
    const algorithmList = screen.getByRole("listbox", { name: "高级编码算法选项" });
    expect(within(algorithmList).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("保持原貌"),
      expect.stringContaining("色彩增强"),
      expect.stringContaining("自动选择"),
      expect.stringContaining("降噪平滑"),
    ]);
    await user.click(within(algorithmList).getByRole("option", { name: /降噪平滑/ }));
    expect(algorithm).toHaveTextContent("降噪平滑");

    await openSection(user, "智能输出");
    const format = screen.getByRole("button", { name: /^主输出格式/ });
    await user.click(format);
    const formatList = screen.getByRole("listbox", { name: "主输出格式选项" });
    expect(within(formatList).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("智能跟随推荐"),
      expect.stringContaining("GIF"),
      expect.stringContaining("Animated WebP"),
      expect.stringContaining("Animated AVIF"),
      expect.stringContaining("APNG"),
      expect.stringContaining("MP4"),
      expect.stringContaining("WebM"),
      expect.stringContaining("实况照片（Live Photo）"),
      expect.stringContaining("全部格式"),
    ]);
    expect(within(formatList).getByText(/聊天粘贴与未知平台/)).toBeVisible();
  });

  it("locks transparent GIFs to the alpha-safe route and explains format alpha behavior", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/transparent.gif"]);
    mocks.inspectMedia.mockResolvedValue({
      codec: "gif",
      width: 320,
      height: 240,
      duration: 2,
      frame_count: 24,
      animated: true,
      has_alpha: true,
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("transparent.gif")).length).toBeGreaterThan(0);

    await openSection(user, "编码覆盖");
    const advancedAlgorithm = screen.getByRole("button", { name: /^高级编码算法/ });
    expect(advancedAlgorithm).toBeDisabled();
    expect(advancedAlgorithm).toHaveTextContent("保持原貌");
    expect(screen.getByText(/已保留透明通道，编码选项已自动适配/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "关闭手动覆盖" }));

    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({ encoder: "ffmpeg_fast" }));

    await user.click(screen.getByRole("button", { name: /^主输出格式/ }));
    await user.click(screen.getByRole("option", { name: /Animated WebP/ }));
    expect(screen.getByText("透明通道：可保留")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("当前格式会保留透明通道");

    await user.click(screen.getByRole("button", { name: /^主输出格式/ }));
    await user.click(screen.getByRole("option", { name: /Animated AVIF/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("当前 AVIF 不支持透明素材");
  });

  it("keeps every output format directly available in the output plan", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    const format = screen.getByRole("button", { name: /主输出格式/ });
    expect(format).toHaveTextContent("GIF");
    await user.click(format);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("智能跟随推荐"),
      expect.stringContaining("GIF"),
      expect.stringContaining("Animated WebP"),
      expect.stringContaining("Animated AVIF"),
      expect.stringContaining("APNG"),
      expect.stringContaining("MP4"),
      expect.stringContaining("WebM"),
      expect.stringContaining("实况照片"),
      expect.stringContaining("全部格式"),
    ]);

    await user.click(screen.getByRole("option", { name: /Animated WebP/ }));
    expect(screen.getByRole("button", { name: /主输出格式.*Animated WebP/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /生成 WEBP/ })).toBeVisible();
    expect(screen.queryByRole("radiogroup", { name: "生成方式" })).not.toBeInTheDocument();
    expect(screen.getAllByText("libwebp_anim").length).toBeGreaterThan(0);
    expect(screen.getByText(/有损 Animated WebP/)).toBeVisible();
    expect(screen.getByText("透明通道：可保留")).toBeVisible();

    await openSection(user, "编码覆盖");
    expect(screen.getByText("压缩强度（0 无损；1–100 有损）")).toBeVisible();
    expect(screen.getByRole("button", { name: /^WebP 优化级别/ })).toBeVisible();
    expect(screen.getByText(/0 为无损；数值越高，文件通常越小/)).toBeVisible();
  });

  it("forwards WebP lossless and optimization controls to the real request", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/webp-controls.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("webp-controls.mp4")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^主输出格式/ }));
    await user.click(screen.getByRole("option", { name: /Animated WebP/ }));
    await openSection(user, "编码覆盖");
    fireEvent.change(screen.getByLabelText("现代格式压缩强度"), { target: { value: "0" } });
    await chooseAnimatedOption(user, "WebP 优化级别", /4 · 最深/);
    await user.click(screen.getByRole("button", { name: "关闭手动覆盖" }));
    await user.click(screen.getByRole("button", { name: /生成 WEBP/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      output_format: "webp",
      lossy: 0,
      optimize_level: 4,
    }));
  });

  it("exposes 4.0 delivery intents and explicit modern formats", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await openSection(user, "交付与文件");
    expect(screen.getByRole("dialog", { name: "手动覆盖" })).toBeVisible();
    expect(screen.queryByText("输出设置")).not.toBeInTheDocument();
    const intent = screen.getByRole("radiogroup", { name: "交付意图" });
    expect(within(intent).getAllByRole("radio").map((option) => option.closest("label")?.textContent)).toEqual([
      expect.stringContaining("智能推荐"),
      expect.stringContaining("最大兼容"),
      expect.stringContaining("现代动图"),
      expect.stringContaining("视频"),
      expect.stringContaining("目标平台"),
    ]);

    await user.click(within(intent).getByRole("radio", { name: /目标平台/ }));
    await chooseAnimatedOption(user, "目标平台", /透明 UI/);
    await chooseAnimatedOption(user, "输出格式", /^APNG/);
    expect(screen.getByRole("button", { name: /生成 APNG/ })).toBeVisible();
    expect(screen.queryByLabelText(/启用绿幕抠图/)).not.toBeInTheDocument();
  });

  it("integrates cutout providers in one column and sends real color-key settings", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/green-screen.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(screen.getAllByText("green-screen.mp4").length).toBeGreaterThan(0));
    await openSection(user, "抠图");

    const providers = screen.getByRole("radiogroup", { name: "抠图来源" });
    expect(within(providers).getAllByRole("radio").map((option) => option.closest("label")?.textContent)).toEqual([
      expect.stringContaining("不新增抠图"),
      expect.stringContaining("色键背景"),
    ]);
    await user.click(within(providers).getByRole("radio", { name: /色键背景/ }));

    fireEvent.change(screen.getByLabelText("抠图背景色"), { target: { value: "#0000ff" } });
    fireEvent.change(screen.getByLabelText("抠图颜色容差"), { target: { value: "31" } });
    fireEvent.change(screen.getByLabelText("抠图边缘融合"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("抠图去溢色"), { target: { value: "48" } });
    await user.click(screen.getByRole("button", { name: /生成 GIF/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      input_path: videoPath,
      output_format: "gif",
      background_removal: {
        mode: "color_key",
        key_color: "#0000FF",
        similarity: 0.31,
        edge_blend: 0.12,
        despill: 0.48,
      },
    }));
  });

  it("keeps cutout detailed-only and clears it before every quick export", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/quick-with-stale-cutout.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(screen.getAllByText("quick-with-stale-cutout.mp4").length).toBeGreaterThan(0));
    await openSection(user, "抠图");
    const providers = screen.getByRole("radiogroup", { name: "抠图来源" });
    await user.click(within(providers).getByRole("radio", { name: /色键背景/ }));

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    expect(screen.queryByRole("button", { name: "抠图" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      input_path: videoPath,
      background_removal: null,
    }));
  });

  it("offers Live Photo without presenting an unverified JPG and MOV pair as compatible", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await chooseAnimatedOption(user, "输出格式", /实况照片/);
    const generateLivePhoto = screen.getByRole("button", { name: /生成 Live Photo/ });
    expect(generateLivePhoto).toBeDisabled();
    expect(generateLivePhoto).toHaveAttribute("title", "正在检查 Live Photo 组件。");
    expect(screen.queryByText("Apple 配对契约已本地验证")).not.toBeInTheDocument();
    expect(mocks.convertAnimation).not.toHaveBeenCalled();
  });

  it("does not leak GIF target-size mode into a Live Photo export", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/live-source.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    mocks.listEncoderCapabilities.mockResolvedValue([{
      id: "ffmpeg.animation",
      status: { state: "available", executable_path: "C:/tools/ffmpeg.exe", version: "test" },
      formats: ["gif", "live_photo"],
    }]);
    mocks.convertAnimation.mockResolvedValueOnce({
      ...exportResult("C:/exports/live-source.pvt", 900_000, 420, "live_photo"),
      backend_id: "gifp.live_photo",
      live_photo: {
        still_path: "C:/exports/live-source.pvt/IMG_TEST.JPG",
        motion_path: "C:/exports/live-source.pvt/IMG_TEST.MOV",
        asset_identifier: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        asset_identifier_verified: true,
        metadata_pairing_verified: true,
        compatibility_status: "locally_verified",
        validation_scope: "local_contract",
      },
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("live-source.mp4")).length).toBeGreaterThan(0);
    await chooseAnimatedOption(user, "交付意图", /最大兼容/);
    await chooseAnimatedOption(user, "生成方式", /精确体积/);
    await chooseAnimatedOption(user, "输出格式", /实况照片/);
    await user.click(screen.getByRole("button", { name: /生成 Live Photo/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      input_path: videoPath,
      output_format: "live_photo",
      generation_mode: "fast_gif",
      target_size_bytes: null,
    }));
    expect((await screen.findAllByText("Apple 配对契约已本地验证")).length).toBeGreaterThan(0);
  }, 10_000);

  it("maps backend registry availability into visible product status", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.listEncoderCapabilities.mockResolvedValue([
      { id: "ffmpeg.animation", status: { state: "available", executable_path: "C:/tools/ffmpeg.exe", version: "test" } },
      { id: "rust.perceptual", status: { state: "available", executable_path: null, version: "3.2.0-alpha.4" }, features: { perceptual_quantization: true } },
    ]);
    mocks.selectVideos.mockResolvedValue(["C:/media/backend-status.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await screen.findAllByText("backend-status.mp4");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    await openSection(user, "编码报告");
    expect(await screen.findByText("转换引擎：可用")).toBeVisible();
    expect(screen.getByText("感知优化：可用")).toBeVisible();
    expect(screen.queryByText(/gifski/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("启用逐帧调色板实验")).not.toBeInTheDocument();
  });

  it("keeps generation mode independent from picture presets", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    const mode = await chooseAnimatedOption(user, "生成方式", /精确体积/);
    await openSection(user, "基础预设");
    await user.click(screen.getByRole("button", { name: /压缩预设/ }));
    await user.click(screen.getByRole("option", { name: /极小包/ }));

    expect(mode).toHaveTextContent("精确体积");
    expect(screen.getByRole("group", { name: "最大输出体积" })).toBeVisible();
    expect(screen.getByLabelText("最大输出体积（MB）")).toHaveValue(2);
  });

  it("forces Bayer for fast and target modes while best mode respects selection", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);
    await openSection(user, "编码覆盖");
    const mode = screen.getByRole("radiogroup", { name: "生成方式" });
    const dither = screen.getByRole("button", { name: /^抖动/ });
    const bayerScale = screen.getByLabelText(/^Bayer 尺度$/);

    expect(dither).toBeEnabled();
    await chooseAnimatedOption(user, "抖动", /Floyd 细节/);
    expect(dither).toHaveTextContent("Floyd 细节");
    expect(bayerScale).toBeDisabled();

    await chooseAnimatedOption(user, "生成方式", /快速 GIF/);
    expect(dither).toBeDisabled();
    expect(dither).toHaveTextContent("Bayer 小体积");
    expect(bayerScale).toBeEnabled();

    await chooseAnimatedOption(user, "生成方式", /精确体积/);
    expect(mode).toHaveTextContent("精确体积");
    expect(dither).toBeDisabled();
    expect(dither).toHaveTextContent("Bayer 小体积");
  });

  it("keeps all twelve filter choices in detailed edit", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await openSection(user, "编码覆盖");
    await user.click(screen.getByRole("button", { name: /^滤镜/ }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "原味",
      "鲜亮抗灰",
      "暖肤柔光",
      "清冷蓝调",
      "高反差黑白",
      "复古胶片",
      "柔和哑光",
      "漫画锐线",
      "GB 绿屏",
      "GBA LCD",
      "CRT 扫描线",
      "像素海报",
    ]);
  });

  it("keeps all four dithering choices in detailed edit", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await openSection(user, "编码覆盖");
    expect(screen.getByLabelText(/^颜色上限$/)).toHaveAttribute("min", "3");
    await user.click(screen.getByRole("button", { name: /^抖动/ }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Sierra 高质量",
      "Floyd 细节",
      "Bayer 小体积",
      "无抖动",
    ]);
  });

  it("uses the three-color minimum in merge production", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^合并制作$/ }));
    expect(screen.getByLabelText("合并颜色数")).toHaveAttribute("min", "3");
  });

  it("keeps one clear export action and removes candidate and batch surfaces", () => {
    render(<GifpV3 />);

    expect(screen.getByRole("button", { name: /^生成 GIF$/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /生成\s*3\s*个候选/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量生成全部/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/候选结果（0）/)).not.toBeInTheDocument();
    expect(document.querySelector(".candidate-panel")).toBeNull();
  });

  it("keeps implementation notes and retired slogans out of the product UI", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    expect(screen.getByText(PRODUCT_VERSION)).toBeVisible();
    expect(screen.getByText("acekanon")).toBeVisible();
    expect(screen.queryByText(/智能动画交付/)).not.toBeInTheDocument();
    expect(screen.queryByText(/保留 2\.3 全部预设/)).not.toBeInTheDocument();
    expect(screen.queryByText(/三个真实导出结果/)).not.toBeInTheDocument();
    expect(screen.queryByText(/不再复用源视频假装候选/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    expect(screen.queryByText(/快速生成只保留高频选择/)).not.toBeInTheDocument();
    expect(screen.getByText("已有推荐，也可以直接生成")).toBeVisible();
  });

  it("keeps retired dynamic-poster, release-status, and platform-verification surfaces out of the main UI", () => {
    render(<GifpV3 />);

    expect(screen.queryByRole("button", { name: "动态海报" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看发行可信度" })).not.toBeInTheDocument();
    expect(screen.queryByText("发行受阻")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "发行可信度" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看平台交付验证" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "真实平台交付验证" })).not.toBeInTheDocument();
  });

  it("keeps browser fallback completion copy user-facing", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    expect(await screen.findAllByText("已生成")).toHaveLength(1);
    expect(screen.queryByText(/演示|桌面版|真实结果/)).not.toBeInTheDocument();
  });

  it("keeps a one-shot desktop export visibly active while the backend is still encoding", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/slow-export.mp4"]);
    let resolveConversion: (value: ReturnType<typeof exportResult>) => void = () => undefined;
    mocks.convertAnimation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveConversion = resolve as (value: ReturnType<typeof exportResult>) => void;
    }));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("slow-export.mp4")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));

    const progress = screen.getByRole("progressbar", { name: "生成进度" });
    const initial = Number(progress.getAttribute("aria-valuenow"));
    expect(initial).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(Number(progress.getAttribute("aria-valuenow"))).toBeGreaterThan(initial), { timeout: 2_000 });
    expect(progress.getAttribute("title")).toContain("进度为估算");

    resolveConversion(exportResult("C:/exports/slow/slow-export.gif", 640_000, 420));
    await waitFor(() => expect(progress).toHaveAttribute("aria-valuenow", "100"));
  });

  it("stops accepting a late desktop result and skips quality scoring after cancellation", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/cancel-export.mp4"]);
    let resolveConversion: (value: ReturnType<typeof exportResult>) => void = () => undefined;
    mocks.convertAnimation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveConversion = resolve as (value: ReturnType<typeof exportResult>) => void;
    }));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /停止任务/ }));
    const taskId = mocks.convertAnimation.mock.calls[0]?.[0]?.task_id;
    expect(taskId).toMatch(/^gifp-/);
    await waitFor(() => expect(mocks.cancelConversionTask).toHaveBeenCalledWith(taskId));
    expect(screen.getAllByText(/已终止 1 个编码进程/).length).toBeGreaterThan(0);

    resolveConversion(exportResult("C:/exports/cancel/late.gif", 720_000, 420));
    await screen.findByText("已停止");
    expect(mocks.evaluateOutputQuality).not.toHaveBeenCalled();
    expect(presentedDevSnapshot()).toBeUndefined();
    expect(screen.getAllByText("等待").length).toBeGreaterThan(0);
  });

  it("offers a dedicated score cancellation button and keeps the encoded result", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/cancel-quality.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/cancel/quality.gif", 720_000, 420));
    let resolveQuality: (value: OutputQualityReport) => void = () => undefined;
    mocks.evaluateOutputQuality.mockImplementationOnce(() => new Promise((resolve) => {
      resolveQuality = resolve as (value: OutputQualityReport) => void;
    }));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.evaluateOutputQuality).toHaveBeenCalledTimes(1));
    const conversionTaskId = mocks.convertAnimation.mock.calls[0]?.[0]?.task_id;
    const qualityTaskId = mocks.evaluateOutputQuality.mock.calls[0]?.[0]?.encode_request?.task_id;
    expect(conversionTaskId).toMatch(/^gifp-/);
    expect(qualityTaskId).toMatch(/^gifp-/);
    expect(qualityTaskId).not.toBe(conversionTaskId);

    expect(screen.getByText("评分中 · 成品可用")).toBeInTheDocument();
    expect(presentedDevSnapshot()?.outputPath).toBe("C:/exports/cancel/quality.gif");
    expect(screen.getByRole("progressbar", { name: "生成进度" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "打开位置" }));
    expect(mocks.openDirectory).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "终止评分" }));
    await waitFor(() => expect(mocks.cancelConversionTask).toHaveBeenCalledWith(qualityTaskId));
    expect(mocks.cancelConversionTask).not.toHaveBeenCalledWith(conversionTaskId);
    resolveQuality({
      status: "measured",
      metric_model: "late quality",
      sample_duration_seconds: 3.2,
      compared_frames: 96,
      vmaf_mean: 99,
      vmaf_p05: 98,
      ssim_mean: 0.999,
      ms_ssim_mean: 0.999,
      elapsed_ms: 1,
      message: null,
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: "终止评分" })).not.toBeInTheDocument());
    expect(presentedDevSnapshot()?.outputPath).toBe("C:/exports/cancel/quality.gif");
    expect(screen.queryByText("late quality")).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(localStorage.getItem("gifp.history.v3") || "[]")[0]?.quality_report?.status).toBe("unavailable"));
  });

  it("keeps a usable result when optional background quality scoring fails", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/quality-error.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/quality-error.gif", 720_000, 420));
    mocks.evaluateOutputQuality.mockRejectedValueOnce(new Error("score process failed"));
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("gifp.history.v3") || "[]")[0]?.quality_report?.status).toBe("unavailable"));
    expect(presentedDevSnapshot()?.outputPath).toBe("C:/exports/quality-error.gif");
    expect(screen.getByRole("button", { name: "打开位置" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ })).toBeEnabled();
    expect(screen.queryByText(/生成失败：/)).not.toBeInTheDocument();
  });

  it("prioritizes a new export and prevents late scores from replacing its result or scoring state", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/score-race.mp4"]);
    mocks.convertAnimation
      .mockResolvedValueOnce(exportResult("C:/exports/first.gif", 720_000, 420))
      .mockResolvedValueOnce(exportResult("C:/exports/second.gif", 640_000, 420));
    const resolveScores: Array<(report: OutputQualityReport) => void> = [];
    mocks.evaluateOutputQuality.mockImplementation(() => new Promise<OutputQualityReport>((resolve) => resolveScores.push(resolve)));
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(resolveScores).toHaveLength(1));
    const firstTaskId = mocks.evaluateOutputQuality.mock.calls[0][0].encode_request.task_id;
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(resolveScores).toHaveLength(2));
    expect(mocks.cancelConversionTask).toHaveBeenCalledWith(firstTaskId);
    const report: OutputQualityReport = {
      status: "measured", metric_model: "VMAF NEG v0.6.1 · float SSIM",
      sample_duration_seconds: 3.2, compared_frames: 96,
      vmaf_mean: 95, vmaf_p05: 90, ssim_mean: 0.98, ms_ssim_mean: 0.97,
      elapsed_ms: 20, message: null,
    };
    await act(async () => resolveScores[0]({ ...report, vmaf_mean: 1 }));
    expect(presentedDevSnapshot()?.outputPath).toBe("C:/exports/second.gif");
    expect(screen.getByRole("button", { name: "终止评分" })).toBeEnabled();
    await act(async () => resolveScores[1](report));
    const history = JSON.parse(localStorage.getItem("gifp.history.v3") || "[]");
    expect(history.map((item: { output_path: string }) => item.output_path)).toEqual(["C:/exports/second.gif", "C:/exports/first.gif"]);
    expect(history[0].quality_report.vmaf_mean).toBe(95);
    expect(history[1].quality_report).toBeUndefined();
    expect(screen.queryByRole("button", { name: "终止评分" })).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "生成进度" })).toHaveAttribute("aria-valuenow", "100");
  });

  it("makes the quick wizard result usable while scoring and adds the score without leaving the result", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/quick-score.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/quick-score.gif", 640_000, 420));
    let resolveQuality!: (report: OutputQualityReport) => void;
    mocks.evaluateOutputQuality.mockImplementationOnce(() => new Promise<OutputQualityReport>((resolve) => { resolveQuality = resolve; }));
    render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));
    await waitFor(() => expect(mocks.evaluateOutputQuality).toHaveBeenCalledTimes(1));
    expect(within(dialog).getByText("评分中 · 成品可用")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "终止评分" })).toBeEnabled();
    const openResult = within(dialog).getByRole("button", { name: "打开目录" });
    expect(openResult).toBeEnabled();
    await user.click(openResult);
    expect(mocks.openDirectory).toHaveBeenCalled();
    await act(async () => resolveQuality({
      status: "measured", metric_model: "VMAF NEG v0.6.1 · float SSIM",
      sample_duration_seconds: 3.2, compared_frames: 96,
      vmaf_mean: 95, vmaf_p05: 90, ssim_mean: 0.98, ms_ssim_mean: 0.97,
      elapsed_ms: 20, message: null,
    }));
    expect(within(dialog).getByRole("group", { name: "生成质量评分" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "终止评分" })).not.toBeInTheDocument();
    expect(openResult).toBeEnabled();
  });

  it("stops background scoring on unmount without accepting a late report", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/closing.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/closing.gif", 640_000, 420));
    let rejectQuality!: (error: Error) => void;
    mocks.evaluateOutputQuality.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQuality = reject; }));
    const view = render(<GifpV3 />);
    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.evaluateOutputQuality).toHaveBeenCalledTimes(1));
    const historyBeforeClose = localStorage.getItem("gifp.history.v3");
    const taskId = mocks.evaluateOutputQuality.mock.calls[0][0].encode_request.task_id;
    view.unmount();
    expect(mocks.cancelConversionTask).toHaveBeenCalledWith(taskId);
    await act(async () => rejectQuality(new Error("closed")));
    expect(localStorage.getItem("gifp.history.v3")).toBe(historyBeforeClose);
  });

  it("keeps the selected quick scale and FPS as hard GIF output constraints without a 2 MB target", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/chat-export.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    expect(within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" })).toBeVisible();
    const scaleSlider = within(dialog).getByRole("slider", { name: "快速生成缩放比例" });
    const fpsSlider = within(dialog).getByRole("slider", { name: "快速生成帧率" });
    await waitFor(() => expect(scaleSlider).toHaveValue("75"));
    expect(fpsSlider).toHaveValue("12");
    fireEvent.change(scaleSlider, { target: { value: "50" } });
    fireEvent.change(fpsSlider, { target: { value: "8" } });
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).toHaveTextContent("生成后显示实际大小");
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).toHaveTextContent("320 × 180 · 8 FPS");
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).not.toHaveTextContent(/~\d+(\.\d+)? MB/);
    const formatGroup = within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" });
    expect(within(formatGroup).getByRole("radio", { name: /^GIF/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /^画质优先/ })).toBeChecked();
    expect(within(dialog).getByText(/不设大小上限/)).toBeVisible();
    expect(within(dialog).getByRole("switch", { name: "质量评分" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    const request = mocks.convertAnimation.mock.calls[0][0];
    expect(request).toMatchObject({
      input_path: videoPath,
      output_format: "gif",
      generation_mode: "best_gif",
      width: 320,
      fps: 8,
      target_size_bytes: null,
      background_removal: null,
    });
    const qualityStamps = await within(dialog).findByRole("group", { name: "生成质量评分" });
    expect(within(qualityStamps).getByLabelText("VMAF 91.4，优秀")).toBeVisible();
    expect(within(qualityStamps).getByLabelText("SSIM 0.974，清晰")).toBeVisible();
    expect(within(dialog).getByText("已生成")).toBeVisible();
    expect(within(dialog).queryByText(/真实成品已生成|成品实测质量|仅界面展示|平台交付/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("成品已经准备好。")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("100%")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("accepts a fixed quick width and keeps the scale slider synchronized", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/fixed-width.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    const widthInput = within(dialog).getByRole("spinbutton", { name: "快速生成固定宽度" });
    const scaleSlider = within(dialog).getByRole("slider", { name: "快速生成缩放比例" });

    await user.click(widthInput);
    await user.keyboard("{Control>}a{/Control}510");
    expect(widthInput).toHaveValue(510);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(scaleSlider).toHaveValue("80"));
    expect(widthInput).toHaveValue(510);
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).toHaveTextContent("510 × 286 · 12 FPS");
  });

  it("lets confirmation disable quality scoring before generation", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/no-score.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });

    const qualitySwitch = within(dialog).getByRole("switch", { name: "质量评分" });
    expect(qualitySwitch).toBeChecked();
    await user.click(qualitySwitch);
    expect(qualitySwitch).not.toBeChecked();
    expect(within(dialog).getByText("关闭")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(dialog).getByText("已生成")).toBeVisible());
    expect(mocks.evaluateOutputQuality).not.toHaveBeenCalled();
    expect(screen.queryByText("编码完成，正在打分中")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "生成质量评分" })).not.toBeInTheDocument();
  });

  it("offers a clearly named target-size mode with a direct MB hard cap", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/quick-target.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });

    expect(within(dialog).queryByRole("slider", { name: "快速生成播放速度滑杆" })).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Tight-cap")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("快速生成最大输出体积（MB）")).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole("switch", { name: "限制文件大小" }));
    const targetCap = within(dialog).getByRole("group", { name: "最大输出体积" });
    await user.clear(within(targetCap).getByLabelText("快速生成最大输出体积（MB）"));
    await user.type(within(targetCap).getByLabelText("快速生成最大输出体积（MB）"), "1.5");
    await user.click(within(dialog).getByText("用在哪里"));
    expect(within(targetCap).getByLabelText("快速生成最大输出体积（MB）")).toHaveValue(1.5);
    expect(within(dialog).getByText(/输出规格：.*最大 1\.5 MB/)).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toEqual(expect.objectContaining({
      input_path: videoPath,
      generation_mode: "target_size",
      target_size_bytes: Math.round(1.5 * 1024 * 1024),
    }));
    expect(mocks.convertAnimation.mock.calls[0][0]).not.toHaveProperty("fast_baseline_size_bytes");
  });

  it("applies the quick GIF algorithm and manual picture controls without replacing the selected dimensions", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/quick-tuning.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    const scaleSlider = within(dialog).getByRole("slider", { name: "快速生成缩放比例" });
    await waitFor(() => expect(scaleSlider).toHaveValue("75"));
    fireEvent.change(scaleSlider, { target: { value: "50" } });

    expect(within(dialog).queryByText("画面预设")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: /降噪平滑/ }));
    await user.click(within(dialog).getByRole("button", { name: /快速生成抖动算法：Sierra 高质量/ }));
    await user.click(within(dialog).getByRole("option", { name: /无抖动/ }));
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成颜色上限" }), { target: { value: "200" } });
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成有损压缩" }), { target: { value: "10" } });
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toMatchObject({
      input_path: videoPath,
      generation_mode: "best_gif",
      target_size_bytes: null,
      width: 320,
      fps: 12,
      colors: 200,
      dither: "none",
      lossy: 10,
      encoder: "clean_opt",
    });
  });

  it("preserves a quick scale chosen before asynchronous media inspection finishes", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/late-inspection.mp4"]);
    let resolveInspection: (inspection: {
      codec: string;
      width: number;
      height: number;
      duration: number;
      frame_count: number;
      animated: boolean;
      has_alpha: boolean;
    }) => void = () => undefined;
    mocks.inspectMedia.mockImplementationOnce(() => new Promise((resolve) => {
      resolveInspection = resolve;
    }));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成缩放比例" }), { target: { value: "50" } });
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成帧率" }), { target: { value: "8" } });

    resolveInspection({
      codec: "h264",
      width: 640,
      height: 360,
      duration: 3.2,
      frame_count: 48,
      animated: true,
      has_alpha: false,
    });

    await waitFor(() => expect(within(dialog).getByLabelText("输入与输出尺寸")).toHaveTextContent("320 × 180"));
    expect(within(dialog).getByRole("slider", { name: "快速生成缩放比例" })).toHaveValue("50");
    expect(within(dialog).getByRole("slider", { name: "快速生成帧率" })).toHaveValue("8");
  });

  it("settles a failed one-shot export and returns the UI to an actionable state", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/failing-export.mp4"]);
    mocks.convertAnimation.mockRejectedValueOnce(new Error("ffmpeg export failed C:/private/client.mp4 https://example.test/?access_token=secret-canary"));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("failing-export.mp4")).length).toBeGreaterThan(0);
    const generate = screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ });
    await user.click(generate);

    expect((await screen.findAllByText(/生成失败：Error: ffmpeg export failed/)).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "生成进度" })).not.toBeInTheDocument());
    expect(screen.getAllByText("失败").length).toBeGreaterThan(0);
    expect(generate).toBeEnabled();

    const recovery = screen.getByRole("region", { name: "任务失败恢复" });
    expect(within(recovery).getByText(/生成当前动画 · 任务未完成/)).toBeVisible();
    expect(within(recovery).queryByRole("region", { name: "本地技术详情预览" })).not.toBeInTheDocument();
    await user.click(within(recovery).getByRole("button", { name: /复制诊断/ }));
    await within(recovery).findByText(/安全诊断已复制/);
    const diagnostic = await navigator.clipboard.readText();
    expect(diagnostic).toContain(`GIFP 版本：${PRODUCT_VERSION}`);
    expect(diagnostic).not.toContain("C:/media/failing-export.mp4");
    expect(diagnostic).not.toContain("secret-canary");
    expect(diagnostic).not.toContain("技术细节：");

    await user.click(within(recovery).getByRole("button", { name: "查看本地详情" }));
    const localPreview = within(recovery).getByRole("region", { name: "本地技术详情预览" });
    expect(localPreview).toHaveTextContent("secret-canary");
    expect(localPreview).toHaveTextContent("默认“复制诊断”不会包含这里的原始内容");

    await user.click(within(recovery).getByRole("button", { name: /按原参数重试/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("region", { name: "任务失败恢复" })).not.toBeInTheDocument());
  });

  it("puts the primary output action first and hides idle progress", () => {
    render(<GifpV3 />);

    expect(screen.queryByRole("progressbar", { name: "生成进度" })).not.toBeInTheDocument();
    const smartOutput = screen.getByRole("button", { name: /^智能输出/ });
    const rail = smartOutput.closest("aside");
    expect(rail).not.toBeNull();
    if (!rail) throw new Error("right output rail is missing");
    const actions = rail.querySelector('[aria-label="首屏输出操作"]');
    expect(actions).not.toBeNull();
    if (!actions) throw new Error("first-screen output actions are missing");
    expect(rail.firstElementChild).toHaveClass("settings-panel__heading");
    expect(actions.compareDocumentPosition(smartOutput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("frames output as a confirm, generate, and review journey", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/night-export.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(screen.getAllByText("night-export.mp4").length).toBeGreaterThan(0));

    let journey = screen.getByRole("region", { name: "输出流程" });
    expect(within(journey).getByRole("list", { name: "输出流程进度" })).toHaveTextContent(/确认输出.*生成中.*验收成品/);
    expect(within(journey).getByText("确认这次输出")).toBeVisible();
    expect(within(journey).getByLabelText("本次输出摘要")).toHaveTextContent("格式GIF规格420px · 15 FPS · 256 色策略最佳 GIF保存到media");
    const generate = within(journey).getByRole("button", { name: "生成 GIF" });
    expect(generate).toHaveTextContent("确认并生成 GIF");

    await user.click(generate);
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    journey = await screen.findByRole("region", { name: "输出流程" });
    await waitFor(() => expect(within(journey).getByText("成品已准备好")).toBeVisible());
    expect(within(journey).getByText("1.4 MB · 48 帧")).toBeVisible();
    expect(within(journey).getByRole("button", { name: "打开成品位置" })).toBeVisible();
    expect(within(journey).getByRole("button", { name: "生成 GIF（按当前方案重新生成）" })).toBeVisible();
  });

  it("uses one persistent output directory button in detailed and quick generation", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectOutputDir.mockResolvedValue("C:/exports/night-work");
    render(<GifpV3 />);

    let directoryButton = screen.getByRole("button", { name: /输出目录，当前 跟随当前素材目录，点击更改/ });
    expect(directoryButton).toBeVisible();
    await user.click(directoryButton);

    await waitFor(() => expect(mocks.selectOutputDir).toHaveBeenCalledTimes(1));
    directoryButton = screen.getByRole("button", { name: /输出目录，当前 C:\/exports\/night-work，点击更改/ });
    expect(directoryButton).toHaveTextContent("输出目录night-work更改");

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    expect(screen.getByRole("button", { name: /输出目录，当前 C:\/exports\/night-work，点击更改/ })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "输出目录" })).not.toBeInTheDocument();
  });

  it("lets detailed overrides accept a width as continuous typed input", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /手动覆盖/ }));
    await openSection(user, "编码覆盖");
    const widthInput = screen.getByRole("spinbutton", { name: "宽度" });
    await user.clear(widthInput);
    await user.type(widthInput, "768");
    expect(widthInput).toHaveValue(768);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(widthInput).toHaveValue(768));
    expect(screen.getByRole("button", { name: /^编码覆盖/ })).toHaveTextContent("宽度 768px");
  });

  it("offers and remembers the low-luminance paper theme", async () => {
    localStorage.setItem("gifp.theme.v3", "midnight");
    const user = userEvent.setup();
    const { container } = render(<GifpV3 />);

    expect(container.querySelector(".gifp-v3")).toHaveClass("theme-midnight");
    await user.click(screen.getByRole("button", { name: "选择皮肤，当前 深夜护眼" }));
    expect(screen.getByRole("menuitemradio", { name: /深夜护眼/ })).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("menuitemradio", { name: /泡泡手账/ }));
    await waitFor(() => expect(localStorage.getItem("gifp.theme.v3")).toBe("bubble"));
    expect(container.querySelector(".gifp-v3")).toHaveClass("theme-bubble");
  });

  it("shows real CPU, GPU encoder, memory, and logical-core telemetry in the progress rail", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.getRuntimeResourceSnapshot.mockResolvedValueOnce({
      sampled_at_ms: 1_700_000_000_001,
      cpu_usage_percent: 42.4,
      app_cpu_usage_percent: 18.2,
      logical_cpu_count: 24,
      physical_cpu_count: 12,
      total_memory_bytes: 64 * 1024 ** 3,
      used_memory_bytes: 32 * 1024 ** 3,
      app_memory_bytes: 512 * 1024 ** 2,
      active_conversion_jobs: 0,
      gpu_backend: "nvidia_smi",
      gpus: [{ name: "NVIDIA GeForce RTX 3080", usage_percent: 31.2, encoder_usage_percent: 7 }],
      gpu_unavailable_reason: null,
    });
    render(<GifpV3 />);

    await openSection(user, "性能");
    expect(await screen.findByRole("meter", { name: "CPU 总占用" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("meter", { name: "GPU 总占用" })).toHaveAttribute("aria-valuenow", "31");
    expect(screen.getByText("31% · 编码 7%")).toBeVisible();
    expect(screen.getByText(/24 逻辑线程 · FFmpeg 单任务自动多线程 · 内存 50%/)).toBeVisible();
    expect(screen.getByText("NVIDIA GeForce RTX 3080")).toBeVisible();
  });

  it("animates collapsible right-rail sections without losing the selected value", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    const section = screen.getByRole("button", { name: /^智能输出/ });
    expect(section).toHaveAttribute("aria-expanded", "true");
    const mode = await chooseAnimatedOption(user, "生成方式", /精确体积/);
    expect(mode).toHaveTextContent("精确体积");

    await user.click(section);
    expect(section).toHaveAttribute("aria-expanded", "false");
    await user.click(section);
    expect(section).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("radiogroup", { name: "生成方式" })).toHaveTextContent("精确体积");
    expect(screen.getByLabelText("最大输出体积（MB）")).toHaveValue(2);
  });

  it("offers one trim rail with independent start and end handles", () => {
    render(<GifpV3 />);

    const startHandle = screen.getByLabelText("开始时间");
    const endHandle = screen.getByLabelText("结束时间");
    expect(startHandle).toHaveAttribute("type", "range");
    expect(endHandle).toHaveAttribute("type", "range");
    expect(startHandle.closest(".trim-range__rail")).toBe(endHandle.closest(".trim-range__rail"));
  });

  it("maps one outer timeline dot to one exact output frame", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    const drawerButton = screen.getByRole("button", { name: "逐帧编辑（0）" });
    expect(drawerButton).toBeEnabled();
    await user.click(screen.getAllByRole("button", { name: /秒关键帧/ })[0]);
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));

    expect(screen.getByRole("button", { name: "逐帧编辑（1）" })).toBeEnabled();
    expect(screen.getByText(/已删除 1 帧 · 导出 5\.73s/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "逐帧编辑（1）" }));
    expect(screen.getByRole("dialog", { name: "逐帧编辑" })).toBeVisible();
    expect(screen.getByText("导出已移除 1 帧")).toBeVisible();
  });

  it("supports selecting multiple exact frames and deleting them in one action", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "逐帧编辑（0）" }));
    const dialog = screen.getByRole("dialog", { name: "逐帧编辑" });
    const samples = within(dialog).getAllByRole("button", { name: /^第 \d+ 帧/ });

    await user.click(samples[0]);
    await user.click(samples[1]);

    expect(samples[0]).toHaveAttribute("aria-pressed", "true");
    expect(samples[1]).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("已选择 2 帧")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "删除所选帧（2）" }));

    expect(screen.getByRole("button", { name: "逐帧编辑（2）" })).toBeEnabled();
    expect(dialog.querySelectorAll(".frame-grid button.removed")).toHaveLength(2);
    expect(within(dialog).getByText("已选择 0 帧")).toBeVisible();
  });

  it("supports Shift range selection and paginates the real output frame list", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "逐帧编辑（0）" }));
    const dialog = screen.getByRole("dialog", { name: "逐帧编辑" });
    const firstPageFrames = await within(dialog).findAllByRole("button", { name: /^第 \d+ 帧/ });
    await user.click(firstPageFrames[0]);
    fireEvent.click(firstPageFrames[4], { shiftKey: true });

    expect(within(dialog).getByText("已选择 5 帧")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "下一页 →" }));
    expect(await within(dialog).findByRole("button", { name: /^第 37 帧/ })).toBeVisible();
    expect(dialog.querySelector(".frame-drawer-pagination")).toHaveTextContent("第 2 / 3 页");
  });

  it("manually samples every Nth output frame while preserving duration and boundaries", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "逐帧编辑（0）" }));
    const dialog = screen.getByRole("dialog", { name: "逐帧编辑" });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "抽帧间隔" }), { target: { value: "3" } });
    await user.click(within(dialog).getByRole("checkbox", { name: "保持原总时长" }));
    await user.click(within(dialog).getByRole("button", { name: "应用抽帧" }));

    expect(within(dialog).getByRole("button", { name: /保持总时长/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("导出已移除 57 帧")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: /^第 1 帧/ })).not.toHaveClass("removed");
    await user.click(within(dialog).getByRole("button", { name: "末页" }));
    expect(await within(dialog).findByRole("button", { name: /^第 87 帧/ })).not.toHaveClass("removed");
    expect(screen.getByText(/已删除 57 帧 · 保持 5\.80s/)).toBeVisible();
  });

  it("adds a real export annotation to the selected timeline segment", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getAllByRole("button", { name: /秒关键帧/ })[0]);
    await user.click(screen.getByRole("button", { name: "添加标注" }));
    const dialog = screen.getByRole("dialog", { name: "添加文字标注" });
    const copy = within(dialog).getByLabelText("标注内容");
    await user.clear(copy);
    await user.type(copy, "注意这里");
    expect(within(dialog).getByRole("radio", { name: /所选连续片段/ })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "应用标注到导出" }));

    expect(screen.getByLabelText("当前文字标注预览")).toHaveTextContent("注意这里");
    expect(screen.getByRole("button", { name: "编辑标注" })).toBeEnabled();
  });

  it("keeps at least one playable frame when every frame is selected", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "逐帧编辑（0）" }));
    const dialog = screen.getByRole("dialog", { name: "逐帧编辑" });
    await user.click(within(dialog).getByRole("button", { name: "全选" }));
    await user.click(within(dialog).getByRole("button", { name: "删除所选帧（87）" }));

    expect(dialog.querySelectorAll(".frame-grid button.removed")).toHaveLength(0);
    expect(screen.getByText(/至少需要保留一个可播放输出帧/, { selector: ".timeline-feedback" })).toHaveAttribute("role", "status");
  });

  it("shows one dot per exact frame and aligns the trim rail with the frame-dot column", () => {
    const { container } = render(<GifpV3 />);
    const timeline = container.querySelector(".timeline");
    const track = timeline?.querySelector(".frame-dot-track");
    const footer = timeline?.querySelector(".timeline-footer");

    expect(track).toHaveAttribute("aria-label", "真实帧点时间线");
    expect(track?.querySelectorAll("button")).toHaveLength(87);
    expect(timeline?.querySelector(".frame-strip")).not.toBeInTheDocument();
    expect(timeline?.querySelector(".frame-dot-scale")).toHaveTextContent("每个点对应 1 个真实输出帧");
    expect(footer?.firstElementChild).toHaveClass("timeline-footer__spacer");
    expect(footer?.querySelector(".trim-range")).toBeInTheDocument();
  });

  it("enlarges the exact frame on dot hover with source and compacted output time", async () => {
    render(<GifpV3 />);
    const track = screen.getByRole("listbox", { name: "真实帧点时间线" });
    const dots = within(track).getAllByRole("button", { name: /秒关键帧/ });

    fireEvent.pointerEnter(dots[4]);

    const preview = await screen.findByRole("tooltip");
    expect(preview).toHaveTextContent("第 5 帧");
    expect(preview).toHaveTextContent("源 0.267s · 成品 0.267s");
    expect(preview.querySelector("img")).toHaveAttribute("src");
  });

  it("box-selects a frame range and reflows the outer compact timeline after deletion", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);
    const track = screen.getByRole("listbox", { name: "真实帧点时间线" });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 870,
      bottom: 36,
      width: 870,
      height: 36,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(track, { pointerId: 7, button: 0, clientX: 100 });
    fireEvent.pointerMove(track, { pointerId: 7, button: 0, clientX: 300 });
    fireEvent.pointerUp(track, { pointerId: 7, button: 0, clientX: 300 });

    expect(screen.getByRole("button", { name: "删除所选帧（21）" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "删除所选帧（21）" }));
    const compactedDots = within(track).getAllByRole("button", { name: /秒关键帧/ });
    expect(compactedDots).toHaveLength(66);
    expect(screen.getByRole("progressbar", { name: "删除后导出长度" })).toHaveAttribute("aria-valuenow", "76");

    fireEvent.pointerEnter(compactedDots[10]);
    const preview = await screen.findByRole("tooltip");
    expect(preview).toHaveTextContent("第 32 帧");
    expect(preview).toHaveTextContent("源 2.067s · 成品 0.667s");
  });

  it("links an exact deleted frame to playback, range preview, and the compacted export bar", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/playback-delete.mp4"]);
    mocks.inspectMedia.mockResolvedValue({
      codec: "h264",
      width: 640,
      height: 360,
      duration: 6,
      frame_count: 180,
      animated: true,
      has_alpha: false,
    });
    mocks.generateMediaThumbnails.mockImplementation(async ({ times }: { times: number[] }) =>
      times.map((time, index) => ({ time, path: `C:/thumbs/playback-${index}.jpg` })),
    );
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));
    const video = screen.getByLabelText("playback-delete.mp4 视频预览") as HTMLVideoElement;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 6 },
      videoWidth: { configurable: true, value: 640 },
      videoHeight: { configurable: true, value: 360 },
    });
    fireEvent.loadedMetadata(video);
    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledTimes(1));
    const firstSample = await screen.findByRole("button", { name: /0\.27 秒关键帧/ });
    await user.click(firstSample);
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));

    const compactedBar = screen.getByRole("progressbar", { name: "删除后导出长度" });
    expect(compactedBar).toHaveAttribute("aria-valuenow", "99");
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    video.currentTime = 4 / 15;
    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(video.currentTime).toBeCloseTo(5 / 15);

    video.currentTime = 0;
    await user.click(screen.getByRole("button", { name: "预览片段" }));
    expect(video.currentTime).toBeCloseTo(0);

    Object.defineProperty(video, "paused", { configurable: true, value: false });
    video.currentTime = 4 / 15;
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBeCloseTo(5 / 15);
  });

  it("covers the full animated GIF timeline and forwards one exact deleted frame", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/long.gif"]);
    mocks.inspectMedia.mockResolvedValue({
      codec: "gif",
      width: 320,
      height: 180,
      duration: 10,
      frame_count: 600,
      animated: true,
      has_alpha: false,
    });
    mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/deleted/long.gif", 505_000, 320, "gif"));
    mocks.generateMediaThumbnails.mockImplementation(async ({ times }: { times: number[] }) => times.map((time, index) => ({ time, path: `C:/thumbs/${index}.jpg` })));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledTimes(1));
    const thumbnailRequest = mocks.generateMediaThumbnails.mock.calls[0][0] as { times: number[] };
    expect(thumbnailRequest.times).toHaveLength(20);
    expect(thumbnailRequest.times[thumbnailRequest.times.length - 1]).toBeCloseTo(9.75);

    await user.click(await screen.findByRole("button", { name: /0\.27 秒关键帧/ }));
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));
    expect(screen.getByText(/已删除 1 帧 · 导出/)).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "删除后导出长度" })).toHaveAttribute("aria-valuenow", "99");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      deleted_frames: [0.266667],
      deleted_ranges: [],
    }));
    expect(presentedDevSnapshot()?.snapshot).toEqual(expect.objectContaining({
      outputFps: 12,
      deletedFrameIndices: [3],
    }));
  });

  it("reduces timeline sampling and concurrency for an extreme source", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/extreme.gif"]);
    mocks.inspectMedia.mockResolvedValue({
      codec: "gif",
      width: 1920,
      height: 1080,
      duration: 310,
      frame_count: 9_300,
      animated: true,
      has_alpha: false,
    });
    mocks.generateMediaThumbnails.mockImplementation(async ({ times }: { times: number[] }) =>
      times.map((time, index) => ({ time, path: `C:/thumbs/extreme-${index}.jpg` })),
    );
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledTimes(1));
    expect(mocks.generateMediaThumbnails.mock.calls[0][0].times).toHaveLength(8);
    const taskCard = screen.getByRole("region", { name: "长素材与任务控制" });
    expect(within(taskCard).getByText("极长素材")).toBeVisible();
    expect(within(taskCard).getByText(/最多 8 张时间线取样 · 最多 1 路/)).toBeVisible();
  });

  it("keeps adjacent exact output frames distinct in the export request", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/timing.gif"]);
    mocks.inspectMedia.mockResolvedValue({
      codec: "gif",
      width: 320,
      height: 180,
      duration: 10,
      frame_count: 600,
      animated: true,
      has_alpha: false,
    });
    mocks.generateMediaThumbnails.mockImplementation(async ({ times }: { times: number[] }) =>
      times.map((time, index) => ({
        time: index === 0 ? 0.067 : index === 1 ? 0.133 : time,
        path: `C:/thumbs/${index}.jpg`,
      })),
    );
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledTimes(1));
    await user.click(await screen.findByRole("button", { name: /0\.07 秒关键帧/ }));
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));
    await user.click(screen.getByRole("button", { name: /0\.13 秒关键帧/ }));
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));

    expect(screen.getByRole("button", { name: "逐帧编辑（2）" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      deleted_frames: [0.066667, 0.133333],
      deleted_ranges: [],
    }));
  }, 30_000);

  it("rebuilds outer frame dots when the trim start changes instead of leaving stale samples", () => {
    render(<GifpV3 />);

    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "1" } });

    expect(screen.queryByRole("button", { name: /0\.24 秒关键帧/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1\.00 秒关键帧/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除所选帧（0）" })).toBeDisabled();
  });

  it("does not start a duplicate thumbnail process during video inspection", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/clip.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));

    expect(mocks.generateMediaThumbnails).not.toHaveBeenCalled();
  });

  it("keeps the base encoder when adjusted settings are saved as custom", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/clip.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));
    await openSection(user, "基础预设");
    await user.click(screen.getByRole("button", { name: /压缩预设/ }));
    await user.click(screen.getByRole("option", { name: /低噪干净/ }));
    await openSection(user, "编码覆盖");
    await user.clear(screen.getByLabelText("宽度"));
    await user.type(screen.getByLabelText("宽度"), "500");
    await user.click(screen.getByRole("button", { name: "保存为自定义参数" }));
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({ width: 500, encoder: "clean_opt" }));
  });

  it("resets crop when switching to a different asset", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "画面裁剪" }));
    await user.click(screen.getByRole("button", { name: "裁剪比例：9:16" }));
    expect(document.querySelector(".preview-media.crop-preview-applied")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完成裁剪" }));
    expect(screen.getByText(/已裁剪为/)).toBeInTheDocument();
    expect(screen.getByText("已裁剪", { exact: true })).toBeInTheDocument();
    expect(document.querySelector(".preview-media.crop-preview-applied")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^clip-02\.mp4 视频/ }));

    expect(screen.queryByText("已裁剪")).not.toBeInTheDocument();
    expect(document.querySelector(".preview-media.crop-preview-applied")).not.toBeInTheDocument();
  });

  it("aligns the crop rulers with the demo media's real pixel dimensions", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: "画面裁剪" }));

    expect(screen.getByLabelText("水平像素标尺，0 至 260 像素")).toBeInTheDocument();
    expect(screen.getByLabelText("垂直像素标尺，0 至 462 像素")).toBeInTheDocument();
    expect(screen.getByText("目标 260 × 462 px · X 0 · Y 0")).toBeVisible();
  });

  it("undoes the most recently marked frame instead of the latest timestamp", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);
    const lateFrame = screen.getByRole("button", { name: /4\.13 秒关键帧/ });

    await user.click(lateFrame);
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));
    const earlyFrame = screen.getByRole("button", { name: /1\.20 秒关键帧/ });
    await user.click(earlyFrame);
    await user.click(screen.getByRole("button", { name: "删除所选帧（1）" }));
    await user.click(screen.getByRole("button", { name: "撤销上次删除" }));

    expect(screen.queryByRole("button", { name: /4\.13 秒关键帧/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /1\.20 秒关键帧/ })).toBeInTheDocument();
  });

  it("forwards target-size and adaptive FFmpeg controls to a real export request", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("clip.mp4")).length).toBeGreaterThan(0);

    await chooseAnimatedOption(user, "交付意图", /最大兼容/);
    await chooseAnimatedOption(user, "生成方式", /精确体积/);
    fireEvent.change(screen.getByLabelText("最大输出体积（MB）"), { target: { value: "1.5" } });
    await openSection(user, "编码覆盖");
    fireEvent.change(screen.getByLabelText(/^Bayer 尺度$/), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/^Alpha 阈值$/), { target: { value: "96" } });
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation.mock.calls[0][0]).toEqual(expect.objectContaining({
      input_path: videoPath,
      schema_version: 1,
      generation_mode: "target_size",
      target_size_bytes: Math.round(1.5 * 1024 * 1024),
      target_max_attempts: 8,
      bayer_scale: 4,
      alpha_threshold: 96,
      dither: "bayer",
      perceptual_focus: "subject",
    }));
    const request = mocks.convertAnimation.mock.calls[0][0];
    expect(request).not.toHaveProperty("fast_baseline_size_bytes");
    expect(request).not.toHaveProperty("webp_quality");
    expect(request).not.toHaveProperty("chroma_key_enabled");

    await openSection(user, "编码报告");
    const report = await screen.findByRole("region", { name: "编码结果报告" });
    expect(mocks.evaluateOutputQuality).toHaveBeenCalledWith(expect.objectContaining({
      encode_request: expect.objectContaining({ input_path: videoPath, generation_mode: "target_size" }),
      output_path: "C:/media/clip-GIFP.gif",
    }));
    expect(within(report).getByRole("group", { name: "质量评分" })).toBeVisible();
    expect(within(report).getByLabelText("VMAF 91.4，优秀")).toBeVisible();
    expect(within(report).getByLabelText("SSIM 0.974，清晰")).toBeVisible();
    expect(within(report).getByText("画质评分")).toBeVisible();
    expect(within(report).getByText(/VMAF NEG v0\.6\.1 · float SSIM · 3\.2s \/ 96 帧/)).toBeVisible();
    expect(within(report).getByText("低于目标")).toBeVisible();
    expect(within(report).getByText("-4.6%")).toBeVisible();
    expect(within(report).getByText("420px · 15 FPS · 112 色")).toBeVisible();
    expect(within(report).getByText("48 帧")).toBeVisible();
    expect(within(report).getByText("1.24s · 8 次编码")).toBeVisible();
    expect(within(report).getByText("1.4 MB")).toBeVisible();
    expect(within(report).getByText("diff_rectangle")).toBeVisible();
    expect(within(report).getByText("均衡优先 · 4 次尺寸实测 + 4 次路线探测 · Pareto 1 项 · 已选 #4 / 内容自适应基线 · 最清晰 #4 · 最流畅 #4 · 最小体积 #4")).toBeVisible();
    await user.click(within(report).getByText("查看候选轨迹"));
    expect(within(report).getByText("#4 · 420px · 15 FPS · 112 色 · 1.4 MB · 4.74% · 命中 · Pareto · 已选尺寸")).toBeVisible();
    expect(within(report).getByText("内容自适应基线 · 420px · 15 FPS · 112 色 · bayer · diff · 1.4 MB · 命中 · 已选路线")).toBeVisible();
    expect(within(report).getByText("感知时间表 · 420px · 15 FPS · 112 色 · Drop-and-Hold 32 保留 / 16 删除 · 时间轴已验证 · bayer · diff · 1.3 MB · 低于")).toBeVisible();
    expect(within(report).getByText("感知预算回投 · 460px · 15 FPS · 112 色 · Drop-and-Hold 32 保留 / 16 删除 · 时间轴已验证 · bayer · diff · 1.5 MB · 命中 · 预测 1.4 MB · 实测/预测 1.033×")).toBeVisible();
    expect(within(report).getByText(/感知后端未启用/)).toBeVisible();
    expect(within(report).getByText(/透明边缘已按 Alpha 阈值处理/)).toBeVisible();
    expect(within(report).queryByText("感知调色板")).not.toBeInTheDocument();
    expect(within(report).queryByLabelText("完整调色板 SHA-256")).not.toBeInTheDocument();
  });

  it("forwards the selected dither in best mode", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("clip.mp4")).length).toBeGreaterThan(0);
    await chooseAnimatedOption(user, "交付意图", /最大兼容/);
    await chooseAnimatedOption(user, "生成方式", /最佳 GIF/);
    await chooseAnimatedOption(user, "内容重点", /文字 \/ UI/);
    await openSection(user, "编码覆盖");
    await chooseAnimatedOption(user, "抖动", /Floyd 细节/);
    await chooseAnimatedOption(user, "优化级别", /4 · 最深/);
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      generation_mode: "best_gif",
      dither: "floyd_steinberg",
      encoder: "pngquant_opt",
      perceptual_focus: "text_ui",
      allow_experimental: false,
    }));
  });

  it("opens the completed export in source, split comparison, and result modes", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("clip.mp4")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    expect(await screen.findByRole("slider", { name: "原素材与成品分割线" })).toHaveAttribute("aria-valuenow", "50");
    const modes = screen.getByRole("group", { name: "预览方式" });
    expect(within(modes).getByRole("button", { name: "对比" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("GIF 成品").length).toBeGreaterThanOrEqual(2);

    await user.click(within(modes).getByRole("button", { name: "原素材" }));
    expect(screen.queryByRole("slider", { name: "原素材与成品分割线" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("clip.mp4 视频预览")).toBeVisible();

    await user.click(within(modes).getByRole("button", { name: "成品" }));
    expect(screen.queryByRole("slider", { name: "原素材与成品分割线" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /clip\.mp4 GIF 成品/ })).toBeVisible();

    await user.click(within(modes).getByRole("button", { name: "对比" }));
    expect(screen.getByRole("slider", { name: "原素材与成品分割线" })).toBeVisible();
  });

  describe("presented export consistency", () => {
    it("reuses the current edit while regenerating a smaller output", async () => {
      useTauriRuntime();
      const user = userEvent.setup();
      mocks.selectVideos.mockResolvedValue(["C:/media/clip.mp4"]);
      mocks.convertAnimation
        .mockResolvedValueOnce(exportResult("C:/exports/first.gif", 400_000, 480, "gif"))
        .mockResolvedValueOnce(exportResult("C:/exports/smaller.gif", 240_000, 394, "gif"));
      render(<GifpV3 />);

      await user.click(screen.getByRole("button", { name: /^添加素材/ }));
      await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
      await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
      const initialRequest = mocks.convertAnimation.mock.calls[0][0];

      await openSection(user, "编码报告");
      await user.click(screen.getAllByRole("button", { name: /更小.*降低体积/ })[0]);
      await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(2));
      const tunedRequest = mocks.convertAnimation.mock.calls[1][0];
      expect(tunedRequest.width).toBeLessThan(initialRequest.width);
      expect(tunedRequest.fps).toBeLessThan(initialRequest.fps);
      expect(tunedRequest.colors).toBeLessThan(initialRequest.colors);
      expect(tunedRequest.start_seconds).toBe(initialRequest.start_seconds);
      expect(tunedRequest.end_seconds).toBe(initialRequest.end_seconds);
    });

    it("keeps an existing result format stable after later delivery settings change", async () => {
      useTauriRuntime();
      const user = userEvent.setup();
      mocks.selectVideos.mockResolvedValue(["C:/media/clip.mp4"]);
      mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/stable/old-result.gif", 505_000, 505));
      render(<GifpV3 />);

      await user.click(screen.getByRole("button", { name: /^添加素材/ }));
      await chooseAnimatedOption(user, "交付意图", /最大兼容/);
      await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
      await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
      expect(screen.getByRole("progressbar", { name: "生成进度" })).toHaveAttribute("data-format", "GIF");

      await chooseAnimatedOption(user, "交付意图", /现代动图/);
      await chooseAnimatedOption(user, "输出格式", /Animated WebP/);
      expect(screen.getByRole("button", { name: /生成 WEBP/ })).toBeVisible();
      expect(screen.getByRole("progressbar", { name: "生成进度" })).toHaveAttribute("data-format", "GIF");
      expect(screen.getByText("GIF", { selector: ".result-format-chip" })).toBeVisible();
      expect(presentedDevSnapshot()).toEqual(expect.objectContaining({
        format: "gif",
        label: "GIF 成品",
        outputPath: "C:/exports/stable/old-result.gif",
      }));
    });

    it("captures the trimmed 2x timeline in the presented comparison snapshot", async () => {
      useTauriRuntime();
      const user = userEvent.setup();
      mocks.selectVideos.mockResolvedValue(["C:/media/timeline.mp4"]);
      mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/timeline/timeline.gif", 550_000, 550, "gif"));
      render(<GifpV3 />);

      await user.click(screen.getByRole("button", { name: /^添加素材/ }));
      await waitFor(() => expect(screen.getByLabelText("结束时间")).toHaveAttribute("max", "3.2"));
      fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "0.5" } });
      fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2.5" } });
      await openSection(user, "画面与节奏");
      await user.click(within(screen.getByRole("group", { name: "输出速度" })).getByRole("button", { name: "2×" }));
      await chooseAnimatedOption(user, "交付意图", /最大兼容/);
      await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
      await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));

      expect(presentedDevSnapshot()?.snapshot).toEqual(expect.objectContaining({
        startSeconds: 0.5,
        endSeconds: 2.5,
        playbackSpeed: 2,
      }));
      expect(screen.getByRole("region", { name: "原素材与输出结果对比" })).toBeVisible();
    });

    it("rebases a captured comparison snapshot when late media inspection discovers the real aspect", async () => {
      useTauriRuntime();
      const user = userEvent.setup();
      let resolveInspection!: (value: {
        codec: string;
        width: number;
        height: number;
        duration: number;
        frame_count: number;
        animated: boolean;
        has_alpha: boolean;
      }) => void;
      mocks.selectVideos.mockResolvedValue(["C:/media/late-aspect.mp4"]);
      mocks.inspectMedia.mockReturnValueOnce(new Promise((resolve) => {
        resolveInspection = resolve;
      }));
      mocks.convertAnimation.mockResolvedValueOnce(exportResult("C:/exports/late/late.gif", 606_000, 606, "gif"));
      render(<GifpV3 />);

      await user.click(screen.getByRole("button", { name: /^添加素材/ }));
      expect((await screen.findAllByText("late-aspect.mp4")).length).toBeGreaterThan(0);
      await chooseAnimatedOption(user, "交付意图", /最大兼容/);
      await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
      await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
      expect(presentedDevSnapshot()?.snapshot?.sourceAspect).toBeUndefined();
      expect(presentedDevSnapshot()?.snapshot?.outputAspect).toBeUndefined();
      expect(presentedDevSnapshot()?.snapshot?.endSeconds).toBe(0);

      resolveInspection({
        codec: "h264",
        width: 800,
        height: 400,
        duration: 4,
        frame_count: 48,
        animated: true,
        has_alpha: false,
      });
      await waitFor(() => expect(presentedDevSnapshot()?.snapshot).toEqual(expect.objectContaining({
        sourceAspect: 2,
        outputAspect: 2,
        endSeconds: 4,
      })));
    });
  });

  it("renders an honest perceptual timeline report from the Rust backend", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    mocks.convertAnimation.mockResolvedValueOnce({
      input_path: videoPath,
      output_path: "C:/media/clip-GIFP.gif",
      size_bytes: 880_000,
      encoder_used: "rust_perceptual_oklab_ffmpeg",
      status: "done",
      backend_id: "rust.perceptual",
      backend_version: "3.2.0-alpha.4",
      ffmpeg_engine_version: "ffmpeg test",
      fallback_reason: null,
      palette_strategy: "perceptual_vfr+oklab_global+ffmpeg",
      attempts: 1,
      elapsed_ms: 950,
      output_width: 420,
      output_fps: 15,
      effective_output_fps: 7.5,
      output_frame_count: 24,
      output_colors: 112,
      target_size_bytes: null,
      target_deviation_percent: null,
      warnings: [],
      perceptual_report: {
        analysis_frame_count: 48,
        kept_frame_count: 24,
        dropped_frame_count: 24,
        kept_ratio: 0.5,
        variable_delay_frames: 12,
        source_duration_ms: 3200,
        output_duration_ms: 3200,
        scene_boundary_count: 2,
        mean_motion: 0.18,
        mean_changed_area: 0.42,
        mean_edge_text: 0.34,
        mean_noise: 0.07,
        mean_subject_saliency: 0.31,
        mean_skin_ratio: 0.09,
        focus: "auto",
        filter_strategy: "temporal_cleanup",
        effective_dither: "sierra2_4a",
        effective_bayer_scale: null,
        truncated: false,
        aggregate_timeline_verified: true,
      },
      palette_report: {
        planner_id: "rust.oklab.weighted_global",
        planner_version: "3.2.0-alpha.4",
        color_space: "oklab",
        strategy: "segmented_local",
        requested_colors: 112,
        emitted_colors: 108,
        histogram_precision_bits: 5,
        reserved_transparent: true,
        segment_count: 3,
        artifact_hashes: ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
        sampled_frame_count: 24,
        sampled_pixel_count: 393216,
        weighted_histogram_mean_oklab_error: 0.01234,
        weighted_histogram_p95_oklab_error: 0.04567,
        global_color_table_verified: true,
        candidate_status: "encoded",
        candidate_fallback_reason: null,
        candidate_segment_count: 3,
        candidate_boundary_reasons: ["hard_cut", "color_drift"],
        candidate_artifact_hashes: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
        shared_anchor_count: 6,
        shared_anchor_sha256: "4".repeat(64),
        segmentation_sha256: "5".repeat(64),
        palette_sequence_sha256: "6".repeat(64),
        candidate_weighted_mean_oklab_error: 0.009,
        candidate_worst_segment_p95_oklab_error: 0.031,
      },
      region_dither_report: {
        planner_id: "rust.region_dither.v1",
        planner_version: "4.0.0",
        status: "encoded",
        fallback_reason: null,
        grid_width: 16,
        grid_height: 16,
        sampled_frame_count: 24,
        sampled_pixel_count: 393216,
        class_counts: { flat: 80, text_edge: 48, skin_subject: 32, texture: 96 },
        mean_dither_strength: 0.31,
        class_map_sha256: "7".repeat(64),
        strength_map_sha256: "8".repeat(64),
        artifact_sha256: "9".repeat(64),
      },
      indexed_gif_writer_report: {
        writer_id: "rust.indexed_gif.local_table.v4",
        writer_version: "4.0.0",
        container_backend: "image-gif 0.14.2",
        status: "encoded_experimental",
        fallback_reason: null,
        frame_count: 24,
        full_frame_count: 1,
        total_indexed_pixels: 552960,
        original_indexed_pixels: 1382400,
        optimized_indexed_pixels: 552960,
        rectangle_frame_count: 23,
        transparent_hold_frame_count: 2,
        background_disposal_frame_count: 0,
        previous_disposal_frame_count: 0,
        disposal_candidate_count: 1,
        selected_disposal_strategy: "opaque_keep_rectangles_v1",
        indexed_pixel_reduction_percent: 60,
        baseline_serialized_bytes: 180000,
        candidate_serialized_bytes: 120000,
        serialized_byte_reduction_percent: 33.333,
        disposal_simulation_verified: true,
        total_delay_cs: 320,
        local_palette_frame_count: 22,
        palette_boundary_full_frame_count: 2,
        global_palette_rgb_sha256: "a".repeat(64),
        local_palette_sequence_sha256: "6".repeat(64),
        indexed_timeline_sha256: "b".repeat(64),
        ffmpeg_mapped_rgba_sha256: "c".repeat(64),
        writer_input_rgba_sha256: "d".repeat(64),
        decoded_rgba_sha256: "d".repeat(64),
        decoded_pixel_parity_verified: true,
        palette_compaction_report: {
          selector_id: "rust.indexed_palette_compaction.real_bytes.v1",
          selector_version: "4.0.0",
          status: "compacted_selected",
          selection_gate_passed: true,
          baseline_serialized_bytes: 132000,
          compacted_serialized_bytes: 120000,
          selected_serialized_bytes: 120000,
          serialized_byte_reduction_percent: 9.091,
          original_global_palette_entries: 256,
          compacted_global_palette_entries: 128,
          selected_global_palette_entries: 128,
          original_local_palette_entries: 5632,
          compacted_local_palette_entries: 2816,
          compacted_local_palette_frame_count: 22,
          remapped_frame_count: 24,
          display_simulation_verified: true,
        },
        regional_quantizer_report: {
          quantizer_id: "rust.oklab.regional_ordered.v2",
          quantizer_version: "4.0.0",
          gate_id: "multiscale_banding_proxy_v4",
          status: "encoded",
          fallback_reason: null,
          quality_gate_passed: true,
          selected_route_id: "temporal_hysteresis",
          temporal_selection: {
            selector_id: "rust.oklab.temporal_hysteresis.v1",
            selector_version: "4.0.0",
            gate_id: "temporal_pareto_v1",
            max_hold_frames: 2,
            status: "candidate_selected",
            fallback_reason: null,
            quality_gate_passed: true,
            selection_gate_passed: true,
            baseline: {
              metrics: {
                sampled_pixel_count: 1382400,
                sampled_static_pixel_count: 420000,
                mean_oklab_error: 0.0112,
                p95_oklab_error: 0.039,
                edge_weighted_mean_oklab_error: 0.012,
                multiscale_low_frequency_oklab_error: 0.0105,
                multiscale_banding_score: 0.007,
                edge_gradient_error: 0.008,
                static_temporal_residual: 0.002,
                multiscale_static_temporal_residual: 0.0017,
              },
              serialized_bytes: 215040,
              indices_sha256: "d".repeat(64),
              artifact_sha256: "e".repeat(64),
              temporal_hold_count: 0,
              temporal_hold_by_class: [0, 0, 0, 0],
            },
            candidate: {
              metrics: {
                sampled_pixel_count: 1382400,
                sampled_static_pixel_count: 420000,
                mean_oklab_error: 0.0111,
                p95_oklab_error: 0.039,
                edge_weighted_mean_oklab_error: 0.0119,
                multiscale_low_frequency_oklab_error: 0.0104,
                multiscale_banding_score: 0.0069,
                edge_gradient_error: 0.008,
                static_temporal_residual: 0.0018,
                multiscale_static_temporal_residual: 0.0015,
              },
              serialized_bytes: 204800,
              indices_sha256: "f".repeat(64),
              artifact_sha256: "0".repeat(64),
              temporal_hold_count: 384,
              temporal_hold_by_class: [96, 144, 144, 0],
            },
          },
          candidate_metrics: {
            sampled_pixel_count: 1382400,
            sampled_static_pixel_count: 420000,
            mean_oklab_error: 0.0112,
            p95_oklab_error: 0.039,
            edge_weighted_mean_oklab_error: 0.012,
            multiscale_low_frequency_oklab_error: 0.0105,
            multiscale_banding_score: 0.007,
            edge_gradient_error: 0.008,
            static_temporal_residual: 0.002,
            multiscale_static_temporal_residual: 0.0017,
          },
          baseline_metrics: {
            sampled_pixel_count: 1382400,
            sampled_static_pixel_count: 420000,
            mean_oklab_error: 0.012,
            p95_oklab_error: 0.041,
            edge_weighted_mean_oklab_error: 0.013,
            multiscale_low_frequency_oklab_error: 0.011,
            multiscale_banding_score: 0.008,
            edge_gradient_error: 0.009,
            static_temporal_residual: 0.003,
            multiscale_static_temporal_residual: 0.0024,
          },
          candidate_serialized_bytes: 210000,
          baseline_serialized_bytes: 220000,
          secondary_choice_count: 18000,
          secondary_choice_by_class: [120, 480, 2400, 15000],
          indices_sha256: "d".repeat(64),
          artifact_sha256: "e".repeat(64),
        },
        segment_palette_report: {
          planner_id: "rust.oklab.segment_local_table.v1",
          planner_version: "4.0.0",
          gate_id: "multiscale_banding_proxy_v4",
          selection_gate_id: "segment_pareto_v1",
          status: "encoded",
          fallback_reason: null,
          quality_gate_passed: true,
          selection_gate_passed: true,
          segment_count: 3,
          candidate_metrics: {
            sampled_pixel_count: 1382400,
            sampled_static_pixel_count: 420000,
            mean_oklab_error: 0.0102,
            p95_oklab_error: 0.035,
            edge_weighted_mean_oklab_error: 0.011,
            multiscale_low_frequency_oklab_error: 0.0094,
            multiscale_banding_score: 0.006,
            edge_gradient_error: 0.007,
            static_temporal_residual: 0.0018,
            multiscale_static_temporal_residual: 0.0015,
          },
          baseline_metrics: {
            sampled_pixel_count: 1382400,
            sampled_static_pixel_count: 420000,
            mean_oklab_error: 0.0112,
            p95_oklab_error: 0.039,
            edge_weighted_mean_oklab_error: 0.012,
            multiscale_low_frequency_oklab_error: 0.0105,
            multiscale_banding_score: 0.007,
            edge_gradient_error: 0.008,
            static_temporal_residual: 0.002,
            multiscale_static_temporal_residual: 0.0017,
          },
          candidate_serialized_bytes: 190000,
          baseline_serialized_bytes: 220000,
          opaque_colors_by_segment: [31, 30, 31],
          local_table_entries_by_segment: [32, 32, 32],
          local_palette_frame_count: 22,
          palette_boundary_full_frame_count: 2,
          palette_sequence_sha256: "6".repeat(64),
        },
      },
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await screen.findAllByText("clip.mp4");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await openSection(user, "编码报告");
    const report = await screen.findByRole("region", { name: "编码结果报告" });
    expect(within(report).getByText("48 → 24 帧 · 保留 50%")).toBeVisible();
    expect(within(report).getByText("12 个可变延迟 · 3200 ms · FFprobe 帧数/总时长已验证")).toBeVisible();
    expect(within(report).getByText("时域清理 · sierra2_4a")).toBeVisible();
    expect(within(report).getByText(/2 个场景边界/)).toBeVisible();
    expect(within(report).getByText("2 个场景边界 · 动作 18 · 边缘 34 · 渐变 未报告 · 噪声 7")).toBeVisible();
    expect(within(report).getByText(/15 FPS 采样上限 · 7.50 FPS 实际平均/)).toBeVisible();
    expect(within(report).getByText(/FFmpeg 引擎 ffmpeg test/)).toBeVisible();
    expect(within(report).getByText("Rust OKLab · 分段 Local Color Table · 3 段 · GIF 全局/局部表契约已验证")).toBeVisible();
    expect(within(report).getByText(/3 段 Local Color Table 已过多尺度\/体积门 · 实色 31\/30\/31 · 表项 32\/32\/32/)).toBeVisible();
    expect(within(report).getByText("16×16 · Rust 区域量化已过多尺度/体积门 · mean 0.0102 · P95 0.0350 · 低频 0.0094 · 条带 0.0060 · 边缘梯度 0.0070 · 时稳 0.0015")).toBeVisible();
    expect(within(report).getByText("已选用时间索引稳定 · 索引保持 384 次 · 实际字节 200 KB / 有序基线 210 KB")).toBeVisible();
    expect(within(report).getByText("Rust Indexed Writer · 23/24 变化矩形 · 索引像素 -60.0% · 3 段 Local Table · Local Table 22 帧 · 段边界强制全帧 2 · 无损索引压缩 256→128 色 · -9.1% · 处置模拟已验证 · 独立解码逐像素已验证")).toBeVisible();
    expect(within(report).getByText("5-bit 桶代表色拟合估算 · mean 0.0123 · P95 0.0457")).toBeVisible();
    const hashSummary = within(report).getByText("SHA-256 前缀 666666666666…");
    expect(hashSummary).toBeVisible();
    await user.click(hashSummary);
    expect(within(report).getByLabelText("完整调色板序列 SHA-256")).toHaveValue("6".repeat(64));
    expect((await screen.findAllByText(/rust\.perceptual/)).length).toBeGreaterThan(0);
  });

  it.each([true, false])("reports transparent baseline retention without inventing verification: verified=%s", async (verified) => {
    useTauriRuntime();
    const user = userEvent.setup();
    const gifPath = "C:/media/transparent.gif";
    mocks.selectVideos.mockResolvedValue([gifPath]);
    mocks.convertAnimation.mockResolvedValueOnce({
      input_path: gifPath,
      output_path: "C:/media/transparent-GIFP.gif",
      size_bytes: 122_880,
      encoder_used: "ffmpeg_fast",
      status: "done",
      backend_id: "ffmpeg.animation",
      backend_version: "ffmpeg test",
      fallback_reason: null,
      palette_strategy: "diff",
      attempts: 1,
      elapsed_ms: 260,
      output_width: 96,
      output_fps: 12,
      effective_output_fps: 12,
      output_frame_count: 12,
      output_colors: 32,
      output_format: "gif",
      output_codec: "gif",
      output_has_alpha: true,
      target_size_bytes: null,
      target_deviation_percent: null,
      warnings: [],
      indexed_gif_writer_report: {
        writer_id: "rust.indexed_gif.transparent_postprocess.v5",
        writer_version: "4.0.0",
        container_backend: "image-gif 0.14.2",
        status: "baseline_retained",
        fallback_reason: null,
        frame_count: 12,
        full_frame_count: 0,
        total_indexed_pixels: 2048,
        original_indexed_pixels: 110592,
        optimized_indexed_pixels: 2048,
        rectangle_frame_count: 12,
        transparent_hold_frame_count: 0,
        background_disposal_frame_count: 7,
        previous_disposal_frame_count: 2,
        disposal_candidate_count: 3,
        selected_disposal_strategy: "transparent_mixed_disposal_v1",
        indexed_pixel_reduction_percent: 98.1,
        baseline_serialized_bytes: 122_880,
        candidate_serialized_bytes: 133_120,
        serialized_byte_reduction_percent: -8.333,
        disposal_simulation_verified: true,
        total_delay_cs: 100,
        local_palette_frame_count: 0,
        palette_boundary_full_frame_count: 0,
        global_palette_rgb_sha256: "a".repeat(64),
        local_palette_sequence_sha256: null,
        indexed_timeline_sha256: "b".repeat(64),
        ffmpeg_mapped_rgba_sha256: "c".repeat(64),
        writer_input_rgba_sha256: "c".repeat(64),
        decoded_rgba_sha256: verified ? "c".repeat(64) : null,
        decoded_pixel_parity_verified: verified,
        regional_quantizer_report: null,
        segment_palette_report: null,
      },
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await screen.findAllByText("transparent.gif");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await openSection(user, "编码报告");
    const report = await screen.findByRole("region", { name: "编码结果报告" });
    expect(within(report).getByText(
      verified ? "透明处置搜索已验证 · 处置实测 3 路 · 透明混合处置 · Background 7 帧 / Previous 2 帧 · 实际字节 130 KB / FFmpeg 120 KB · 增大 8.3% · FFmpeg 基线更小，已保留原输出" : "候选未缩小文件，已保留原输出",
    )).toBeVisible();
    expect(within(report).queryByText("跨帧索引稳定")).not.toBeInTheDocument();
  });

  it.each([
    ["candidate_selected", "陈旧报告不应覆盖最终 FFmpeg 路线"],
    ["selection_gate_rejected", "真实字节无优势"],
    ["quality_gate_rejected", "时稳指标回退"],
    ["candidate_failed", "候选编码失败"],
  ] as const)("hides unselected temporal diagnostic status %s", async (status, fallbackReason) => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/temporal-status.mp4"]);
    mocks.convertAnimation.mockResolvedValueOnce(temporalStatusResult(status, fallbackReason));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await screen.findAllByText("temporal-status.mp4");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await openSection(user, "编码报告");
    const report = await screen.findByRole("region", { name: "编码结果报告" });
    expect(within(report).queryByText("跨帧索引稳定")).not.toBeInTheDocument();
    expect(within(report).queryByText(fallbackReason)).not.toBeInTheDocument();
  });

  it("labels an unverified palette artifact without claiming output verification", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    const unverifiedHash = "abcdef0123456789".repeat(4);
    mocks.selectVideos.mockResolvedValue([videoPath]);
    mocks.convertAnimation.mockResolvedValueOnce({
      input_path: videoPath,
      output_path: "C:/media/clip-GIFP.gif",
      size_bytes: 910_000,
      encoder_used: "rust_perceptual_oklab_ffmpeg",
      status: "done",
      backend_id: "rust.perceptual",
      backend_version: "3.2.0-alpha.4",
      ffmpeg_engine_version: "ffmpeg test",
      fallback_reason: null,
      palette_strategy: "perceptual_vfr+oklab_global+ffmpeg",
      attempts: 1,
      elapsed_ms: 980,
      output_width: 420,
      output_fps: 15,
      output_frame_count: 24,
      output_colors: 112,
      target_size_bytes: null,
      target_deviation_percent: null,
      warnings: [],
      perceptual_report: null,
      palette_report: {
        planner_id: "rust.oklab.weighted_global",
        planner_version: "3.2.0-alpha.4",
        color_space: "oklab",
        strategy: "global",
        requested_colors: 112,
        emitted_colors: 108,
        histogram_precision_bits: 5,
        reserved_transparent: true,
        segment_count: 1,
        artifact_hashes: [unverifiedHash],
        sampled_frame_count: 24,
        sampled_pixel_count: 393216,
        weighted_histogram_mean_oklab_error: 0.01234,
        weighted_histogram_p95_oklab_error: 0.04567,
        global_color_table_verified: false,
        candidate_status: "planned_not_encoded",
        candidate_segment_count: 2,
        shared_anchor_count: 0,
      },
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await screen.findAllByText("clip.mp4");
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await openSection(user, "编码报告");
    const report = await screen.findByRole("region", { name: "编码结果报告" });
    expect(within(report).getByText("Rust OKLab · 全局 · 108/112 色 · 1 段 · GIF 调色板契约未验证")).toBeVisible();
    expect(within(report).queryByText("Rust OKLab · 全局 · 108/112 色 · 1 段 · GIF 调色板契约已验证")).not.toBeInTheDocument();
    expect(within(report).getByText("2 段候选 · 0 个共享锚点 · 当前输出全局表未通过契约验证")).toBeVisible();
    expect(within(report).getByLabelText("完整调色板 SHA-256")).toHaveValue(unverifiedHash);
  });

  it("removes the random preset recommendation from the quick side rail", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    const sidebar = screen.getByRole("complementary", { name: "快速生成侧栏" });
    expect(within(sidebar).getByRole("button", { name: /快速生成向导/ })).toHaveTextContent(/× 0\.\d{2} · \d+ FPS · GIF/);
    expect(screen.queryByRole("region", { name: "随机压缩预设展示" })).not.toBeInTheDocument();
  });

  it("updates the visible output specification without claiming platform acceptance", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    const dialog = screen.getByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    const purposePicker = within(dialog).getByRole("region", { name: "选择用途" });
    expect(within(purposePicker).getByRole("button", { name: /聊天动图/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(purposePicker).getByRole("button", { name: /表情包/ })).toBeVisible();
    const scaleSlider = within(dialog).getByRole("slider", { name: "快速生成缩放比例" });
    expect(scaleSlider).toHaveAttribute("min", "5");
    fireEvent.change(scaleSlider, { target: { value: "5" } });
    expect(within(dialog).getByLabelText("输入与输出尺寸")).toHaveTextContent("16 × 28");
    expect(within(dialog).getAllByText("× 0.06").length).toBeGreaterThanOrEqual(1);
    const predictionBefore = within(dialog).getByRole("status", { name: "文件大小与输出规格" }).textContent;
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成帧率" }), { target: { value: "8" } });
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" }).textContent).not.toBe(predictionBefore);
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成缩放比例" }), { target: { value: "100" } });
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成帧率" }), { target: { value: "30" } });
  });

  it("explains format uses without presenting fixed ratios as a size prediction", async () => {
    const user = userEvent.setup();
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    const dialog = screen.getByRole("dialog", { name: "快速生成" });
    expect(within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" })).toBeVisible();

    const comparison = within(dialog).getByRole("region", { name: "输出格式与用途" });
    expect(comparison).not.toHaveTextContent(/同规格体积预判|GIF = 100%/);
    const webp = within(comparison).getByRole("radio", { name: /Animated WebP/ });
    const avif = within(comparison).getByRole("radio", { name: /Animated AVIF/ });
    const apng = within(comparison).getByRole("radio", { name: /APNG/ });
    const all = within(comparison).getByRole("radio", { name: /全部格式/ });
    expect(webp.closest("label")).toHaveTextContent("支持完整透明");
    expect(avif.closest("label")).toHaveTextContent("仅支持不透明素材");
    expect(apng.closest("label")).toHaveTextContent("无损动画");
    expect(comparison).not.toHaveTextContent(/体积比较基准|5 素材实测|按 MP4 \+ 封面估算|各格式相加/);
    expect(all.closest("label")).not.toHaveTextContent(/列表中的|份合计/);
    expect(comparison).not.toHaveTextContent(/参考基准|约为 GIF|合计约/);
    expect(comparison).not.toHaveTextContent(/~\d+(\.\d+)? MB/);

    const comparisonBeforeFormatChange = comparison.textContent;
    await user.click(webp);
    expect(comparison.textContent).toBe(comparisonBeforeFormatChange);
    expect(within(dialog).getByRole("status", { name: "文件大小与输出规格" })).toHaveTextContent("生成后显示实际大小");
    expect(within(dialog).queryByRole("slider", { name: "快速生成播放速度滑杆" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "最大输出体积" })).not.toBeInTheDocument();
  });

  it("directly generates a verified Live Photo pair from the quick wizard", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/quick-live-source.mp4";
    const bundlePath = "C:/exports/quick-live-source-GIFP.pvt";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    mocks.listEncoderCapabilities.mockResolvedValue([{
      id: "ffmpeg.animation",
      status: { state: "available", executable_path: "C:/tools/ffmpeg.exe", version: "test" },
      formats: ["gif", "live_photo"],
    }]);
    mocks.convertAnimation.mockResolvedValueOnce({
      ...exportResult(bundlePath, 920_000, 480, "live_photo"),
      backend_id: "gifp.live_photo",
      live_photo: {
        still_path: `${bundlePath}/IMG_TEST.JPG`,
        motion_path: `${bundlePath}/IMG_TEST.MOV`,
        still_size_bytes: 120_000,
        motion_size_bytes: 800_000,
        asset_identifier: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
        asset_identifier_verified: true,
        metadata_pairing_verified: true,
        compatibility_status: "locally_verified",
        validation_scope: "local_contract",
      },
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    expect(within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" })).toBeVisible();
    await waitFor(() => expect(mocks.listEncoderCapabilities).toHaveBeenCalledTimes(1));

    const livePhotoFormat = within(dialog).getByRole("radio", { name: /实况照片/ });
    await user.click(livePhotoFormat);
    expect(livePhotoFormat.closest("label")).toHaveTextContent("可生成");

    expect(within(dialog).getAllByText("Live Photo").length).toBeGreaterThan(0);
    expect(within(dialog).getByLabelText("Live Photo 直接生成链")).toHaveTextContent("JPG 关键帧");
    expect(within(dialog).getByLabelText("Live Photo 直接生成链")).toHaveTextContent("H.264 MOV");
    fireEvent.change(within(dialog).getByRole("slider", { name: "快速生成 Live Photo MOV 压缩强度" }), { target: { value: "34" } });
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      input_path: videoPath,
      output_format: "live_photo",
      generation_mode: "fast_gif",
      target_size_bytes: null,
      lossy: 34,
    }));
    expect(await within(dialog).findByText("已生成")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "打开配对包" }));
    expect(mocks.openDirectory).toHaveBeenCalledWith(bundlePath);
  }, 10_000);

  it("keeps frame editing detailed while exposing quick encoding and picture controls", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/quick-source.mp4"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    expect(screen.queryByRole("dialog", { name: "快速生成" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    await user.click(within(dialog).getByRole("button", { name: /更多设置/ }));
    expect(within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" })).toBeVisible();
    expect(document.querySelector(".quick-wizard__leaf")).toBeNull();
    const scaleSlider = within(dialog).getByRole("slider", { name: "快速生成缩放比例" });
    const fpsSlider = within(dialog).getByRole("slider", { name: "快速生成帧率" });
    await waitFor(() => expect(scaleSlider).toHaveValue("75"));
    expect(fpsSlider).toHaveValue("12");
    const purposePicker = within(dialog).getByRole("region", { name: "选择用途" });
    expect(within(purposePicker).getByRole("button", { name: /聊天动图/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(purposePicker).getByRole("button", { name: /表情包/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /生成当前/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^滤镜$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删帧/ })).not.toBeInTheDocument();

    fireEvent.change(scaleSlider, { target: { value: "50" } });
    fireEvent.change(fpsSlider, { target: { value: "10" } });
    const formatGroup = within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" });
    const webpFormat = within(formatGroup).getByRole("radio", { name: /Animated WebP/ });
    await user.click(webpFormat);
    const comparison = within(dialog).getByRole("region", { name: "输出格式与用途" });
    expect(comparison).not.toHaveTextContent("320 × 180");
    expect(comparison).not.toHaveTextContent("10 FPS");
    expect(webpFormat.closest("label")).toHaveTextContent("支持完整透明");
    expect(screen.queryByRole("radio", { name: /极小包/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("slider", { name: "快速生成播放速度滑杆" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("group", { name: "最大输出体积" })).not.toBeInTheDocument();
    expect(within(dialog).getAllByText("WEBP").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/输出规格：320 × 180 · 10 FPS/)).toBeVisible();
    expect(within(dialog).getAllByText("10 FPS").length).toBeGreaterThanOrEqual(1);
    expect(within(dialog).getByRole("button", { name: /开始生成/ })).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalled());
    expect(mocks.convertAnimation.mock.calls[mocks.convertAnimation.mock.calls.length - 1]?.[0]).toMatchObject({
      output_format: "webp",
      width: 320,
      fps: 10,
      lossy: 14,
    });
    const openDirectory = await within(dialog).findByRole("button", { name: "打开目录" });
    await user.click(openDirectory);
    expect(mocks.openDirectory).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^精细编辑$/ }));
    expect(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "精细编辑控制台" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /手动覆盖/ }));
    await openSection(user, "编码覆盖");
    expect(screen.getByRole("button", { name: /^滤镜/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /逐帧编辑（0）/ })).toBeVisible();
  });

  it("exports every format once while keeping GIF as the primary preview", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/all-formats-source.mp4"]);
    mocks.listEncoderCapabilities.mockResolvedValue([{
      id: "ffmpeg.animation",
      status: { state: "available", executable_path: "C:/tools/ffmpeg.exe", version: "test" },
      formats: ["gif", "webp", "avif", "apng", "mp4", "webm", "live_photo"],
    }]);
    mocks.convertAnimation.mockImplementation(async (request: {
      output_format: "gif" | "webp" | "avif" | "apng" | "mp4" | "webm" | "live_photo";
    }) => {
      const format = request.output_format;
      const extension = format === "live_photo" ? "pvt" : format;
      const result = exportResult(`C:/exports/all-formats-source-GIFP.${extension}`, 640_000, 640, format);
      return format === "live_photo" ? {
        ...result,
        backend_id: "gifp.live_photo",
        live_photo: {
          still_path: "C:/exports/all-formats-source-GIFP.pvt/IMG_TEST.JPG",
          motion_path: "C:/exports/all-formats-source-GIFP.pvt/IMG_TEST.MOV",
          asset_identifier: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
          asset_identifier_verified: true,
          metadata_pairing_verified: true,
          compatibility_status: "locally_verified",
          validation_scope: "local_contract",
        },
      } : result;
    });
    render(<GifpV3 />);

    await waitFor(() => expect(mocks.listEncoderCapabilities).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /^快速生成$/ }));
    await user.click(screen.getByRole("button", { name: /先添加素材/ }));
    const dialog = await screen.findByRole("dialog", { name: "快速生成" });
    expect(within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" })).toBeVisible();
    const formatGroup = within(dialog).getByRole("radiogroup", { name: "快速生成输出格式" });
    expect(within(formatGroup).getByRole("radio", { name: /^GIF/ })).toBeChecked();
    await user.click(within(formatGroup).getByRole("radio", { name: /全部格式/ }));
    const allFormatsSummary = within(dialog).getByRole("group", { name: "本次全部输出参数" });
    expect(allFormatsSummary).toHaveTextContent("7 份");
    expect(allFormatsSummary).toHaveTextContent("生成后逐份显示");
    await user.click(within(dialog).getByRole("button", { name: /开始生成/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(7), { timeout: 10_000 });
    expect(mocks.convertAnimation.mock.calls.map(([request]) => request.output_format)).toEqual([
      "gif",
      "webp",
      "avif",
      "apng",
      "mp4",
      "webm",
      "live_photo",
    ]);
    expect(await within(dialog).findByText("已生成")).toBeVisible();
    expect(presentedDevSnapshot()?.format).toBe("gif");
  }, 15_000);
});

describe("recording and media preview regressions", () => {
  it("shows immediate progress while the desktop region selector is preparing", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    let resolveSelection: (value: unknown) => void = () => undefined;
    mocks.selectScreenRegion.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSelection = resolve;
    }));
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^屏幕录制$/ }));
    await user.click(screen.getByRole("button", { name: /指定区域/ }));
    await user.click(screen.getByRole("button", { name: /拖拽框选录制区域/ }));

    expect(await screen.findByRole("progressbar", { name: "正在准备区域选择" })).toHaveAttribute("aria-valuetext", "正在读取桌面画面");
    expect(screen.getByText("正在准备屏幕画面")).toBeVisible();
    expect(screen.getByRole("button", { name: "正在准备选区…" })).toBeDisabled();

    resolveSelection({
      x: 120,
      y: 90,
      width: 640,
      height: 360,
      screen_x: 0,
      screen_y: 0,
      screen_width: 1920,
      screen_height: 1080,
    });

    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "正在准备区域选择" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("当前录制范围 640 × 360，X 120，Y 90")).toBeVisible();
  });

  it("keeps the confirmed recording region visible with desktop-relative position", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectScreenRegion.mockResolvedValueOnce({
      x: 318,
      y: 218,
      width: 826,
      height: 523,
      screen_x: 0,
      screen_y: 0,
      screen_width: 1920,
      screen_height: 1080,
    });
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^屏幕录制$/ }));
    await user.click(screen.getByRole("button", { name: /指定区域/ }));
    await user.click(screen.getByRole("button", { name: /拖拽框选录制区域/ }));

    await waitFor(() => expect(mocks.selectScreenRegion).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("当前录制范围 826 × 523，X 318，Y 218")).toBeVisible();
    expect(screen.getByText("826 × 523 · X 318 · Y 218")).toBeVisible();
    expect(screen.getByText(/已确认录制区域 826 × 523/, { selector: ".record-status-copy" })).toBeVisible();
  });

  it("adds a completed recording to assets and activates detailed edit", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.stopScreenRecording.mockResolvedValue("C:/captures/session-01.mp4");
    render(<GifpV3 />);

    const editorTab = screen.getByRole("button", { name: /^精细编辑$/ });
    const recordTab = screen.getByRole("button", { name: /^屏幕录制$/ });
    await user.click(recordTab);
    await user.click(screen.getByRole("button", { name: /开始录制/ }));
    const stopButton = await screen.findByRole("button", { name: /停止录制/ });
    expect(editorTab).toBeDisabled();
    expect(screen.getByRole("button", { name: "15 FPS" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "自定义录制帧率" })).toBeDisabled();
    await user.click(stopButton);

    expect((await screen.findAllByText("session-01.mp4")).length).toBeGreaterThan(0);
    expect(editorTab).toHaveClass("active");
    expect(recordTab).not.toHaveClass("active");
    expect(mocks.stopScreenRecording).toHaveBeenCalledTimes(1);
  });

  it("keeps a safely retained recording available for another save attempt", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.stopScreenRecording
      .mockRejectedValueOnce(new Error(
        "GIFP_RETRYABLE_RECORDING: GIFP cannot write to the screen recording output folder C:/locked",
      ))
      .mockResolvedValueOnce("C:/captures/recovered-recording.mp4");
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^屏幕录制$/ }));
    await user.click(screen.getByRole("button", { name: /开始录制/ }));
    await user.click(await screen.findByRole("button", { name: /停止录制/ }));

    expect(await screen.findByText(/录制内容已安全保留/, { selector: ".record-status-copy" })).toHaveClass("retained");
    expect(screen.getByRole("button", { name: /停止录制/ })).toBeVisible();
    expect(screen.getByText(/输出目录不可写/, { selector: ".record-status-copy" })).toBeVisible();
    const recovery = screen.getByRole("region", { name: "任务失败恢复" });
    await user.click(within(recovery).getByRole("button", { name: /再次保存录制/ }));
    expect((await screen.findAllByText("recovered-recording.mp4")).length).toBeGreaterThan(0);
    expect(mocks.stopScreenRecording).toHaveBeenCalledTimes(2);
  });

  it("never uses a video asset URL as an img source", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/clip.mp4";
    const videoUrl = `https://assets.local/${encodeURIComponent(videoPath)}`;
    mocks.selectVideos.mockResolvedValue([videoPath]);
    const { container } = render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    expect((await screen.findAllByText("clip.mp4")).length).toBeGreaterThan(0);
    await waitFor(() => expect(mocks.convertFileSrc).toHaveBeenCalledWith(videoPath));

    const imageSources = Array.from(container.querySelectorAll("img"), (image) => image.getAttribute("src"));
    expect(imageSources).not.toContain(videoUrl);
  });

  it("uses FFmpeg-backed real frames for a Tauri video thumbnail", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/native-clip.mp4";
    const framePath = "C:/temp/GIFP_thumbnails/frame-00.jpg";
    const frameUrl = `https://assets.local/${encodeURIComponent(framePath)}`;
    mocks.selectVideos.mockResolvedValue([videoPath]);
    mocks.generateMediaThumbnails.mockResolvedValue([{ time: 0.2, path: framePath }]);
    const { container } = render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    const video = await waitFor(() => {
      const element = container.querySelector("video");
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    Object.defineProperty(video, "duration", { configurable: true, value: 3.2 });
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 640 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 360 });
    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(mocks.generateMediaThumbnails).toHaveBeenCalledWith({
      input_path: videoPath,
      times: expect.arrayContaining([expect.any(Number)]),
    }));
    await waitFor(() => {
      const sources = Array.from(container.querySelectorAll("img"), (image) => image.getAttribute("src"));
      expect(sources).toContain(frameUrl);
    });
  });

  it("turns the volume director plan into target-search controls", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    mocks.selectVideos.mockResolvedValue(["C:/media/director.gif"]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));
    await chooseAnimatedOption(user, "生成方式", /精确体积/);
    fireEvent.change(screen.getByLabelText("最大输出体积（MB）"), { target: { value: "0.1" } });
    await openSection(user, "智能输出");
    await user.click(screen.getByRole("button", { name: "文字" }));

    expect(screen.getByText("界面与文字")).toBeVisible();
    expect(screen.getByLabelText("体积导演当前策略")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));

    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      generation_mode: "target_size",
      target_size_bytes: Math.round(0.1 * 1024 * 1024),
      target_preference: "clarity",
      perceptual_focus: "text_ui",
      target_max_attempts: expect.any(Number),
    }));
    const request = mocks.convertAnimation.mock.calls[0][0];
    expect(request.target_max_attempts).toBeGreaterThan(8);
    expect(request.fps).toBeLessThan(15);
    expect(request.colors).toBeGreaterThanOrEqual(128);
  });

  it("tracks a selected object, exposes correction nodes, and burns privacy into export", async () => {
    useTauriRuntime();
    const user = userEvent.setup();
    const videoPath = "C:/media/private-scene.mp4";
    mocks.selectVideos.mockResolvedValue([videoPath]);
    render(<GifpV3 />);

    await user.click(screen.getByRole("button", { name: /^添加素材/ }));
    await waitFor(() => expect(mocks.inspectMedia).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /对象跟踪（0）/ }));
    const drawer = await screen.findByRole("dialog", { name: "对象跟踪与隐私处理" });
    await user.click(within(drawer).getByRole("button", { name: /安全遮挡/ }));
    await user.click(within(drawer).getByRole("button", { name: "分析并跟踪" }));

    await waitFor(() => expect(mocks.trackMediaRegion).toHaveBeenCalledWith(expect.objectContaining({
      input_path: videoPath,
      sample_fps: 8,
      max_frames: 240,
    })));
    expect(await within(drawer).findByRole("list", { name: "轨迹关键帧" })).toBeVisible();
    expect(within(drawer).getAllByRole("listitem")).toHaveLength(3);
    await user.click(within(drawer).getAllByRole("listitem")[1]);
    await user.click(within(drawer).getByRole("button", { name: "应用到导出" }));

    expect(screen.getByRole("button", { name: /对象跟踪（1）/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^生成 (?!3 个|全部)/ }));
    await waitFor(() => expect(mocks.convertAnimation).toHaveBeenCalledTimes(1));
    expect(mocks.convertAnimation).toHaveBeenCalledWith(expect.objectContaining({
      tracked_effects: [expect.objectContaining({
        kind: "blackout",
        keyframes: expect.arrayContaining([
          expect.objectContaining({ time_seconds: 0, confidence: 1 }),
          expect.objectContaining({ time_seconds: 1.6 }),
        ]),
      })],
    }));
  });
});
