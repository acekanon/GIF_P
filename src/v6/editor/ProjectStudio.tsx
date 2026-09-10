import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowClockwise, ArrowLeft, ArrowRight, ArrowsOutSimple, Check, Copy, DownloadSimple, FilmStrip, FloppyDisk, FolderOpen, ImageSquare, MagnifyingGlassMinus, MagnifyingGlassPlus, Pause, Play, Plus, Scissors, SkipBack, SkipForward, Stack, Stop, TextT, Trash, X } from "@phosphor-icons/react";
import { cancelConversionTask, generateMediaThumbnails, inspectMedia, openDirectory, selectOutputDir, selectVideos } from "../../tauri";
import { addAsset, addClip, addMediaLayer, addTextLayer, clipDurationUs, commitHistory, createHistory, createProject, deleteFrame, duplicateClip, duplicateFrame, frameBoundaryUs, frameIndexAt, freezeFrame, isolateFrame, mediaSourceTimeAt, moveClip, moveLayer, projectDurationUs, redoHistory, relinkAsset, removeClip, removeLayer, setClipRate, sourceTimeAt, splitAtPlayhead, stepFrame, timelineEntries, toggleClipReverse, transformAt, trimClip, undoHistory, updateClip, updateLayer, updateProject, upsertKeyframe, type LayerTimingPolicy } from "./model";
import { migrateLegacySession, parseProject, readProjectAutosave, serializeProject, writeProjectAutosave, type SessionMigration } from "./persistence";
import { SESSION_DRAFT_KEY } from "../../v3/sessionPersistence";
import { hasProjectNative, openEditProject, projectMediaUrl, renderEditProject, saveEditProject } from "./native";
import type { EditProject, LayerTransform, ProjectAsset, ProjectClip, ProjectLayer, ProjectRenderResult } from "./types";
import "./studio.css";

