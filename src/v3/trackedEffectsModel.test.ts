import { describe, expect, it } from "vitest";
import {
  interpolateTrackedBox,
  normalizeTrackedBox,
  simplifyTrackedKeyframes,
  trackedEffectConfidenceLabel,
  transformTrackedBoxForCrop,
} from "./trackedEffectsModel";

describe("tracked effects model", () => {
  it("keeps boxes inside the visible frame", () => {
    expect(normalizeTrackedBox({ x: 95, y: -4, width: 20, height: 30 })).toEqual({ x: 80, y: 0, width: 20, height: 30 });
  });

  it("interpolates editable object tracks", () => {
    const box = interpolateTrackedBox({ keyframes: [
      { timeSeconds: 0, x: 10, y: 20, width: 20, height: 20, confidence: 1 },
      { timeSeconds: 2, x: 30, y: 40, width: 20, height: 20, confidence: 0.9 },
    ] }, 1);
    expect(box).toMatchObject({ x: 20, y: 30, width: 20, height: 20 });
  });

  it("simplifies linear tracks without removing endpoints", () => {
    const frames = Array.from({ length: 20 }, (_, index) => ({
      timeSeconds: index / 10,
      x: 10 + index,
      y: 20 + index * 0.5,
      width: 20,
      height: 16,
      confidence: 0.9,
    }));
    const simplified = simplifyTrackedKeyframes(frames);
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toBe(frames[0]);
    expect(simplified[1]).toBe(frames[frames.length - 1]);
  });

  it("retains low-confidence corrections during simplification", () => {
    const frames = [
      { timeSeconds: 0, x: 10, y: 10, width: 20, height: 20, confidence: 0.9 },
      { timeSeconds: 1, x: 20, y: 20, width: 20, height: 20, confidence: 0.2 },
      { timeSeconds: 2, x: 30, y: 30, width: 20, height: 20, confidence: 0.9 },
    ];
    expect(simplifyTrackedKeyframes(frames)).toHaveLength(3);
  });

  it("keeps the weakest correction points when a long trajectory exceeds its keyframe budget", () => {
    const frames = Array.from({ length: 18 }, (_, index) => ({
      timeSeconds: index / 4,
      x: index % 2 ? 42 : 8,
      y: 10 + index,
      width: 20,
      height: 20,
      confidence: index === 7 ? 0.12 : 0.9,
    }));
    const simplified = simplifyTrackedKeyframes(frames, 0.1, 6);
    expect(simplified.length).toBeLessThanOrEqual(6);
    expect(simplified).toContain(frames[0]);
    expect(simplified).toContain(frames[7]);
    expect(simplified).toContain(frames[frames.length - 1]);
  });

  it("maps source coordinates into an applied crop", () => {
    expect(transformTrackedBoxForCrop(
      { x: 25, y: 25, width: 25, height: 25 },
      { left: 25, top: 25, right: 25, bottom: 25 },
    )).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("makes weak tracks explicit instead of claiming success", () => {
    expect(trackedEffectConfidenceLabel({ averageConfidence: 0.58, lowConfidenceFrames: 4 })).toBe("需要校正");
  });
});
