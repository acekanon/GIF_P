import {
  ArrowRight,
  ArrowsOutCardinal,
  Check,
  Eraser,
  ImageSquare,
  Sparkle,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextT,
} from "@phosphor-icons/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { MediaAsset } from "./GifpV3";
import { AnimatedMediaPlayer } from "./AnimatedMediaPlayer";
import "./meme-workspace.css";

export type MemeTextStyle =
  | "classic"
  | "panel"
  | "bubble"
  | "highlight"
  | "blackbar"
  | "cinema"
  | "news";
export type MemeAlignment = "left" | "center" | "right";
export type MemePlacement = "split" | "center" | "lower" | "free";
export type MemeTextPosition = { x: number; y: number };

export type MemeMediaAsset = Pick<
  MediaAsset,
  "id" | "name" | "kind" | "sourceUrl" | "thumbnailUrl" | "dimensions" | "duration"
>;

export type MemeTemplateId =
  | "classic"
  | "blackbar"
  | "subtitle"
  | "dialogue"
  | "cinema"
  | "poster"
  | "news"
  | "barrage"
  | "minimal";

export type MemeOverlaySettings = {
  sourceAssetId?: string;
  templateId: MemeTemplateId;
  topText: string;
  bottomText: string;
  style: MemeTextStyle;
  fontSize: number;
  textAlign: MemeAlignment;
  position: MemePlacement;
  topPosition: MemeTextPosition;
  bottomPosition: MemeTextPosition;
  startSeconds?: number;
  endSeconds?: number;
  source?: "meme" | "frame_annotation";
};

/** @deprecated Use MemeOverlaySettings for the encoder-facing payload. */
export type MemeDraft = MemeOverlaySettings;

type MemeTemplate = Omit<MemeOverlaySettings, "sourceAssetId"> & {
  name: string;
  note: string;
  glyph: string;
};

export type MemeWorkspaceProps = {
  draftId?: string;
  collectionBar?: ReactNode;
  collectionFooter?: ReactNode;
  outputControls?: ReactNode;
  readOnly?: boolean;
  asset?: MemeMediaAsset;
  crop?: { left: number; top: number; right: number; bottom: number };
  onApply: (settings: MemeOverlaySettings) => void;
  onQuickExport?: (settings: MemeOverlaySettings) => void;
  value?: MemeOverlaySettings;
  defaultValue?: MemeOverlaySettings;
  onDraftChange?: (settings: MemeOverlaySettings) => void;
  playerStageOnly?: boolean;
  reducedMotion?: boolean;
  className?: string;
};

