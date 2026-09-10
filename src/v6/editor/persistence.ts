import type { EditProject } from "./types";
import { addAsset, addClip, addTextLayer, assertProject, createProject, deleteFrame, projectDurationUs, updateLayer, updateProject } from "./model";
import { isSessionDraftData, type SessionDraftData } from "../../v3/sessionPersistence";

/** Engineering projects have their own durable namespace and never inherit v5 session expiry. */
export const PROJECT_AUTOSAVE_KEY = "gifp.project.autosave.v1";
export const PROJECT_FILE_EXTENSION = "gifp-project.json";
export const MAX_PROJECT_JSON_BYTES = 8 * 1024 * 1024;
export type ProjectStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type ProjectAutosaveResult = { status: "empty" } | { status: "ready"; project: EditProject; savedAt: number } | { status: "corrupt"; reason: string };

function parseJson(raw: string): unknown {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > MAX_PROJECT_JSON_BYTES) throw new Error("Project file exceeds 8 MiB");
  return JSON.parse(raw);
}
/** Strict validation also rejects accidental runtime state (URLs, previews, selections). */
export function parseProject(raw: string): EditProject {
  const project = parseJson(raw); assertProject(project); return project;
}
export function serializeProject(project: EditProject): string {
  assertProject(project); let raw = JSON.stringify(project, null, 2);
  if (new TextEncoder().encode(raw).length > MAX_PROJECT_JSON_BYTES) raw = JSON.stringify(project);
  if (new TextEncoder().encode(raw).length > MAX_PROJECT_JSON_BYTES) throw new Error("Project file exceeds 8 MiB");
  return raw;
}
export function writeProjectAutosave(storage: ProjectStorage, project: EditProject, savedAt = Date.now()): boolean {
  try {
    assertProject(project);
    if (!Number.isSafeInteger(savedAt) || savedAt < 0) return false;
    const raw = JSON.stringify({ format: "gifp-project-autosave", version: 1, savedAt, project });
    if (new TextEncoder().encode(raw).length > MAX_PROJECT_JSON_BYTES) return false;
    storage.setItem(PROJECT_AUTOSAVE_KEY, raw); return true;
  } catch { return false; }
}
export function readProjectAutosave(storage: ProjectStorage): ProjectAutosaveResult {
  try {
    const raw = storage.getItem(PROJECT_AUTOSAVE_KEY); if (raw === null) return { status: "empty" };
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid autosave envelope");
    const envelope = parsed as Record<string, unknown>;
    if (Object.keys(envelope).some(key => !["format", "version", "savedAt", "project"].includes(key)) || envelope.format !== "gifp-project-autosave" || envelope.version !== 1) throw new Error("Unsupported autosave format");
    if (typeof envelope.savedAt !== "number" || !Number.isSafeInteger(envelope.savedAt) || envelope.savedAt < 0) throw new Error("Invalid autosave timestamp");
    assertProject(envelope.project);
    return { status: "ready", project: envelope.project, savedAt: envelope.savedAt };
  } catch (error) { return { status: "corrupt", reason: error instanceof Error ? error.message : "Unable to read project autosave" }; }
}
export function clearProjectAutosave(storage: ProjectStorage): boolean {
  try { storage.removeItem(PROJECT_AUTOSAVE_KEY); return true; } catch { return false; }
}

