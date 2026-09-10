import type { ClipCrop, EditProject, LayerKeyframe, LayerTransform, ProjectAsset, ProjectClip, ProjectLayer, ProjectMediaLayer } from "./types";

export const US_PER_SECOND = 1_000_000;
/** Shared desktop renderer budgets; keep user projects saveable before rendering. */
export const PROJECT_LIMITS = { durationUs: 300_000_000, assets: 128, clips: 2048, layers: 64, keyframes: 128, sourceTimePoints: 36002, transformSamples: 36002, jsonBytes: 8 * 1024 * 1024 } as const;
export const DEFAULT_TRANSFORM: LayerTransform = { x: .5, y: .5, scale: 1, rotation: 0, opacity: 1 };
export const DEFAULT_CROP: ClipCrop = { left: 0, top: 0, right: 0, bottom: 0 };
/** Primary edits preserve absolute subtitle/overlay times unless ripple is requested. */
export type LayerTimingPolicy = "absolute" | "ripple";
function checkLayerPolicy(policy: LayerTimingPolicy) { if (policy !== "absolute" && policy !== "ripple") fail("Invalid layer timing policy"); }
export function newProjectId(prefix = "item"): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
function fail(message: string): never { throw new Error(message); }
function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(`${name} must be an integer between ${min} and ${max}`);
}
function number(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(`${name} is out of range`);
}
function string(value: unknown, name: string, nonempty = false, maxBytes = Number.MAX_SAFE_INTEGER): asserts value is string {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail(`${name} must be a ${nonempty ? "nonempty " : ""}string`);
  if (new TextEncoder().encode(value).length > maxBytes) fail(`${name} is too long`);
}
function record(value: unknown, name: string, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name}.${key} is not supported`);
}
function bool(value: unknown, name: string): asserts value is boolean { if (typeof value !== "boolean") fail(`${name} must be boolean`); }
function color(value: unknown, name: string) {
  string(value, name);
  if (!/^#[\da-f]{6}$/i.test(value)) fail(`${name} must be a #RRGGBB color`);
}
function transform(value: unknown) {
  record(value, "transform", ["x", "y", "scale", "rotation", "opacity"]);
  number(value.x, "transform.x", -2, 3); number(value.y, "transform.y", -2, 3);
  number(value.scale, "transform.scale", .01, 8); number(value.rotation, "transform.rotation", -3600, 3600);
  number(value.opacity, "transform.opacity", 0, 1);
}
function crop(value: unknown) {
  record(value, "crop", ["left", "top", "right", "bottom"]);
  for (const key of ["left", "top", "right", "bottom"]) number(value[key], `crop.${key}`, 0, .99);
  if ((value.left as number) + (value.right as number) >= .99 || (value.top as number) + (value.bottom as number) >= .99) fail("Crop must leave more than 1% visible on each axis");
}
export function assertProject(value: unknown): asserts value is EditProject {
  record(value, "project", ["schemaVersion", "id", "name", "revision", "canvas", "assets", "clips", "layers", "editing", "output"]);
  if (value.schemaVersion !== 1) fail("Unsupported project schema version");
  string(value.id, "project.id", true, 160); string(value.name, "project.name", false, 512); integer(value.revision, "revision");
  record(value.canvas, "canvas", ["width", "height", "fps", "background"]);
  integer(value.canvas.width, "canvas.width", 96, 1920); integer(value.canvas.height, "canvas.height", 16, 1920);
  integer(value.canvas.fps, "canvas.fps", 1, 60); color(value.canvas.background, "canvas.background");
  record(value.output, "output", ["loop", "maxBytes", "smartLossless", "temporalStability", "lzwSearch"]);
  bool(value.output.loop, "output.loop"); bool(value.output.smartLossless, "output.smartLossless");
  for (const key of ["temporalStability", "lzwSearch"]) if (key in value.output) bool(value.output[key], `output.${key}`);
  if (value.output.maxBytes !== null) integer(value.output.maxBytes, "output.maxBytes", 1024, 512 * 1024 * 1024);
  if (value.editing !== undefined) {
    record(value.editing, "editing", ["layerTiming"]);
    if (value.editing.layerTiming !== "absolute" && value.editing.layerTiming !== "ripple") fail("Invalid layer timing policy");
  }
  if (!Array.isArray(value.assets) || !Array.isArray(value.clips) || !Array.isArray(value.layers)) fail("Project tracks and assets must be arrays");
  if (value.assets.length > PROJECT_LIMITS.assets || value.clips.length > PROJECT_LIMITS.clips || value.layers.length > PROJECT_LIMITS.layers) fail("Project exceeds 128 assets, 2048 clips or 64 layers");
  const ids = new Set<string>(); const assets = new Map<string, ProjectAsset>();
  const id = (v: unknown) => { string(v, "id", true); if (ids.has(v)) fail(`Duplicate id: ${v}`); ids.add(v); };
  for (const asset of value.assets) {
    record(asset, "asset", ["id", "path", "name", "kind", "width", "height", "durationUs"]);
    id(asset.id); string(asset.path, "asset.path", true, 32768); string(asset.name, "asset.name", false, 512);
    if (!["video", "gif", "webp", "apng", "image"].includes(String(asset.kind))) fail("Unsupported asset kind");
    integer(asset.width, "asset.width", 1, 100_000); integer(asset.height, "asset.height", 1, 100_000); integer(asset.durationUs, "asset.durationUs");
    assets.set(asset.id as string, asset as unknown as ProjectAsset);
  }
  let total = 0;
  for (const clip of value.clips) {
    record(clip, "clip", ["id", "assetId", "inUs", "outUs", "rate", "durationUs", "reverse", "holdUs", "fit", "crop"]);
    id(clip.id); string(clip.assetId, "clip.assetId", true); const asset = assets.get(clip.assetId) ?? fail("Clip references a missing asset");
    integer(clip.inUs, "clip.inUs", 0, 86_400_000_000); integer(clip.outUs, "clip.outUs", 0, 86_400_000_000); integer(clip.holdUs, "clip.holdUs");
    number(clip.rate, "clip.rate", .05, 16); bool(clip.reverse, "clip.reverse");
    if (clip.durationUs !== undefined) integer(clip.durationUs, "clip.durationUs", 1);
    if (clip.fit !== "contain" && clip.fit !== "cover") fail("Invalid clip fit"); crop(clip.crop);
    if (clip.outUs < clip.inUs || (!clip.holdUs && clip.outUs === clip.inUs)) fail("Clip source range is empty or reversed");
    if (asset.kind !== "image" && (clip.outUs > asset.durationUs || clip.inUs >= asset.durationUs)) fail("Clip exceeds source duration");
    const duration = clipDurationUs(clip as unknown as ProjectClip); integer(duration, "clip duration", 1);
    total += duration; integer(total, "project duration", 0, PROJECT_LIMITS.durationUs);
  }
  for (const layer of value.layers) {
    const common = ["id", "name", "kind", "startUs", "endUs", "visible", "locked", "transform", "keyframes", "transformSamples"];
    record(layer, "layer", [...common, "text", "fontSize", "color", "strokeColor", "strokeWidth", "assetId", "width", "sourceOffsetUs", "sourceFrozen", "sourceTimeMap", "rasterScaleMax"]);
    id(layer.id); string(layer.name, "layer.name"); integer(layer.startUs, "layer.startUs", 0, PROJECT_LIMITS.durationUs); integer(layer.endUs, "layer.endUs", 1, PROJECT_LIMITS.durationUs);
    if (layer.endUs <= layer.startUs) fail("Layer must have positive duration");
    bool(layer.visible, "layer.visible"); bool(layer.locked, "layer.locked"); transform(layer.transform);
    if (!Array.isArray(layer.keyframes) || layer.keyframes.length > PROJECT_LIMITS.keyframes) fail("Invalid layer keyframes (maximum 128 per layer)");
    let last = -1;
    for (const key of layer.keyframes) {
      record(key, "keyframe", ["timeUs", "transform"]); integer(key.timeUs, "keyframe.timeUs", 0, layer.endUs - layer.startUs);
      if (key.timeUs <= last) fail("Keyframes must be sorted with unique times"); last = key.timeUs; transform(key.transform);
    }
    if (layer.transformSamples !== undefined) {
      if (!Array.isArray(layer.transformSamples) || layer.transformSamples.length < 2 || layer.transformSamples.length > PROJECT_LIMITS.transformSamples) fail("transformSamples requires 2–36002 samples");
      let previous = -1;
      for (const sample of layer.transformSamples) {
        record(sample, "transform sample", ["timeUs", "transform"]); integer(sample.timeUs, "transformSamples.timeUs", 0, layer.endUs-layer.startUs);
        if (sample.timeUs <= previous) fail("transformSamples must have strictly increasing times"); previous = sample.timeUs; transform(sample.transform);
      }
      if (layer.transformSamples[0].timeUs !== 0 || previous !== layer.endUs-layer.startUs) fail("transformSamples must cover the whole layer interval");
    }
    if (layer.kind === "text") {
      record(layer, "text layer", [...common, "text", "fontSize", "color", "strokeColor", "strokeWidth"]);
      string(layer.text, "layer.text", false, 8192); number(layer.fontSize, "fontSize", 1, 512); color(layer.color, "text color"); color(layer.strokeColor, "stroke color"); number(layer.strokeWidth, "strokeWidth", 0, 32);
    } else if (layer.kind === "media") {
      record(layer, "media layer", [...common, "assetId", "width", "sourceOffsetUs", "sourceFrozen", "sourceTimeMap", "rasterScaleMax"]);
      string(layer.assetId, "layer.assetId"); if (!assets.has(layer.assetId)) fail("Layer references a missing asset"); number(layer.width, "layer.width", .01, 2);
      if (layer.sourceOffsetUs !== undefined) number(layer.sourceOffsetUs, "layer.sourceOffsetUs", 0, 86_400_000_000);
      if (layer.sourceFrozen !== undefined) bool(layer.sourceFrozen, "layer.sourceFrozen");
      if (layer.rasterScaleMax !== undefined) number(layer.rasterScaleMax, "layer.rasterScaleMax", .01, 8);
      if (layer.sourceTimeMap !== undefined) {
        if (layer.sourceFrozen) fail("Frozen media cannot also have a sourceTimeMap");
        if (!Array.isArray(layer.sourceTimeMap) || layer.sourceTimeMap.length < 2 || layer.sourceTimeMap.length > PROJECT_LIMITS.sourceTimePoints) fail("sourceTimeMap requires 2–36002 points");
        let previousTime = -1, previousSource = -1;
        for (const point of layer.sourceTimeMap) {
          record(point, "sourceTimeMap point", ["timeUs", "sourceUs"]);
          integer(point.timeUs, "sourceTimeMap.timeUs", 0, layer.endUs - layer.startUs);
          number(point.sourceUs, "sourceTimeMap.sourceUs", 0, 86_400_000_000);
          if (point.timeUs <= previousTime || point.sourceUs <= previousSource) fail("sourceTimeMap times and source clocks must strictly increase");
          previousTime = point.timeUs; previousSource = point.sourceUs;
        }
        if (layer.sourceTimeMap[0].timeUs !== 0 || previousTime !== layer.endUs - layer.startUs) fail("sourceTimeMap must cover the whole layer interval");
      }
    } else fail("Unsupported layer kind");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > PROJECT_LIMITS.jsonBytes) fail("Project JSON exceeds 8 MiB");
}
export function createProject(name = "未命名工程"): EditProject {
  const project: EditProject = { schemaVersion: 1, id: newProjectId("project"), name, revision: 0,
    canvas: { width: 480, height: 480, fps: 15, background: "#000000" }, assets: [], clips: [], layers: [],
    editing: { layerTiming: "ripple" }, output: { loop: true, maxBytes: null, smartLossless: false, temporalStability: false, lzwSearch: false } };
  assertProject(project); return project;
}
function changed(project: EditProject, next: EditProject): EditProject {
  const candidate = { ...next, revision: project.revision };
  assertProject(candidate);
  if (JSON.stringify(candidate) === JSON.stringify(project)) return project;
  const result = { ...candidate, revision: project.revision + 1 }; assertProject(result); return result;
}
function getClip(project: EditProject, id: string) { return project.clips.find(c => c.id === id) ?? fail(`Unknown clip: ${id}`); }
function getLayer(project: EditProject, id: string) { return project.layers.find(l => l.id === id) ?? fail(`Unknown layer: ${id}`); }
export function clipDurationUs(clip: ProjectClip): number { return clip.holdUs || clip.durationUs || Math.round((clip.outUs - clip.inUs) / clip.rate); }
export function timelineEntries(project: EditProject) {
  let start = 0;
  return project.clips.map((clip, index) => { const startUs = start; start += clipDurationUs(clip); return { clip, index, startUs, endUs: start }; });
}
export function projectDurationUs(project: EditProject) { return project.clips.reduce((sum, clip) => sum + clipDurationUs(clip), 0); }
export function clipStartUs(project: EditProject, clipId: string) { return timelineEntries(project).find(e => e.clip.id === clipId)?.startUs ?? fail(`Unknown clip: ${clipId}`); }
/** Source position is kept fractional here; only the decoder/frame lookup rounds it. */
export function sourceTimeAt(clip: ProjectClip, localUs: number): number {
  number(localUs, "local time", 0, clipDurationUs(clip));
  if (clip.holdUs) return clip.inUs;
  const fraction = localUs / clipDurationUs(clip);
  return clip.reverse ? clip.outUs - fraction * (clip.outUs - clip.inUs) : clip.inUs + fraction * (clip.outUs - clip.inUs);
}
export function updateProject(project: EditProject, patch: Partial<Pick<EditProject, "name" | "canvas" | "output" | "editing">>) { return changed(project, { ...project, ...patch }); }
export function addAsset(project: EditProject, asset: ProjectAsset) { return changed(project, { ...project, assets: [...project.assets, { ...asset }] }); }
export function relinkAsset(project: EditProject, assetId: string, patch: Partial<Omit<ProjectAsset, "id">>) {
  if (!project.assets.some(a => a.id === assetId)) fail(`Unknown asset: ${assetId}`);
  return changed(project, { ...project, assets: project.assets.map(a => a.id === assetId ? { ...a, ...patch, id: assetId } : a) });
}
export function addClip(project: EditProject, assetId: string, options: Partial<ProjectClip> = {}, atIndex = project.clips.length) {
  integer(atIndex, "clip index", 0, project.clips.length);
  const asset = project.assets.find(a => a.id === assetId) ?? fail(`Unknown asset: ${assetId}`);
  const clip: ProjectClip = { id: newProjectId("clip"), assetId, inUs: 0, outUs: asset.durationUs || 3_000_000, rate: 1, reverse: false,
    holdUs: asset.kind === "image" ? 3_000_000 : 0, fit: "contain", crop: { ...DEFAULT_CROP }, ...options, };
  const clips = [...project.clips]; clips.splice(atIndex, 0, clip); return changed(project, { ...project, clips });
}
/** Duration changes add/remove time at the clip tail. Layers are not tied to source edits. */
export function updateClip(project: EditProject, clipId: string, patch: Partial<ProjectClip>, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  const old = getClip(project, clipId); if (patch.id !== undefined && patch.id !== clipId) fail("Clip identity cannot be changed");
  const next = { ...old, ...patch, id: clipId };
  if ((patch.rate !== undefined && patch.rate !== old.rate) || (patch.inUs !== undefined && patch.inUs !== old.inUs) || (patch.outUs !== undefined && patch.outUs !== old.outUs)) {
    if (patch.durationUs === undefined) delete next.durationUs;
  }
  const before = clipDurationUs(old), start = clipStartUs(project, clipId), fps = project.canvas.fps;
  // A source trim stores integer µs, so a pure rate edit can magnify its <=1µs
  // rounding. Normalize only this bounded error on an already aligned clip.
  if (patch.rate !== undefined && patch.rate !== old.rate && patch.durationUs === undefined && next.inUs === old.inUs && next.outUs === old.outUs && old.holdUs === 0 && next.holdUs === 0) {
    number(next.rate,"clip.rate",.05,16);
    if (alignedFrameIndex(start,fps)!==null && alignedFrameIndex(start+before,fps)!==null) {
      const rawEnd=start+clipDurationUs(next),nearest=frameBoundaryUs(Math.round(rawEnd*fps/US_PER_SECOND),fps);
      if(nearest>start && Math.abs(nearest-rawEnd)<=Math.ceil(1/next.rate)) next.durationUs=nearest-start;
    }
  }
  const edited = { ...project, clips: project.clips.map(c => c.id === clipId ? next : c) };
  // Validate the changed clip before deriving maps, but validate the complete
  // duration only after retiming: rounded untouched spans can differ by 1µs.
  assertProject({ ...edited, clips: [next] });
  const after = clipDurationUs(next);
  if (before !== after) {
    const oldEnd = start + before, newEnd = start + after;
    const oldFrame = alignedFrameIndex(oldEnd,fps), newFrame = alignedFrameIndex(newEnd,fps);
    if (oldFrame !== null && newFrame !== null) {
      const frames = newFrame-oldFrame, map = (time: number) => shiftByFrames(time,frames,fps);
      edited.clips = timelineEntries(project).map(entry => entry.clip.id === clipId ? next : entry.startUs >= oldEnd
        ? retimeClip(entry.clip,map(entry.endUs)-map(entry.startUs)) : entry.clip);
      if (policy === "ripple") edited.layers = spliceLayers(project.layers, {
        atUs: Math.min(oldEnd,newEnd), removedUs: Math.max(0,oldEnd-newEnd), insertedUs: Math.max(0,newEnd-oldEnd),
        afterMap: map, frameGridFps: nonlinearFrameGrid(frames,fps),
        insertion: newEnd>oldEnd ? {kind:"hold",sampleUs:oldEnd-1} : undefined,
      });
    } else if (policy === "ripple") edited.layers = after > before
      ? rippleLayers(project.layers, oldEnd, 0, after-before)
      : rippleLayers(project.layers, newEnd, before-after, 0);
  }
  return changed(project, edited);
}
export function trimClip(project: EditProject, clipId: string, inUs: number, outUs: number, policy: LayerTimingPolicy = "absolute") { return updateClip(project, clipId, { inUs, outUs }, policy); }
export function setClipRate(project: EditProject, clipId: string, rate: number, policy: LayerTimingPolicy = "absolute") { return updateClip(project, clipId, { rate }, policy); }
export function toggleClipReverse(project: EditProject, clipId: string) { return updateClip(project, clipId, { reverse: !getClip(project, clipId).reverse }); }
export function freezeClip(project: EditProject, clipId: string, sourceUs: number, holdUs: number, policy: LayerTimingPolicy = "absolute") {
  integer(holdUs, "freeze duration", 1); integer(sourceUs, "freeze source time");
  return updateClip(project, clipId, { inUs: sourceUs, outUs: sourceUs, holdUs }, policy);
}
export function splitClip(project: EditProject, clipId: string, playheadUs: number): EditProject {
  integer(playheadUs, "playhead");
  const clip = getClip(project, clipId); const start = clipStartUs(project, clipId); const duration = clipDurationUs(clip); const local = playheadUs - start;
  if (local === 0 || local === duration) return project;
  if (local < 0 || local > duration) fail("Split time is outside the clip");
  const left = { ...clip, crop: { ...clip.crop } }; const right = { ...clip, id: newProjectId("clip"), crop: { ...clip.crop } };
  if (clip.holdUs) { left.holdUs = local; right.holdUs = duration - local; }
  else {
    const boundary = Math.round(sourceTimeAt(clip, local));
    if (boundary <= clip.inUs || boundary >= clip.outUs) {
      // Sub-source-tick slices sample the same source position; retain their exact timeline span.
      const source = Math.min(clip.outUs - 1, Math.max(clip.inUs, boundary));
      if (local <= duration / 2) { left.inUs = source; left.outUs = source; left.holdUs = local; right.durationUs = duration - local; }
      else { right.inUs = source; right.outUs = source; right.holdUs = duration - local; left.durationUs = local; }
    } else {
      if (clip.reverse) { left.inUs = boundary; right.outUs = boundary; }
      else { left.outUs = boundary; right.inUs = boundary; }
      left.durationUs = local; right.durationUs = duration - local;
    }
  }
  const clips = [...project.clips]; clips.splice(clips.indexOf(clip), 1, left, right); return changed(project, { ...project, clips });
}
export function splitAtPlayhead(project: EditProject, playheadUs: number) {
  integer(playheadUs, "playhead", 0, projectDurationUs(project));
  const entry = timelineEntries(project).find(e => playheadUs > e.startUs && playheadUs < e.endUs);
  return entry ? splitClip(project, entry.clip.id, playheadUs) : project;
}
export function moveClip(project: EditProject, clipId: string, toIndex: number) {
  integer(toIndex, "clip index", 0, project.clips.length - 1); const clip = getClip(project, clipId);
  const clips = project.clips.filter(c => c.id !== clipId); clips.splice(toIndex, 0, clip); return changed(project, { ...project, clips });
}
export function duplicateClip(project: EditProject, clipId: string, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  const clip = getClip(project, clipId);
  const fromUs = clipStartUs(project, clipId), duration = clipDurationUs(clip), endUs = fromUs + duration;
  const fps=project.canvas.fps, firstFrame=alignedFrameIndex(fromUs,fps), lastFrame=alignedFrameIndex(endUs,fps);
  const frames=firstFrame!==null && lastFrame!==null ? lastFrame-firstFrame : null;
  const map=frames===null ? (time:number)=>time+duration : (time:number)=>shiftByFrames(time,frames,fps);
  const copy={...retimeClip(clip,map(endUs)-map(fromUs)),id:newProjectId("clip"),crop:{...clip.crop}};
  const clips=timelineEntries(project).flatMap(entry=>{
    if(entry.clip.id===clipId) return [entry.clip,copy];
    return [entry.startUs>=endUs ? retimeClip(entry.clip,map(entry.endUs)-map(entry.startUs)) : entry.clip];
  });
  const layers = policy === "ripple" ? spliceLayers(project.layers, {
    atUs: endUs, removedUs: 0, insertedUs: map(endUs)-endUs, afterMap: map,
    frameGridFps: frames===null ? undefined : nonlinearFrameGrid(frames,fps),
    insertion: { kind: "copy", fromUs, toUs: endUs, map },
  }) : project.layers;
  return changed(project, { ...project, clips, layers });
}
export function removeClip(project: EditProject, clipId: string, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  const clip = getClip(project, clipId), start = clipStartUs(project, clipId), end=start+clipDurationUs(clip), fps=project.canvas.fps;
  const firstFrame=alignedFrameIndex(start,fps),lastFrame=alignedFrameIndex(end,fps);
  const frames=firstFrame!==null && lastFrame!==null ? firstFrame-lastFrame : null;
  const map=frames===null ? (time:number)=>time-(end-start) : (time:number)=>shiftByFrames(time,frames,fps);
  const clips=timelineEntries(project).filter(entry=>entry.clip.id!==clipId).map(entry=>entry.startUs>=end
    ? retimeClip(entry.clip,map(entry.endUs)-map(entry.startUs)) : entry.clip);
  const layers=policy==="ripple" ? spliceLayers(project.layers,{
    atUs:start,removedUs:end-start,insertedUs:0,afterMap:map,frameGridFps:frames===null ? undefined : nonlinearFrameGrid(frames,fps),
  }) : project.layers;
  return changed(project,{...project,clips,layers});
}
/** Absolute boundaries, never repeated addition of a rounded frame period. */
export function frameBoundaryUs(frameIndex: number, fps: number) {
  integer(frameIndex, "frame index"); number(fps, "fps", 1, 100);
  const time = Math.round(frameIndex * US_PER_SECOND / fps); integer(time, "frame boundary"); return time;
}
export function frameIndexAt(timeUs: number, fps: number) {
  integer(timeUs, "frame time"); number(fps, "fps", 1, 100);
  let frame = Math.floor(timeUs * fps / US_PER_SECOND);
  while (frameBoundaryUs(frame + 1, fps) <= timeUs) frame++;
  while (frame > 0 && frameBoundaryUs(frame, fps) > timeUs) frame--;
  return frame;
}
function alignedFrameIndex(timeUs:number,fps:number):number|null {
  const frame=frameIndexAt(timeUs,fps); return frameBoundaryUs(frame,fps)===timeUs ? frame : null;
}
/** Whole-microsecond frame shifts are already linear and need no new map knots. */
function nonlinearFrameGrid(frames:number,fps:number):number|undefined {
  return Number.isInteger(frames*US_PER_SECOND/fps) ? undefined : fps;
}
export function stepFrame(project: EditProject, playheadUs: number, delta: number) {
  integer(delta, "frame step", -Number.MAX_SAFE_INTEGER); integer(playheadUs, "playhead");
  const duration = projectDurationUs(project); if (!duration) return 0;
  const current = frameIndexAt(Math.min(playheadUs, duration - 1), project.canvas.fps);
  const last = frameIndexAt(duration - 1, project.canvas.fps);
  return frameBoundaryUs(Math.max(0, Math.min(last, current + delta)), project.canvas.fps);
}
export interface IsolatedFrame { project: EditProject; clipIds: string[]; startUs: number; endUs: number }
export function isolateFrame(project: EditProject, playheadUs: number): IsolatedFrame {
  integer(playheadUs, "playhead", 0, projectDurationUs(project)); const duration = projectDurationUs(project);
  if (!duration) return { project, clipIds: [], startUs: 0, endUs: 0 };
  const index = frameIndexAt(Math.min(playheadUs, duration - 1), project.canvas.fps);
  const startUs = frameBoundaryUs(index, project.canvas.fps); const endUs = Math.min(duration, frameBoundaryUs(index + 1, project.canvas.fps));
  const isolated = splitAtPlayhead(splitAtPlayhead(project, endUs), startUs);
  const clipIds = timelineEntries(isolated).filter(e => e.startUs >= startUs && e.endUs <= endUs).map(e => e.clip.id);
  return { project: changed(project, isolated), clipIds, startUs, endUs };
}
/** Move a timestamp by whole output frames, preserving its position within a
 * frame interval. Exact boundaries remain exact after arbitrarily many edits. */
