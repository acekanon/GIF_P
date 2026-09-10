import { describe, expect, it } from "vitest";
import type { MediaAsset } from "./GifpV3";
import { DEFAULT_POSTER_SLOTS, clampPosterSlot, posterReady, seedPosterSlots } from "./dynamicPosterModel";

const assets: MediaAsset[] = [
  { id: "still", path: "poster.png", name: "poster.png", kind: "image", sourceUrl: "poster.png", status: "等待" },
  { id: "motion-a", path: "a.gif", name: "a.gif", kind: "gif", animated: true, sourceUrl: "a.gif", status: "等待" },
  { id: "motion-b", path: "b.mp4", name: "b.mp4", kind: "video", sourceUrl: "b.mp4", status: "等待" },
];

describe("dynamic poster model", () => {
  it("seeds the two motion windows without assigning the still background", () => {
    const seeded = seedPosterSlots(assets, DEFAULT_POSTER_SLOTS.map((slot) => ({ ...slot })) as typeof DEFAULT_POSTER_SLOTS);
    expect(seeded.map((slot) => slot.assetId)).toEqual(["motion-a", "motion-b"]);
    expect(posterReady(seeded, assets)).toBe(true);
  });

  it("keeps a dragged slot inside the poster canvas", () => {
    expect(clampPosterSlot({ assetId: "motion-a", enabled: true, x: 99, y: -8, width: 44, height: 22 })).toMatchObject({ x: 56, y: 0, width: 44, height: 22 });
  });

  it("requires at least one enabled known motion asset", () => {
    const disabled = DEFAULT_POSTER_SLOTS.map((slot) => ({ ...slot, assetId: "motion-a", enabled: false })) as typeof DEFAULT_POSTER_SLOTS;
    expect(posterReady(disabled, assets)).toBe(false);
  });
});