type Selection = { kind: "clip" | "layer"; id: string } | null;
type StudioRenderToken = { taskId: string; projectId: string; revision: number; frameUs: number | null; generation: number };
type ProjectIoToken = { sequence: number; kind: "open" | "save"; projectId: string; revision: number; generation: number };
const US = 1_000_000;
const sec = (us: number) => (us / US).toFixed(3);
const uid = () => crypto.randomUUID();
const bytes = (value: number) => value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(2)} MB`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const bounded = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function createStudioDemo(): EditProject {
  let p = createProject("小小瞬间 · 练习工程");
  p = updateProject(p, { canvas: { width: 280, height: 498, fps: 20, background: "#fff9ec" } });
  p = addAsset(p, { id: "demo-photo", path: "/preset-previews/clean.jpg", name: "海边一帧.jpg", kind: "image", width: 280, height: 498, durationUs: 2 * US });
  p = addAsset(p, { id: "demo-motion", path: "/preset-previews/perceptual.gif", name: "流动的瞬间.gif", kind: "gif", width: 260, height: 462, durationUs: 1_790_000 });
  p = addClip(p, "demo-photo", { holdUs: 2 * US });
  p = addClip(p, "demo-motion");
  p = addTextLayer(p, "把这一刻，留在循环里。", 0, 2 * US);
  const text = p.layers[p.layers.length - 1];
  return updateLayer(p, text.id, { fontSize: 17, transform: { x: .5, y: .83, scale: 1, rotation: 0, opacity: 1 } });
}

function Field({ label, value, onChange, min, max, step = 1, suffix }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const finish = () => {
    const parsed = Number(draft);
    if (draft.trim() && Number.isFinite(parsed)) onChange(bounded(parsed, min ?? -Infinity, max ?? Infinity));
    else setDraft(String(value));
  };
  return <label className="studio-field"><span>{label}</span><span className="studio-input-unit"><input type="number" aria-label={label} value={draft} min={min} max={max} step={step} onChange={event => setDraft(event.target.value)} onBlur={finish} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />{suffix && <small>{suffix}</small>}</span></label>;
}

function Tool({ label, children, onClick, disabled, active, shortcut, hint, className = "" }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; active?: boolean; shortcut?: string; hint?: string; className?: string }) {
  return <button type="button" className={`studio-tool ${active ? "is-active" : ""} ${className}`} title={[label, shortcut?.replace("Control", "Ctrl"), hint].filter(Boolean).join(" · ")} aria-label={label} aria-keyshortcuts={shortcut} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function AssetVisual({ asset, sourceUs, native, className, style, onError }: { asset: ProjectAsset; sourceUs: number; native: boolean; className?: string; style?: CSSProperties; onError?: () => void }) {
  const [thumbnail, setThumbnail] = useState<{ key: string; path: string } | null>(null);
  const sourceKey = `${asset.path}:${Math.round(sourceUs / 1000)}`;
  const latestSource = useRef({ sourceKey, sourceUs, onError });
  latestSource.current = { sourceKey, sourceUs, onError };
  useEffect(() => {
    if (!native || asset.kind === "image") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let lastKey = "";
    const sample = async () => {
      const source = latestSource.current;
      if (source.sourceKey !== lastKey) {
        lastKey = source.sourceKey;
        try {
          const result = await generateMediaThumbnails({ input_path: asset.path, times: [source.sourceUs / US] });
          if (alive && result[0]) setThumbnail({ key: source.sourceKey, path: result[0].path });
        } catch { if (alive) latestSource.current.onError?.(); }
      }
      if (alive) timer = setTimeout(() => { void sample(); }, 125);
    };
    timer = setTimeout(() => { void sample(); }, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [asset.path, asset.kind, native]);
  const path = native && asset.kind !== "image" ? thumbnail?.key.startsWith(`${asset.path}:`) ? thumbnail.path : null : asset.path;
  if (!path) return <div className={`studio-asset-placeholder ${className ?? ""}`} style={style}><FilmStrip size={28} /><span>读取这一帧…</span></div>;
  return <img className={className} style={style} src={projectMediaUrl(path)} alt={asset.name} draggable={false} onError={onError} />;
}

function readRecovery() {
  try { return readProjectAutosave(window.localStorage); } catch { return { status: "empty" as const }; }
}

function readLegacyOffer(): SessionMigration | null {
  try { const raw = localStorage.getItem(SESSION_DRAFT_KEY); return raw ? migrateLegacySession(raw) : null; } catch { return null; }
}

export function ProjectStudio({ onClose }: { onClose?: () => void }) {
  const native = hasProjectNative();
  const [theme, setTheme] = useState(() => { try { const stored = localStorage.getItem("gifp.theme.v3") ?? "bubble"; return ["bubble", "animal", "handheld", "kid", "midnight"].includes(stored) ? stored : "bubble"; } catch { return "bubble"; } });
  const [history, setHistory] = useState(() => createHistory(createProject("未命名工程")));
  const project = history.present;
  const projectRef = useRef(project);
  projectRef.current = project;
  const projectGeneration = useRef(0);
  const fileIoSequence = useRef(0);
  const fileIoRef = useRef<ProjectIoToken | null>(null);
  const browserOpenRef = useRef<ProjectIoToken | null>(null);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [playhead, setPlayhead] = useState(0);
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [status, setStatus] = useState("从素材开始，也可以载入示例体验逐帧剪辑。");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(readRecovery);
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const [legacyOffer, setLegacyOffer] = useState(() => recovery.status === "empty" ? readLegacyOffer() : null);
  const legacyOfferRef = useRef(legacyOffer);
  legacyOfferRef.current = legacyOffer;
  const [migrationWarnings, setMigrationWarnings] = useState<string[]>([]);
  const [projectPath, setProjectPath] = useState<string>();
  const [outputDir, setOutputDir] = useState("");
  const [busy, setBusy] = useState<"import" | "preview" | "export" | null>(null);
  const [renderResult, setRenderResult] = useState<ProjectRenderResult | null>(null);
  const [renderResultFrameUs, setRenderResultFrameUs] = useState<number | null>(null);
  const [viewResult, setViewResult] = useState(false);
  const [frameMode, setFrameMode] = useState(false);
  const [holdSeconds, setHoldSeconds] = useState(.5);
  const [missing, setMissing] = useState<string[]>([]);
  const [layerDrag, setLayerDrag] = useState<{ id: string; transform: LayerTransform } | null>(null);
  const layerDragOrigin = useRef<{ id: string; x: number; y: number; width: number; height: number; transform: LayerTransform } | null>(null);
  const trimOrigin = useRef<{ clip: ProjectClip; side: "start" | "end"; x: number; width: number; patch: Partial<ProjectClip> | null; policy: LayerTimingPolicy } | null>(null);
  const [trimPreview, setTrimPreview] = useState<{ id: string; duration: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestRef = useRef<StudioRenderToken | null>(null);
  const cancellationRef = useRef<StudioRenderToken | null>(null);
  const shortcutActionsRef = useRef<{ open: () => void; save: (asNew: boolean) => void; render: (preview: boolean) => void } | null>(null);
  const mounted = useRef(true);
  const duration = projectDurationUs(project);
  const layerTiming: LayerTimingPolicy = project.editing?.layerTiming ?? "absolute";
  const entries = timelineEntries(project);
  const activeEntry = entries.find(entry => playhead >= entry.startUs && playhead < entry.endUs) ?? entries[entries.length - 1];
  const activeAsset = project.assets.find(asset => asset.id === activeEntry?.clip.assetId);
  const selectedClip = selection?.kind === "clip" ? project.clips.find(clip => clip.id === selection.id) : undefined;
  const selectedLayer = selection?.kind === "layer" ? project.layers.find(layer => layer.id === selection.id) : undefined;
  const frame = frameIndexAt(playhead, project.canvas.fps);
  const totalFrames = duration ? frameIndexAt(duration - 1, project.canvas.fps) + 1 : 0;
  const frameStart = frameBoundaryUs(frame, project.canvas.fps);
  const frameEnd = Math.min(duration, frameBoundaryUs(frame + 1, project.canvas.fps));
  const currentResult = renderResult?.projectId === project.id && renderResult.revision === project.revision && (renderResultFrameUs === null || renderResultFrameUs === frameStart);
  const visibleLayers = project.layers.filter(layer => layer.visible && playhead >= layer.startUs && playhead < layer.endUs);
  const commit = (next: EditProject, label: string) => {
    projectRef.current = next;
    setHistory(current => commitHistory(current, next, label));
    setLegacyOffer(null);
    setViewResult(false); setError(""); setStatus(label);
  };
  const operate = (operation: () => void) => { try { operation(); } catch (caught) { setError(errorText(caught)); } };
  const resetTo = (next: EditProject) => { projectGeneration.current += 1; fileIoRef.current = null; browserOpenRef.current = null; projectRef.current = next; setHistory(createHistory(next)); setSelection(null); setPlayhead(0); setPlaying(false); setViewResult(false); setRenderResult(null); setRenderResultFrameUs(null); setProjectPath(undefined); setMissing([]); setError(""); setRecovery({ status: "empty" }); setLegacyOffer(null); setMigrationWarnings([]); };

  useEffect(() => {
    if (recovery.status !== "ready" && recovery.status !== "corrupt" && !legacyOffer) {
      const timer = setTimeout(() => { try { if (!writeProjectAutosave(localStorage, project)) setStatus("自动保存失败，请手动保存工程。"); } catch { setStatus("自动保存不可用，请手动保存工程。"); } }, 500);
      return () => clearTimeout(timer);
    }
  }, [project, recovery.status, legacyOffer]);
  useEffect(() => { setPlayhead(value => bounded(value, 0, Math.max(0, duration - 1))); }, [duration]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; const request = requestRef.current; requestRef.current = null; if (request) void cancelConversionTask(request.taskId).catch(() => undefined); if (recoveryRef.current.status === "empty" && !legacyOfferRef.current) { try { writeProjectAutosave(localStorage, projectRef.current); } catch { /* Manual save remains available. */ } } };
  }, []);
  useEffect(() => {
    if (!playing || !duration) return;
    let last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); const delta = (now - last) * 1000; last = now; setPlayhead(value => {
      const next = value + delta;
      if (next >= duration && !project.output.loop) { setPlaying(false); return Math.max(0, duration - 1); }
      return Math.min(duration - 1, Math.round(next % duration));
    }); }, 1000 / project.canvas.fps);
    return () => clearInterval(timer);
  }, [playing, duration, project.canvas.fps, project.output.loop]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : document.activeElement;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && (key === "s" || key === "o" && !event.shiftKey || key === "enter")) {
        event.preventDefault();
        if (event.repeat) return;
        if (target instanceof HTMLElement && target.closest('input[type="number"]')) { setError(""); setStatus("数字属性编辑中，请先按 Enter 确认，再使用打开、保存或渲染快捷键。"); return; }
        if (key === "o") shortcutActionsRef.current?.open();
        else if (key === "s") shortcutActionsRef.current?.save(event.shiftKey);
        else shortcutActionsRef.current?.render(event.shiftKey);
        return;
      }
      if (target instanceof HTMLElement && (target.closest("input, textarea, select") || target.isContentEditable)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); setHistory(current => event.shiftKey ? redoHistory(current) : undoHistory(current)); setViewResult(false); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); setHistory(redoHistory); setViewResult(false); }
      else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setPlaying(false); setPlayhead(value => stepFrame(projectRef.current, value, event.key === "ArrowLeft" ? -1 : 1)); }
      else if (event.code === "Space") { event.preventDefault(); if (projectRef.current.clips.length) setPlaying(value => !value); }
    };
    window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle);
  }, []);

  const seek = (time: number) => { setPlaying(false); setViewResult(false); setPlayhead(Math.round(bounded(time, 0, Math.max(0, duration - 1)))); };
  const importAssets = async () => {
    if (!native) { setStatus("浏览器演示可使用示例素材；桌面版支持导入本地视频、GIF 和图片。"); return; }
    setBusy("import"); setError("");
    try {
      const paths = await selectVideos();
      const imported: ProjectAsset[] = [];
      for (const path of paths) {
        const info = await inspectMedia(path);
        const ext = path.split(".").pop()?.toLowerCase();
        const asset: ProjectAsset = { id: uid(), path, name: path.split(/[\\/]/).pop() ?? path, kind: !info.animated && info.duration <= 0 ? "image" : ext === "gif" ? "gif" : ext === "webp" ? "webp" : ext === "apng" ? "apng" : ["jpg", "jpeg", "png", "bmp"].includes(ext ?? "") ? "image" : "video", width: info.width, height: info.height, durationUs: Math.round(Math.max(info.duration, 2 * Number(!info.animated && !info.duration)) * US) || 2 * US };
        imported.push(asset);
      }
      let next = projectRef.current;
      for (const asset of imported) {
        next = addClip(addAsset(next, asset), asset.id);
        if (next.clips.length === 1) { const ratio = Math.min(1, 1280 / asset.width, 1920 / asset.height); next = updateProject(next, { canvas: { ...next.canvas, width: Math.max(96, Math.round(asset.width * ratio)), height: Math.max(16, Math.round(asset.height * ratio)) } }); }
      }
      if (paths.length) { commit(next, `已导入 ${paths.length} 个素材`); setSelection({ kind: "clip", id: next.clips[next.clips.length - 1].id }); }
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(null); }
  };
  const relink = async (asset: ProjectAsset) => {
    try {
      const [path] = await selectVideos(); if (!path) return;
      const info = await inspectMedia(path);
      commit(relinkAsset(projectRef.current, asset.id, { path, name: path.split(/[\\/]/).pop() ?? path, width: info.width, height: info.height, durationUs: Math.round((info.duration || 2) * US) }), "已重新关联素材");
      setMissing(value => value.filter(id => id !== asset.id));
    } catch (caught) { setError(errorText(caught)); }
  };
  const beginFileIo = (kind: "open" | "save"): ProjectIoToken => {
    const token = { sequence: ++fileIoSequence.current, kind, generation: projectGeneration.current, projectId: projectRef.current.id, revision: projectRef.current.revision };
    fileIoRef.current = token; return token;
  };
  const ownsFileIo = (token: ProjectIoToken) => mounted.current && fileIoRef.current === token && projectGeneration.current === token.generation && projectRef.current.id === token.projectId;
  const acceptOpenedProject = (token: ProjectIoToken, next: EditProject, path?: string) => {
    if (!ownsFileIo(token)) return;
    if (projectRef.current.revision !== token.revision) { setStatus("打开期间工程已有新编辑，本次未替换当前工程。请重新打开文件。"); return; }
    resetTo(next); setProjectPath(path); setStatus(path ? "已打开工程" : "已从 JSON 打开工程");
  };
  const loadProject = async () => {
    const token = beginFileIo("open");
    if (!native) { browserOpenRef.current = token; fileInput.current?.click(); return; }
    try { const result = await openEditProject(); if (result) acceptOpenedProject(token, result.project, result.path); }
    catch (caught) { if (ownsFileIo(token)) setError(errorText(caught)); }
    finally { if (fileIoRef.current === token) fileIoRef.current = null; }
  };
  const loadBrowserProject = async (file: File) => {
    const token = browserOpenRef.current ?? beginFileIo("open"); browserOpenRef.current = null;
    try { const raw = await file.text(); if (ownsFileIo(token)) acceptOpenedProject(token, parseProject(raw)); }
    catch (caught) { if (ownsFileIo(token)) setError(errorText(caught)); }
    finally { if (fileIoRef.current === token) fileIoRef.current = null; }
  };
  const saveProject = async (asNew = false) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true);
    const token = beginFileIo("save");
    try {
      const snapshot = parseProject(serializeProject(projectRef.current));
      if (native) {
        const result = await saveEditProject(snapshot, asNew ? undefined : projectPath);
        if (result && ownsFileIo(token)) { setProjectPath(result.path); setError(""); setStatus(projectRef.current.revision === token.revision ? "工程已保存" : "较早的工程快照已保存，当前新增编辑仍需保存。"); }
      } else { const blob = new Blob([serializeProject(snapshot)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${snapshot.name}.gifp.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); if (ownsFileIo(token)) setStatus("工程 JSON 已下载，可在此重新打开。"); }
    } catch (caught) { if (ownsFileIo(token)) setError(errorText(caught)); }
    finally { savingRef.current = false; if (mounted.current) setSaving(false); if (fileIoRef.current === token) fileIoRef.current = null; }
  };
  const startRender = async (preview: boolean) => {
    if (!native) { setStatus("真实预览与 GIF 编码需在 GIFP 桌面版运行。浏览器演示不会生成成品。"); return; }
    if (requestRef.current) return;
    setError(""); setPlaying(false);
    let token: StudioRenderToken | null = null;
    try {
      const snapshot = parseProject(serializeProject(projectRef.current));
      const requestedFrameUs = preview && frameMode ? frameBoundaryUs(frameIndexAt(playheadRef.current, snapshot.canvas.fps), snapshot.canvas.fps) : null;
      token = { taskId: `studio-${uid()}`, projectId: snapshot.id, revision: snapshot.revision, frameUs: requestedFrameUs, generation: projectGeneration.current };
      requestRef.current = token; setBusy(preview ? "preview" : "export");
      let dir = outputDir;
      if (!preview && !dir) { dir = await selectOutputDir() ?? ""; if (!dir) return; setOutputDir(dir); }
      if (requestRef.current !== token || projectGeneration.current !== token.generation) return;
      setStatus(requestedFrameUs !== null ? `正在精确合成第 ${frameIndexAt(requestedFrameUs, snapshot.canvas.fps) + 1} 帧…` : preview ? "正在按工程快照合成真实预览（最多前 15 秒）…" : "正在合成图层、编码 GIF 并验证智能压缩…");
      const result = await renderEditProject({ project: snapshot, outputDir: dir, taskId: token.taskId, preview, previewFrameUs: requestedFrameUs ?? undefined });
      if (!mounted.current || requestRef.current !== token) return;
      if (projectGeneration.current !== token.generation || projectRef.current.id !== token.projectId || projectRef.current.revision !== token.revision) { setStatus("渲染期间工程已更改，本次结果未替换当前预览。请重新渲染。"); return; }
      if (requestedFrameUs !== null && frameBoundaryUs(frameIndexAt(playheadRef.current, snapshot.canvas.fps), snapshot.canvas.fps) !== requestedFrameUs) { setStatus("播放头已移到另一帧，本次结果未替换当前画面。请重新渲染当前帧。"); return; }
      setRenderResult(result); setRenderResultFrameUs(requestedFrameUs); setViewResult(true); setError(""); setStatus(`${requestedFrameUs !== null ? "当前帧精确合成" : preview ? "真实预览（最多前 15 秒）" : "GIF 导出"}完成 · ${bytes(result.bytes)}`);
    } catch (caught) { if (mounted.current && (!token || requestRef.current === token && projectGeneration.current === token.generation)) setError(errorText(caught)); }
    finally { if (mounted.current && token && requestRef.current === token) { requestRef.current = null; setBusy(null); } }
  };
  const stopRender = async () => {
    const active = requestRef.current; if (!active || cancellationRef.current === active) return;
    cancellationRef.current = active;
    try {
      const canceled = await cancelConversionTask(active.taskId);
      if (!mounted.current || requestRef.current !== active) return;
      if (canceled === true) { requestRef.current = null; setBusy(null); if (projectGeneration.current === active.generation) { setError(""); setStatus("已停止渲染"); } }
      else if (projectGeneration.current === active.generation) setStatus("当前渲染已进入提交阶段或尚不能取消，正在等待实际结果。");
    } catch (caught) { if (mounted.current && requestRef.current === active && projectGeneration.current === active.generation) setError(`取消请求失败，仍在等待渲染结果：${errorText(caught)}`); }
    finally { if (cancellationRef.current === active) cancellationRef.current = null; }
  };
  shortcutActionsRef.current = {
    open: () => { if (!busy) void loadProject(); },
    save: asNew => { void saveProject(asNew); },
    render: preview => { if (!busy && projectRef.current.clips.length) void startRender(preview); },
  };
  const selectClip = (clip: ProjectClip, startUs: number) => { setSelection({ kind: "clip", id: clip.id }); seek(startUs); };
  const addText = (onlyFrame = frameMode) => operate(() => {
    const next = addTextLayer(project, onlyFrame ? "这一帧" : "输入你的文字", onlyFrame ? frameStart : playhead, onlyFrame ? frameEnd : Math.min(duration, playhead + 2 * US));
    commit(next, onlyFrame ? "已添加仅此帧文字" : "已添加文字轨"); setSelection({ kind: "layer", id: next.layers[next.layers.length - 1].id });
  });
  const addOverlay = (asset: ProjectAsset, onlyFrame = frameMode) => operate(() => {
    const next = addMediaLayer(project, asset.id, onlyFrame ? frameStart : playhead, onlyFrame ? frameEnd : Math.min(duration, playhead + 2 * US));
    commit(next, onlyFrame ? "已添加仅此帧贴纸" : "已添加叠加轨"); setSelection({ kind: "layer", id: next.layers[next.layers.length - 1].id });
  });
  const isolate = () => operate(() => { const result = isolateFrame(project, playhead); commit(result.project, "已将当前输出帧拆成独立片段，可单独裁剪与调时长"); setSelection(result.clipIds[0] ? { kind: "clip", id: result.clipIds[0] } : null); setFrameMode(true); seek(result.startUs); });
  const layerPatch = (patch: Partial<ProjectLayer>) => { if (selectedLayer) operate(() => commit(updateLayer(project, selectedLayer.id, patch), "已修改图层")); };
  const layerToCurrentFrame = () => {
    if (!selectedLayer || !duration) return;
    const local = bounded(frameStart - selectedLayer.startUs, 0, selectedLayer.endUs - selectedLayer.startUs - 1);
    const snapshot: Partial<ProjectLayer> = { startUs: frameStart, endUs: frameEnd, transform: transformAt(selectedLayer, local), keyframes: [] };
    if (selectedLayer.kind === "media") Object.assign(snapshot, {
      sourceOffsetUs: mediaSourceTimeAt(selectedLayer, local), sourceFrozen: true, sourceTimeMap: undefined,
      rasterScaleMax: Math.max(selectedLayer.rasterScaleMax ?? .01, selectedLayer.transform.scale, ...selectedLayer.keyframes.map(key => key.transform.scale), ...(selectedLayer.transformSamples ?? []).map(key => key.transform.scale)),
    });
    layerPatch(snapshot);
  };
  const transformPatch = (patch: Partial<LayerTransform>) => { if (selectedLayer) layerPatch({ transform: { ...selectedLayer.transform, ...patch } }); };
  const canvasPatch = (patch: Partial<EditProject["canvas"]>) => operate(() => commit(updateProject(project, { canvas: { ...project.canvas, ...patch } }), "已修改画布"));
  const markMissing = (id: string) => setMissing(value => value.includes(id) ? value : [...value, id]);
  const dragLayer = (event: React.PointerEvent<HTMLButtonElement>, layer: ProjectLayer) => {
    if (layer.locked || layer.keyframes.length) return;
    const canvas = event.currentTarget.parentElement?.getBoundingClientRect(); if (!canvas?.width || !canvas.height) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection({ kind: "layer", id: layer.id }); setPlaying(false);
    layerDragOrigin.current = { id: layer.id, x: event.clientX, y: event.clientY, width: canvas.width, height: canvas.height, transform: layer.transform };
  };
  const beginTrim = (event: React.PointerEvent<HTMLSpanElement>, clip: ProjectClip, side: "start" | "end") => {
    event.stopPropagation(); event.preventDefault();
    const width = event.currentTarget.closest(".studio-primary-track")?.getBoundingClientRect().width;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId); setPlaying(false); setSelection({ kind: "clip", id: clip.id });
    trimOrigin.current = { clip, side, x: event.clientX, width, patch: null, policy: projectRef.current.editing?.layerTiming ?? "absolute" };
  };
  const moveTrim = (event: React.PointerEvent<HTMLSpanElement>) => {
    const origin = trimOrigin.current; if (!origin) return; event.stopPropagation();
    const deltaFrames = Math.round((event.clientX - origin.x) / origin.width * duration / US * project.canvas.fps);
    const delta = Math.round(deltaFrames * US / project.canvas.fps);
    const clip = origin.clip;
    const patch: Partial<ProjectClip> = clip.holdUs
      ? { holdUs: clip.holdUs + (origin.side === "end" ? delta : -delta) }
      : origin.side === "start"
        ? clip.reverse ? { outUs: clip.outUs - Math.round(delta * clip.rate) } : { inUs: clip.inUs + Math.round(delta * clip.rate) }
        : clip.reverse ? { inUs: clip.inUs - Math.round(delta * clip.rate) } : { outUs: clip.outUs + Math.round(delta * clip.rate) };
    try { const next = updateClip(projectRef.current, clip.id, patch, origin.policy); const updated = next.clips.find(item => item.id === clip.id)!; if (clipDurationUs(updated) < frameBoundaryUs(1, project.canvas.fps)) return; origin.patch = patch; setTrimPreview({ id: clip.id, duration: clipDurationUs(updated) }); } catch { /* Keep the last valid frame-aligned trim while dragging beyond the source. */ }
  };
  const finishTrim = (event: React.PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation(); const origin = trimOrigin.current;
    if (origin?.patch) operate(() => commit(updateClip(projectRef.current, origin.clip.id, origin.patch!, origin.policy), "已按输出帧吸附修剪片段"));
    trimOrigin.current = null; setTrimPreview(null);
  };
  const trimHandle = (clip: ProjectClip, side: "start" | "end") => <span className="studio-clip-grip" title={side === "start" ? "拖动修剪起点（逐帧吸附）" : "拖动修剪终点（逐帧吸附）"} onClick={event => event.stopPropagation()} onPointerDown={event => beginTrim(event, clip, side)} onPointerMove={moveTrim} onPointerUp={finishTrim} onPointerCancel={() => { trimOrigin.current = null; setTrimPreview(null); }} />;

  return <section className={`project-studio theme-${theme}`} aria-label="GIFP 6.0 剪辑工作台">
    <header className="studio-header">
      <div className="studio-brand"><span className="studio-logo"><FilmStrip size={26} weight="duotone" /></span><div><b>GIFP <span>STUDIO / 6.0</span></b><small>把灵感，剪成循环。</small></div></div>
      <input className="studio-project-name" aria-label="工程名称" value={project.name} onChange={event => operate(() => commit(updateProject(project, { name: event.target.value }), "已重命名工程"))} />
      <div className="studio-header-actions">
        <Tool label="打开工程" shortcut="Control+O" onClick={() => void loadProject()} disabled={!!busy}><FolderOpen size={18} /><span>打开</span></Tool>
        <Tool label="保存工程" shortcut="Control+S" onClick={() => void saveProject()} disabled={saving}><FloppyDisk size={18} /><span>保存</span></Tool>
        <Tool label="另存为" shortcut="Control+Shift+S" onClick={() => void saveProject(true)} disabled={saving}><Copy size={17} /></Tool>
        <button className="studio-primary" aria-keyshortcuts="Control+Enter" title="导出 GIF · Ctrl+Enter" disabled={!project.clips.length || !!busy} onClick={() => void startRender(false)}><DownloadSimple size={18} />导出 GIF</button>
        {onClose && <Tool label="返回快速制作" onClick={onClose}><ArrowLeft size={17} /><span>快速工具</span></Tool>}
      </div>
    </header>
    <input ref={fileInput} hidden type="file" accept=".json,.gifp" aria-label="选择工程 JSON" onChange={event => { const file = event.target.files?.[0]; if (file) void loadBrowserProject(file); event.target.value = ""; }} />
    {recovery.status === "ready" && <div className="studio-recovery"><FloppyDisk size={17} /><span>找到自动保存的「{recovery.project.name}」</span><button onClick={() => { if (recovery.status === "ready") { resetTo(recovery.project); setStatus("已恢复自动保存工程"); } }}>恢复工程</button><button onClick={() => setRecovery({ status: "empty" })}>开始新工程</button></div>}
    {recovery.status === "corrupt" && <div className="studio-recovery"><span>自动保存无法读取，请打开手动保存的工程。</span><button onClick={() => setRecovery({ status: "empty" })}>关闭提示</button></div>}
    {legacyOffer && <div className="studio-recovery"><FilmStrip size={17} /><span>发现旧版编辑「{legacyOffer.project.name}」，可复制到 6.0 工作台。</span><button onClick={() => { const migration = legacyOffer; resetTo(migration.project); setMigrationWarnings(migration.warnings); setStatus(`已导入旧版编辑，旧版会话完整保留${migration.warnings.length ? `；${migration.warnings.length} 项效果需复核` : ""}。`); }}>导入旧版编辑</button><button onClick={() => { setLegacyOffer(null); setStatus("已开始新工程，旧版编辑仍保留在旧版工具中。"); }}>开始新工程</button>{onClose && <button onClick={onClose}>继续使用旧版工具</button>}</div>}
    {migrationWarnings.length > 0 && <div className="studio-migration-warnings" role="note" aria-label="旧版编辑迁移说明"><button aria-label="关闭迁移说明" onClick={() => setMigrationWarnings([])}><X size={14} /></button><b>以下效果需要复核，旧版编辑仍可在旧版工具中查看：</b>{migrationWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    <div className="studio-workspace">
      <aside className="studio-bin" aria-label="素材库">
        <div className="studio-section-heading"><h2>我的素材 <small>{project.assets.length.toString().padStart(2, "0")}</small></h2><Stack size={18} /></div>
        <button className="studio-import" onClick={() => void importAssets()} disabled={!!busy}><Plus size={20} />导入素材<small>视频 / GIF / 图片</small></button>
        {!native && <p className="studio-browser-note">浏览器交互演示 · 原生渲染请使用桌面版</p>}
        <div className="studio-asset-list">
          {project.assets.map(asset => <article className={`studio-asset-card ${missing.includes(asset.id) ? "is-missing" : ""}`} key={asset.id}>
            <div className="studio-asset-image"><AssetVisual asset={asset} sourceUs={0} native={native} onError={() => markMissing(asset.id)} /><span>{asset.kind.toUpperCase()}</span></div>
            <b title={asset.name}>{asset.name}</b><small>{asset.width} × {asset.height} · {sec(asset.durationUs)}s</small>
            <div><button onClick={() => operate(() => commit(addClip(project, asset.id), "已追加到主轨"))}><Plus size={13} />主轨</button><button disabled={!duration} onClick={() => addOverlay(asset)}><Stack size={13} />{frameMode ? "此帧贴纸" : "叠加"}</button></div>
            {native && <button className="studio-relink" onClick={() => void relink(asset)}>{missing.includes(asset.id) ? "素材缺失 · 重新关联" : "重新关联素材"}</button>}
          </article>)}
          {!project.assets.length && <div className="studio-empty-bin"><ImageSquare size={36} weight="duotone" /><p>一个片段，一点文字，<br />就能开始你的故事。</p>{!native && <button onClick={() => { resetTo(createStudioDemo()); setStatus("已载入示例。GIF 在浏览器中播放为素材参考；单帧精确预览由桌面版提供。"); }}>载入示例工程 <ArrowRight size={15} /></button>}</div>}
        </div>
        <div className="studio-bin-footer"><span className="studio-dot" />工程自动保存到本机</div>
      </aside>
      <main className="studio-monitor" aria-label="编辑画布">
        <div className="studio-monitor-heading"><div><b>{viewResult && currentResult ? renderResultFrameUs !== null ? `精确合成 · 第 ${frameIndexAt(renderResultFrameUs, project.canvas.fps) + 1} 帧` : renderResult?.preview ? "真实预览 · 最多前 15 秒" : "真实 GIF 成品" : "编辑预览"}</b><span>{project.canvas.width} × {project.canvas.height}</span></div><div className="studio-view-switch"><button className={!viewResult ? "is-active" : ""} onClick={() => setViewResult(false)}>编排</button><button disabled={!currentResult} className={viewResult ? "is-active" : ""} onClick={() => setViewResult(true)}>成品</button></div></div>
        <div className="studio-stage">
          {project.clips.length ? <div className="studio-canvas" data-testid="studio-canvas" style={{ aspectRatio: `${project.canvas.width} / ${project.canvas.height}`, width: `min(100cqw, ${project.canvas.width / project.canvas.height * 100}cqh)`, height: `min(100cqh, ${project.canvas.height / project.canvas.width * 100}cqw)`, backgroundColor: project.canvas.background }}>
            {viewResult && currentResult && renderResult ? <img className="studio-result-image" src={projectMediaUrl(renderResult.outputPath)} alt={renderResultFrameUs === null ? "实际渲染的 GIF 成品" : "精确合成的当前帧"} /> : <>
              {activeAsset && activeEntry && <div className="studio-primary-image" style={{ overflow: "hidden" }}><AssetVisual key={activeAsset.id} asset={activeAsset} sourceUs={activeEntry.clip.holdUs ? activeEntry.clip.inUs : Math.max(activeEntry.clip.inUs, Math.min(activeEntry.clip.outUs - 1, sourceTimeAt(activeEntry.clip, Math.min(clipDurationUs(activeEntry.clip), Math.max(0, playhead - activeEntry.startUs)))))} native={native} onError={() => markMissing(activeAsset.id)} style={{ width: `${100 / (1 - activeEntry.clip.crop.left - activeEntry.clip.crop.right)}%`, height: `${100 / (1 - activeEntry.clip.crop.top - activeEntry.clip.crop.bottom)}%`, maxWidth: "none", objectFit: activeEntry.clip.fit, marginLeft: `${-activeEntry.clip.crop.left * 100 / (1 - activeEntry.clip.crop.left - activeEntry.clip.crop.right)}%`, marginTop: `${-activeEntry.clip.crop.top * 100 / (1 - activeEntry.clip.crop.top - activeEntry.clip.crop.bottom)}%` }} /></div>}
              {visibleLayers.map(layer => { const transform = layerDrag?.id === layer.id ? layerDrag.transform : transformAt(layer, playhead - layer.startUs); const asset = layer.kind === "media" ? project.assets.find(item => item.id === layer.assetId) : undefined; return <button key={layer.id} aria-label={`选择图层 ${layer.name}`} className={`studio-canvas-layer ${selection?.id === layer.id ? "is-selected" : ""}`} disabled={layer.locked} onPointerDown={event => dragLayer(event, layer)} onPointerMove={event => { const origin = layerDragOrigin.current; if (origin?.id === layer.id) setLayerDrag({ id: layer.id, transform: { ...origin.transform, x: bounded(origin.transform.x + (event.clientX - origin.x) / origin.width, -1, 2), y: bounded(origin.transform.y + (event.clientY - origin.y) / origin.height, -1, 2) } }); }} onPointerUp={() => { if (layerDrag?.id === layer.id) operate(() => commit(updateLayer(project, layer.id, { transform: layerDrag.transform }), "已拖动图层位置")); layerDragOrigin.current = null; setLayerDrag(null); }} onPointerCancel={() => { layerDragOrigin.current = null; setLayerDrag(null); }} onClick={() => setSelection({ kind: "layer", id: layer.id })} style={{ left: `${transform.x * 100}%`, top: `${transform.y * 100}%`, transform: `translate(-50%, -50%) rotate(${transform.rotation}deg) scale(${transform.scale})`, opacity: transform.opacity, width: layer.kind === "media" ? `${layer.width * 100}%` : "max-content", maxWidth: layer.kind === "text" ? "95%" : undefined }}>
                {layer.kind === "text" ? <span style={{ color: layer.color, fontSize: `${layer.fontSize / project.canvas.width * 100}cqw`, WebkitTextStroke: `${layer.strokeWidth / project.canvas.width * 100}cqw ${layer.strokeColor}`, paintOrder: "stroke fill", whiteSpace: "pre-wrap" }}>{layer.text}</span> : asset && <AssetVisual asset={asset} sourceUs={asset.kind === "image" ? 0 : mediaSourceTimeAt(layer, playhead - layer.startUs) % Math.max(1, asset.durationUs)} native={native} onError={() => markMissing(asset.id)} />}
              </button>; })}
            </>}
          </div> : <div className="studio-empty-stage"><span><FilmStrip size={44} weight="duotone" /></span><h1>每一帧，都值得认真剪。</h1><p>导入素材，开始你的第一条时间轴</p><button className="studio-primary" onClick={() => native ? void importAssets() : (resetTo(createStudioDemo()), setStatus("已载入示例工程"))}><Plus size={17} />{native ? "导入第一个素材" : "载入示例工程"}</button></div>}
          {project.clips.length > 0 && <span className="studio-preview-tag">{viewResult && currentResult ? renderResultFrameUs !== null ? `此输出帧已精确合成 · ${sec(renderResultFrameUs)}s` : `已编码 · ${bytes(renderResult!.bytes)}` : native ? "源帧与图层参考 · 请渲染确认合成效果" : "素材参考 · 浏览器动图无法精确逐帧定位"}</span>}
        </div>
        <div className="studio-transport"><span className="studio-time">{sec(playhead)} <small>/ {sec(duration)} s</small></span><div><Tool label="上一帧（←）" disabled={!duration} onClick={() => seek(stepFrame(project, playhead, -1))}><SkipBack size={17} /></Tool><Tool label={playing ? "暂停" : "播放（空格）"} disabled={!duration || viewResult} onClick={() => setPlaying(!playing)} className="studio-play">{playing ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</Tool><Tool label="下一帧（→）" disabled={!duration} onClick={() => seek(stepFrame(project, playhead, 1))}><SkipForward size={17} /></Tool></div><span className="studio-frame-count" data-testid="frame-count">帧 {totalFrames ? frame + 1 : 0} / {totalFrames}</span></div>
      </main>
      <aside className="studio-inspector" aria-label="属性面板"><div className="studio-section-heading"><h2>{selectedLayer ? selectedLayer.kind === "text" ? "文字属性" : "叠加属性" : selectedClip ? "片段属性" : "画布与导出"}</h2>{selection && <Tool label="取消选择" onClick={() => setSelection(null)}><X size={15} /></Tool>}</div>
        <div className="studio-inspector-body">
          {selectedClip ? <>
            <div className="studio-property-title"><FilmStrip size={20} /><b>{project.assets.find(asset => asset.id === selectedClip.assetId)?.name}</b></div>
            <div className="studio-property-grid"><Field label="源入点" value={Number(sec(selectedClip.inUs))} min={0} step={.001} suffix="s" onChange={value => operate(() => commit(trimClip(project, selectedClip.id, Math.round(value * US), selectedClip.outUs, layerTiming), "已修剪入点"))} /><Field label="源出点" value={Number(sec(selectedClip.outUs))} min={.001} step={.001} suffix="s" onChange={value => operate(() => commit(trimClip(project, selectedClip.id, selectedClip.inUs, Math.round(value * US), layerTiming), "已修剪出点"))} /></div>
            <p className="studio-hint">片段时长 {sec(clipDurationUs(selectedClip))} 秒 · {Math.max(1, Math.round(clipDurationUs(selectedClip) / US * project.canvas.fps))} 输出帧</p>
            <div className="studio-property-grid"><Field label="播放速度" value={selectedClip.rate} min={.1} max={8} step={.1} suffix="×" onChange={value => operate(() => commit(setClipRate(project, selectedClip.id, value, layerTiming), "已修改片段速度"))} /><Field label="定格时长" value={Number(sec(selectedClip.holdUs))} min={0} max={30} step={.05} suffix="s" onChange={value => operate(() => commit(updateClip(project, selectedClip.id, { holdUs: Math.round(value * US) }, layerTiming), "已修改定格时长"))} /></div>
            <label className="studio-check"><input type="checkbox" checked={selectedClip.reverse} onChange={() => operate(() => commit(toggleClipReverse(project, selectedClip.id), "已切换倒放"))} />倒放此片段</label>
            <button className="studio-wide-button" onClick={() => operate(() => { const next = duplicateClip(project, selectedClip.id, layerTiming); const duplicate = next.clips[next.clips.findIndex(clip => clip.id === selectedClip.id) + 1]; commit(toggleClipReverse(next, duplicate.id), "已添加倒放副本，组成往返片段"); })}>往返播放 · 追加倒放副本</button>
            <label className="studio-field"><span>画面适配</span><select aria-label="画面适配" value={selectedClip.fit} onChange={event => operate(() => commit(updateClip(project, selectedClip.id, { fit: event.target.value as "contain" | "cover" }, layerTiming), "已修改画面适配"))}><option value="contain">完整显示</option><option value="cover">填满画布</option></select></label>
            <div className="studio-subheading"><ArrowsOutSimple size={15} />源画面裁剪</div>
            <div className="studio-property-grid">{([['left', '左侧'], ['top', '顶部'], ['right', '右侧'], ['bottom', '底部']] as const).map(([key, label]) => <Field key={key} label={`裁剪${label}`} value={Math.round(selectedClip.crop[key] * 100)} min={0} max={90} suffix="%" onChange={value => operate(() => commit(updateClip(project, selectedClip.id, { crop: { ...selectedClip.crop, [key]: value / 100 } }, layerTiming), "已修改片段裁剪"))} />)}</div>
            <p className="studio-hint">仅修改一帧：点击「独立此帧」，再调整裁剪。源文件保持完整。</p>
            <button className="studio-danger" onClick={() => operate(() => { commit(removeClip(project, selectedClip.id, layerTiming), "已删除片段"); setSelection(null); })}><Trash size={15} />删除片段</button>
          </> : selectedLayer ? <fieldset className="studio-layer-fields" disabled={selectedLayer.locked}>
            {selectedLayer.kind === "text" && <><label className="studio-field"><span>字幕内容</span><textarea aria-label="字幕内容" value={selectedLayer.text} onChange={event => layerPatch({ text: event.target.value })} /></label><div className="studio-property-grid"><Field label="字号" value={selectedLayer.fontSize} min={6} max={300} onChange={value => layerPatch({ fontSize: value })} /><label className="studio-field"><span>文字颜色</span><input type="color" aria-label="文字颜色" value={selectedLayer.color} onChange={event => layerPatch({ color: event.target.value })} /></label><Field label="描边宽度" value={selectedLayer.strokeWidth} min={0} max={20} step={.5} onChange={value => layerPatch({ strokeWidth: value })} /><label className="studio-field"><span>描边颜色</span><input type="color" aria-label="描边颜色" value={selectedLayer.strokeColor} onChange={event => layerPatch({ strokeColor: event.target.value })} /></label></div></>}
            <div className="studio-property-grid"><Field label="出现时间" value={Number(sec(selectedLayer.startUs))} min={0} max={duration / US} step={.001} suffix="s" onChange={value => layerPatch({ startUs: Math.round(value * US) })} /><Field label="结束时间" value={Number(sec(selectedLayer.endUs))} min={0} max={duration / US} step={.001} suffix="s" onChange={value => layerPatch({ endUs: Math.round(value * US) })} /></div>
            <button className="studio-wide-button" disabled={!duration} onClick={layerToCurrentFrame}>仅显示在当前帧</button>
            <div className="studio-subheading">位置与变换</div>
            <div className="studio-property-grid"><Field label="水平位置" value={Math.round(selectedLayer.transform.x * 100)} min={-100} max={200} suffix="%" onChange={value => transformPatch({ x: value / 100 })} /><Field label="垂直位置" value={Math.round(selectedLayer.transform.y * 100)} min={-100} max={200} suffix="%" onChange={value => transformPatch({ y: value / 100 })} /><Field label="缩放" value={Math.round(selectedLayer.transform.scale * 100)} min={1} max={500} suffix="%" onChange={value => transformPatch({ scale: value / 100 })} /><Field label="旋转" value={selectedLayer.transform.rotation} min={-360} max={360} suffix="°" onChange={value => transformPatch({ rotation: value })} /><Field label="不透明度" value={Math.round(selectedLayer.transform.opacity * 100)} min={0} max={100} suffix="%" onChange={value => transformPatch({ opacity: value / 100 })} />{selectedLayer.kind === "media" && <Field label="图层宽度" value={Math.round(selectedLayer.width * 100)} min={1} max={200} suffix="%" onChange={value => layerPatch({ width: value / 100 })} />}</div>
            <div className="studio-subheading">关键帧 <small>线性插值</small></div><button className="studio-wide-button" disabled={playhead < selectedLayer.startUs || playhead >= selectedLayer.endUs} onClick={() => operate(() => commit(upsertKeyframe(project, selectedLayer.id, playhead - selectedLayer.startUs, selectedLayer.transform), "已记录当前变换关键帧"))}>◇ 在播放头记录当前变换</button>
            <p className="studio-hint">修改上方变换值后点击记录，保存为此时刻的关键帧。</p><div className="studio-keyframes">{selectedLayer.keyframes.map(key => <span key={key.timeUs}><button onClick={() => { seek(selectedLayer.startUs + key.timeUs); }}>◇ {sec(key.timeUs)}s</button><button aria-label={`删除 ${sec(key.timeUs)} 秒关键帧`} onClick={() => layerPatch({ keyframes: selectedLayer.keyframes.filter(item => item.timeUs !== key.timeUs) })}><X size={12} /></button></span>)}</div>
            <div className="studio-layer-actions"><button onClick={() => operate(() => commit(moveLayer(project, selectedLayer.id, Math.max(0, project.layers.findIndex(layer => layer.id === selectedLayer.id) - 1)), "已下移图层"))}>下移一层</button><button onClick={() => operate(() => commit(moveLayer(project, selectedLayer.id, Math.min(project.layers.length - 1, project.layers.findIndex(layer => layer.id === selectedLayer.id) + 1)), "已上移图层"))}>上移一层</button></div>
            <button className="studio-danger" onClick={() => { operate(() => commit(removeLayer(project, selectedLayer.id), "已删除图层")); setSelection(null); }}><Trash size={15} />删除图层</button>
          </fieldset> : <>
            <div className="studio-property-grid"><Field label="画布宽度" value={project.canvas.width} min={96} max={1920} suffix="px" onChange={value => canvasPatch({ width: Math.round(value) })} /><Field label="画布高度" value={project.canvas.height} min={16} max={1920} suffix="px" onChange={value => canvasPatch({ height: Math.round(value) })} /><Field label="输出帧率" value={project.canvas.fps} min={1} max={60} suffix="fps" onChange={value => canvasPatch({ fps: Math.round(value) })} /><label className="studio-field"><span>背景颜色</span><input aria-label="背景颜色" type="color" value={project.canvas.background} onChange={event => canvasPatch({ background: event.target.value })} /></label></div>
            <div className="studio-ratio-presets">{[[480, 480, "1:1"], [480, 640, "3:4"], [640, 360, "16:9"]].map(([width, height, label]) => <button key={label} onClick={() => canvasPatch({ width: Number(width), height: Number(height) })}>{label}</button>)}</div>
            <label className="studio-check"><input type="checkbox" checked={project.output.loop} onChange={event => operate(() => commit(updateProject(project, { output: { ...project.output, loop: event.target.checked } }), "已修改循环播放"))} />循环播放</label>
            <div className="studio-compression-card"><span><Check size={17} weight="bold" />智能无损压缩</span><p>真实编码后比较体积，通过画面一致性验证才采用更小的结果。</p><label className="studio-check"><input type="checkbox" checked={project.output.smartLossless} onChange={event => operate(() => commit(updateProject(project, { output: { ...project.output, smartLossless: event.target.checked } }), "已修改智能压缩"))} />启用结构优化</label></div>
            <Field label="文件上限（0 为不限）" value={project.output.maxBytes ? project.output.maxBytes / 1048576 : 0} min={0} max={100} step={.1} suffix="MB" onChange={value => operate(() => commit(updateProject(project, { output: { ...project.output, maxBytes: value ? Math.round(value * 1048576) : null } }), "已修改文件上限"))} />
            <p className="studio-hint">保留画幅和动作约束；无法满足上限时会明确报错。</p>
            {native && <button className="studio-wide-button" title={outputDir} onClick={() => void selectOutputDir().then(path => { if (path) setOutputDir(path); }).catch(caught => setError(errorText(caught)))}><FolderOpen size={16} />{outputDir ? "更改导出目录" : "选择导出目录"}</button>}
            <label className="studio-field"><span>工作台外观</span><select aria-label="工作台外观" value={theme} onChange={event => { setTheme(event.target.value); try { localStorage.setItem("gifp.theme.v3", event.target.value); } catch { /* Appearance does not affect saved projects. */ } }}><option value="bubble">泡泡手账</option><option value="animal">岛屿薄荷</option><option value="handheld">掌机灰</option><option value="kid">糖果岛</option><option value="midnight">深夜护眼</option></select></label>
            <div className="studio-inspector-tip"><Scissors size={19} /><b>想精修某一帧？</b><p>底部开启「单帧模式」，可独立、删除、复制、定格当前帧，并添加仅此帧文字。</p></div>
          </>}
          {renderResult && currentResult && <div className="studio-render-report"><b>{renderResult.preview ? "预览结果" : "导出结果"} · {bytes(renderResult.bytes)}</b><span>{renderResult.width} × {renderResult.height} · {sec(renderResult.durationUs)}s</span>{renderResult.result?.structure_optimization_report && <p>{renderResult.result.structure_optimization_report.adopted ? `结构优化已采用 · 节省 ${bytes(Math.max(0, renderResult.result.structure_optimization_report.before_bytes - renderResult.result.structure_optimization_report.after_bytes))}` : "保留原编码结果"} · {renderResult.result.structure_optimization_report.verified ? "画面一致性已验证" : renderResult.result.structure_optimization_report.reason || "本次未采用结构优化"}</p>}{renderResult.result?.warnings?.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          {selectedLayer && <div className="studio-layer-toggles"><label className="studio-check"><input type="checkbox" checked={selectedLayer.visible} onChange={event => layerPatch({ visible: event.target.checked })} />显示图层</label><label className="studio-check"><input type="checkbox" checked={selectedLayer.locked} onChange={event => operate(() => commit(updateLayer(project, selectedLayer.id, { locked: event.target.checked }), "已修改图层锁定"))} />锁定图层</label></div>}
          <p className="studio-hint">快捷键：Ctrl+O 打开；Ctrl+S 保存；Ctrl+Shift+S 另存为；Ctrl+Shift+Enter 渲染预览（单帧模式渲染当前帧）；Ctrl+Enter 导出。数字属性先按 Enter 确认，再使用快捷键。</p>
        </div>
      </aside>
    </div>
    <section className="studio-timeline" aria-label="多轨时间轴">
      <div className="studio-timeline-toolbar"><div className="studio-toolbar-group"><Tool label="撤销（Ctrl+Z）" disabled={!history.past.length} onClick={() => { setHistory(undoHistory); setViewResult(false); }}><ArrowCounterClockwise size={18} /></Tool><Tool label="重做（Ctrl+Shift+Z）" disabled={!history.future.length} onClick={() => { setHistory(redoHistory); setViewResult(false); }}><ArrowClockwise size={18} /></Tool><i /><Tool label="在播放头分割" disabled={!duration} onClick={() => operate(() => commit(splitAtPlayhead(project, playhead), "已在播放头分割"))}><Scissors size={18} /><span>分割</span></Tool><Tool label="复制选中片段" disabled={!selectedClip} onClick={() => selectedClip && operate(() => commit(duplicateClip(project, selectedClip.id, layerTiming), "已复制片段"))}><Copy size={18} /></Tool><Tool label="片段向前移动" hint="仅调整主轨顺序，字幕/贴纸不随重排绑定移动" disabled={!selectedClip || project.clips[0]?.id === selectedClip.id} onClick={() => selectedClip && operate(() => commit(moveClip(project, selectedClip.id, project.clips.findIndex(clip => clip.id === selectedClip.id) - 1), "已前移片段"))}><ArrowLeft size={16} /></Tool><Tool label="片段向后移动" hint="仅调整主轨顺序，字幕/贴纸不随重排绑定移动" disabled={!selectedClip || project.clips[project.clips.length - 1]?.id === selectedClip.id} onClick={() => selectedClip && operate(() => commit(moveClip(project, selectedClip.id, project.clips.findIndex(clip => clip.id === selectedClip.id) + 1), "已后移片段"))}><ArrowRight size={16} /></Tool><i /><Tool label="添加文字" disabled={!duration} onClick={() => addText()}><TextT size={18} /><span>文字</span></Tool></div><div className="studio-toolbar-group"><label className="studio-timing-policy" title="删帧、复制、定格、修剪和变速按时段联动；锁定图层保护，重排不绑定移动"><input type="checkbox" aria-label="字幕/贴纸跟随剪辑" aria-describedby="studio-layer-timing-help" checked={layerTiming === "ripple"} onChange={event => operate(() => commit(updateProject(project, { editing: { layerTiming: event.target.checked ? "ripple" : "absolute" } }), event.target.checked ? "已开启字幕/贴纸时段联动" : "已保留字幕/贴纸的绝对时间"))} />字幕/贴纸跟随剪辑</label><button className={`studio-frame-mode ${frameMode ? "is-active" : ""}`} aria-pressed={frameMode} onClick={() => { setFrameMode(!frameMode); setPlaying(false); }}><FilmStrip size={17} />单帧模式</button><Tool label="缩小时间轴" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value / 1.5))}><MagnifyingGlassMinus size={17} /></Tool><span className="studio-zoom">{Math.round(zoom * 100)}%</span><Tool label="放大时间轴" disabled={zoom >= 8} onClick={() => setZoom(value => Math.min(8, value * 1.5))}><MagnifyingGlassPlus size={17} /></Tool></div></div>
      <p className="studio-timing-help" id="studio-layer-timing-help"><b>{layerTiming === "ripple" ? "时段联动已开启" : "图层保持原时间"}</b>{layerTiming === "ripple" ? "删帧、复制、定格同步图层；修剪和变速按片段末端的增减调整后续时段。" : "关闭时，主轨时长变化不会调整字幕或贴纸。"}锁定图层不动；片段内动画不自动拉伸，重排不绑定移动。</p>
      {frameMode && <div className="studio-frame-tools"><b>第 {frame + 1} 帧 <small>{sec(frameStart)}–{sec(frameEnd)}s</small></b><button disabled={!duration} onClick={isolate}><Scissors size={15} />独立此帧</button><button disabled={!duration} onClick={() => operate(() => commit(deleteFrame(project, playhead, layerTiming), layerTiming === "ripple" ? "已删除当前帧，未锁定字幕/贴纸已联动" : "已删除当前帧，主轨前移；图层时段保持"))}><Trash size={15} />删除此帧</button><button disabled={!duration} onClick={() => operate(() => commit(duplicateFrame(project, playhead, layerTiming), "已复制当前帧"))}><Copy size={15} />复制此帧</button><label>定格 <input aria-label="当前帧定格秒数" type="number" min={.02} max={30} step={.1} value={holdSeconds} onChange={event => setHoldSeconds(Number(event.target.value))} />s</label><button disabled={!duration || !Number.isFinite(holdSeconds) || holdSeconds <= 0} onClick={() => operate(() => commit(freezeFrame(project, playhead, Math.round(holdSeconds * US), layerTiming), "已将当前帧定格"))}>应用定格</button><button disabled={!duration} onClick={() => addText(true)}><TextT size={15} />此帧文字</button></div>}
      <div className="studio-tracks-scroll"><div className="studio-tracks" style={{ minWidth: `${zoom * 100}%` }}>
        <div className="studio-ruler-row"><span className="studio-track-name">{project.canvas.fps} FPS <small>输出时间轴</small></span><div className="studio-ruler"><div>{Array.from({ length: 9 }, (_, index) => <span key={index}>{(duration / US * index / 8).toFixed(2)}s</span>)}</div><input aria-label="播放头位置" type="range" min={0} max={Math.max(0, totalFrames - 1)} step={1} value={Math.min(frame, Math.max(0, totalFrames - 1))} disabled={!duration} onChange={event => seek(frameBoundaryUs(Number(event.target.value), project.canvas.fps))} /></div></div>
        <div className="studio-track-row"><span className="studio-track-name"><FilmStrip size={15} />主画面<small>{project.clips.length} 片段</small></span><div className="studio-track-content studio-primary-track" aria-label="主轨片段">{entries.map(entry => { const asset = project.assets.find(item => item.id === entry.clip.assetId); return <button key={entry.clip.id} aria-label={`选择片段 ${entry.index + 1} ${asset?.name}`} aria-pressed={selection?.id === entry.clip.id} title="拖动调整主轨顺序；字幕/贴纸不随重排绑定移动" draggable onDragStart={event => event.dataTransfer.setData("application/gifp-clip", entry.clip.id)} onDragOver={event => { if (event.dataTransfer.types.includes("application/gifp-clip")) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData("application/gifp-clip"); if (id) operate(() => commit(moveClip(project, id, entry.index), "已拖动排序片段")); }} onClick={() => selectClip(entry.clip, entry.startUs)} className={`studio-clip ${selection?.id === entry.clip.id ? "is-selected" : ""}`} style={{ width: `${(entry.endUs - entry.startUs) / duration * 100}%` }}>{trimHandle(entry.clip, "start")}<b>{entry.clip.holdUs ? "❚❚ " : ""}{asset?.name}</b><small>{trimPreview?.id === entry.clip.id ? `修剪 ${sec(trimPreview.duration)}` : sec(entry.endUs - entry.startUs)}s{entry.clip.reverse ? " · 倒放" : ""}{entry.clip.rate !== 1 ? ` · ${entry.clip.rate}×` : ""}</small>{trimHandle(entry.clip, "end")}</button>; })}{!duration && <span className="studio-track-empty">素材加入后会出现在这里</span>}<span className="studio-playhead" style={{ left: `${duration ? playhead / duration * 100 : 0}%` }} /></div></div>
        {project.layers.map(layer => <div className="studio-track-row studio-layer-row" key={layer.id}><button className="studio-track-name" onClick={() => setSelection({ kind: "layer", id: layer.id })}>{layer.kind === "text" ? <TextT size={15} /> : <Stack size={15} />}{layer.kind === "text" ? "文字" : "叠加"}<small>{layer.locked ? "已锁定" : layer.visible ? "可见" : "已隐藏"}</small></button><div className="studio-track-content"><button className={`studio-layer-block ${layer.kind} ${selection?.id === layer.id ? "is-selected" : ""}`} aria-label={`选择时间轴图层 ${layer.name}`} aria-pressed={selection?.id === layer.id} onClick={() => { setSelection({ kind: "layer", id: layer.id }); seek(layer.startUs); }} style={{ left: `${duration ? layer.startUs / duration * 100 : 0}%`, width: `${duration ? (layer.endUs - layer.startUs) / duration * 100 : 0}%`, opacity: layer.visible ? 1 : .45 }}><b>{layer.kind === "text" ? layer.text : layer.name}</b>{layer.keyframes.map(key => <span className="studio-keyframe-dot" key={key.timeUs} style={{ left: `${key.timeUs / (layer.endUs - layer.startUs) * 100}%` }}>◆</span>)}</button><span className="studio-playhead" style={{ left: `${duration ? playhead / duration * 100 : 0}%` }} /></div></div>)}
        {!project.layers.length && <div className="studio-track-row studio-layer-row"><span className="studio-track-name"><TextT size={15} />文字 / 叠加</span><div className="studio-track-content"><button className="studio-empty-layer" disabled={!duration} onClick={() => addText()}>＋ 添加第一句文字，或从素材库叠加贴纸</button></div></div>}
      </div></div>
    </section>
    <footer className={`studio-status ${error ? "has-error" : ""}`}><div role={error ? "alert" : "status"}><span className="studio-dot" />{error || status}</div><div>{busy === "preview" || busy === "export" ? <button onClick={() => void stopRender()}><Stop size={14} weight="fill" />停止渲染</button> : <button aria-keyshortcuts="Control+Shift+Enter" title="渲染预览 · Ctrl+Shift+Enter（单帧模式渲染当前帧）" disabled={!duration || !!busy} onClick={() => void startRender(true)}><Play size={14} />{frameMode ? "渲染当前帧" : "渲染真实预览"}</button>}{renderResult && currentResult && !renderResult.preview && native && <button onClick={() => void openDirectory(renderResult.outputPath.replace(/[\\/][^\\/]+$/, "")).catch(caught => setError(errorText(caught)))}><FolderOpen size={14} />打开成品目录</button>}<span className="studio-revision">R{project.revision}</span></div></footer>
  </section>;
}

export default ProjectStudio;