function shiftByFrames(timeUs: number, frames: number, fps: number): number {
  const frame = frameIndexAt(timeUs, fps);
  const oldStart = frameBoundaryUs(frame, fps), oldEnd = frameBoundaryUs(frame + 1, fps);
  const newStart = frameBoundaryUs(frame + frames, fps), newEnd = frameBoundaryUs(frame + frames + 1, fps);
  return Math.round(newStart + (timeUs - oldStart) * (newEnd - newStart) / (oldEnd - oldStart));
}
function retimeClip(clip: ProjectClip, durationUs: number): ProjectClip {
  if (durationUs === clipDurationUs(clip)) return clip;
  return clip.holdUs ? { ...clip, holdUs: durationUs } : { ...clip, durationUs };
}
/** Unwrapped source clock. Decoders/preview apply the asset's loop duration. */
function interpolateSourceSegment(a: { timeUs: number; sourceUs: number }, b: { timeUs: number; sourceUs: number }, timeUs: number): number {
  const sourceSpan = b.sourceUs - a.sourceUs, timeSpan = b.timeUs - a.timeUs, elapsed = timeUs - a.timeUs;
  if (sourceSpan === timeSpan) return a.sourceUs + elapsed;
  if (Number.isSafeInteger(sourceSpan) && Number.isSafeInteger(elapsed)) {
    const numerator = BigInt(sourceSpan) * BigInt(elapsed), denominator = BigInt(timeSpan);
    return a.sourceUs + Number(numerator / denominator) + Number(numerator % denominator) / timeSpan;
  }
  return a.sourceUs + sourceSpan * (elapsed / timeSpan);
}
export function mediaSourceTimeAt(layer: ProjectMediaLayer, relativeTimeUs: number): number {
  number(relativeTimeUs, "media layer time", 0, layer.endUs - layer.startUs);
  const points = layer.sourceTimeMap;
  if (!layer.sourceFrozen && points?.length) {
    let low = 0, high = points.length - 1;
    while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (points[middle].timeUs > relativeTimeUs) high = middle; else low = middle; }
    const a = points[low], b = points[high];
    if (relativeTimeUs === a.timeUs) return a.sourceUs;
    if (relativeTimeUs === b.timeUs) return b.sourceUs;
    return interpolateSourceSegment(a, b, relativeTimeUs);
  }
  return (layer.sourceOffsetUs ?? 0) + (layer.sourceFrozen ? 0 : relativeTimeUs);
}
interface LayerSplice {
  atUs: number;
  removedUs: number;
  insertedUs: number;
  afterMap: (timeUs: number) => number;
  /** Preserve original source samples at the nonuniform rounded output grid. */
  frameGridFps?: number;
  insertion?: { kind: "hold"; sampleUs: number } | { kind: "copy"; fromUs: number; toUs: number; map: (timeUs: number) => number };
}
/** Crop a layer's original clock before moving it. Boundary values preserve
 * linear interpolation; a new segment carries the media clock at its start. */
