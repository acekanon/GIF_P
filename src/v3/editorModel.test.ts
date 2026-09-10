import { describe, expect, it } from "vitest";
import {
  COMPRESSION_PRESETS,
  FILTER_OPTIONS,
  buildGifRequest,
  buildTargetPortfolioProfiles,
  compactedOutputTimeForSourceTime,
  deletedFrameSourceRanges,
  deletedTimelineRanges,
  editableOutputFramePage,
  insetsToRect,
  manualSampleDeletedFrameIndices,
  normalizeDeletedFrameTimes,
  normalizeTimelineSampleTimes,
  nextPlayableSourceTime,
  outputFrameCountForTimeline,
  outputFrameIndexForSourceTime,
  outputFrameIndicesForDeletedRanges,
  outputFrameIndicesForSourceTimes,
  presetForOutputFormat,
  rectFromDrag,
  rectToInsets,
  sourceTimeForOutputFrameIndex,
  timelineFrameDots,
} from "./editorModel";

describe("crop geometry", () => {
  it("converts a crop rectangle to FFmpeg percentage insets", () => {
    expect(rectToInsets({ x: 10, y: 20, width: 60, height: 50 })).toEqual({
      left: 10,
      top: 20,
      right: 30,
      bottom: 30,
    });
  });

  it("round trips insets and rectangle coordinates", () => {
    const insets = { left: 12.5, top: 8, right: 17.5, bottom: 22 };
    expect(rectToInsets(insetsToRect(insets))).toEqual(insets);
  });

  it("normalizes reverse pointer drags and keeps the crop inside the preview", () => {
    expect(rectFromDrag({ x: 88, y: 76 }, { x: -8, y: 12 })).toEqual({
      x: 0,
      y: 12,
      width: 88,
      height: 64,
    });
  });
});

describe("compression presets", () => {
  it("retains every compression preset shipped in GIFP 2.3", () => {
    const ids = COMPRESSION_PRESETS.map((preset) => preset.id as string);

    expect(ids).toEqual(expect.arrayContaining([
      "tiny",
      "perceptual",
      "clean_noise",
      "clean",
      "meme",
      "vertical",
      "wechat",
      "qq",
      "bili",
    ]));
  });

  it("uses modern true-color baselines instead of GIF spatial and temporal ceilings", () => {
    const perceptual = COMPRESSION_PRESETS.find((preset) => preset.id === "perceptual")!;
    const webp = presetForOutputFormat(perceptual, "webp", { width: 1112, fps: 24.04 });
    const avif = presetForOutputFormat(perceptual, "avif", { width: 1112, fps: 24.04 });
    const apng = presetForOutputFormat(perceptual, "apng", { width: 1112, fps: 24.04 });

    expect(webp).toMatchObject({ width: 720, fps: 24, lossy: 14 });
    expect(avif).toMatchObject({ width: 720, fps: 24, lossy: 50 });
    expect(apng).toMatchObject({ width: 720, fps: 24, lossy: 0 });
    expect(webp.route).toContain("WebP");
    expect(avif.route).toContain("AVIF");
    expect(apng.route).toContain("APNG");
  });

  it("never upscales or invents frames beyond the inspected source", () => {
    const clean = COMPRESSION_PRESETS.find((preset) => preset.id === "clean")!;
    expect(presetForOutputFormat(clean, "webp", { width: 638, fps: 17.6 })).toMatchObject({
      width: 638,
      fps: 17,
    });
  });
});