export const MEME_TEMPLATES: readonly MemeTemplate[] = [
  {
    templateId: "classic",
    name: "经典上下白字",
    note: "大字描边，适合反转梗",
    glyph: "A / Z",
    topText: "当我说只改一个参数",
    bottomText: "然后重做了整个项目",
    style: "classic",
    fontSize: 44,
    textAlign: "center",
    position: "split",
    topPosition: { x: 50, y: 12 },
    bottomPosition: { x: 50, y: 88 },
  },
  {
    templateId: "blackbar",
    name: "黑框底字",
    note: "参考图同款，黑底白字",
    glyph: "黑 / 白",
    topText: "",
    bottomText: "可爱！真的！",
    style: "blackbar",
    fontSize: 42,
    textAlign: "center",
    position: "lower",
    topPosition: { x: 50, y: 20 },
    bottomPosition: { x: 50, y: 92 },
  },
  {
    templateId: "subtitle",
    name: "底部字幕",
    note: "对白清楚，不挡主体",
    glyph: "…",
    topText: "",
    bottomText: "事情开始变得有趣了",
    style: "panel",
    fontSize: 30,
    textAlign: "center",
    position: "lower",
    topPosition: { x: 50, y: 20 },
    bottomPosition: { x: 50, y: 88 },
  },
  {
    templateId: "dialogue",
    name: "双行对白",
    note: "问答节奏，一眼看懂",
    glyph: "Q A",
    topText: "老板：今天能发吗？",
    bottomText: "我：马上（刚新建文件夹）",
    style: "bubble",
    fontSize: 30,
    textAlign: "left",
    position: "split",
    topPosition: { x: 10, y: 24 },
    bottomPosition: { x: 10, y: 76 },
  },
  {
    templateId: "cinema",
    name: "电影黑边",
    note: "上下留黑，适合对白",
    glyph: "16 : 9",
    topText: "你以为这就结束了？",
    bottomText: "不，这才刚刚开始",
    style: "cinema",
    fontSize: 29,
    textAlign: "center",
    position: "split",
    topPosition: { x: 50, y: 8 },
    bottomPosition: { x: 50, y: 92 },
  },
  {
    templateId: "poster",
    name: "白边海报",
    note: "留白更精致，适合金句",
    glyph: "▣",
    topText: "今日限定",
    bottomText: "拒绝无效内耗",
    style: "panel",
    fontSize: 36,
    textAlign: "center",
    position: "split",
    topPosition: { x: 50, y: 18 },
    bottomPosition: { x: 50, y: 82 },
  },
  {
    templateId: "news",
    name: "热搜标题",
    note: "白条醒目，适合新鲜事",
    glyph: "热 搜",
    topText: "",
    bottomText: "刚刚，需求又加了一个",
    style: "news",
    fontSize: 28,
    textAlign: "left",
    position: "lower",
    topPosition: { x: 7, y: 20 },
    bottomPosition: { x: 7, y: 89 },
  },
  {
    templateId: "barrage",
    name: "弹幕 / 吐槽",
    note: "高亮观点，适合槽点",
    glyph: "!!!",
    topText: "等等，这合理吗？",
    bottomText: "→ 重点完全不在这里",
    style: "highlight",
    fontSize: 29,
    textAlign: "left",
    position: "split",
    topPosition: { x: 8, y: 24 },
    bottomPosition: { x: 8, y: 72 },
  },
  {
    templateId: "minimal",
    name: "极简反应",
    note: "一个词，保留表情空间",
    glyph: "。",
    topText: "",
    bottomText: "懂了。",
    style: "classic",
    fontSize: 50,
    textAlign: "center",
    position: "center",
    topPosition: { x: 50, y: 43 },
    bottomPosition: { x: 50, y: 52 },
  },
] as const;

const TEXT_STYLES: ReadonlyArray<{ id: MemeTextStyle; label: string; note: string }> = [
  { id: "classic", label: "经典白字", note: "黑描边" },
  { id: "panel", label: "白底黑字", note: "字幕板" },
  { id: "bubble", label: "对白卡片", note: "轻圆角" },
  { id: "highlight", label: "重点高亮", note: "矩形荧光底" },
  { id: "blackbar", label: "黑框白字", note: "参考图同款" },
  { id: "cinema", label: "电影字幕", note: "上下黑边" },
  { id: "news", label: "热搜标题", note: "白条红标" },
];

const PLACEMENTS: ReadonlyArray<{
  id: Exclude<MemePlacement, "free">;
  label: string;
  topPosition: MemeTextPosition;
  bottomPosition: MemeTextPosition;
}> = [
  { id: "split", label: "上下构图", topPosition: { x: 50, y: 12 }, bottomPosition: { x: 50, y: 88 } },
  { id: "center", label: "居中反应", topPosition: { x: 50, y: 43 }, bottomPosition: { x: 50, y: 57 } },
  { id: "lower", label: "底部字幕", topPosition: { x: 50, y: 78 }, bottomPosition: { x: 50, y: 90 } },
];

type CaptionSlot = "top" | "bottom";

export function clampMemeCoordinate(value: number) {
  return Math.min(96, Math.max(4, value));
}

