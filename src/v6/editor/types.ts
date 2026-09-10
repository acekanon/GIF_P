/** Shared v6 project contract. All times are integer microseconds; transforms
 * use normalized canvas coordinates, with x/y identifying the layer centre. */
export type ProjectAssetKind = "video" | "gif" | "webp" | "apng" | "image";
export interface ProjectAsset {
  id: string;
  path: string;
  name: string;
  kind: ProjectAssetKind;
  width: number;
  height: number;
  durationUs: number;
}
export interface ClipCrop { left: number; top: number; right: number; bottom: number }
export interface ProjectClip {
  id: string;
  assetId: string;
  inUs: number;
  outUs: number;
  rate: number;
  /** Exact timeline span after splitting; avoids accumulating rate rounding. */
  durationUs?: number;
  reverse: boolean;
  /** Positive duration freezes the source at inUs. Zero means normal playback. */
  holdUs: number;
  fit: "contain" | "cover";
  crop: ClipCrop;
}
export interface LayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}
export interface LayerKeyframe {
  /** Time relative to the layer start. */
  timeUs: number;
  transform: LayerTransform;
}
export interface LayerBase {
  id: string;
  name: string;
  startUs: number;
  endUs: number;
  visible: boolean;
  locked: boolean;
  transform: LayerTransform;
  keyframes: LayerKeyframe[];
  /** Preserve composed poses across rounded frame-grid edits; cleared by authored transform edits. */
  transformSamples?: LayerKeyframe[];
}
export interface ProjectTextLayer extends LayerBase {
  kind: "text";
  text: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
}
export interface ProjectMediaLayer extends LayerBase {
  kind: "media";
  assetId: string;
  /** Unwrapped source clock at layer start; fractional microseconds stay exact until decoding. */
  sourceOffsetUs?: number;
  /** Hold sourceOffsetUs instead of advancing the source clock. */
  sourceFrozen?: boolean;
  /** Exact source phase after frame-grid edits; local time maps to unwrapped source time. */
  sourceTimeMap?: Array<{ timeUs: number; sourceUs: number }>;
  /** Keep the original raster bounds when a transformed layer is split. */
  rasterScaleMax?: number;
  /** Overlay width relative to canvas before applying transform.scale. */
  width: number;
}
export type ProjectLayer = ProjectTextLayer | ProjectMediaLayer;
export interface EditProject {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  canvas: { width: number; height: number; fps: number; background: string };
  assets: ProjectAsset[];
  /** A contiguous primary track. Start times are derived from clip order. */
  clips: ProjectClip[];
  /** Back-to-front order. */
  layers: ProjectLayer[];
  /** Older projects omit this and keep absolute layer times while editing. */
  editing?: { layerTiming: "absolute" | "ripple" };
  output: { loop: boolean; maxBytes: number | null; smartLossless: boolean };
}
export interface ProjectRenderRequest {
  project: EditProject;
  outputDir: string;
  taskId: string;
  preview: boolean;
  /** Request a precise, composed single-output-frame preview at project time. */
  previewFrameUs?: number;
}
export interface ProjectRenderResult {
  projectId: string;
  revision: number;
  outputPath: string;
  width: number;
  height: number;
  durationUs: number;
  bytes: number;
  preview: boolean;
  /** Product GifResult, including native verification and compression reports. */
  result: import("../../tauri").GifResult;
}