function sliceLayer(layer: ProjectLayer, fromUs: number, toUs: number, map: (timeUs: number) => number, id: string, frameGridFps?: number): ProjectLayer | null {
  if (toUs <= fromUs) return null;
  const startUs = map(fromUs), endUs = map(toUs); if (endUs <= startUs) return null;
  const whole = fromUs === layer.startUs && toUs === layer.endUs;
  if (whole && id === layer.id && startUs === fromUs && endUs === toUs) return layer;
  const points = whole ? layer.keyframes.map(key => ({ absoluteUs: layer.startUs + key.timeUs, transform: key.transform }))
    : layer.keyframes.length ? [
      { absoluteUs: fromUs, transform: transformFromKeys(layer.keyframes,layer.transform,fromUs-layer.startUs) },
      ...layer.keyframes.filter(key => layer.startUs + key.timeUs > fromUs && layer.startUs + key.timeUs < toUs).map(key => ({ absoluteUs: layer.startUs + key.timeUs, transform: key.transform })),
      { absoluteUs: toUs, transform: transformFromKeys(layer.keyframes,layer.transform,toUs-layer.startUs) },
    ] : [];
  const keys = new Map<number, LayerTransform>();
  for (const point of points) keys.set(Math.max(0, Math.min(endUs - startUs, map(point.absoluteUs) - startUs)), { ...point.transform });
  const result: ProjectLayer = { ...layer, id, startUs, endUs,
    transform: whole ? layer.transform : transformAt(layer, fromUs - layer.startUs),
    keyframes: [...keys].sort((a, b) => a[0] - b[0]).map(([timeUs, value]) => ({ timeUs, transform: value })),
  };
  if (layer.transformSamples || (frameGridFps && US_PER_SECOND%frameGridFps!==0 && layer.keyframes.length)) result.transformSamples=slicedTransformSamples(layer,fromUs,toUs,map,frameGridFps);
  if (result.kind === "media" && layer.kind === "media") {
    result.rasterScaleMax = mediaRasterScale(layer);
    if (fromUs !== layer.startUs) result.sourceOffsetUs = mediaSourceTimeAt(layer, fromUs - layer.startUs);
    if (!layer.sourceFrozen && (layer.sourceTimeMap || frameGridFps)) result.sourceTimeMap = slicedSourceTimeMap(layer, fromUs, toUs, map, frameGridFps);
  }
  return result;
}
function mediaRasterScale(layer: ProjectMediaLayer): number {
  let maximum=Math.max(layer.rasterScaleMax ?? .01,layer.transform.scale);
  for (const key of layer.keyframes) maximum=Math.max(maximum,key.transform.scale);
  for (const sample of layer.transformSamples ?? []) maximum=Math.max(maximum,sample.transform.scale);
  return maximum;
}
function slicedTransformSamples(layer:ProjectLayer,fromUs:number,toUs:number,map:(time:number)=>number,fps?:number):LayerKeyframe[] {
  const times=new Set<number>([fromUs,toUs]);
  for(const point of [...(layer.transformSamples ?? []),...layer.keyframes]) {
    const time=layer.startUs+point.timeUs; if(time>fromUs && time<toUs) times.add(time);
  }
  if(fps) for(let frame=frameIndexAt(fromUs,fps)+1;;frame++) {
    const time=frameBoundaryUs(frame,fps); if(time>=toUs) break; times.add(time);
  }
  const startUs=map(fromUs),samples:LayerKeyframe[]=[];
  for(const time of [...times].sort((a,b)=>a-b)) {
    const next={timeUs:map(time)-startUs,transform:transformAt(layer,time-layer.startUs)},previous=samples[samples.length-1];
    if(previous?.timeUs===next.timeUs) {
      if((Object.keys(next.transform) as (keyof LayerTransform)[]).some(key=>previous.transform[key]!==next.transform[key])) fail("Transform samples collide after frame rounding; edit cannot be represented exactly");
      continue;
    }
    samples.push(next);
  }
  return samples;
}
function slicedSourceTimeMap(layer: ProjectMediaLayer, fromUs: number, toUs: number, map: (timeUs: number) => number, fps?: number) {
  const sourceTimes = new Set<number>([fromUs, toUs]);
  for (const point of layer.sourceTimeMap ?? []) { const time = layer.startUs + point.timeUs; if (time > fromUs && time < toUs) sourceTimes.add(time); }
  if (fps) {
    for (let frame = frameIndexAt(fromUs, fps) + 1; ; frame++) {
      const time = frameBoundaryUs(frame, fps); if (time >= toUs) break; sourceTimes.add(time);
    }
  }
  const startUs = map(fromUs), points: { timeUs: number; sourceUs: number }[] = [];
  for (const originalUs of [...sourceTimes].sort((a,b) => a-b)) {
    const next = { timeUs: map(originalUs) - startUs, sourceUs: mediaSourceTimeAt(layer, originalUs - layer.startUs) };
    const previous = points[points.length - 1];
    if (previous?.timeUs === next.timeUs) {
      if (previous.sourceUs !== next.sourceUs) fail("Source clock points collide after frame rounding; edit cannot be represented exactly");
      continue;
    }
    points.push(next);
    // Drop only provably collinear integer differences. No epsilon or lossy
    // simplification: fractional breakpoints survive subsequent compositions.
    while (points.length >= 3) {
      const a = points[points.length - 3], b = points[points.length - 2], c = points[points.length - 1];
      const ab = b.sourceUs-a.sourceUs, ac = c.sourceUs-a.sourceUs;
      if (!Number.isSafeInteger(ab) || !Number.isSafeInteger(ac) || BigInt(ab)*BigInt(c.timeUs-a.timeUs) !== BigInt(ac)*BigInt(b.timeUs-a.timeUs)) break;
      points.splice(points.length - 2, 1);
    }
  }
  return points;
}
/** A cut creates separate pieces rather than merging different keyframes at a
 * collapsed timestamp. Locked layers are never shifted, cropped or duplicated. */