export function memePointFromClient(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  clientX: number,
  clientY: number,
): MemeTextPosition {
  if (rect.width <= 0 || rect.height <= 0) return { x: 50, y: 50 };
  return {
    x: clampMemeCoordinate(((clientX - rect.left) / rect.width) * 100),
    y: clampMemeCoordinate(((clientY - rect.top) / rect.height) * 100),
  };
}

export function settingsFromTemplate(template: MemeTemplate): MemeOverlaySettings {
  const { name: _name, note: _note, glyph: _glyph, ...draft } = template;
  return draft;
}

function hasCustomizedCopy(settings: MemeOverlaySettings) {
  const template = MEME_TEMPLATES.find((candidate) => candidate.templateId === settings.templateId);
  return !template || settings.topText !== template.topText || settings.bottomText !== template.bottomText;
}

function getAssetKindLabel(asset: MemeMediaAsset) {
  if (asset.kind === "video") return "视频";
  if (asset.kind === "image") return "图片";
  return asset.kind.toUpperCase();
}

export function parseMemeMediaDimensions(value?: string) {
  const match = value?.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function fitMemePreviewBox(
  container: { width: number; height: number },
  media: { width: number; height: number },
) {
  if (container.width <= 0 || container.height <= 0 || media.width <= 0 || media.height <= 0) {
    return null;
  }
  const scale = Math.min(container.width / media.width, container.height / media.height);
  return {
    width: Math.max(1, Math.round(media.width * scale)),
    height: Math.max(1, Math.round(media.height * scale)),
  };
}

export function MemeWorkspace({
  asset,
  crop,
  onApply,
  onQuickExport,
  value,
  defaultValue,
  onDraftChange,
  playerStageOnly = true,
  reducedMotion,
  className = "",
  collectionBar,
  collectionFooter,
  outputControls,
  readOnly = false,
  draftId,
}: MemeWorkspaceProps) {
  const initialDraft = value ?? defaultValue ?? settingsFromTemplate(MEME_TEMPLATES[0]);
  const [internalDraft, setInternalDraft] = useState<MemeOverlaySettings>(
    () => initialDraft,
  );
  const [copyEdited, setCopyEdited] = useState(() => hasCustomizedCopy(initialDraft));
  const previewRef = useRef<HTMLDivElement>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    slot: CaptionSlot;
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [draggingCaption, setDraggingCaption] = useState<CaptionSlot | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [previewSurface, setPreviewSurface] = useState<"canvas" | "chat_light" | "chat_dark">("canvas");
  const draft = value ?? internalDraft;
  useEffect(() => {
    setCopyEdited(hasCustomizedCopy(draft));
    dragRef.current = null;
    setDraggingCaption(null);
  }, [draftId]);
  const selectedTemplate = useMemo(
    () => MEME_TEMPLATES.find((template) => template.templateId === draft.templateId) ?? MEME_TEMPLATES[0],
    [draft.templateId],
  );

  function updateDraft(next: MemeOverlaySettings) {
    if (readOnly) return;
    if (value === undefined) setInternalDraft(next);
    onDraftChange?.(next);
  }

  function applyTemplate(template: MemeTemplate) {
    const templateSettings = settingsFromTemplate(template);
    updateDraft({
      ...draft,
      ...templateSettings,
      ...(copyEdited ? { topText: draft.topText, bottomText: draft.bottomText } : {}),
    });
  }

  function patchDraft(patch: Partial<MemeOverlaySettings>) {
    updateDraft({ ...draft, ...patch });
  }

  function patchCopy(patch: Pick<Partial<MemeOverlaySettings>, "topText" | "bottomText">) {
    setCopyEdited(true);
    patchDraft(patch);
  }

  function pointForSlot(slot: CaptionSlot) {
    return slot === "top" ? draft.topPosition : draft.bottomPosition;
  }

  function patchCaptionPosition(slot: CaptionSlot, point: MemeTextPosition) {
    patchDraft({
      position: "free",
      ...(slot === "top" ? { topPosition: point } : { bottomPosition: point }),
    });
  }

  function startCaptionDrag(slot: CaptionSlot, event: ReactPointerEvent<HTMLParagraphElement>) {
    if (readOnly) return;
    if (event.button !== 0) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const point = pointForSlot(slot);
    dragRef.current = {
      slot,
      pointerId: event.pointerId,
      offsetX: event.clientX - (rect.left + rect.width * point.x / 100),
      offsetY: event.clientY - (rect.top + rect.height * point.y / 100),
    };
    setDraggingCaption(slot);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveCaption(slot: CaptionSlot, event: ReactPointerEvent<HTMLParagraphElement>) {
    const drag = dragRef.current;
    const canvas = previewCanvasRef.current;
    if (!drag || drag.slot !== slot || drag.pointerId !== event.pointerId || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    patchCaptionPosition(slot, memePointFromClient(
      rect,
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
    ));
    event.preventDefault();
  }

  function finishCaptionDrag(slot: CaptionSlot, event: ReactPointerEvent<HTMLParagraphElement>) {
    const drag = dragRef.current;
    if (!drag || drag.slot !== slot || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDraggingCaption(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function nudgeCaption(slot: CaptionSlot, event: ReactKeyboardEvent<HTMLParagraphElement>) {
    const deltas: Partial<Record<string, MemeTextPosition>> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    const amount = event.shiftKey ? 5 : 1;
    const current = pointForSlot(slot);
    patchCaptionPosition(slot, {
      x: clampMemeCoordinate(current.x + delta.x * amount),
      y: clampMemeCoordinate(current.y + delta.y * amount),
    });
    event.preventDefault();
  }

  function applyPlacement(placement: (typeof PLACEMENTS)[number]) {
    const alignedX = draft.textAlign === "left" ? 10 : draft.textAlign === "right" ? 90 : 50;
    patchDraft({
      position: placement.id,
      topPosition: { ...placement.topPosition, x: alignedX },
      bottomPosition: { ...placement.bottomPosition, x: alignedX },
    });
  }

  function applyToExport() {
    onApply({ ...draft, sourceAssetId: asset?.id });
  }

  const hasText = draft.topText.trim().length > 0 || draft.bottomText.trim().length > 0;
  const previewSource = asset?.sourceUrl || asset?.thumbnailUrl;
  const mediaDimensions = useMemo(() => parseMemeMediaDimensions(asset?.dimensions), [asset?.dimensions]);
  const visibleWidth = Math.max(0.01, 1 - ((crop?.left ?? 0) + (crop?.right ?? 0)) / 100);
  const visibleHeight = Math.max(0.01, 1 - ((crop?.top ?? 0) + (crop?.bottom ?? 0)) / 100);
  const croppedDimensions = useMemo(() => mediaDimensions ? {
    width: Math.max(2, Math.floor(mediaDimensions.width * visibleWidth / 2) * 2),
    height: Math.max(2, Math.floor(mediaDimensions.height * visibleHeight / 2) * 2),
  } : null, [mediaDimensions, visibleWidth, visibleHeight]);
  const mediaBox = useMemo(
    () => croppedDimensions ? fitMemePreviewBox(previewSurface === "canvas" ? previewSize : {
      width: Math.min(176, Math.max(0, previewSize.width - 32)),
      height: Math.min(176, Math.max(0, previewSize.height - 32)),
    }, croppedDimensions) : null,
    [croppedDimensions, previewSize, previewSurface],
  );
  const previewFontSize = mediaBox ? draft.fontSize * mediaBox.width / 420 : draft.fontSize;

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return undefined;
    const updateSize = () => {
      const { width, height } = preview.getBoundingClientRect();
      if (width > 0 && height > 0) setPreviewSize({ width: preview.clientWidth || width, height: preview.clientHeight || height });
    };
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!draggingCaption) return undefined;
    const stopDragging = () => {
      dragRef.current = null;
      setDraggingCaption(null);
    };
    window.addEventListener("pointerup", stopDragging, true);
    window.addEventListener("pointercancel", stopDragging, true);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("pointerup", stopDragging, true);
      window.removeEventListener("pointercancel", stopDragging, true);
      window.removeEventListener("blur", stopDragging);
    };
  }, [draggingCaption]);

  const templateSelector = (
<div className="meme-template-section">
        <div className="meme-section-heading">
          <span><TextT weight="bold" aria-hidden="true" /><strong>先选一个表达方式</strong></span>
          <small>换模板保留已写好的文字</small>
        </div>
        <div className="meme-template-list" role="list" aria-label="表情包预设模板">
          {MEME_TEMPLATES.map((template) => {
            const selected = template.templateId === draft.templateId;
            return (
              <div key={template.templateId} className="meme-template-item" role="listitem">
                <button
                  type="button"
                  className={`meme-template-card${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => applyTemplate(template)}
                >
                  <span className={`meme-template-card__glyph template-${template.templateId}`}>{template.glyph}</span>
                  <span><strong>{template.name}</strong><small>{template.note}</small></span>
                  {selected && <Check className="meme-template-card__check" weight="bold" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
  );

  return (
    <section className={`meme-workspace paper-panel${reducedMotion ? " reduce-motion" : ""} ${className}`.trim()} aria-label="GIF表情包制作工作台">
      <header className="meme-workspace__header">
        <div className="meme-workspace__title">
          <span className="meme-workspace__title-icon"><Sparkle weight="fill" aria-hidden="true" /></span>
          <span>
            <small>GIFP MEME STUDIO</small>
            <h1>GIF表情包制作</h1>
          </span>
        </div>
        <div className="meme-source-chip" aria-label="当前表情包素材">
          {asset ? (
            <>
              <span>{getAssetKindLabel(asset)}</span>
              <strong title={asset.name}>{asset.name}</strong>
              <small>{asset.dimensions || "尺寸读取中"}{asset.duration ? ` · ${asset.duration.toFixed(1)}s` : ""}</small>
            </>
          ) : (
            <><ImageSquare aria-hidden="true" /><strong>先从素材区选择图片或动图</strong></>
          )}
        </div>
      </header>

      {collectionBar ?? templateSelector}

      <div className="meme-workspace__body">
        <div className="meme-preview-column">
          <div className="meme-preview-heading">
            <span><i aria-hidden="true" />实时画面</span>
            <div className="meme-preview-surfaces" role="group" aria-label="表情包预览背景">
              {([{ id: "canvas", label: "画布" }, { id: "chat_light", label: "浅色聊天" }, { id: "chat_dark", label: "深色聊天" }] as const).map((surface) =>
                <button type="button" key={surface.id} aria-pressed={previewSurface === surface.id} onClick={() => setPreviewSurface(surface.id)}>{surface.label}</button>)}
            </div>
          </div>
          <div
            className={`meme-preview template-${draft.templateId} placement-${draft.position} align-${draft.textAlign} surface-${previewSurface}`}
            data-testid="meme-preview"
            ref={previewRef}
          >
            <div
              className="meme-preview__canvas"
              style={mediaBox ? { width: `${mediaBox.width}px`, height: `${mediaBox.height}px` } : undefined}
              data-testid="meme-preview-canvas"
              ref={previewCanvasRef}
            >
              <div className="meme-preview__media" style={crop ? {
                left: `${-crop.left / visibleWidth}%`, top: `${-crop.top / visibleHeight}%`,
                width: `${100 / visibleWidth}%`, height: `${100 / visibleHeight}%`,
              } : undefined}>
                {previewSource && asset && (asset.kind === "gif" || asset.kind === "webp" || asset.kind === "apng") ? (
                  <AnimatedMediaPlayer
                    src={previewSource}
                    format={asset.kind}
                    alt={`${asset.name} 动画预览`}
                    className="meme-animation-player"
                    stageOnly={playerStageOnly}
                    reducedMotion={reducedMotion}
                  />
                ) : previewSource && asset?.kind === "video" ? (
                  <video
                    src={previewSource}
                    poster={asset.thumbnailUrl}
                    controls
                    muted
                    loop
                    playsInline
                    aria-label={`${asset.name} 视频预览`}
                  />
                ) : previewSource && asset ? (
                  <img src={previewSource} alt={`${asset.name} 预览`} />
                ) : (
                  <div className="meme-preview__empty">
                    <ImageSquare weight="duotone" aria-hidden="true" />
                    <strong>选择素材后在这里排版</strong>
                    <small>支持视频、GIF、WebP、APNG 与静态图片</small>
                  </div>
                )}
              </div>
              <div
                className={`meme-preview__captions style-${draft.style}`}
                style={{ "--meme-font-size": `${previewFontSize}px` } as CSSProperties}
                aria-live="polite"
              >
                {draft.topText.trim() && (
                  <p
                    className="meme-caption meme-caption--top"
                    style={{ left: `${draft.topPosition.x}%`, top: `${draft.topPosition.y}%` }}
                    role="button"
                    tabIndex={0}
                    aria-label="拖动上方文字；方向键可微调"
                    data-dragging={draggingCaption === "top" || undefined}
                    onPointerDown={(event) => startCaptionDrag("top", event)}
                    onPointerMove={(event) => moveCaption("top", event)}
                    onPointerUp={(event) => finishCaptionDrag("top", event)}
                    onPointerCancel={(event) => finishCaptionDrag("top", event)}
                    onLostPointerCapture={() => {
                      dragRef.current = null;
                      setDraggingCaption(null);
                    }}
                    onKeyDown={(event) => nudgeCaption("top", event)}
                  >
                    {draft.topText}<ArrowsOutCardinal className="meme-caption__drag-handle" aria-hidden="true" />
                  </p>
                )}
                {draft.bottomText.trim() && (
                  <p
                    className="meme-caption meme-caption--bottom"
                    style={{ left: `${draft.bottomPosition.x}%`, top: `${draft.bottomPosition.y}%` }}
                    role="button"
                    tabIndex={0}
                    aria-label="拖动下方文字；方向键可微调"
                    data-dragging={draggingCaption === "bottom" || undefined}
                    onPointerDown={(event) => startCaptionDrag("bottom", event)}
                    onPointerMove={(event) => moveCaption("bottom", event)}
                    onPointerUp={(event) => finishCaptionDrag("bottom", event)}
                    onPointerCancel={(event) => finishCaptionDrag("bottom", event)}
                    onLostPointerCapture={() => {
                      dragRef.current = null;
                      setDraggingCaption(null);
                    }}
                    onKeyDown={(event) => nudgeCaption("bottom", event)}
                  >
                    {draft.bottomText}<ArrowsOutCardinal className="meme-caption__drag-handle" aria-hidden="true" />
                  </p>
                )}
                {!hasText && <p className="meme-caption-placeholder">输入文字，预览会立即更新</p>}
              </div>
            </div>
          </div>
          <p className="meme-preview-note">{previewSurface === "canvas" ? `${selectedTemplate.name} · 拖动文字改位置；方向键微调，Shift 快移。` : "聊天小图预览 · 最长边 176px，仅影响预览；检查文字能否一眼读清。"}</p>
        </div>

        <fieldset disabled={readOnly} className="meme-controls" aria-label="表情包文字与构图设置">
          {outputControls}
          {collectionBar && <details className="meme-set-templates"><summary>表达模板 · {selectedTemplate.name}</summary>{templateSelector}</details>}
          <div className="meme-control-card meme-copy-editor">
            <div className="meme-control-title"><strong>写梗</strong><small>建议每行不超过 16 个字</small></div>
            <div className="meme-reaction-copy" role="group" aria-label="常用反应文案">
              <small>点选短句，替换下方文字</small>
              <div>{["收到！", "好耶", "救命", "让我想想", "谢谢老板", "下次一定"].map((copy) => <button type="button" key={copy} onClick={() => patchCopy({ bottomText: copy })}>{copy}</button>)}</div>
            </div>
            <label>
              <span>上方文字 <small>{draft.topText.length}/80</small></span>
              <textarea
                aria-label="上方文字"
                value={draft.topText}
                maxLength={80}
                rows={2}
                placeholder="铺垫或第一句对白"
                onChange={(event) => patchCopy({ topText: event.target.value })}
              />
            </label>
            <label>
              <span>下方文字 <small>{draft.bottomText.length}/80</small></span>
              <textarea
                aria-label="下方文字"
                value={draft.bottomText}
                maxLength={80}
                rows={2}
                placeholder="反转、结论或反应词"
                onChange={(event) => patchCopy({ bottomText: event.target.value })}
              />
            </label>
          </div>

          <fieldset className="meme-control-card meme-style-picker">
            <legend>文字样式</legend>
            <div className="meme-style-options">
              {TEXT_STYLES.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  className={`meme-style-option preview-${style.id}${draft.style === style.id ? " selected" : ""}`}
                  aria-pressed={draft.style === style.id}
                  onClick={() => patchDraft({ style: style.id })}
                >
                  <i>字</i><span><strong>{style.label}</strong><small>{style.note}</small></span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="meme-control-card meme-layout-controls">
            <label className="meme-size-control">
              <span><strong>字号</strong><output>{draft.fontSize}px</output></span>
              <input
                type="range"
                min="20"
                max="72"
                step="1"
                value={draft.fontSize}
                aria-label="文字字号"
                onChange={(event) => patchDraft({ fontSize: Number(event.target.value) })}
              />
            </label>

            <fieldset>
              <legend>对齐</legend>
              <div className="meme-segmented meme-alignment-options">
                <button type="button" aria-label="文字左对齐" aria-pressed={draft.textAlign === "left"} onClick={() => patchDraft({ textAlign: "left" })}><TextAlignLeft /></button>
                <button type="button" aria-label="文字居中对齐" aria-pressed={draft.textAlign === "center"} onClick={() => patchDraft({ textAlign: "center" })}><TextAlignCenter /></button>
                <button type="button" aria-label="文字右对齐" aria-pressed={draft.textAlign === "right"} onClick={() => patchDraft({ textAlign: "right" })}><TextAlignRight /></button>
              </div>
            </fieldset>

            <fieldset>
              <legend>位置</legend>
              <div className="meme-segmented meme-placement-options">
                {PLACEMENTS.map((placement) => (
                  <button
                    key={placement.id}
                    type="button"
                    aria-pressed={draft.position === placement.id}
                  onClick={() => applyPlacement(placement)}
                  >
                    {placement.label}
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={draft.position === "free"}
                  onClick={() => patchDraft({ position: "free" })}
                >
                  自由拖动
                </button>
              </div>
            </fieldset>
          </div>

        </fieldset>
      </div>
      {collectionFooter ?? <footer className="meme-actions">
        <button type="button" className="meme-clear-button" onClick={() => patchCopy({ topText: "", bottomText: "" })}>
          <Eraser aria-hidden="true" />清空文字
        </button>
        <button type="button" className={onQuickExport ? "meme-detail-button" : "meme-export-button"} disabled={!asset || !hasText} onClick={applyToExport}>
          <span><strong>应用到导出</strong><small>沿用当前素材的输出设置</small></span>
          <ArrowRight weight="bold" aria-hidden="true" />
        </button>
        {onQuickExport && <button type="button" className="meme-export-button" disabled={!asset || !hasText} onClick={() => onQuickExport({ ...draft, sourceAssetId: asset?.id })}>
          <span><strong>快速导出表情包</strong><small>确认大小，即可生成 GIF</small></span><ArrowRight weight="bold" aria-hidden="true" />
        </button>}
      </footer>}
    </section>
  );
}

export default MemeWorkspace;