describe("filter styles", () => {
  it("exposes the practical color and tone styles alongside the legacy filters", () => {
    const values = FILTER_OPTIONS.map((option) => option.value);

    expect(values).toEqual([
      "none",
      "vivid",
      "warm_skin",
      "cool_tone",
      "mono_contrast",
      "vintage_film",
      "soft_matte",
      "comic_ink",
      "gb",
      "gba_lcd",
      "crt",
      "pixel",
    ]);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("target-size portfolio", () => {
  it("creates three distinct real search ceilings for clarity, motion, and compactness", () => {
    const profiles = buildTargetPortfolioProfiles({
      width: 480,
      fps: 15,
      colors: 160,
      targetSizeBytes: 2_000_000,
      sourceFps: 30,
    });

    expect(profiles.map((profile) => profile.role)).toEqual([
      "clearest",
      "smoothest",
      "smallest",
    ]);
    expect(profiles[0]).toMatchObject({
      targetPreference: "clarity",
      width: 480,
      fps: 11,
      colors: 160,
      targetSizeBytes: 2_000_000,
    });
    expect(profiles[1]).toMatchObject({
      targetPreference: "smoothness",
      width: 374,
      fps: 21,
      colors: 125,
      targetSizeBytes: 2_000_000,
    });
    expect(profiles[2]).toMatchObject({
      targetPreference: "smallest",
      width: 312,
      fps: 9,
      colors: 88,
      targetSizeBytes: 1_440_000,
    });
  });

  it("does not invent motion frames beyond a known source frame rate", () => {
    const profiles = buildTargetPortfolioProfiles({
      width: 320,
      fps: 12,
      colors: 96,
      targetSizeBytes: 512_000,
      sourceFps: 15,
    });
    expect(profiles[1].fps).toBe(15);
  });
});

describe("deleted frame timing", () => {
  it("maps source time through trim and playback speed exactly like the backend", () => {
    expect(outputFrameIndexForSourceTime(1.05, 1, 3, 2, 15)).toBe(0);
    expect(outputFrameIndexForSourceTime(1.15, 1, 3, 2, 15)).toBe(1);
  });

  it("supports 3x playback speed when mapping source time to output frames", () => {
    expect(outputFrameIndexForSourceTime(0.3, 0, 1, 3, 10)).toBe(1);
    expect(outputFrameIndexForSourceTime(1, 0, 1, 3, 10)).toBeNull();
  });

  it("clamps a near-end sample to the final real CFR frame and rejects the exact end", () => {
    expect(outputFrameIndexForSourceTime(0.975, 0, 1, 1, 15)).toBe(14);
    expect(outputFrameIndexForSourceTime(1, 0, 1, 1, 15)).toBeNull();
  });

  it("deduplicates output-frame indices while preserving the latest edit order", () => {
    expect(normalizeDeletedFrameTimes([0.067, 0.133, 0.25], 0, 1, 2, 15)).toEqual([
      0.067,
      0.25,
    ]);
  });

  it("removes deletion markers outside the current trim range", () => {
    expect(normalizeDeletedFrameTimes([0.4, 0.5, 0.9, 1.1], 0.5, 1, 1, 10)).toEqual([
      0.5,
      0.9,
    ]);
  });

  it("builds a stable output-frame page from trim, speed and fps", () => {
    expect(outputFrameCountForTimeline(1, 3, 2, 15)).toBe(15);
    expect(sourceTimeForOutputFrameIndex(2, 1, 3, 2, 15)).toBeCloseTo(1.266667, 6);
    expect(sourceTimeForOutputFrameIndex(15, 1, 3, 2, 15)).toBeNull();
    expect(editableOutputFramePage(1, 3, 2, 15, 2, 3)).toEqual([
      { index: 2, sourceTime: 1.266667, outputTime: 0.133333 },
      { index: 3, sourceTime: 1.4, outputTime: 0.2 },
      { index: 4, sourceTime: 1.533333, outputTime: 0.266667 },
    ]);
  });

  it("maps exact deleted output frames back to source ranges for preview", () => {
    const times = [
      sourceTimeForOutputFrameIndex(2, 1, 3, 2, 10)!,
      sourceTimeForOutputFrameIndex(3, 1, 3, 2, 10)!,
      sourceTimeForOutputFrameIndex(7, 1, 3, 2, 10)!,
    ];
    expect(outputFrameIndicesForSourceTimes(times, 1, 3, 2, 10)).toEqual([2, 3, 7]);
    expect(deletedFrameSourceRanges(times, 1, 3, 2, 10)).toEqual([
      { start_seconds: 1.4, end_seconds: 1.8 },
      { start_seconds: 2.4, end_seconds: 2.6 },
    ]);
  });

  it("supports manual every-N-frame sampling while retaining boundaries", () => {
    expect(manualSampleDeletedFrameIndices(10, 3)).toEqual([1, 2, 4, 5, 7, 8]);
    expect(manualSampleDeletedFrameIndices(10, 2, [2, 3, 4, 5, 6])).toEqual([3, 5]);
    expect(manualSampleDeletedFrameIndices(1, 4)).toEqual([]);
  });

  it("reflows compact timeline dots after deletion and preserves source mapping", () => {
    expect(timelineFrameDots(8, [1, 4], "compact", 20)).toEqual([
      expect.objectContaining({ representativeIndex: 0, representativeOutputIndex: 0 }),
      expect.objectContaining({ representativeIndex: 2, representativeOutputIndex: 1 }),
      expect.objectContaining({ representativeIndex: 3, representativeOutputIndex: 2 }),
      expect.objectContaining({ representativeIndex: 5, representativeOutputIndex: 3 }),
      expect.objectContaining({ representativeIndex: 6, representativeOutputIndex: 4 }),
      expect.objectContaining({ representativeIndex: 7, representativeOutputIndex: 5 }),
    ]);
  });

  it("keeps duration-preserving deletion slots visible as removed dots", () => {
    const dots = timelineFrameDots(8, [1, 4], "preserve", 20);
    expect(dots).toHaveLength(8);
    expect(dots[1]).toMatchObject({ representativeIndex: 1, representativeOutputIndex: 1, removed: true });
    expect(dots[4]).toMatchObject({ representativeIndex: 4, representativeOutputIndex: 4, removed: true });
  });

  it("buckets an extreme timeline without losing its first and final frame", () => {
    const dots = timelineFrameDots(10_000, [], "compact", 180);
    expect(dots).toHaveLength(180);
    expect(dots[0].firstIndex).toBe(0);
    expect(dots[dots.length - 1]?.lastIndex).toBe(9_999);
  });
});

describe("timeline segment deletion", () => {
  it("maps source annotation times onto the compacted output timeline", () => {
    const removed = [
      { start_seconds: 5.5, end_seconds: 6 },
      { start_seconds: 7, end_seconds: 8 },
    ];
    expect(compactedOutputTimeForSourceTime(6.5, 5, 12, 2, removed)).toBe(0.5);
    expect(compactedOutputTimeForSourceTime(9, 5, 12, 2, removed)).toBe(1.25);
    expect(compactedOutputTimeForSourceTime(4.9, 5, 12, 2, removed)).toBeNull();
  });

  it("turns sampled thumbnails into midpoint-bounded time ranges and merges neighbors", () => {
    expect(deletedTimelineRanges([0.25, 0.75], [0.25, 0.75, 1.25, 1.75], 0, 2)).toEqual([
      { start_seconds: 0, end_seconds: 1 },
    ]);
    expect(deletedTimelineRanges([1.75], [0.25, 0.75, 1.25, 1.75], 0, 2)).toEqual([
      { start_seconds: 1.5, end_seconds: 2 },
    ]);
  });

  it("uses 256 as the quality ceiling while retaining explicit small-file palettes", () => {
    const colors = Object.fromEntries(COMPRESSION_PRESETS.map((preset) => [preset.id, preset.colors]));
    expect(colors).toMatchObject({
      perceptual: 256,
      clean_noise: 256,
      clean: 256,
      bili: 256,
      vertical: 192,
      tiny: 24,
      meme: 32,
      wechat: 32,
      qq: 64,
    });
  });

  it("keeps distinct sample edits even if they map to the same output frame", () => {
    expect(normalizeTimelineSampleTimes([0.067, 0.133, 0.133, 1.1], 0, 1)).toEqual([0.067, 0.133]);
  });

  it("expands deleted ranges to the compacted comparison frame map", () => {
    expect(outputFrameIndicesForDeletedRanges(
      [{ start_seconds: 0, end_seconds: 0.5 }],
      0,
      10,
      1,
      12,
    )).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("skips deleted source ranges during edited playback", () => {
    const ranges = [
      { start_seconds: 0, end_seconds: 2 },
      { start_seconds: 4, end_seconds: 6 },
      { start_seconds: 9, end_seconds: 10 },
    ];
    expect(nextPlayableSourceTime(0, ranges, 0, 10)).toBe(2);
    expect(nextPlayableSourceTime(3, ranges, 0, 10)).toBe(3);
    expect(nextPlayableSourceTime(4.5, ranges, 0, 10)).toBe(6);
    expect(nextPlayableSourceTime(9.5, ranges, 0, 10)).toBeNull();
  });
});

describe("GIF request builder", () => {
  it("keeps GIF input first-class and forwards 2x playback speed", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/loop.gif",
      outputDir: "C:/media/out",
      presetId: "perceptual",
      playbackSpeed: 2,
      loopOutput: true,
      crop: { left: 10, top: 5, right: 10, bottom: 5 },
      startSeconds: 0,
      endSeconds: 3.2,
      deletedFrames: [],
    });

    expect(request.schema_version).toBe(1);
    expect(request.perceptual_focus).toBe("auto");
    expect(request.target_preference).toBe("auto");
    expect(request.input_path).toBe("C:/media/loop.gif");
    expect(request.output_format).toBe("gif");
    expect(request).not.toHaveProperty("webp_quality");
    expect(request).not.toHaveProperty("chroma_key_enabled");
    expect(request.playback_speed).toBe(2);
    expect(request.frame_timing_mode).toBe("compact");
    expect(request.crop_enabled).toBe(true);
    expect(request.crop_left).toBe(10);
    expect(request.fps).toBe(15);
  });

  it("forwards duration-preserving manual frame sampling", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "perceptual",
      playbackSpeed: 1,
      loopOutput: true,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      startSeconds: 0,
      endSeconds: 2,
      deletedFrames: [0.1, 0.3],
      frameTimingMode: "preserve",
    });

    expect(request.frame_timing_mode).toBe("preserve");
    expect(request.deleted_frames).toEqual([0.1, 0.3]);
    expect(request.deleted_ranges).toEqual([]);
  });

  it("omits crop mode when all insets are zero", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "clean",
      playbackSpeed: 1,
      loopOutput: true,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      startSeconds: 0,
      endSeconds: 0,
      deletedFrames: [],
    });

    expect(request.crop_enabled).toBe(false);
    expect(request.playback_speed).toBe(1);
  });

  it("preserves a crop anchored to the right and bottom while enforcing a four-percent minimum", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "clean",
      playbackSpeed: 1,
      loopOutput: true,
      crop: { left: 80, top: 80, right: 0, bottom: 0 },
      startSeconds: 0,
      endSeconds: 0,
      deletedFrames: [],
    });

    expect(request).toMatchObject({
      crop_enabled: true,
      crop_left: 80,
      crop_top: 80,
      crop_right: 0,
      crop_bottom: 0,
    });
  });

  it("normalizes combined crop insets instead of clipping either side independently", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "clean",
      playbackSpeed: 1,
      loopOutput: true,
      crop: { left: 80, top: 48, right: 80, bottom: 48 },
      startSeconds: 0,
      endSeconds: 0,
      deletedFrames: [],
    });

    expect(request.crop_left + request.crop_right).toBe(96);
    expect(request.crop_top + request.crop_bottom).toBe(96);
  });

  it("reserves a transparent palette entry by clamping colors to at least three", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "custom",
      playbackSpeed: 1,
      loopOutput: true,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      startSeconds: 0,
      endSeconds: 0,
      deletedFrames: [],
      overrides: { colors: 2 },
    });

    expect(request.colors).toBe(3);
  });

  it("preserves advanced encoding values and deleted frames", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "custom",
      playbackSpeed: 1,
      loopOutput: false,
      crop: { left: 1, top: 2, right: 3, bottom: 4 },
      startSeconds: 0.4,
      endSeconds: 4.8,
      deletedFrames: [0.667, 1.333, 2.8],
      perceptualFocus: "text_ui",
      overrides: {
        width: 512,
        fps: 24,
        colors: 160,
        dither: "floyd_steinberg",
        lossy: 37,
        encoder: "clean_opt",
        filter_style: "crt",
      },
    });

    expect(request).toMatchObject({
      width: 512,
      fps: 24,
      colors: 160,
      dither: "floyd_steinberg",
      lossy: 37,
      encoder: "clean_opt",
      filter_style: "crt",
      loop_output: false,
      deleted_frames: [0.667, 1.333, 2.8],
      perceptual_focus: "text_ui",
    });
  });

  it("forwards only unique in-range output frames after trim and 2x mapping", () => {
    const request = buildGifRequest({
      inputPath: "C:/media/clip.mp4",
      outputDir: "C:/media/out",
      presetId: "perceptual",
      playbackSpeed: 2,
      loopOutput: true,
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      startSeconds: 1,
      endSeconds: 2,
      deletedFrames: [0.9, 1.067, 1.133, 1.25, 2.1],
    });

    expect(request.deleted_frames).toEqual([1.067, 1.25]);
  });
});
