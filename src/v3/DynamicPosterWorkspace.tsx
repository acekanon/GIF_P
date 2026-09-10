import {
  ArrowRight,
  ArrowsOutCardinal,
  Check,
  FolderOpen,
  ImageSquare,
  Layout,
  Plus,
  Sparkle,
  Stack,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DynamicPosterRequest, DynamicPosterResult } from "../tauri";
import type { MediaAsset } from "./GifpV3";
import {
  DEFAULT_POSTER_SLOTS,
  POSTER_CANVASES,
  clampPosterSlot,
  posterMotionAssets,
  posterReady,
  posterStillAssets,
  seedPosterSlots,
  type PosterCanvasPreset,
  type PosterExportMode,
  type PosterSlot,
} from "./dynamicPosterModel";
import "./dynamic-poster-workspace.css";

type Props = {
  assets: MediaAsset[];
  outputDir: string;
  busy: boolean;
  status: string;
  reducedMotion?: boolean;
  result?: DynamicPosterResult;
  onAddAssets: () => void;
  onChooseOutput: () => void;
  onGenerate: (request: DynamicPosterRequest) => void;
};

const DEFAULT_TITLE = "潜能影像介绍";
const DEFAULT_SUBTITLE = "重点信息与动态演示，放在同一张海报里";

function PosterMedia({ asset, reducedMotion }: { asset?: MediaAsset; reducedMotion?: boolean }) {
  if (!asset) return <span className="poster-empty-media"><Plus />选择动态素材</span>;
  if (asset.kind === "video" && asset.sourceUrl) {
    return <video src={asset.sourceUrl} muted loop autoPlay={!reducedMotion} playsInline />;
  }
  const src = asset.sourceUrl || asset.thumbnailUrl;
  return src ? <img src={src} alt={asset.name} /> : <span className="poster-empty-media"><ImageSquare />{asset.name}</span>;
}

