import { describe, expect, it } from "vitest";
import { planVolumeDirector } from "./volumeDirectorModel";

const base = {
  sourceWidth: 1920,
  sourceHeight: 1080,
  durationSeconds: 8,
  sourceFps: 30,
  outputWidth: 960,
  outputFps: 20,
  colors: 256,
  lossy: 10,
  targetSizeMb: 2,
  hasAlpha: false,
  mediaKind: "video" as const,
  perceptualFocus: "auto" as const,
  priority: "balanced" as const,
};

describe("volume director", () => {
  it("protects text by spending frame rate before colors", () => {
    const plan = planVolumeDirector({ ...base, priority: "text", perceptualFocus: "text_ui", targetSizeMb: 0.6 });
    expect(plan.contentClass).toBe("screen_ui");
    expect(plan.targetPreference).toBe("clarity");
    expect(plan.suggestedFps).toBeLessThan(base.outputFps);
    expect(plan.suggestedColors).toBe(256);
    expect(plan.protectedSignals).toContain("文字与细线");
  });

  it("protects frame rate for motion and reduces spatial pressure first", () => {
    const plan = planVolumeDirector({ ...base, priority: "motion", perceptualFocus: "motion", targetSizeMb: 0.5 });
    expect(plan.targetPreference).toBe("smoothness");
    expect(plan.suggestedFps).toBe(base.outputFps);
    expect(plan.suggestedWidth).toBeLessThan(base.outputWidth);
  });

  it("uses static frame holding for pressured screen recordings", () => {
    const plan = planVolumeDirector({ ...base, priority: "text", targetSizeMb: 0.4 });
    expect(plan.timelinePolicy).toBe("static_hold");
    expect(plan.maxAttempts).toBe(12);
  });

  it("never proposes invalid GIF limits", () => {
    const plan = planVolumeDirector({ ...base, outputWidth: 96, outputFps: 5, colors: 3, priority: "smallest", targetSizeMb: 0.1 });
    expect(plan.suggestedWidth).toBeGreaterThanOrEqual(96);
    expect(plan.suggestedFps).toBeGreaterThanOrEqual(5);
    expect(plan.suggestedColors).toBeGreaterThanOrEqual(3);
  });

  it("recognizes transparent assets and protects alpha edges", () => {
    const plan = planVolumeDirector({ ...base, mediaKind: "webp", hasAlpha: true, priority: "balanced" });
    expect(plan.contentClass).toBe("transparent_asset");
    expect(plan.targetPreference).toBe("clarity");
    expect(plan.protectedSignals).toContain("透明边缘");
  });

  it("does not reduce visible quality when the byte budget is comfortable", () => {
    const plan = planVolumeDirector({
      ...base,
      durationSeconds: 0.5,
      outputWidth: 320,
      outputFps: 10,
      colors: 128,
      targetSizeMb: 20,
      priority: "text",
    });
    expect(plan.pressure).toBe("low");
    expect(plan.suggestedWidth).toBe(320);
    expect(plan.suggestedFps).toBe(10);
    expect(plan.suggestedColors).toBe(128);
    expect(plan.suggestedLossy).toBe(base.lossy);
  });
});
