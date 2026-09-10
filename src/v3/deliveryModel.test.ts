import { describe, expect, it } from "vitest";
import {
  ALL_DELIVERY_FORMATS,
  availableDeliveryFormats,
  DELIVERY_FORMAT_OPTIONS,
  recommendDelivery,
  resolveDeliveryFormat,
} from "./deliveryModel";

const base = {
  intent: "smart" as const,
  targetPlatform: "modern_web" as const,
  duration: 4,
  fps: 15,
  hasAlpha: false,
  focus: "auto" as const,
};

describe("GIFP 4.0 delivery routing", () => {
  it("keeps strict compatibility on GIF", () => {
    expect(recommendDelivery({ ...base, intent: "compatibility" }).format).toBe("gif");
  });

  it("routes transparent UI animation to APNG", () => {
    expect(recommendDelivery({ ...base, hasAlpha: true, focus: "text_ui" }).format).toBe("apng");
  });

  it("routes long photographic animation to MP4", () => {
    expect(recommendDelivery({ ...base, duration: 12 }).format).toBe("mp4");
  });

  it("routes transparent video to WebM", () => {
    expect(recommendDelivery({ ...base, intent: "video", hasAlpha: true }).format).toBe("webm");
  });

  it("honors an explicit target platform", () => {
    expect(recommendDelivery({ ...base, intent: "target_platform", targetPlatform: "chat" }).format).toBe("gif");
    expect(recommendDelivery({ ...base, intent: "target_platform", targetPlatform: "transparent_ui" }).format).toBe("apng");
  });

  it("offers Live Photo as an explicit paired Apple delivery", () => {
    const option = DELIVERY_FORMAT_OPTIONS.find((item) => item.value === "live_photo");
    expect(option).toMatchObject({ label: "实况照片（Live Photo）" });
    expect(option?.note).toContain("封面照片和动态视频");
  });

  it("offers Animated AVIF as an explicit opaque modern delivery", () => {
    const option = DELIVERY_FORMAT_OPTIONS.find((item) => item.value === "avif");
    expect(option).toMatchObject({ label: "Animated AVIF" });
    expect(option?.note).toContain("当前仅支持不透明素材");
    expect(resolveDeliveryFormat(recommendDelivery(base), "avif").format).toBe("avif");
  });

  it("keeps an explicit Live Photo selection without claiming compatibility", () => {
    const resolved = resolveDeliveryFormat(recommendDelivery(base), "live_photo");
    expect(resolved.format).toBe("live_photo");
    expect(resolved.reason).toContain("封面照片和动态视频");
  });

  it("defaults the visible choices to GIF and keeps all-formats last", () => {
    expect(DELIVERY_FORMAT_OPTIONS[0]).toMatchObject({ value: "gif", label: "GIF" });
    expect(DELIVERY_FORMAT_OPTIONS.some((option) => option.value === "auto")).toBe(false);
    expect(DELIVERY_FORMAT_OPTIONS[DELIVERY_FORMAT_OPTIONS.length - 1]).toMatchObject({
      value: "all",
      label: "全部格式",
    });
    expect(ALL_DELIVERY_FORMATS).toEqual(["gif", "webp", "avif", "apng", "mp4", "webm", "live_photo"]);

    const resolved = resolveDeliveryFormat(recommendDelivery(base), "all");
    expect(resolved).toMatchObject({ format: "gif" });
    expect(resolved.reason).toContain("GIF 作为主预览");
  });

  it("removes known-incompatible formats from an all-format delivery", () => {
    expect(availableDeliveryFormats({ sourceHasAlpha: true, livePhotoReady: false })).toEqual([
      "gif",
      "webp",
      "apng",
      "mp4",
      "webm",
    ]);
    expect(availableDeliveryFormats({ sourceHasAlpha: false, livePhotoReady: true }))
      .toEqual(ALL_DELIVERY_FORMATS);
  });
});
