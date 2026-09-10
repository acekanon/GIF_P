import { describe, expect, it } from "vitest";
import { addAsset, addClip, addMediaLayer, addTextLayer, createProject, DEFAULT_TRANSFORM, projectDurationUs, updateLayer, upsertKeyframe } from "./model";
import { clearProjectAutosave, migrateLegacySession, migrateSessionDraft, parseProject, PROJECT_AUTOSAVE_KEY, readProjectAutosave, serializeProject, writeProjectAutosave } from "./persistence";
import { SESSION_DRAFT_KEY, type SessionDraftData } from "../../v3/sessionPersistence";

function fixture() {
  let p = createProject("永久工程");
  p = addAsset(p, { id: "source", name: "source.gif", path: "D:/source.gif", kind: "gif", width: 480, height: 270, durationUs: 3_000_000 });
  p = addClip(p, "source"); p = addTextLayer(p, "单帧字幕", 66667, 133333);
  return upsertKeyframe(p, p.layers[0].id, 66666, { ...DEFAULT_TRANSFORM, opacity: .5 });
}
function storage() {
  const entries = new Map<string,string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}
function legacy(): SessionDraftData {
  return { mode: "editor", assets: [{ id: "old", path: "D:/old.gif", name: "old.gif", kind: "gif", duration: 4, dimensions: "640 × 480", pathAvailability: { state: "unchecked" } }], activeAssetId: "old", mergePaths: [], outputDir: "D:/export", editor: {
    presetId: "perceptual", encoder: "pngquant_opt", deliveryIntent: "smart", deliveryFormatPreference: "gif", targetPlatform: "modern_web", playbackSpeed: 2, cropEnabled: true,
    crop: { left: 10, top: 0, right: 10, bottom: 0 }, loopOutput: false, width: 480, fps: 20, colors: 128, dither: "sierra2_4a", lossy: 0, optimizeLevel: 3,
    generationMode: "best_gif", targetSizeMb: 2, bayerScale: 2, alphaThreshold: 128, perceptualFocus: "auto", filter: "none", outputFormat: "gif", startSeconds: 1, endSeconds: 3, selectedFrameTimes: [], deletedFrameTimes: [],
    memeOverlay: { templateId: "classic", topText: "上", bottomText: "下", style: "classic", fontSize: 32, textAlign: "center", position: "split", topPosition: { x: 50, y: 12 }, bottomPosition: { x: 50, y: 88 } },
  } };
}