function spliceLayers(layers: ProjectLayer[], splice: LayerSplice): ProjectLayer[] {
  const { atUs, removedUs, insertedUs, afterMap, insertion, frameGridFps } = splice;
  if (!removedUs && !insertedUs) return layers;
  const endUs = atUs + removedUs;
  return layers.flatMap(layer => {
    if (layer.locked) return [layer];
    const pieces: ProjectLayer[] = [];
    const before = sliceLayer(layer, layer.startUs, Math.min(layer.endUs, atUs), time => time, layer.id,frameGridFps);
    if (before) pieces.push(before);
    // Reserve the old identity for a surviving original piece. Only a fully
    // replaced layer lends its identity to the held snapshot.
    const afterFrom = Math.max(layer.startUs, endUs);
    const hasAfter = layer.endUs > afterFrom;
    if (insertedUs && insertion?.kind === "hold" && layer.startUs <= insertion.sampleUs && layer.endUs > insertion.sampleUs) {
      const held: ProjectLayer = { ...layer, id: !before && !hasAfter ? layer.id : newProjectId("layer"), startUs: atUs, endUs: atUs + insertedUs,
        transform: transformAt(layer, insertion.sampleUs - layer.startUs), keyframes: [], };
      delete held.transformSamples;
      if (held.kind === "media" && layer.kind === "media") {
        held.sourceOffsetUs = mediaSourceTimeAt(layer, insertion.sampleUs - layer.startUs); held.sourceFrozen = true; held.rasterScaleMax = mediaRasterScale(layer); delete held.sourceTimeMap;
      }
      pieces.push(held);
    } else if (insertedUs && insertion?.kind === "copy") {
      const copy = sliceLayer(layer, Math.max(layer.startUs, insertion.fromUs), Math.min(layer.endUs, insertion.toUs), insertion.map, newProjectId("layer"), frameGridFps);
      if (copy) pieces.push(copy);
    }
    const after = sliceLayer(layer, afterFrom, layer.endUs, afterMap, before ? newProjectId("layer") : layer.id, frameGridFps);
    if (after) pieces.push(after);
    return pieces;
  });
}
export function deleteFrame(project: EditProject, playheadUs: number, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  const isolated = isolateFrame(project, playheadUs);
  if (!isolated.clipIds.length) return project;
  const wholeFrame = isolated.endUs === frameBoundaryUs(frameIndexAt(isolated.startUs, project.canvas.fps) + 1, project.canvas.fps);
  const map = (timeUs: number) => timeUs < isolated.startUs ? timeUs : timeUs < isolated.endUs ? isolated.startUs : wholeFrame ? shiftByFrames(timeUs, -1, project.canvas.fps) : timeUs - (isolated.endUs - isolated.startUs);
  const clips = timelineEntries(isolated.project).flatMap(e => {
    if (isolated.clipIds.includes(e.clip.id)) return [];
    const durationUs = map(e.endUs) - map(e.startUs); return durationUs > 0 ? [retimeClip(e.clip, durationUs)] : [];
  });
  return changed(project, { ...isolated.project, clips, layers: policy === "ripple" ? spliceLayers(project.layers, {
    atUs: isolated.startUs, removedUs: isolated.endUs - isolated.startUs, insertedUs: 0, afterMap: map, frameGridFps: wholeFrame ? project.canvas.fps : undefined,
  }) : project.layers });
}
export function duplicateFrame(project: EditProject, playheadUs: number, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  const isolated = isolateFrame(project, playheadUs); if (!isolated.clipIds.length) return project;
  const fps = project.canvas.fps;
  const wholeFrame = isolated.endUs === frameBoundaryUs(frameIndexAt(isolated.startUs, fps) + 1, fps);
  const map = (timeUs: number) => timeUs < isolated.endUs ? timeUs : shiftByFrames(timeUs, 1, fps);
  const entries = timelineEntries(isolated.project);
  const copiedEntries = entries.filter(e => isolated.clipIds.includes(e.clip.id));
  // Even a 1µs final partial frame duplicates to one additional output sample.
  // Holding its sampled source prevents stretching a sub-frame motion fragment.
  const partialClip = copiedEntries[0].clip;
  const partialSource = partialClip.holdUs ? partialClip.inUs : Math.max(partialClip.inUs, Math.min(partialClip.outUs - 1, Math.round(sourceTimeAt(partialClip, 0))));
  const copies = wholeFrame ? copiedEntries.map(e => {
    const durationUs = shiftByFrames(e.endUs, 1, fps) - shiftByFrames(e.startUs, 1, fps);
    return { ...retimeClip(e.clip, durationUs), id: newProjectId("clip"), crop: { ...e.clip.crop } };
  }).filter(c => clipDurationUs(c) > 0) : [{ ...partialClip, id: newProjectId("clip"), inUs: partialSource, outUs: partialSource, holdUs: map(isolated.endUs) - isolated.endUs, durationUs: undefined }];
  const clips = entries.flatMap(e => {
    const durationUs = e.startUs >= isolated.endUs ? map(e.endUs) - map(e.startUs) : e.endUs - e.startUs;
    const part = durationUs > 0 ? [retimeClip(e.clip, durationUs)] : [];
    return e.clip.id === isolated.clipIds[isolated.clipIds.length - 1] ? [...part, ...copies] : part;
  });
  return changed(project, { ...isolated.project, clips, layers: policy === "ripple" ? spliceLayers(project.layers, {
    atUs: isolated.endUs, removedUs: 0, insertedUs: map(isolated.endUs) - isolated.endUs, afterMap: map, frameGridFps: fps,
    insertion: { kind: "copy", fromUs: isolated.startUs, toUs: isolated.endUs, map: time => shiftByFrames(time, 1, fps) },
  }) : project.layers });
}
export function freezeFrame(project: EditProject, playheadUs: number, holdUs: number, policy: LayerTimingPolicy = "absolute") {
  checkLayerPolicy(policy);
  integer(holdUs, "freeze duration", 1); const isolated = isolateFrame(project, playheadUs); if (!isolated.clipIds.length) return project;
  const original = isolated.project.clips.find(c => c.id === isolated.clipIds[0])!;
  const sourceUs = original.holdUs ? original.inUs : Math.max(original.inUs, Math.min(original.outUs - 1, Math.round(sourceTimeAt(original, 0))));
  const fps = project.canvas.fps, holdFrames = Math.max(1, Math.round(holdUs * fps / US_PER_SECOND));
  const frozenEnd = frameBoundaryUs(frameIndexAt(isolated.startUs, fps) + holdFrames, fps);
  const frozen = { ...original, inUs: sourceUs, outUs: sourceUs, holdUs: frozenEnd - isolated.startUs, durationUs: undefined };
  const wholeFrame = isolated.endUs === frameBoundaryUs(frameIndexAt(isolated.startUs, fps) + 1, fps);
  const map = (timeUs: number) => timeUs < isolated.startUs ? timeUs : timeUs < isolated.endUs ? isolated.startUs : wholeFrame ? shiftByFrames(timeUs, holdFrames - 1, fps) : timeUs + frozenEnd - isolated.endUs;
  const clips = timelineEntries(isolated.project).flatMap(e => {
    if (e.clip.id === original.id) return [frozen]; if (isolated.clipIds.includes(e.clip.id)) return [];
    const durationUs = e.startUs >= isolated.endUs ? map(e.endUs) - map(e.startUs) : e.endUs - e.startUs;
    return durationUs > 0 ? [retimeClip(e.clip, durationUs)] : [];
  });
  return changed(project, { ...isolated.project, clips, layers: policy === "ripple" ? spliceLayers(project.layers, {
    atUs: isolated.startUs, removedUs: isolated.endUs - isolated.startUs, insertedUs: frozenEnd - isolated.startUs, afterMap: map, frameGridFps: wholeFrame ? fps : undefined,
    insertion: { kind: "hold", sampleUs: isolated.startUs },
  }) : project.layers });
}
export function transformAt(layer: ProjectLayer, relativeTimeUs: number): LayerTransform {
  number(relativeTimeUs, "keyframe time", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return transformFromKeys(layer.transformSamples ?? layer.keyframes,layer.transform,relativeTimeUs);
}
function transformFromKeys(keys:LayerKeyframe[],fallback:LayerTransform,relativeTimeUs:number):LayerTransform {
  if (!keys.length) return { ...fallback };
  if (relativeTimeUs <= keys[0].timeUs) return { ...keys[0].transform };
  if(relativeTimeUs>=keys[keys.length-1].timeUs) return {...keys[keys.length-1].transform};
  let low=0,high=keys.length-1;
  while(high-low>1) { const middle=Math.floor((low+high)/2); if(keys[middle].timeUs>relativeTimeUs) high=middle; else low=middle; }
  const a=keys[low],b=keys[high]; if(relativeTimeUs===a.timeUs) return {...a.transform}; if(relativeTimeUs===b.timeUs) return {...b.transform};
  const fraction=(relativeTimeUs-a.timeUs)/(b.timeUs-a.timeUs),result={...a.transform};
  for(const key of Object.keys(result) as (keyof LayerTransform)[]) result[key]=a.transform[key]===b.transform[key] ? a.transform[key] : a.transform[key]*(1-fraction)+b.transform[key]*fraction;
  return result;
}
/** Remove a range, or insert a held snapshot immediately before a cut. Animation
 * on retained pieces keeps its clock; no layer is stretched over inserted time. */
export function rippleLayers(layers: ProjectLayer[], atUs: number, removedUs: number, insertedUs: number): ProjectLayer[] {
  integer(atUs, "splice start"); integer(removedUs, "removed duration"); integer(insertedUs, "inserted duration");
  return spliceLayers(layers, { atUs, removedUs, insertedUs, afterMap: time => time + insertedUs - removedUs,
    insertion: insertedUs ? { kind: "hold", sampleUs: removedUs ? atUs : Math.max(0, atUs - 1) } : undefined,
  });
}
function layerBase(project: EditProject, startUs: number, endUs: number) {
  return { id: newProjectId("layer"), name: "图层", startUs, endUs, visible: true, locked: false, transform: { ...DEFAULT_TRANSFORM }, keyframes: [] };
}
export function addTextLayer(project: EditProject, text = "新字幕", startUs = 0, endUs = Math.max(1, projectDurationUs(project))) {
  const layer: ProjectLayer = { ...layerBase(project, startUs, endUs), kind: "text", name: text || "字幕", text, fontSize: 36, color: "#ffffff", strokeColor: "#000000", strokeWidth: 2 };
  return changed(project, { ...project, layers: [...project.layers, layer] });
}
export function addMediaLayer(project: EditProject, assetId: string, startUs = 0, endUs = Math.max(1, projectDurationUs(project))) {
  const asset = project.assets.find(a => a.id === assetId) ?? fail(`Unknown asset: ${assetId}`);
  const layer: ProjectLayer = { ...layerBase(project, startUs, endUs), kind: "media", name: asset.name, assetId, width: .3 };
  return changed(project, { ...project, layers: [...project.layers, layer] });
}
export function updateLayer(project: EditProject, layerId: string, patch: Partial<ProjectLayer>) {
  const layer = getLayer(project, layerId); if (patch.id !== undefined && patch.id !== layerId) fail("Layer identity cannot be changed");
  if (patch.kind !== undefined && patch.kind !== layer.kind) fail("Layer kind cannot be changed");
  const next = { ...layer, ...patch, id: layerId } as ProjectLayer;
  const authoredTransformEdit=Object.prototype.hasOwnProperty.call(patch,"transform") || Object.prototype.hasOwnProperty.call(patch,"keyframes");
  if(authoredTransformEdit) delete next.transformSamples;
  if (patch.endUs !== undefined || patch.startUs !== undefined) {
    const duration = next.endUs - next.startUs;
    next.keyframes = next.keyframes.filter(k => k.timeUs <= duration);
    if(duration>0 && !authoredTransformEdit && layer.transformSamples && !Object.prototype.hasOwnProperty.call(patch,"transformSamples") && duration!==layer.endUs-layer.startUs) {
      next.transformSamples=duration<layer.endUs-layer.startUs
        ? [...layer.transformSamples.filter(sample=>sample.timeUs<duration),{timeUs:duration,transform:transformAt(layer,duration)}]
        : [...layer.transformSamples,{timeUs:duration,transform:transformAt(layer,layer.endUs-layer.startUs)}];
    }
    if (duration > 0 && next.kind === "media" && layer.kind === "media" && layer.sourceTimeMap && !Object.prototype.hasOwnProperty.call(patch,"sourceTimeMap") && duration !== layer.endUs - layer.startUs) {
      const previous = layer.sourceTimeMap;
      if (duration < layer.endUs - layer.startUs) next.sourceTimeMap = [
        ...previous.filter(point=>point.timeUs<duration), {timeUs:duration,sourceUs:mediaSourceTimeAt(layer,duration)},
      ];
      else {
        const last=previous[previous.length-1], penultimate=previous[previous.length-2];
        next.sourceTimeMap=[...previous,{timeUs:duration,sourceUs:interpolateSourceSegment(penultimate,last,duration)}];
      }
    }
  }
  return changed(project, { ...project, layers: project.layers.map(l => l.id === layerId ? next : l) });
}
export function removeLayer(project: EditProject, layerId: string) { getLayer(project, layerId); return changed(project, { ...project, layers: project.layers.filter(l => l.id !== layerId) }); }
export function moveLayer(project: EditProject, layerId: string, toIndex: number) {
  integer(toIndex, "layer index", 0, project.layers.length - 1); const layer = getLayer(project, layerId); const layers = project.layers.filter(l => l.id !== layerId); layers.splice(toIndex, 0, layer);
  return changed(project, { ...project, layers });
}
export function upsertKeyframe(project: EditProject, layerId: string, timeUs: number, value: LayerTransform) {
  const layer = getLayer(project, layerId); integer(timeUs, "keyframe time", 0, layer.endUs - layer.startUs); transform(value);
  const keyframes = [...layer.keyframes.filter(k => k.timeUs !== timeUs), { timeUs, transform: { ...value } }].sort((a, b) => a.timeUs - b.timeUs);
  return updateLayer(project, layerId, { keyframes });
}
export function removeKeyframe(project: EditProject, layerId: string, timeUs: number) {
  integer(timeUs, "keyframe time"); const layer = getLayer(project, layerId); return updateLayer(project, layerId, { keyframes: layer.keyframes.filter(k => k.timeUs !== timeUs) });
}
export interface ProjectHistory { past: EditProject[]; present: EditProject; future: EditProject[]; limit: number }
export function createHistory(project: EditProject, limit = 100): ProjectHistory { assertProject(project); integer(limit, "history limit", 1, 1000); return { past: [], present: project, future: [], limit }; }
export function commitHistory(history: ProjectHistory, project: EditProject, _label?: string): ProjectHistory {
  assertProject(project); const next = changed(history.present, project); if (next === history.present) return history;
  return { ...history, past: [...history.past, history.present].slice(-history.limit), present: next, future: [] };
}
export function undoHistory(history: ProjectHistory): ProjectHistory {
  if (!history.past.length) return history;
  return { ...history, past: history.past.slice(0, -1), present: { ...history.past[history.past.length - 1], revision: history.present.revision + 1 }, future: [history.present, ...history.future].slice(0, history.limit) };
}
export function redoHistory(history: ProjectHistory): ProjectHistory {
  if (!history.future.length) return history;
  return { ...history, past: [...history.past, history.present].slice(-history.limit), present: { ...history.future[0], revision: history.present.revision + 1 }, future: history.future.slice(1) };
}
