import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectStudio, { AssetVisual, createStudioDemo } from "./ProjectStudio";
import { PROJECT_AUTOSAVE_KEY, readProjectAutosave, writeProjectAutosave } from "./persistence";
import type { EditProject, ProjectRenderResult } from "./types";
import type { SavedEditProject } from "./native";
import { SESSION_DRAFT_KEY, type SessionDraftData } from "../../v3/sessionPersistence";

const mocks = vi.hoisted(() => ({ native: false, render: vi.fn(), cancel: vi.fn(), thumbnails: vi.fn(), save: vi.fn(), open: vi.fn(), outputDir: vi.fn() }));
vi.mock("./native", () => ({ hasProjectNative: () => mocks.native, projectMediaUrl: (path: string) => path, renderEditProject: mocks.render, saveEditProject: mocks.save, openEditProject: mocks.open }));
vi.mock("../../tauri", () => ({ cancelConversionTask: mocks.cancel, generateMediaThumbnails: mocks.thumbnails, inspectMedia: vi.fn(), openDirectory: vi.fn(), selectOutputDir: mocks.outputDir, selectVideos: vi.fn() }));

beforeEach(() => { localStorage.clear(); mocks.native = false; mocks.render.mockReset(); mocks.cancel.mockReset().mockResolvedValue(true); mocks.thumbnails.mockReset().mockResolvedValue([]); mocks.save.mockReset().mockResolvedValue(null); mocks.open.mockReset().mockResolvedValue(null); mocks.outputDir.mockReset().mockResolvedValue(null); });
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
const openDemo = () => { render(<ProjectStudio />); fireEvent.click(screen.getAllByRole("button", { name: /载入示例工程/ })[0]); };
const frameMode = () => fireEvent.click(screen.getByRole("button", { name: "单帧模式" }));
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const nativeFixture = (project = createStudioDemo()) => { mocks.native = true; writeProjectAutosave(localStorage, project); render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" })); return project; };
const renderedFixture = (project: EditProject, path = "completed.gif") => ({ projectId: project.id, revision: project.revision, outputPath: path, width: 280, height: 498, durationUs: 3_790_000, bytes: 120, preview: true } as ProjectRenderResult);
const timingFixture = (policy: "absolute" | "ripple" | "legacy" = "ripple"): EditProject => {
  const project = createStudioDemo(), base = project.layers[0];
  project.clips[0] = { ...project.clips[0], holdUs: 0 };
  if (policy === "legacy") delete project.editing; else project.editing = { layerTiming: policy };
  project.layers = [
    { ...base, id: "tail-caption", kind: "text", name: "后续字幕", text: "后续字幕", fontSize: 20, color: "#ffffff", strokeColor: "#000000", strokeWidth: 1, startUs: 2_000_000, endUs: 3_000_000 },
    { id: "locked-sticker", kind: "media", name: "锁定贴纸", assetId: "demo-photo", width: .3, startUs: 2_100_000, endUs: 3_100_000, visible: true, locked: true, transform: { ...base.transform }, keyframes: [], sourceOffsetUs: 0, sourceFrozen: false },
  ];
  return project;
};
const restoreTimingFixture = (project = timingFixture()) => { writeProjectAutosave(localStorage, project); const view = render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" })); return view; };
const selectTailCaption = () => fireEvent.click(screen.getByRole("button", { name: "选择时间轴图层 后续字幕" }));
const legacySession = () => {
  const data: SessionDraftData = { mode: "editor", assets: [{ id: "legacy-source", path: "D:/old.gif", name: "旧版剪辑.gif", kind: "gif", duration: 4, dimensions: "640 × 480", pathAvailability: { state: "unchecked" } }], activeAssetId: "legacy-source", mergePaths: [], outputDir: "D:/export", editor: {
    presetId: "perceptual", encoder: "pngquant_opt", deliveryIntent: "smart", deliveryFormatPreference: "gif", targetPlatform: "modern_web", playbackSpeed: 2, cropEnabled: true,
    crop: { left: 10, top: 0, right: 10, bottom: 0 }, loopOutput: false, width: 480, fps: 20, colors: 128, dither: "sierra2_4a", lossy: 0, optimizeLevel: 3,
    generationMode: "best_gif", targetSizeMb: 2, bayerScale: 2, alphaThreshold: 128, perceptualFocus: "auto", filter: "vivid", outputFormat: "gif", startSeconds: 1, endSeconds: 3, selectedFrameTimes: [], deletedFrameTimes: [], memeOverlay: null,
  } };
  return JSON.stringify({ version: 1, savedAt: 1, data });
};

describe("ProjectStudio", () => {
  it("saves and exports opt-in lossy compression choices with independent undo and legacy defaults", async () => {
    const project = createStudioDemo(); delete project.output.temporalStability; delete project.output.lzwSearch;
    nativeFixture(project);
    expect(screen.getByRole("switch", { name: "跨帧稳定优化" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "LZW 成本搜索" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "跨帧稳定优化" }));
    fireEvent.click(screen.getByRole("switch", { name: "LZW 成本搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.getByRole("switch", { name: "跨帧稳定优化" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "LZW 成本搜索" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "重做（Ctrl+Shift+Z）" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存工程" })));
    const output = { ...project.output, temporalStability: true, lzwSearch: true };
    expect(mocks.save.mock.calls[0][0].output).toEqual(output);
    mocks.outputDir.mockResolvedValue("D:/compression-export");
    mocks.render.mockImplementation(async request => ({ ...renderedFixture(request.project), preview: false, result: { advanced_compression_report: {
      algorithm_version: "1", status: "optimized", before_bytes: 10000, after_bytes: 8000, adopted: true, verified: true,
      reference_kind: "prequantized_source", elapsed_ms: 10, estimated_peak_bytes: 20000,
      stages: [{ method: "temporal_stability", status: "adopted", before_bytes: 10000, candidate_bytes: 8000, writer_control_bytes: 9000, algorithm_saved_bytes: 1000, adopted: true, verified: true, compression_probes: 2, changed_pixels: 12, elapsed_ms: 10 }],
    } } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "导出 GIF" })));
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ project: { output }, outputDir: "D:/compression-export", preview: false });
    expect(screen.getByLabelText("启用结构优化")).not.toBeChecked();
    const report = screen.getByRole("region", { name: "新压缩算法报告" });
    expect(within(report).getByText(/新压缩阶段已采用 · 减少 20.0%（有损）/)).toBeVisible();
    expect(within(report).getByText("画质参考：量化前画面")).toBeVisible();
  });
  it("restricts an animated sticker to the displayed frame without restarting its source clock", async () => {
    mocks.native = true;
    const project = createStudioDemo();
    const transform = { x: .2, y: .5, scale: 1, rotation: 0, opacity: 1 };
    project.layers = [{ id: "clock-overlay", kind: "media", name: "相位贴纸", assetId: "demo-motion", width: .3,
      startUs: 0, endUs: 200000, visible: true, locked: false, transform,
      keyframes: [{ timeUs: 0, transform }, { timeUs: 100000, transform: { ...transform, x: .8, scale: 1.5 } }],
      sourceTimeMap: [{ timeUs: 0, sourceUs: 25000 }, { timeUs: 100000, sourceUs: 150000 }, { timeUs: 200000, sourceUs: 300000 }],
    }];
    writeProjectAutosave(localStorage, project);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" }));
    fireEvent.click(screen.getByRole("button", { name: "选择时间轴图层 相位贴纸" }));
    fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    fireEvent.click(screen.getByRole("button", { name: "仅显示在当前帧" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存工程" })); });
    const saved = mocks.save.mock.calls[0][0] as EditProject;
    expect(saved.layers[0]).toMatchObject({ startUs: 50000, endUs: 100000, sourceOffsetUs: 87500, sourceFrozen: true, rasterScaleMax: 1.5, keyframes: [], transform: { x: .5, scale: 1.25 } });
    expect(saved.layers[0]).not.toHaveProperty("sourceTimeMap");
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.getByLabelText("结束时间")).toHaveValue(.2);
  });
  it("isolates a real output frame, edits only its crop, and undoes the edit", () => {
    openDemo();
    fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    expect(screen.getByTestId("frame-count")).toHaveTextContent("帧 2 / 76");
    frameMode(); fireEvent.click(screen.getByRole("button", { name: "独立此帧" }));
    expect(within(screen.getByLabelText("主轨片段")).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByText(/片段时长 0.050 秒/)).toBeVisible();
    const crop = screen.getByLabelText("裁剪左侧"); fireEvent.change(crop, { target: { value: "10" } }); fireEvent.blur(crop);
    expect(screen.getByLabelText("裁剪左侧")).toHaveValue(10);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.getByLabelText("裁剪左侧")).toHaveValue(0);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(within(screen.getByLabelText("主轨片段")).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "重做（Ctrl+Shift+Z）" }));
    expect(within(screen.getByLabelText("主轨片段")).getAllByRole("button")).toHaveLength(4);
  });

  it("creates frame-only text and sticker ranges and restores them through history", () => {
    openDemo(); frameMode(); fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    fireEvent.click(screen.getByRole("button", { name: "此帧文字" }));
    expect(screen.getByLabelText("出现时间")).toHaveValue(.05);
    expect(screen.getByLabelText("结束时间")).toHaveValue(.1);
    fireEvent.change(screen.getByLabelText("字幕内容"), { target: { value: "只在第二帧" } });
    expect(screen.getByLabelText("字幕内容")).toHaveValue("只在第二帧");
    fireEvent.click(screen.getAllByRole("button", { name: "此帧贴纸" })[0]);
    expect(screen.getByLabelText("出现时间")).toHaveValue(.05);
    expect(screen.getByLabelText("结束时间")).toHaveValue(.1);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.queryByRole("heading", { name: "叠加属性" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重做（Ctrl+Shift+Z）" }));
    expect(screen.getByRole("heading", { name: "叠加属性" })).toBeVisible();
  });

  it("deletes, duplicates and holds a frame with visible frame counts", () => {
    openDemo(); frameMode();
    fireEvent.click(screen.getByRole("button", { name: "删除此帧" }));
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 75");
    fireEvent.click(screen.getByRole("button", { name: "复制此帧" }));
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 76");
    fireEvent.click(screen.getByRole("button", { name: "应用定格" }));
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 85");
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 76");
  });

  it("plays integer microsecond positions and flushes the last edit on exit", () => {
    vi.useFakeTimers();
    openDemo();
    fireEvent.click(screen.getByRole("button", { name: "播放（空格）" }));
    act(() => vi.advanceTimersByTime(174));
    expect(screen.getByTestId("frame-count")).not.toHaveTextContent("帧 1 /");
    fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "最后一笔" } });
    cleanup();
    const saved = readProjectAutosave(localStorage);
    expect(saved.status).toBe("ready");
    if (saved.status === "ready") expect(saved.project.name).toBe("最后一笔");
  });

  it("protects pending recovery and does not pretend browser export succeeded", () => {
    writeProjectAutosave(localStorage, createStudioDemo());
    const original = localStorage.getItem(PROJECT_AUTOSAVE_KEY);
    render(<ProjectStudio />); cleanup();
    expect(localStorage.getItem(PROJECT_AUTOSAVE_KEY)).toBe(original);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" }));
    fireEvent.click(screen.getByRole("button", { name: "导出 GIF" }));
    expect(mocks.render).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("浏览器演示不会生成成品");
  });

  it("discards native render results if the project changed during encoding", async () => {
    mocks.native = true;
    let finish!: (value: ProjectRenderResult) => void;
    mocks.render.mockImplementation(() => new Promise<ProjectRenderResult>(resolve => { finish = resolve; }));
    const demo = createStudioDemo(); writeProjectAutosave(localStorage, demo);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" }));
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.render.mock.calls[0][0].project).not.toBe(demo);
    fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "更新后的工程" } });
    await act(async () => finish({ projectId: demo.id, revision: demo.revision, outputPath: "stale.gif", bytes: 100, preview: true } as ProjectRenderResult));
    expect(screen.getByRole("status")).toHaveTextContent("工程已更改");
    expect(screen.queryByAltText("实际渲染的 GIF 成品")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成品" })).toBeDisabled();
  });

  it("an old canceled request cannot clear the next running render", async () => {
    mocks.native = true;
    const pending: Array<(value: ProjectRenderResult) => void> = [];
    mocks.render.mockImplementation(() => new Promise<ProjectRenderResult>(resolve => pending.push(resolve)));
    const demo = createStudioDemo(); writeProjectAutosave(localStorage, demo);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" }));
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止渲染" })));
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    await act(async () => pending[0]({ projectId: demo.id, revision: demo.revision, outputPath: "old.gif", bytes: 100, preview: true } as ProjectRenderResult));
    expect(screen.getByRole("button", { name: "停止渲染" })).toBeEnabled();
    await act(async () => pending[1]({ projectId: demo.id, revision: demo.revision, outputPath: "new.gif", bytes: 120, preview: true } as ProjectRenderResult));
    expect(screen.getByAltText("实际渲染的 GIF 成品")).toHaveAttribute("src", "new.gif");
  });

  it("renders the selected output frame and invalidates it when stepping", async () => {
    mocks.native = true;
    const demo = createStudioDemo(); writeProjectAutosave(localStorage, demo);
    mocks.render.mockImplementation(async request => ({ projectId: request.project.id, revision: request.project.revision, outputPath: "frame-2.gif", width: 280, height: 498, durationUs: 50_000, bytes: 120, preview: true }));
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" })); frameMode();
    fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "渲染当前帧" })));
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ preview: true, previewFrameUs: 50_000 });
    expect(screen.getByAltText("精确合成的当前帧")).toHaveAttribute("src", "frame-2.gif");
    expect(screen.getByText("精确合成 · 第 2 帧")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    expect(screen.queryByAltText("精确合成的当前帧")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "成品" })).toBeDisabled();
  });

  it("does not accept an in-flight frame result after the playhead moved", async () => {
    mocks.native = true;
    let finish!: (value: ProjectRenderResult) => void;
    mocks.render.mockImplementation(() => new Promise<ProjectRenderResult>(resolve => { finish = resolve; }));
    const demo = createStudioDemo(); writeProjectAutosave(localStorage, demo);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "恢复工程" })); frameMode();
    fireEvent.click(screen.getByRole("button", { name: "渲染当前帧" }));
    fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    await act(async () => finish({ projectId: demo.id, revision: demo.revision, outputPath: "wrong-frame.gif", bytes: 100, preview: true } as ProjectRenderResult));
    expect(screen.getByRole("status")).toHaveTextContent("播放头已移到另一帧");
    expect(screen.queryByAltText("精确合成的当前帧")).not.toBeInTheDocument();
  });

  it("keeps the canvas valid when the project is shortened before its old playhead", () => {
    openDemo();
    fireEvent.click(screen.getByRole("button", { name: /选择片段 2/ }));
    fireEvent.change(screen.getByLabelText("播放头位置"), { target: { value: "75" } });
    const speed = screen.getByLabelText("播放速度");
    fireEvent.change(speed, { target: { value: "8" } }); fireEvent.blur(speed);
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 45");
    expect(screen.getByTestId("studio-canvas")).toBeVisible();
  });

  it("samples animated source references without starving or overlapping requests", async () => {
    vi.useFakeTimers();
    let finish!: (frames: Array<{ path: string; time: number }>) => void;
    mocks.thumbnails.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const asset = createStudioDemo().assets[1];
    const view = render(<AssetVisual asset={asset} sourceUs={0} native />);
    await act(async () => vi.advanceTimersByTime(0));
    expect(mocks.thumbnails).toHaveBeenCalledTimes(1);
    view.rerender(<AssetVisual asset={asset} sourceUs={50_000} native />);
    view.rerender(<AssetVisual asset={asset} sourceUs={100_000} native />);
    await act(async () => vi.advanceTimersByTime(200));
    expect(mocks.thumbnails).toHaveBeenCalledTimes(1);
    await act(async () => finish([{ path: "source-reference-0.png", time: 0 }]));
    expect(screen.getByAltText(asset.name)).toHaveAttribute("src", "source-reference-0.png");
    await act(async () => vi.advanceTimersByTime(125));
    expect(mocks.thumbnails).toHaveBeenCalledTimes(2);
    expect(mocks.thumbnails.mock.calls[1][0].times).toEqual([.1]);
  });

  it("explicitly imports a valid old edit and displays migration warnings", () => {
    const original = legacySession(); localStorage.setItem(SESSION_DRAFT_KEY, original);
    render(<ProjectStudio />);
    expect(screen.getByRole("button", { name: "导入旧版编辑" })).toBeVisible();
    expect(within(screen.getByLabelText("主轨片段")).queryAllByRole("button")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "导入旧版编辑" }));
    expect(screen.getByLabelText("工程名称")).toHaveValue("旧版剪辑");
    expect(screen.getByTestId("frame-count")).toHaveTextContent("/ 20");
    expect(screen.getByRole("note", { name: "旧版编辑迁移说明" })).toHaveTextContent("旧滤镜尚未转成工程效果");
    cleanup();
    expect(readProjectAutosave(localStorage).status).toBe("ready");
    expect(localStorage.getItem(SESSION_DRAFT_KEY)).toBe(original);
  });

  it("preserves old storage while migration is pending and prioritizes v6 recovery", () => {
    vi.useFakeTimers();
    const original = legacySession(); localStorage.setItem(SESSION_DRAFT_KEY, original);
    render(<ProjectStudio />);
    act(() => vi.advanceTimersByTime(1000)); cleanup();
    expect(localStorage.getItem(PROJECT_AUTOSAVE_KEY)).toBeNull();
    expect(localStorage.getItem(SESSION_DRAFT_KEY)).toBe(original);
    render(<ProjectStudio />); fireEvent.click(screen.getByRole("button", { name: "开始新工程" }));
    act(() => vi.advanceTimersByTime(501)); cleanup();
    expect(readProjectAutosave(localStorage).status).toBe("ready");
    expect(localStorage.getItem(SESSION_DRAFT_KEY)).toBe(original);
    writeProjectAutosave(localStorage, createStudioDemo());
    const savedV6 = localStorage.getItem(PROJECT_AUTOSAVE_KEY);
    render(<ProjectStudio />);
    expect(screen.getByRole("button", { name: "恢复工程" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "导入旧版编辑" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1000)); cleanup();
    expect(localStorage.getItem(PROJECT_AUTOSAVE_KEY)).toBe(savedV6);
    expect(localStorage.getItem(SESSION_DRAFT_KEY)).toBe(original);
  });

  it.each(["refused", "failed"])("keeps awaiting render completion after a %s cancellation", async outcome => {
    const pending = deferred<ProjectRenderResult>(); mocks.render.mockReturnValue(pending.promise);
    if (outcome === "refused") mocks.cancel.mockResolvedValue(false); else mocks.cancel.mockRejectedValue(new Error("transport failed"));
    const project = nativeFixture();
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止渲染" })));
    expect(screen.getByRole("button", { name: "停止渲染" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出 GIF" })).toBeDisabled();
    await act(async () => pending.resolve(renderedFixture(project)));
    expect(screen.getByAltText("实际渲染的 GIF 成品")).toHaveAttribute("src", "completed.gif");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("完成");
  });

  it.each([true, false])("does not replace completed render state with a late cancellation result (%s)", async canceled => {
    const pending = deferred<ProjectRenderResult>(), cancellation = deferred<boolean>();
    mocks.render.mockReturnValue(pending.promise); mocks.cancel.mockReturnValue(cancellation.promise);
    const project = nativeFixture();
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    fireEvent.click(screen.getByRole("button", { name: "停止渲染" }));
    await act(async () => pending.resolve(renderedFixture(project)));
    const status = screen.getByRole("status").textContent;
    await act(async () => cancellation.resolve(canceled));
    expect(screen.getByRole("status").textContent).toBe(status);
    expect(screen.getByAltText("实际渲染的 GIF 成品")).toHaveAttribute("src", "completed.gif");
  });

  it("does not adopt a stale saved path after another project was opened", async () => {
    const saving = deferred<SavedEditProject | null>(); mocks.save.mockReturnValueOnce(saving.promise);
    const first = nativeFixture();
    fireEvent.click(screen.getByRole("button", { name: "保存工程" }));
    const second = { ...createStudioDemo(), name: "工程 B" };
    mocks.open.mockResolvedValue({ path: "D:/B.gifp-project.json", project: second });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开工程" })));
    await act(async () => saving.resolve({ path: "D:/A.gifp-project.json", project: first }));
    expect(screen.getByLabelText("工程名称")).toHaveValue("工程 B");
    expect(screen.getByRole("status")).toHaveTextContent("已打开工程");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存工程" })));
    expect(mocks.save.mock.calls[1][0].id).toBe(second.id);
    expect(mocks.save.mock.calls[1][1]).toBe("D:/B.gifp-project.json");
  });

  it("keeps new edits dirty when an earlier save snapshot finishes", async () => {
    const saving = deferred<SavedEditProject | null>(); mocks.save.mockReturnValueOnce(saving.promise);
    const project = nativeFixture(); fireEvent.click(screen.getByRole("button", { name: "保存工程" }));
    fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "尚未保存的新编辑" } });
    await act(async () => saving.resolve({ path: "D:/snapshot.gifp-project.json", project }));
    expect(screen.getByLabelText("工程名称")).toHaveValue("尚未保存的新编辑");
    expect(screen.getByRole("status")).toHaveTextContent("当前新增编辑仍需保存");
    expect(mocks.save.mock.calls[0][0].name).toBe(project.name);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存工程" })));
    expect(mocks.save.mock.calls[1][1]).toBe("D:/snapshot.gifp-project.json");
    expect(mocks.save.mock.calls[1][0].name).toBe("尚未保存的新编辑");
  });

  it("does not apply a late opened project over intervening edits", async () => {
    const opening = deferred<SavedEditProject | null>(); mocks.open.mockReturnValue(opening.promise);
    nativeFixture(); fireEvent.click(screen.getByRole("button", { name: "打开工程" }));
    fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "保留这些编辑" } });
    await act(async () => opening.resolve({ path: "D:/other.gifp-project.json", project: createStudioDemo() }));
    expect(screen.getByLabelText("工程名称")).toHaveValue("保留这些编辑");
    expect(screen.getByRole("status")).toHaveTextContent("本次未替换当前工程");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存工程" })));
    expect(mocks.save.mock.calls[0][1]).toBeUndefined();
  });

  it("rejects an old render after reopening different contents with the same ID and revision", async () => {
    const opening = deferred<SavedEditProject | null>(), rendering = deferred<ProjectRenderResult>();
    mocks.open.mockReturnValue(opening.promise); mocks.render.mockReturnValue(rendering.promise);
    const project = nativeFixture();
    fireEvent.click(screen.getByRole("button", { name: "打开工程" }));
    fireEvent.click(screen.getByRole("button", { name: "渲染真实预览" }));
    await act(async () => opening.resolve({ path: "D:/replacement.gifp-project.json", project: { ...project, name: "相同编号的替换工程", canvas: { ...project.canvas, width: 560 } } }));
    await act(async () => rendering.resolve(renderedFixture(project, "old-session.gif")));
    expect(screen.getByLabelText("工程名称")).toHaveValue("相同编号的替换工程");
    expect(screen.queryByAltText("实际渲染的 GIF 成品")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("渲染期间工程已更改");
  });

  it("routes open and precise-frame preview shortcuts through existing native actions", async () => {
    const project = nativeFixture();
    const open = new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(open); });
    expect(open.defaultPrevented).toBe(true);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "打开工程" })).toHaveAttribute("aria-keyshortcuts", "Control+O");
    frameMode(); fireEvent.click(screen.getByRole("button", { name: "下一帧（→）" }));
    mocks.render.mockResolvedValue(renderedFixture(project, "keyboard-frame.gif"));
    await act(async () => fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true }));
    expect(mocks.render).toHaveBeenCalledTimes(1);
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ preview: true, previewFrameUs: 50_000 });
    expect(screen.getByAltText("精确合成的当前帧")).toHaveAttribute("src", "keyboard-frame.gif");
    expect(screen.getByRole("button", { name: "渲染当前帧" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Enter");
  });

  it("routes save, save-as and export shortcuts with the current project path", async () => {
    const project = nativeFixture();
    mocks.open.mockResolvedValue({ path: "D:/keyboard.gifp-project.json", project });
    await act(async () => fireEvent.keyDown(window, { key: "o", ctrlKey: true }));
    await act(async () => fireEvent.keyDown(window, { key: "s", ctrlKey: true }));
    expect(mocks.save.mock.calls[0][1]).toBe("D:/keyboard.gifp-project.json");
    await act(async () => fireEvent.keyDown(window, { key: "s", ctrlKey: true, shiftKey: true }));
    expect(mocks.save.mock.calls[1][1]).toBeUndefined();
    mocks.outputDir.mockResolvedValue("D:/keyboard-export");
    mocks.render.mockResolvedValue({ ...renderedFixture(project), preview: false });
    await act(async () => fireEvent.keyDown(window, { key: "Enter", ctrlKey: true }));
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ preview: false, outputDir: "D:/keyboard-export" });
    expect(screen.getByRole("button", { name: "导出 GIF" })).toHaveAttribute("aria-keyshortcuts", "Control+Enter");
  });

  it("requires numeric draft confirmation before save shortcuts and preserves text undo", async () => {
    nativeFixture();
    const width = screen.getByLabelText("画布宽度");
    act(() => width.focus()); fireEvent.change(width, { target: { value: "560" } });
    await act(async () => fireEvent.keyDown(width, { key: "s", ctrlKey: true }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("请先按 Enter 确认");
    fireEvent.keyDown(width, { key: "Enter" });
    await act(async () => fireEvent.keyDown(window, { key: "s", ctrlKey: true }));
    expect(mocks.save.mock.calls[0][0].canvas.width).toBe(560);
    const name = screen.getByLabelText("工程名称"); act(() => name.focus());
    const undo = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { name.dispatchEvent(undo); });
    expect(undo.defaultPrevented).toBe(false);
    expect(screen.getByLabelText("画布宽度")).toHaveValue(560);
  });

  it.each(["ripple", "absolute", "legacy"] as const)("applies %s frame timing while protecting locked layers and undo", policy => {
    restoreTimingFixture(timingFixture(policy));
    expect(screen.getByRole("checkbox", { name: "字幕/贴纸跟随剪辑" })).toHaveProperty("checked", policy === "ripple");
    frameMode(); fireEvent.click(screen.getByRole("button", { name: "删除此帧" }));
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(policy === "ripple" ? 1.95 : 2);
    fireEvent.click(screen.getByRole("button", { name: "选择时间轴图层 锁定贴纸" }));
    expect(screen.getByLabelText("出现时间")).toHaveValue(2.1);
    expect(screen.getByLabelText("结束时间")).toHaveValue(3.1);
    expect(screen.getByLabelText("出现时间")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(2);
  });

  it("stores the follow-editing switch in project history", () => {
    restoreTimingFixture();
    const policy = screen.getByRole("checkbox", { name: "字幕/贴纸跟随剪辑" });
    expect(policy).toBeChecked(); fireEvent.click(policy); expect(policy).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" })); expect(policy).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "重做（Ctrl+Shift+Z）" })); expect(policy).not.toBeChecked();
    expect(screen.getByRole("button", { name: "片段向后移动" })).toHaveAttribute("title", expect.stringContaining("不随重排绑定移动"));
  });

  it.each([
    { name: "复制此帧", expected: 2.05 },
    { name: "应用定格", expected: 2.45 },
    { name: "复制选中片段", expected: 4 },
    { name: "删除片段", expected: 0 },
    { name: "往返播放 · 追加倒放副本", expected: 4 },
  ])("links $name to following subtitles in one undo action", ({ name, expected }) => {
    restoreTimingFixture();
    fireEvent.click(screen.getByRole("button", { name: /选择片段 1/ })); frameMode();
    fireEvent.click(screen.getByRole("button", { name }));
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(expected);
    fireEvent.click(screen.getByRole("button", { name: "选择时间轴图层 锁定贴纸" }));
    expect(screen.getByLabelText("出现时间")).toHaveValue(2.1);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(2);
    expect(within(screen.getByLabelText("主轨片段")).getAllByRole("button")).toHaveLength(2);
  });

  it.each([
    { name: "播放速度", value: "2", expected: 1 },
    { name: "源出点", value: "1.5", expected: 1.5 },
    { name: "源入点", value: ".5", expected: 1.5 },
    { name: "定格时长", value: "3", expected: 3 },
  ])("links the $name property change with a single history entry", ({ name, value, expected }) => {
    restoreTimingFixture(); fireEvent.click(screen.getByRole("button", { name: /选择片段 1/ }));
    const field = screen.getByLabelText(name); fireEvent.change(field, { target: { value } }); fireEvent.blur(field);
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(expected);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.getByLabelText("出现时间")).toHaveValue(2);
  });

  it("uses the follow-editing policy for a frame-aligned edge trim", () => {
    const view = restoreTimingFixture();
    const track = screen.getByLabelText("主轨片段");
    track.getBoundingClientRect = vi.fn(() => ({ width: 758 } as DOMRect));
    const grip = view.container.querySelector<HTMLSpanElement>(".studio-clip .studio-clip-grip:last-child")!;
    grip.setPointerCapture = vi.fn();
    fireEvent(grip, new MouseEvent("pointerdown", { bubbles: true, clientX: 200 }));
    fireEvent(grip, new MouseEvent("pointermove", { bubbles: true, clientX: 100 }));
    expect(screen.getByText("修剪 1.500s")).toBeVisible();
    fireEvent(grip, new MouseEvent("pointerup", { bubbles: true, clientX: 100 }));
    selectTailCaption(); expect(screen.getByLabelText("出现时间")).toHaveValue(1.5);
    fireEvent.click(screen.getByRole("button", { name: "撤销（Ctrl+Z）" }));
    expect(screen.getByLabelText("出现时间")).toHaveValue(2);
  });

  it("saves and reopens timing policy plus retimed animated source fields", async () => {
    const project = timingFixture(), transform = { ...project.layers[0].transform };
    project.layers = [{ id: "animated-overlay", kind: "media", name: "动态贴纸", assetId: "demo-motion", width: .3, startUs: 0, endUs: 1_000_000, visible: true, locked: false, transform, keyframes: [], sourceOffsetUs: 125_000, sourceFrozen: false }];
    nativeFixture(project); frameMode(); fireEvent.click(screen.getByRole("button", { name: "应用定格" }));
    let saved!: EditProject;
    mocks.save.mockImplementation(async current => { saved = current; return { path: "D:/retimed.gifp-project.json", project: current }; });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存工程" })));
    expect(saved.editing?.layerTiming).toBe("ripple");
    const media = saved.layers.filter(layer => layer.kind === "media");
    expect(media).toEqual(expect.arrayContaining([
      expect.objectContaining({ startUs: 0, endUs: 500_000, sourceOffsetUs: 125_000, sourceFrozen: true }),
      expect.objectContaining({ startUs: 500_000, sourceOffsetUs: 175_000, sourceFrozen: false }),
    ]));
    fireEvent.click(screen.getByRole("checkbox", { name: "字幕/贴纸跟随剪辑" }));
    mocks.open.mockResolvedValue({ path: "D:/retimed.gifp-project.json", project: saved });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开工程" })));
    expect(screen.getByRole("checkbox", { name: "字幕/贴纸跟随剪辑" })).toBeChecked();
    mocks.render.mockImplementation(async request => renderedFixture(request.project));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "渲染当前帧" })));
    expect(mocks.render.mock.calls[0][0].project.layers).toEqual(saved.layers);
  });
});