describe("durable v6 engineering projects", () => {
  it("persists new compression choices and keeps omitted legacy routes disabled", () => {
    const project = fixture();
    expect(project.output).toMatchObject({ temporalStability: false, lzwSearch: false });
    project.output.temporalStability = true; project.output.lzwSearch = true;
    expect(parseProject(serializeProject(project)).output).toEqual(project.output);
    const saved = storage(); writeProjectAutosave(saved, project, 1);
    expect(readProjectAutosave(saved)).toMatchObject({ status: "ready", project: { output: { temporalStability: true, lzwSearch: true } } });
    delete project.output.temporalStability; delete project.output.lzwSearch;
    expect(parseProject(serializeProject(project)).output).toEqual({ loop: true, maxBytes: null, smartLossless: false });
  });
  it("rejects nonboolean compression opt-ins instead of coercing old project data", () => {
    const project = fixture();
    for (const key of ["temporalStability", "lzwSearch"]) for (const value of [null, "false", 1, {}, []]) {
      expect(() => parseProject(JSON.stringify({ ...project, output: { ...project.output, [key]: value } }))).toThrow(`output.${key}`);
    }
  });
  it("round-trips tracks, individual-frame layer timing and keyframes", () => {
    const project = fixture(); expect(parseProject(serializeProject(project))).toEqual(project);
  });
  it("persists ripple settings and frozen media source clocks through files and recovery", () => {
    let project = addMediaLayer(fixture(), "source", 120000, 240000);
    project = updateLayer(project, project.layers[project.layers.length - 1].id, { sourceOffsetUs: 160000, sourceFrozen: true });
    expect(project.editing?.layerTiming).toBe("ripple");
    const reopened = parseProject(serializeProject(project));
    expect(reopened).toEqual(project);
    expect(reopened.layers[reopened.layers.length - 1]).toMatchObject({ sourceOffsetUs: 160000, sourceFrozen: true });
    const saved = storage();
    expect(writeProjectAutosave(saved, reopened, 1)).toBe(true);
    expect(readProjectAutosave(saved)).toEqual({ status: "ready", savedAt: 1, project });
  });
  it("keeps old project files without editing or source-clock fields unchanged", () => {
    const project = addMediaLayer(fixture(), "source", 0, 400000);
    delete project.editing;
    const reopened = parseProject(serializeProject(project));
    expect(reopened).toEqual(project);
    expect(reopened.editing).toBeUndefined();
    expect(reopened.layers[reopened.layers.length - 1]).not.toHaveProperty("sourceOffsetUs");
  });
  it("rejects malformed edit policies and invalid media source clocks", () => {
    const project = addMediaLayer(fixture(), "source", 0, 400000);
    for (const layerTiming of ["automatic", null, true]) {
      expect(() => parseProject(JSON.stringify({ ...project, editing: { layerTiming } }))).toThrow();
    }
    for (const patch of [{ sourceOffsetUs: -1 }, { sourceOffsetUs: 86400000001 }, { sourceFrozen: "yes" }, { rasterScaleMax: 0 }, { rasterScaleMax: 9 }]) {
      expect(() => parseProject(JSON.stringify({ ...project, layers: [{ ...project.layers[1], ...patch }] }))).toThrow();
    }
    expect(() => parseProject(JSON.stringify({ ...project, layers: [{ ...project.layers[0], sourceOffsetUs: 0 }] }))).toThrow();
  });
  it("round-trips exact media phase and raster bounds without early source rounding", () => {
    let project = addMediaLayer(fixture(), "source", 0, 66667);
    project = updateLayer(project, project.layers[1].id, {
      sourceOffsetUs: .5, rasterScaleMax: 1.1,
      sourceTimeMap: [{ timeUs: 0, sourceUs: .5 }, { timeUs: 33333, sourceUs: 66667 }, { timeUs: 66667, sourceUs: 100000 }],
    });
    expect(parseProject(serializeProject(project))).toEqual(project);
    for (const sourceTimeMap of [[], [{ timeUs: 1, sourceUs: 0 }, { timeUs: 66667, sourceUs: 100000 }], [{ timeUs: 0, sourceUs: 10 }, { timeUs: 66667, sourceUs: 5 }]]) {
      expect(() => parseProject(JSON.stringify({ ...project, layers: [{ ...project.layers[1], sourceTimeMap }] }))).toThrow();
    }
    expect(() => parseProject(JSON.stringify({ ...project, layers: [{ ...project.layers[1], sourceFrozen: true }] }))).toThrow();
  });
  it("preserves sampled poses in saved and restored frame-edited layers", () => {
    const project = fixture();
    const layer = project.layers[0];
    layer.transformSamples = [{ timeUs: 0, transform: { ...layer.transform, x: .50000045 } }, { timeUs: layer.endUs - layer.startUs, transform: { ...layer.transform, x: .6 } }];
    expect(parseProject(serializeProject(project))).toEqual(project);
    expect(() => parseProject(JSON.stringify({ ...project, layers: [{ ...layer, transformSamples: [{ timeUs: 1, transform: layer.transform }] }] }))).toThrow();
  });
  it("saves a valid dense source map compactly when indentation alone exceeds the file budget", () => {
    const project = addMediaLayer(fixture(), "source", 0, 300000000);
    const base = project.layers[1];
    const points = Array.from({ length: 30001 }, (_, index) => ({ timeUs: index * 10000, sourceUs: index * 10000 }));
    project.layers = Array.from({ length: 4 }, (_, index) => ({ ...base, id: `dense-${index}`, sourceTimeMap: points }));
    expect(new TextEncoder().encode(JSON.stringify(project, null, 2)).length).toBeGreaterThan(8 * 1024 * 1024);
    const raw = serializeProject(project);
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(raw.startsWith('{"')).toBe(true);
    expect(parseProject(raw)).toEqual(project);
  });
  it("rejects malformed json, unsupported versions and unpersistable runtime fields", () => {
    expect(() => parseProject("{" )).toThrow();
    expect(() => parseProject(JSON.stringify({ ...fixture(), schemaVersion: 2 }))).toThrow("Unsupported");
    expect(() => parseProject(JSON.stringify({ ...fixture(), playheadUs: 10 }))).toThrow("playheadUs");
    const p = fixture(); expect(() => parseProject(JSON.stringify({ ...p, assets: [{ ...p.assets[0], sourceUrl: "blob:preview" }] }))).toThrow("sourceUrl");
  });
  it("rejects dangling references, duplicate identities, corrupt timing and nonfinite input", () => {
    const p = fixture();
    expect(() => parseProject(JSON.stringify({ ...p, clips: [{ ...p.clips[0], assetId: "missing" }] }))).toThrow("missing asset");
    expect(() => parseProject(JSON.stringify({ ...p, clips: [p.clips[0], p.clips[0]] }))).toThrow("Duplicate");
    expect(() => parseProject(JSON.stringify({ ...p, clips: [{ ...p.clips[0], inUs: -1 }] }))).toThrow();
    expect(() => serializeProject({ ...p, canvas: { ...p.canvas, fps: Infinity } })).toThrow();
    expect(() => parseProject(JSON.stringify({ ...p, canvas: { ...p.canvas, fps: null } }))).toThrow();
  });
  it("rejects unordered keys, impossible canvas sizes and out of range source trims", () => {
    const p = fixture(), layer = p.layers[0], key = layer.keyframes[0];
    expect(() => parseProject(JSON.stringify({ ...p, layers: [{ ...layer, keyframes: [key,key] }] }))).toThrow("unique times");
    expect(() => parseProject(JSON.stringify({ ...p, canvas: { ...p.canvas, width: 1 } }))).toThrow();
    expect(() => parseProject(JSON.stringify({ ...p, clips: [{ ...p.clips[0], outUs: 3_000_001 }] }))).toThrow("source duration");
  });
  it("autosaves independently of v5 recents and never expires an old engineering project", () => {
    const s = storage(), p = fixture(); s.setItem(SESSION_DRAFT_KEY, "old session");
    expect(readProjectAutosave(s)).toEqual({ status: "empty" }); expect(writeProjectAutosave(s, p, 1)).toBe(true);
    expect(readProjectAutosave(s)).toEqual({ status: "ready", project: p, savedAt: 1 });
    expect(s.getItem(SESSION_DRAFT_KEY)).toBe("old session"); expect(clearProjectAutosave(s)).toBe(true); expect(s.getItem(SESSION_DRAFT_KEY)).toBe("old session");
  });
  it("handles storage denial and corrupt recovery data without overwriting it", () => {
    const s = storage(); s.setItem(PROJECT_AUTOSAVE_KEY, "broken"); expect(readProjectAutosave(s).status).toBe("corrupt"); expect(s.getItem(PROJECT_AUTOSAVE_KEY)).toBe("broken");
    const denied = { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("denied"); }, removeItem: () => { throw Error("denied"); } };
    expect(writeProjectAutosave(denied, fixture())).toBe(false); expect(readProjectAutosave(denied).status).toBe("corrupt"); expect(clearProjectAutosave(denied)).toBe(false);
  });
  it("validates autosave envelopes and timestamps", () => {
    const s = storage(); s.setItem(PROJECT_AUTOSAVE_KEY, JSON.stringify({ format: "gifp-project-autosave", version: 99, project: fixture(), savedAt: 1 }));
    expect(readProjectAutosave(s).status).toBe("corrupt"); expect(writeProjectAutosave(s, fixture(), -1)).toBe(false);
  });
});

