import { describe, expect, it } from "vitest";
import {
  estimateQuickFormatSizes,
  estimateQuickOutputSize,
  QUICK_FORMAT_MEASURED_RANGE_TO_GIF,
  QUICK_FORMAT_RELATIVE_TO_GIF,
  QUICK_DELIVERY_SCENARIOS,
  QUICK_USE_CASE_OPTIONS,
  quickDesiredTargetSizeMb,
  quickPlatformHints,
  quickScalePercentForWidth,
  quickScenarioById,
  quickScenariosFor,
  quickWidthForScale,
  recommendQuickStart,
  resolveQuickScenarioForSource,
} from "./quickDeliveryModel";

describe("quick delivery scenarios", () => {
  it("uses the 5.7 multi-source format benchmark instead of example ratios", () => {
    expect(QUICK_FORMAT_RELATIVE_TO_GIF).toMatchObject({
      gif: 1,
      webp: 0.4,
      avif: 0.1,
      apng: 2.8,
      mp4: 0.1,
      webm: 0.1,
    });
    expect(QUICK_FORMAT_MEASURED_RANGE_TO_GIF.apng).toEqual([2.36, 3.08]);
  });

  it("covers chat, social live-photo, web, and manual workflows", () => {
    expect(QUICK_USE_CASE_OPTIONS.map((option) => option.value)).toEqual([
      "chat",
      "social_live",
      "web",
      "manual",
    ]);
    expect(QUICK_DELIVERY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "qq_chat",
      "wechat_chat",
      "wechat_sticker",
      "feishu_chat",
      "xiaohongshu_live",
      "douyin_live",
      "web_animation",
      "web_transparent_ui",
    ]);
  });

  it("keeps chat size values as conservative guidance rather than verified platform ceilings", () => {
    expect(quickScenariosFor("chat")[0]).toMatchObject({
      id: "qq_chat",
      format: "gif",
      targetSizeMb: 1.9,
      targetLabel: "保守建议 1.9 MB（非平台上限）",
    });
    expect(quickScenarioById("wechat_chat")).toMatchObject({
      format: "gif",
      width: 420,
      targetSizeMb: 1.9,
      targetLabel: "保守建议 1.9 MB（非平台上限）",
    });
    expect(quickScenarioById("feishu_chat")).toMatchObject({
      format: "gif",
      targetLabel: "平台建议上限",
    });
    expect(quickScenarioById("feishu_chat")?.targetSizeMb).toBeUndefined();
  });

  it("keeps the strict WeChat sticker profile distinct from chat GIF delivery", () => {
    expect(quickScenarioById("wechat_sticker")).toMatchObject({
      format: "gif",
      width: 240,
      fps: 12,
      targetSizeMb: 0.48,
      aspect: 1,
      maxDuration: 3,
    });
    expect(quickScenarioById("wechat_chat")!.targetSizeMb).toBeGreaterThan(
      quickScenarioById("wechat_sticker")!.targetSizeMb!,
    );
  });

  it("uses native Live Photo packaging for Xiaohongshu and Douyin scenes", () => {
    expect(quickScenariosFor("social_live")).toEqual([
      expect.objectContaining({ id: "xiaohongshu_live", format: "live_photo", aspect: 3 / 4, maxDuration: 3 }),
      expect.objectContaining({ id: "douyin_live", format: "live_photo", aspect: 9 / 16, maxDuration: 3 }),
    ]);
  });

  it("caps scenario resolution and frame rate to the inspected source", () => {
    const web = quickScenarioById("web_animation")!;
    expect(resolveQuickScenarioForSource(web, { width: 638, fps: 17.8 })).toMatchObject({
      width: 638,
      fps: 17,
      format: "webp",
      lossy: 14,
    });
  });

  it("does not upscale a portrait crop taken from a landscape source", () => {
    const douyin = quickScenarioById("douyin_live")!;
    expect(resolveQuickScenarioForSource(douyin, { width: 1920, height: 1080, fps: 60 })).toMatchObject({
      width: 606,
      fps: 30,
      aspect: 9 / 16,
    });
  });

  it("starts a long HD source with an aggressive scale and low recommended frame rate", () => {
    expect(recommendQuickStart({
      width: 1280,
      height: 720,
      fps: 30,
      duration: 15,
    })).toEqual({
      scalePercent: 20,
      width: 256,
      fps: 8,
      reason: "长片段建议使用 20% 尺寸和 8 FPS",
    });
  });

  it("converts scale multipliers to even widths without upscaling", () => {
    expect(quickWidthForScale(638, 50)).toBe(318);
    expect(quickWidthForScale(638, 100)).toBe(638);
    expect(quickWidthForScale(638, 120)).toBe(638);
    expect(quickWidthForScale(320, 20)).toBe(64);
    expect(quickWidthForScale(320, 10)).toBe(32);
    expect(quickWidthForScale(320, 5)).toBe(16);
    expect(quickWidthForScale(320, 1)).toBe(16);
    expect(quickScalePercentForWidth(638, 318)).toBe(50);
    expect(quickScalePercentForWidth(320, 16)).toBe(5);
  });

  it("predicts monotonically smaller output when both scale and frame rate fall", () => {
    const large = estimateQuickOutputSize({
      sourceWidth: 1280,
      sourceHeight: 720,
      sourceFps: 30,
      duration: 8,
      width: 640,
      fps: 15,
      format: "gif",
    });
    const small = estimateQuickOutputSize({
      sourceWidth: 1280,
      sourceHeight: 720,
      sourceFps: 30,
      duration: 8,
      width: 320,
      fps: 8,
      format: "gif",
    });
    expect(small.upperBytes).toBeLessThan(large.lowerBytes);
    expect(small.savingPercent).toBeGreaterThan(large.savingPercent);
    expect(quickDesiredTargetSizeMb(small)).toBeLessThan(quickDesiredTargetSizeMb(large));
    expect(quickDesiredTargetSizeMb(large)).toBeGreaterThan(1.9);
  });

  it("compares every output format at the same dimensions, frame rate, and duration", () => {
    const comparison = estimateQuickFormatSizes({
      formats: ["gif", "webp", "avif", "apng", "mp4", "webm", "live_photo"],
      sourceWidth: 1280,
      sourceHeight: 720,
      sourceFps: 30,
      duration: 8,
      width: 640,
      fps: 15,
    });

    expect(comparison.map((item) => [item.format, item.relativeToGifPercent])).toEqual([
      ["gif", 100],
      ["webp", 40],
      ["avif", 10],
      ["apng", 280],
      ["mp4", 10],
      ["webm", 10],
      ["live_photo", 20],
    ]);
    expect(comparison.every((item) => item.lowerBytes < item.upperBytes)).toBe(true);
    expect(comparison.find((item) => item.format === "apng")?.likelyBytes)
      .toBeGreaterThan(comparison.find((item) => item.format === "gif")?.likelyBytes ?? 0);
  });

  it("does not let GIF palette controls change modern-format size estimates", () => {
    const common = {
      sourceWidth: 1280,
      sourceHeight: 720,
      sourceFps: 30,
      duration: 8,
      width: 640,
      fps: 15,
    };
    const compactPalette = estimateQuickOutputSize({ ...common, format: "webp", colors: 16, lossy: 100 });
    const richPalette = estimateQuickOutputSize({ ...common, format: "webp", colors: 256, lossy: 0 });
    expect(compactPalette).toEqual(richPalette);

    const compactGif = estimateQuickOutputSize({ ...common, format: "gif", colors: 16, lossy: 100 });
    const richGif = estimateQuickOutputSize({ ...common, format: "gif", colors: 256, lossy: 0 });
    expect(compactGif.likelyBytes).toBeLessThan(richGif.likelyBytes);
  });

  it("returns versioned, explicitly unverified platform hints for GIF delivery", () => {
    const hints = quickPlatformHints({
      format: "gif",
      width: 320,
      fps: 12,
      duration: 3,
      estimatedBytes: 1024 * 1024,
    });
    expect(hints.filter((hint) => hint.fit === "unverified").map((hint) => hint.id)).toEqual([
      "wechat_chat",
      "qq_chat",
      "feishu_chat",
    ]);
    expect(hints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "wechat_sticker",
        fit: "adjust",
        verification: "unverified",
        policyVersion: "1",
      }),
    ]));
    expect(hints.every((hint) => hint.sourceLabel.length > 0)).toBe(true);
  });
});
