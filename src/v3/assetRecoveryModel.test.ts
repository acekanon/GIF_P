import { describe, expect, it } from "vitest";
import {
  applyAssetReplacement,
  assetKindFromPath,
  planAssetReplacement,
  replaceMergePaths,
  replacementStatePolicy,
  type ReplaceableAsset,
} from "./assetRecoveryModel";

const source: ReplaceableAsset = {
  id: "asset-1",
  path: "C:\\old\\clip.gif",
  name: "clip.gif",
  kind: "gif",
  sourceUrl: "asset://old",
  thumbnailUrl: "blob:cover",
  thumbs: [{ time: 1, url: "blob:thumb" }],
  duration: 4.2,
  dimensions: "640 × 360",
  frameCount: 63,
  animated: true,
  hasAlpha: true,
  codec: "gif",
  aspect: 16 / 9,
  result: { output_path: "C:\\output.gif" },
  comparisonSnapshot: { width: 640 },
  error: "old error",
  timelineError: "old timeline error",
  status: "失败",
  durableNote: "keep me",
};

describe("asset recovery model", () => {
  it("classifies every supported replacement format case-insensitively", () => {
    expect(assetKindFromPath("D:\\media\\ANIMATION.GIF")).toBe("gif");
    expect(assetKindFromPath("D:/media/card.WebP")).toBe("webp");
    expect(assetKindFromPath("D:/media/card.apng")).toBe("apng");
    expect(assetKindFromPath("D:/media/frame.PNG")).toBe("image");
    expect(assetKindFromPath("D:/media/photo.jpeg")).toBe("image");
    expect(assetKindFromPath("D:/media/movie.MOV")).toBe("video");
    expect(assetKindFromPath("D:/media/movie.mkv")).toBe("video");
    expect(assetKindFromPath("D:/media/movie.webm")).toBe("video");
  });

  it("rejects empty and unsupported replacement paths", () => {
    expect(planAssetReplacement(source, "   ")).toEqual({ ok: false, reason: "empty-path" });
    expect(planAssetReplacement(source, "D:\\media\\notes.txt")).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
    expect(planAssetReplacement(source, "D:\\media\\no-extension")).toEqual({
      ok: false,
      reason: "unsupported-format",
    });
  });

  it("plans identity, old/new paths, basename and the new file kind", () => {
    expect(planAssetReplacement(source, "  D:\\replacement\\new clip.MP4  ")).toEqual({
      ok: true,
      plan: {
        assetId: "asset-1",
        oldPath: "C:\\old\\clip.gif",
        newPath: "D:\\replacement\\new clip.MP4",
        name: "new clip.MP4",
        kind: "video",
      },
    });
  });

  it("replaces merge references case-insensitively, deduplicates, and preserves order", () => {
    expect(replaceMergePaths(
      ["D:\\first.png", "c:\\OLD\\CLIP.GIF", "D:\\keep.webp", "C:/old/clip.gif", "d:\\FIRST.PNG"],
      "C:\\old\\clip.gif",
      "D:\\replacement\\clip.mp4",
    )).toEqual([
      "D:\\first.png",
      "D:\\replacement\\clip.mp4",
      "D:\\keep.webp",
    ]);
  });

  it("deduplicates when the new path already exists while retaining its first position", () => {
    expect(replaceMergePaths(
      ["D:\\new.gif", "D:\\middle.png", "C:\\old.gif"],
      "c:\\OLD.GIF",
      "d:\\NEW.GIF",
    )).toEqual(["D:\\new.gif", "D:\\middle.png"]);
  });

  it("preserves edit state only for the matching asset identity and old path", () => {
    const result = planAssetReplacement(source, "D:\\new.mp4");
    if (!result.ok) throw new Error("expected plan");
    expect(replacementStatePolicy(source, result.plan)).toEqual({
      preserveAssetIdentity: true,
      preserveEditState: true,
      clearRuntimeState: true,
    });
    expect(replacementStatePolicy({ ...source, id: "other" }, result.plan).preserveEditState).toBe(false);
    expect(replacementStatePolicy({ ...source, path: "C:\\other.gif" }, result.plan).preserveEditState).toBe(false);
  });

  it("keeps identity and durable fields but clears all old-file runtime state and metadata", () => {
    const result = planAssetReplacement(source, "D:\\replacement\\fresh.webm");
    if (!result.ok) throw new Error("expected plan");
    const replaced = applyAssetReplacement(source, result.plan);

    expect(replaced).toEqual({
      id: "asset-1",
      path: "D:\\replacement\\fresh.webm",
      name: "fresh.webm",
      kind: "video",
      status: "等待",
      durableNote: "keep me",
    });
    for (const staleKey of [
      "sourceUrl", "thumbnailUrl", "thumbs", "duration", "dimensions", "frameCount",
      "animated", "hasAlpha", "codec", "aspect", "result", "comparisonSnapshot", "error", "timelineError",
    ]) {
      expect(replaced).not.toHaveProperty(staleKey);
    }
  });

  it("refuses to apply a plan to a different asset", () => {
    const result = planAssetReplacement(source, "D:\\new.gif");
    if (!result.ok) throw new Error("expected plan");
    expect(() => applyAssetReplacement({ ...source, id: "asset-2" }, result.plan))
      .toThrow("asset-replacement-plan-mismatch");
  });
});