describe("v5 single-source migration", () => {
  it("preserves active source trim, speed, crop, output loop and independent captions", () => {
    const result = migrateSessionDraft(legacy()); const p = result.project;
    expect(p.clips[0]).toMatchObject({ inUs: 1_000_000, outUs: 3_000_000, rate: 2, crop: { left: .1, right: .1, top: 0, bottom: 0 } });
    expect(projectDurationUs(p)).toBe(1_000_000); expect(p.layers).toHaveLength(2); expect(p.layers[0].transform.y).toBe(.12); expect(p.output.loop).toBe(false);
    expect(result.warnings).toEqual([]); expect(p.revision).toBe(0);
    expect(p.editing?.layerTiming).toBe("absolute");
  });
  it("explicit import accepts an old session regardless of recency expiration", () => {
    const result = migrateLegacySession(JSON.stringify({ version: 1, savedAt: 1, data: legacy() })); expect(result.project.clips).toHaveLength(1);
  });
  it("reports effects needing review and approximated source-frame migration", () => {
    const draft = legacy(); draft.editor.filter = "vivid"; draft.editor.deletedFrameTimes = [1.5];
    const result = migrateSessionDraft(draft); expect(result.warnings.some(w => w.includes("滤镜"))).toBe(true); expect(result.warnings.some(w => w.includes("帧时间表"))).toBe(true);
    expect(projectDurationUs(result.project)).toBe(950000);
  });
  it("does not silently imitate preserved-delay deletion without the missing frame table", () => {
    const draft = legacy(); draft.editor.deletedFrameTimes = [1.5]; draft.editor.frameTimingMode = "preserve";
    const result = migrateSessionDraft(draft); expect(projectDurationUs(result.project)).toBe(1_000_000); expect(result.warnings.some(w => w.includes("尚未迁移"))).toBe(true);
  });
});