export interface SessionMigration { project: EditProject; warnings: string[] }
/** Converts one active v5 source; unsupported effects are reported rather than silently discarded. */
export function migrateSessionDraft(draft: SessionDraftData): SessionMigration {
  if (!isSessionDraftData(draft)) throw new Error("Invalid legacy session");
  const asset = draft.assets.find(a => a.id === draft.activeAssetId) ?? draft.assets.find(a => a.path === draft.activeAssetPath);
  if (!asset) throw new Error("Legacy session has no active source");
  const warnings: string[] = [];
  const dimensions = asset.dimensions?.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!dimensions) warnings.push("旧会话缺少素材尺寸，暂按 480 × 480 建立画布，请重新探测素材。");
  const width = dimensions ? Number(dimensions[1]) : 480, height = dimensions ? Number(dimensions[2]) : 480;
  const editor = draft.editor;
  const duration = asset.duration ?? Math.max(3, editor.endSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Legacy source duration is invalid");
  let project = createProject(asset.name.replace(/\.[^.]+$/, "") || "迁移的工程");
  // Preserve the legacy absolute caption timing policy on the copied project.
  project = updateProject(project, { editing: { layerTiming: "absolute" } });
  const canvasWidth = Math.max(96, Math.min(1920, Math.round(editor.width)));
  const visibleW = width * (1 - (editor.cropEnabled ? editor.crop.left + editor.crop.right : 0) / 100);
  const visibleH = height * (1 - (editor.cropEnabled ? editor.crop.top + editor.crop.bottom : 0) / 100);
  project = updateProject(project, { canvas: { ...project.canvas, width: canvasWidth, height: Math.max(16, Math.min(1920, Math.round(canvasWidth * visibleH / visibleW))), fps: editor.fps },
    output: { ...project.output, loop: editor.loopOutput, maxBytes: editor.generationMode === "target_size" && editor.targetSizeMb > 0 ? Math.round(editor.targetSizeMb * 1024 * 1024) : null } });
  project = addAsset(project, { id: asset.id, path: asset.path, name: asset.name, kind: asset.kind, width, height, durationUs: Math.round(duration * 1_000_000) });
  const inUs = Math.round(editor.startSeconds * 1_000_000), outUs = Math.round(Math.min(duration, editor.endSeconds > editor.startSeconds ? editor.endSeconds : duration) * 1_000_000);
  project = addClip(project, asset.id, { inUs, outUs, rate: editor.playbackSpeed,
    holdUs: asset.kind === "image" ? outUs - inUs : 0,
    crop: editor.cropEnabled ? { left: editor.crop.left / 100, top: editor.crop.top / 100, right: editor.crop.right / 100, bottom: editor.crop.bottom / 100 } : { left: 0, top: 0, right: 0, bottom: 0 } });
  if (editor.deletedFrameTimes.length) {
    if (editor.frameTimingMode === "preserve") warnings.push("旧会话的保留时长删帧需要源帧时间表，尚未迁移；请在逐帧工具中确认。");
    else {
      const times = [...new Set(editor.deletedFrameTimes)].filter(t => t >= editor.startSeconds && t < outUs / 1_000_000).sort((a, b) => b - a);
      for (const time of times) {
        const position = Math.round((time * 1_000_000 - inUs) / editor.playbackSpeed);
        if (position < projectDurationUs(project)) project = deleteFrame(project, position);
      }
      warnings.push("旧删帧已映射到工程输出帧；旧会话不含完整源帧时间表，请逐帧复核可变帧率素材。");
    }
  }
  const overlay = editor.memeOverlay;
  if (overlay && projectDurationUs(project)) {
    const startUs = Math.max(0, Math.round(((overlay.startSeconds ?? editor.startSeconds) - editor.startSeconds) * 1_000_000 / editor.playbackSpeed));
    const endUs = Math.min(projectDurationUs(project), Math.round(((overlay.endSeconds ?? outUs / 1_000_000) - editor.startSeconds) * 1_000_000 / editor.playbackSpeed));
    if (endUs > startUs) for (const [text, position] of [[overlay.topText, overlay.topPosition], [overlay.bottomText, overlay.bottomPosition]] as const) {
      if (!text.trim()) continue;
      project = addTextLayer(project, text, startUs, endUs); const layer = project.layers[project.layers.length - 1];
      project = updateLayer(project, layer.id, { fontSize: overlay.fontSize, transform: { ...layer.transform, x: position.x / 100, y: position.y / 100 } });
    }
    if (overlay.style !== "classic" || overlay.textAlign !== "center") warnings.push("字幕文字、时段和位置已迁移；旧模板背景和对齐样式请在工作台复核。");
  }
  if (editor.filter !== "none") warnings.push("旧滤镜尚未转成工程效果，请对照原预览确认。");
  if (editor.trackedEffects?.length) warnings.push("旧跟踪效果尚未迁移，请保留旧会话供回查。");
  assertProject(project); return { project: { ...project, revision: 0 }, warnings };
}
/** Explicit migration permits an old saved session irrespective of its recent-list age. */
export function migrateLegacySession(raw: string): SessionMigration {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 || !("data" in parsed) || !isSessionDraftData(parsed.data)) throw new Error("Invalid legacy session file");
  return migrateSessionDraft(parsed.data);
}