export function DynamicPosterWorkspace({
  assets,
  outputDir,
  busy,
  status,
  reducedMotion,
  result,
  onAddAssets,
  onChooseOutput,
  onGenerate,
}: Props) {
  const [canvasPreset, setCanvasPreset] = useState<PosterCanvasPreset>("portrait");
  const [backgroundId, setBackgroundId] = useState("");
  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [subtitle, setSubtitle] = useState(DEFAULT_SUBTITLE);
  const [accent, setAccent] = useState<"violet" | "mint" | "coral">("violet");
  const [exportMode, setExportMode] = useState<PosterExportMode>("gif_webp");
  const [fps, setFps] = useState(15);
  const [duration, setDuration] = useState(2.5);
  const [slots, setSlots] = useState<[PosterSlot, PosterSlot]>(() => DEFAULT_POSTER_SLOTS.map((slot) => ({ ...slot })) as [PosterSlot, PosterSlot]);
  const [selectedSlot, setSelectedSlot] = useState<0 | 1>(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; slot: 0 | 1; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const motionAssets = useMemo(() => posterMotionAssets(assets), [assets]);
  const stillAssets = useMemo(() => posterStillAssets(assets), [assets]);
  const canvas = POSTER_CANVASES[canvasPreset];
  const background = assets.find((asset) => asset.id === backgroundId);
  const ready = posterReady(slots, assets);

  useEffect(() => {
    setSlots((current) => seedPosterSlots(assets, current));
    if (backgroundId && !stillAssets.some((asset) => asset.id === backgroundId)) setBackgroundId("");
  }, [assets, backgroundId, stillAssets]);

  function patchSlot(index: 0 | 1, patch: Partial<PosterSlot>) {
    setSlots((current) => {
      const next: [PosterSlot, PosterSlot] = [{ ...current[0] }, { ...current[1] }];
      next[index] = clampPosterSlot({ ...next[index], ...patch });
      return next;
    });
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, slot: 0 | 1) {
    const current = slots[slot];
    dragRef.current = { pointerId: event.pointerId, slot, startX: event.clientX, startY: event.clientY, originX: current.x, originY: current.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedSlot(slot);
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    const preview = previewRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !preview) return;
    const bounds = preview.getBoundingClientRect();
    patchSlot(drag.slot, {
      x: drag.originX + ((event.clientX - drag.startX) / Math.max(1, bounds.width)) * 100,
      y: drag.originY + ((event.clientY - drag.startY) / Math.max(1, bounds.height)) * 100,
    });
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  function generate() {
    const backgroundPath = background?.path.startsWith("demo://") ? null : background?.path || null;
    const activeSlots = slots.flatMap((slot) => {
      const asset = assets.find((item) => item.id === slot.assetId);
      if (!slot.enabled || !asset || asset.path.startsWith("demo://")) return [];
      return [{
        input_path: asset.path,
        x_percent: slot.x,
        y_percent: slot.y,
        width_percent: slot.width,
        height_percent: slot.height,
      }];
    });
    onGenerate({
      background_path: backgroundPath,
      output_dir: outputDir,
      width: canvas.width,
      height: canvas.height,
      fps,
      duration_seconds: duration,
      title: title.trim(),
      subtitle: subtitle.trim(),
      accent,
      export_mode: exportMode,
      slots: activeSlots,
    });
  }

  return (
    <main className="dynamic-poster-workspace">
      <section className="poster-preview-panel paper-panel">
        <header className="poster-workspace-heading">
          <span className="poster-heading-icon"><Layout weight="fill" /></span>
          <div><p>DYNAMIC POSTER · 5.7.18</p><h1>动态海报</h1><span>静态信息保持清楚，只让两个重点窗口动起来。</span></div>
          <b>双动态窗</b>
        </header>

        <div className="poster-stage-wrap">
          <div
            ref={previewRef}
            className={`poster-canvas accent-${accent}`}
            style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
            aria-label="动态海报预览"
          >
            {background?.sourceUrl && <img className="poster-background" src={background.sourceUrl} alt="海报底板" />}
            <div className="poster-canvas-shade" />
            <header className="poster-canvas-title"><small>GIFP · VISUAL BRIEF</small><strong>{title || "输入海报标题"}</strong><span>{subtitle || "输入一句重点说明"}</span></header>
            {slots.map((slot, index) => {
              const slotIndex = index as 0 | 1;
              if (!slot.enabled) return null;
              const asset = assets.find((item) => item.id === slot.assetId);
              return (
                <button
                  type="button"
                  key={slotIndex}
                  className={`poster-motion-window slot-${slotIndex + 1}${selectedSlot === slotIndex ? " selected" : ""}`}
                  style={{ left: `${slot.x}%`, top: `${slot.y}%`, width: `${slot.width}%`, height: `${slot.height}%` }}
                  aria-label={`${slotIndex === 0 ? "主" : "辅"}动态窗口，拖动调整位置`}
                  onPointerDown={(event) => beginDrag(event, slotIndex)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                >
                  <PosterMedia asset={asset} reducedMotion={reducedMotion} />
                  <i><ArrowsOutCardinal />{slotIndex === 0 ? "主画面" : "辅助画面"}</i>
                </button>
              );
            })}
            <footer className="poster-canvas-footer"><span>STATIC COPY</span><strong>动态范围越小，成品越轻</strong></footer>
          </div>
        </div>

        <div className="poster-preview-note"><Sparkle weight="fill" /><span><strong>局部动态策略</strong><small>静态底板不会在每帧重新变化；导出时只更新两个动态窗口。</small></span></div>
      </section>

      <aside className="poster-control-panel paper-panel">
        <section>
          <h2><span>1</span>版式与底板</h2>
          <div className="poster-option-grid three">
            {(Object.entries(POSTER_CANVASES) as Array<[PosterCanvasPreset, (typeof POSTER_CANVASES)[PosterCanvasPreset]]>).map(([id, option]) => (
              <button type="button" key={id} aria-pressed={canvasPreset === id} onClick={() => setCanvasPreset(id)}><strong>{option.label}</strong><small>{option.width} × {option.height}</small>{canvasPreset === id && <Check />}</button>
            ))}
          </div>
          <label className="poster-select-field"><span>静态底板</span><select aria-label="静态底板" value={backgroundId} onChange={(event) => setBackgroundId(event.target.value)}><option value="">内置纸张底板</option>{stillAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
          <div className="poster-accent-row" role="group" aria-label="强调色">
            {(["violet", "mint", "coral"] as const).map((color) => <button key={color} type="button" className={`accent-dot ${color}`} aria-label={`${color} 强调色`} aria-pressed={accent === color} onClick={() => setAccent(color)} />)}
          </div>
        </section>

        <section>
          <h2><span>2</span>文字信息</h2>
          <label className="poster-text-field"><span>主标题</span><input aria-label="海报主标题" maxLength={36} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="poster-text-field"><span>一句说明</span><textarea aria-label="海报说明" maxLength={72} value={subtitle} onChange={(event) => setSubtitle(event.target.value)} /></label>
        </section>

        <section>
          <h2><span>3</span>动态窗口</h2>
          <div className="poster-slot-tabs" role="tablist" aria-label="动态窗口">
            {slots.map((slot, index) => <button key={index} type="button" role="tab" aria-selected={selectedSlot === index} onClick={() => setSelectedSlot(index as 0 | 1)}>{index === 0 ? "主动态窗" : "辅动态窗"}<b>{slot.enabled ? "开启" : "关闭"}</b></button>)}
          </div>
          <div className="poster-slot-editor">
            <label className="poster-slot-switch"><input type="checkbox" checked={slots[selectedSlot].enabled} onChange={(event) => patchSlot(selectedSlot, { enabled: event.target.checked })} /><span>启用这个窗口</span></label>
            <label className="poster-select-field"><span>动态素材</span><select aria-label={`${selectedSlot === 0 ? "主" : "辅"}动态素材`} value={slots[selectedSlot].assetId} onChange={(event) => patchSlot(selectedSlot, { assetId: event.target.value })}><option value="">请选择</option>{motionAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
            <div className="poster-range-grid">
              <label><span>宽度 <output>{Math.round(slots[selectedSlot].width)}%</output></span><input aria-label="动态窗口宽度" type="range" min="18" max="92" value={slots[selectedSlot].width} onChange={(event) => patchSlot(selectedSlot, { width: Number(event.target.value) })} /></label>
              <label><span>高度 <output>{Math.round(slots[selectedSlot].height)}%</output></span><input aria-label="动态窗口高度" type="range" min="10" max="60" value={slots[selectedSlot].height} onChange={(event) => patchSlot(selectedSlot, { height: Number(event.target.value) })} /></label>
            </div>
            <small className="poster-drag-tip"><ArrowsOutCardinal />也可以直接拖动预览里的窗口。</small>
          </div>
          {!motionAssets.length && <button type="button" className="poster-add-media" onClick={onAddAssets}><Plus />添加 GIF / WebP / 视频</button>}
        </section>

        <section>
          <h2><span>4</span>交付</h2>
          <div className="poster-delivery-options">
            <button type="button" aria-pressed={exportMode === "gif_webp"} onClick={() => setExportMode("gif_webp")}><Stack /><span><strong>GIF + WebP 双料包</strong><small>上传原图，也准备轻量播放版</small></span>{exportMode === "gif_webp" && <Check />}</button>
            <button type="button" aria-pressed={exportMode === "gif"} onClick={() => setExportMode("gif")}><span><strong>仅 GIF</strong><small>最大兼容</small></span>{exportMode === "gif" && <Check />}</button>
            <button type="button" aria-pressed={exportMode === "webp"} onClick={() => setExportMode("webp")}><span><strong>仅 WebP</strong><small>体积更轻</small></span>{exportMode === "webp" && <Check />}</button>
          </div>
          <div className="poster-range-grid compact">
            <label><span>帧率 <output>{fps} FPS</output></span><input aria-label="海报帧率" type="range" min="8" max="24" value={fps} onChange={(event) => setFps(Number(event.target.value))} /></label>
            <label><span>循环长度 <output>{duration.toFixed(1)}s</output></span><input aria-label="海报循环长度" type="range" min="1" max="8" step="0.5" value={duration} onChange={(event) => setDuration(Number(event.target.value))} /></label>
          </div>
          <button type="button" className="poster-output-path" onClick={onChooseOutput}><FolderOpen /><span><strong>保存位置</strong><small>{outputDir || "跟随第一段素材"}</small></span></button>
          <button type="button" className="poster-generate" disabled={!ready || busy} onClick={generate}><span><strong>{busy ? "正在生成动态海报" : "生成动态海报"}</strong><small>{exportMode === "gif_webp" ? "一次得到两个版本" : "保持局部动态"}</small></span><ArrowRight weight="bold" /></button>
          <div className="poster-status" role="status"><span className={busy ? "working" : result ? "done" : ""} />{result ? `已生成 ${result.outputs.length} 个文件` : status}</div>
        </section>
      </aside>
    </main>
  );
}

export default DynamicPosterWorkspace;
