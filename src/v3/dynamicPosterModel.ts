import type { MediaAsset } from "./GifpV3";

export type PosterCanvasPreset = "portrait" | "story" | "square";
export type PosterExportMode = "gif_webp" | "gif" | "webp";

export type PosterSlot = {
  assetId: string;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PosterCanvas = {
  width: number;
  height: number;
  label: string;
};

export const POSTER_CANVASES: Record<PosterCanvasPreset, PosterCanvas> = {
  portrait: { width: 1200, height: 1920, label: "竖版海报" },
  story: { width: 1080, height: 1920, label: "全屏故事" },
  square: { width: 1080, height: 1080, label: "方形宣传图" },
};

export const DEFAULT_POSTER_SLOTS: [PosterSlot, PosterSlot] = [
  { assetId: "", enabled: true, x: 8, y: 31, width: 84, height: 32 },
  { assetId: "", enabled: true, x: 8, y: 67, width: 43, height: 21 },
];

export function posterMotionAssets(assets: MediaAsset[]) {
  return assets.filter((asset) => asset.kind === "video" || Boolean(asset.animated));
}

export function posterStillAssets(assets: MediaAsset[]) {
  return assets.filter((asset) => asset.kind === "image" || (asset.kind === "webp" && !asset.animated));
}

export function seedPosterSlots(assets: MediaAsset[], current: [PosterSlot, PosterSlot]): [PosterSlot, PosterSlot] {
  const motion = posterMotionAssets(assets);
  const available = new Set(motion.map((asset) => asset.id));
  const first = available.has(current[0].assetId) ? current[0].assetId : motion[0]?.id || "";
  const second = available.has(current[1].assetId)
    ? current[1].assetId
    : motion.find((asset) => asset.id !== first)?.id || first;
  return [
    { ...current[0], assetId: first },
    { ...current[1], assetId: second, enabled: Boolean(second) && current[1].enabled },
  ];
}

export function clampPosterSlot(slot: PosterSlot): PosterSlot {
  const width = Math.min(96, Math.max(12, slot.width));
  const height = Math.min(90, Math.max(8, slot.height));
  return {
    ...slot,
    width,
    height,
    x: Math.min(100 - width, Math.max(0, slot.x)),
    y: Math.min(100 - height, Math.max(0, slot.y)),
  };
}

export function posterReady(slots: [PosterSlot, PosterSlot], assets: MediaAsset[]) {
  const known = new Set(posterMotionAssets(assets).map((asset) => asset.id));
  return slots.some((slot) => slot.enabled && known.has(slot.assetId));
}
