import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  convertGif,
  selectOutputDir,
  selectScreenRegion,
  selectVideos,
  startScreenRecording,
  stopScreenRecording,
  type FilterStyle,
  type GifEncoder,
  type GifRequest,
  type GifResult,
} from "./tauri";

type Preset = {
  id: string;
  tone: string;
  name: string;
  desc: string;
  route: string;
  preview: string;
  still: string;
  previewBytes: number;
  width: number;
  fps: number;
  colors: number;
  dither: string;
  lossy: number;
  encoder: GifEncoder;
  filter: FilterStyle;
};

type Job = { path: string; status: "等待" | "生成中" | "完成" | "失败"; result?: GifResult; error?: string };
type Theme = "kid" | "handheld" | "animal";
type Thumb = { time: number; url: string };
type TrimDrag = "start" | "end" | null;

const VIDEO_RE = /\.(mp4|mov|mkv|webm)$/i;
const HISTORY_KEY = "gif_p.history.v2";
const LOGO_SRC = "/gifp-logo.jpg";
const SAMPLE_SOURCE_BYTES = 4_487_862;

const PRESETS: Preset[] = [
  { id: "tiny", tone: "berry", name: "极小包", desc: "聊天秒发，体积压到底", route: "快速矩形差分 / 低色强压", preview: "/preset-previews/tiny.gif", still: "/preset-previews/tiny.jpg", previewBytes: 380375, width: 280, fps: 8, colors: 24, dither: "bayer", lossy: 86, encoder: "ffmpeg_fast", filter: "pixel" },
  { id: "perceptual", tone: "mint", name: "观感优先", desc: "色彩更亮，少灰雾", route: "pngquant 全局调色 / Sierra 抖动", preview: "/preset-previews/perceptual.gif", still: "/preset-previews/perceptual.jpg", previewBytes: 1352672, width: 420, fps: 15, colors: 112, dither: "sierra2_4a", lossy: 28, encoder: "pngquant_opt", filter: "vivid" },
  { id: "clean_noise", tone: "cream", name: "低噪干净", desc: "少颗粒，适合纯色和皮肤", route: "全局调色 / 无抖动 / 轻降噪", preview: "/preset-previews/clean_noise.gif", still: "/preset-previews/clean_noise.jpg", previewBytes: 1118036, width: 420, fps: 12, colors: 160, dither: "none", lossy: 18, encoder: "clean_opt", filter: "none" },
  { id: "clean", tone: "cream", name: "字幕保真", desc: "界面录屏、字幕、线条", route: "混合策略 / Floyd 细节保护", preview: "/preset-previews/clean.gif", still: "/preset-previews/clean.jpg", previewBytes: 1908314, width: 560, fps: 18, colors: 224, dither: "floyd_steinberg", lossy: 10, encoder: "hybrid", filter: "none" },
  { id: "meme", tone: "sun", name: "表情包", desc: "动作优先，轮廓更硬", route: "低帧高损 / 轮廓鲜明", preview: "/preset-previews/meme.gif", still: "/preset-previews/meme.jpg", previewBytes: 516767, width: 360, fps: 8, colors: 32, dither: "bayer", lossy: 78, encoder: "ffmpeg_fast", filter: "vivid" },
  { id: "vertical", tone: "peach", name: "竖屏短视频", desc: "9:16 预览和导出更顺手", route: "竖屏友好 / 保持原比例", preview: "/preset-previews/vertical.gif", still: "/preset-previews/vertical.jpg", previewBytes: 1324503, width: 360, fps: 15, colors: 96, dither: "sierra2_4a", lossy: 34, encoder: "hybrid", filter: "vivid" },
  { id: "wechat", tone: "leaf", name: "微信表情", desc: "小尺寸、平台友好", route: "平台预设 / 小图低色", preview: "/preset-previews/wechat.gif", still: "/preset-previews/wechat.jpg", previewBytes: 423472, width: 240, fps: 8, colors: 32, dither: "sierra2_4a", lossy: 72, encoder: "ffmpeg_fast", filter: "vivid" },
  { id: "qq", tone: "sky", name: "QQ聊天", desc: "清晰度和体积折中", route: "智能混合 / 中色中帧", preview: "/preset-previews/qq.gif", still: "/preset-previews/qq.jpg", previewBytes: 965438, width: 360, fps: 12, colors: 64, dither: "sierra2_4a", lossy: 46, encoder: "hybrid", filter: "vivid" },
  { id: "bili", tone: "violet", name: "B站移动", desc: "移动端预览更饱满", route: "pngquant 调色 / 高色平台图", preview: "/preset-previews/bili.gif", still: "/preset-previews/bili.jpg", previewBytes: 1578157, width: 480, fps: 15, colors: 128, dither: "sierra2_4a", lossy: 24, encoder: "pngquant_opt", filter: "vivid" },
];

function fileName(path: string) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function folderName(path: string) {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash >= 0 ? path.slice(0, slash) : "";
}

function sizeText(bytes: number) {
  if (!bytes) return "--";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function compressionText(bytes: number) {
  if (!bytes) return "--";
  const ratio = SAMPLE_SOURCE_BYTES / bytes;
  const saved = Math.max(0, 100 - (bytes / SAMPLE_SOURCE_BYTES) * 100);
  return `${ratio.toFixed(1)}x / 省${saved.toFixed(0)}%`;
}

function loadHistory(): GifResult[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]").slice(0, 5);
  } catch {
    return [];
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewTimer = useRef<number | null>(null);
  const thumbStripRef = useRef<HTMLDivElement | null>(null);
  const [queue, setQueue] = useState<Job[]>([]);
  const [activePath, setActivePath] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [presetId, setPresetId] = useState("perceptual");
  const [playingPresetId, setPlayingPresetId] = useState("perceptual");
  const [theme, setTheme] = useState<Theme>("animal");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("拖入 MP4，开始压 GIF");
  const [history, setHistory] = useState<GifResult[]>(loadHistory);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [width, setWidth] = useState(PRESETS[1].width);
  const [fps, setFps] = useState(PRESETS[1].fps);
  const [colors, setColors] = useState(PRESETS[1].colors);
  const [dither, setDither] = useState(PRESETS[1].dither);
  const [lossy, setLossy] = useState(PRESETS[1].lossy);
  const [encoder, setEncoder] = useState<GifEncoder>(PRESETS[1].encoder);
  const [filter, setFilter] = useState<FilterStyle>(PRESETS[1].filter);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [sourceAspect, setSourceAspect] = useState(16 / 9);
  const [cropEnabled, setCropEnabled] = useState(false);
  const [cropLeft, setCropLeft] = useState(0);
  const [cropTop, setCropTop] = useState(0);
  const [cropRight, setCropRight] = useState(0);
  const [cropBottom, setCropBottom] = useState(0);
  const [deletedFrames, setDeletedFrames] = useState<number[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordRegion, setRecordRegion] = useState(false);
  const [recordX, setRecordX] = useState(0);
  const [recordY, setRecordY] = useState(0);
  const [recordWidth, setRecordWidth] = useState(720);
  const [recordHeight, setRecordHeight] = useState(480);
  const [recordFps, setRecordFps] = useState(15);
  const [recordOpen, setRecordOpen] = useState(false);
  const [recordBackend, setRecordBackend] = useState<"psgrab" | "gdigrab" | "ddagrab">("psgrab");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [trimDrag, setTrimDrag] = useState<TrimDrag>(null);
  const [hoverThumb, setHoverThumb] = useState<Thumb | null>(null);
  const [selectedFrameTime, setSelectedFrameTime] = useState<number | null>(null);

  const activeUrl = activePath ? convertFileSrc(activePath) : "";
  const doneCount = queue.filter((job) => job.status === "完成" || job.status === "失败").length;
  const progress = queue.length ? Math.round((doneCount / queue.length) * 100) : 0;
  const canRun = queue.length > 0 && !busy;
  const activeJob = queue.find((job) => job.path === activePath);
  const selectedPreset = PRESETS.find((preset) => preset.id === presetId) || PRESETS[1];
  const selectedDuration = Math.max(0, (end || duration) - start);
  const selectionLeft = duration ? (start / duration) * 100 : 0;
  const selectionRight = duration ? 100 - ((end || duration) / duration) * 100 : 0;
  const selectionEnd = 100 - selectionRight;
  const estimatedHeight = Math.max(1, Math.round(width / (sourceAspect || 1)));
  const isVertical = sourceAspect < 0.85;
  const cropAspect = sourceAspect * ((100 - cropLeft - cropRight) / Math.max(1, 100 - cropTop - cropBottom));
  const effectiveAspect = cropEnabled ? cropAspect : sourceAspect;
  const effectiveHeight = Math.max(1, Math.round(width / (effectiveAspect || 1)));
  const visibleDeletedFrames = deletedFrames
    .filter((time) => duration && time >= start && time <= (end || duration))
    .sort((a, b) => a - b);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 5)));
  }, [history]);

  useEffect(() => {
    return () => {
      if (previewTimer.current) window.clearInterval(previewTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!trimDrag) return;
    const move = (event: PointerEvent) => {
      const rect = thumbStripRef.current?.getBoundingClientRect();
      if (!rect || !duration) return;
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const time = Number((ratio * duration).toFixed(3));
      const minGap = Math.min(0.2, duration / 10);
      if (trimDrag === "start") {
        setStart(Math.max(0, Math.min(time, (end || duration) - minGap)));
      } else {
        setEnd(Math.min(duration, Math.max(time, start + minGap)));
      }
    };
    const up = () => setTrimDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [duration, end, start, trimDrag]);

  useEffect(() => {
    let disposed = false;
    let unlisten: undefined | (() => void);
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragging(true);
          return;
        }
        if (event.payload.type === "drop") {
          setDragging(false);
          addPaths(event.payload.paths);
          return;
        }
        setDragging(false);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  function applyPreset(preset: Preset) {
    setPresetId(preset.id);
    setPlayingPresetId(preset.id);
    setWidth(preset.width);
    setFps(preset.fps);
    setColors(preset.colors);
    setDither(preset.dither);
    setLossy(preset.lossy);
    setEncoder(preset.encoder);
    setFilter(preset.filter);
    setStatus(`已套用 ${preset.name}`);
  }

  function addPaths(paths: string[]) {
    const videos = paths.filter((path) => VIDEO_RE.test(path));
    if (!videos.length) {
      setStatus("只支持 MP4 / MOV / MKV / WEBM");
      return;
    }
    setQueue((current) => {
      const known = new Set(current.map((item) => item.path));
      const fresh = videos.filter((path) => !known.has(path));
      return [...fresh.map((path) => ({ path, status: "等待" as const })), ...current];
    });
    setActivePath(videos[0]);
    setOutputDir((value) => value || folderName(videos[0]));
    setDuration(0);
    setStart(0);
    setEnd(0);
    setThumbs([]);
    setSourceAspect(16 / 9);
    setDeletedFrames([]);
    setSelectedFrameTime(null);
    setPreviewZoom(1);
    setStatus(`已加入 ${videos.length} 个视频`);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path || "")
      .filter(Boolean);
    addPaths(paths);
  }

  async function addByDialog() {
    try {
      addPaths(await selectVideos());
    } catch (err) {
      setStatus(`选择失败：${String(err)}`);
    }
  }

  async function browseOutput() {
    const dir = await selectOutputDir();
    if (dir) setOutputDir(dir);
  }

  function onLoadedMetadata(event: React.SyntheticEvent<HTMLVideoElement>) {
    const value = event.currentTarget.duration || 0;
    const aspect = event.currentTarget.videoWidth && event.currentTarget.videoHeight
      ? event.currentTarget.videoWidth / event.currentTarget.videoHeight
      : 16 / 9;
    setDuration(value);
    setSourceAspect(aspect);
    setEnd((current) => (current > 0 ? Math.min(current, value) : value));
    void captureTimeline(event.currentTarget, value);
  }

  function waitForSeek(video: HTMLVideoElement, time: number) {
    return new Promise<void>((resolve) => {
      const target = Math.max(0, Math.min(time, video.duration || time));
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        resolve();
        return;
      }
      let timeout = 0;
      const done = () => {
        window.clearTimeout(timeout);
        video.removeEventListener("seeked", done);
        resolve();
      };
      timeout = window.setTimeout(done, 900);
      video.addEventListener("seeked", done, { once: true });
      video.currentTime = target;
    });
  }

  async function captureTimeline(video: HTMLVideoElement, videoDuration: number) {
    if (!videoDuration || !Number.isFinite(videoDuration)) return;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return;
    const count = 8;
    const samples = Array.from({ length: count }, (_, index) => (videoDuration * (index + 0.5)) / count);
    const nextThumbs: Thumb[] = [];
    const originalTime = video.currentTime || 0;
    const wasPaused = video.paused;
    try {
      video.pause();
      for (const time of samples) {
        await waitForSeek(video, time);
        const ratio = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
        canvas.width = 150;
        canvas.height = Math.round(150 / ratio);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        nextThumbs.push({ time, url: canvas.toDataURL("image/jpeg", 0.72) });
      }
      setThumbs(nextThumbs);
      await waitForSeek(video, Math.min(originalTime, videoDuration));
      if (!wasPaused) void video.play();
    } catch {
      setThumbs([]);
    }
  }

  async function runBatch() {
    if (!canRun) return;
    setBusy(true);
    const snapshot = [...queue];
    for (let index = 0; index < snapshot.length; index += 1) {
      const job = snapshot[index];
      setStatus(`生成中 ${index + 1}/${snapshot.length}：${fileName(job.path)}`);
      setQueue((items) => items.map((item) => (item.path === job.path ? { ...item, status: "生成中" } : item)));
      const request: GifRequest = {
        input_path: job.path,
        output_dir: outputDir || folderName(job.path),
        width,
        fps,
        colors,
        dither,
        optimize_level: 3,
        lossy,
        start_seconds: start,
        end_seconds: end > start ? end : 0,
        encoder,
        filter_style: filter,
        loop_output: true,
        crop_enabled: cropEnabled,
        crop_left: cropLeft,
        crop_top: cropTop,
        crop_right: cropRight,
        crop_bottom: cropBottom,
        deleted_frames: deletedFrames,
      };
      try {
        const result = await convertGif(request);
        setQueue((items) => items.map((item) => (item.path === job.path ? { ...item, status: "完成", result } : item)));
        setHistory((items) => [result, ...items.filter((item) => item.output_path !== result.output_path)].slice(0, 5));
      } catch (err) {
        setQueue((items) => items.map((item) => (item.path === job.path ? { ...item, status: "失败", error: String(err) } : item)));
      }
    }
    setBusy(false);
    setStatus("GIF 生成完成");
  }

  function resetEdit() {
    setStart(0);
    setEnd(duration);
    setQueue([]);
    setActivePath("");
    setThumbs([]);
    setSourceAspect(16 / 9);
    setCropEnabled(false);
    setCropLeft(0);
    setCropTop(0);
    setCropRight(0);
    setCropBottom(0);
    setDeletedFrames([]);
    setSelectedFrameTime(null);
    setPreviewZoom(1);
    setStatus("已回到初始编辑状态");
  }

  function previewRange() {
    const video = videoRef.current;
    if (!video || !duration) return;
    if (previewTimer.current) window.clearInterval(previewTimer.current);
    const stopAt = end || duration;
    video.currentTime = start;
    void video.play();
    previewTimer.current = window.setInterval(() => {
      if (!video || video.currentTime >= stopAt) {
        video?.pause();
        if (previewTimer.current) window.clearInterval(previewTimer.current);
        previewTimer.current = null;
      }
    }, 60);
  }

  function deleteCurrentFrame() {
    const video = videoRef.current;
    if (!video || !duration) {
      setStatus("先加载视频，再点击胶片条选择要删除的帧");
      return;
    }
    const frameStep = 1 / Math.max(1, fps);
    const current = selectedFrameTime ?? Math.max(0, Math.min(video.currentTime || 0, duration));
    const snapped = Number((Math.round(current / frameStep) * frameStep).toFixed(3));
    setDeletedFrames((items) => {
      if (items.some((time) => Math.abs(time - snapped) < frameStep * 0.6)) return items;
      return [...items, snapped].sort((a, b) => a - b);
    });
    setStatus(`已标记删除 ${snapped.toFixed(2)}s 附近的输出帧`);
  }

  function undoDeletedFrame() {
    setDeletedFrames((items) => items.slice(0, -1));
    setStatus("已撤销最近一个删帧标记");
  }

  async function toggleRecording() {
    const fallback = recordBackend === "psgrab" ? "显卡模式" : "截图序列模式";
    const fallbackBackend = recordBackend === "psgrab" ? "ddagrab" : "psgrab";
    const request = {
      output_dir: outputDir || "",
      fps: recordFps,
      region_enabled: recordRegion,
      x: recordX,
      y: recordY,
      width: recordWidth,
      height: recordHeight,
      capture_backend: recordBackend,
    };
    try {
      if (!recording) {
        try {
          await startScreenRecording(request);
        } catch (err) {
          await startScreenRecording({ ...request, capture_backend: fallbackBackend });
          setRecordBackend(fallbackBackend);
          setStatus(`${recordBackend === "ddagrab" ? "显卡模式" : "兼容模式"}不可用，已自动切换到${fallback}`);
        }
        setRecording(true);
        setStatus(recordRegion ? "正在录制屏幕区域" : "正在录制整个桌面");
        return;
      }
      const videoPath = await stopScreenRecording();
      setRecording(false);
      addPaths([videoPath]);
      setStatus("录屏已完成，已加入 GIF 队列");
    } catch (err) {
      setRecording(false);
      setStatus(`录屏失败：${String(err)}。如果是黑屏/无画面，请切换到${fallback}再试。`);
    }
  }

  async function pickScreenRegion() {
    try {
      setStatus("拖拽鼠标框选要录制的屏幕区域，按 Esc 取消");
      const region = await selectScreenRegion();
      if (!region) {
        setStatus("已取消屏幕区域选择");
        return;
      }
      setRecordRegion(true);
      setRecordX(region.x);
      setRecordY(region.y);
      setRecordWidth(region.width);
      setRecordHeight(region.height);
      setRecordOpen(true);
      setStatus(`已选择录屏区域 ${region.width}x${region.height}`);
    } catch (err) {
      setStatus(`区域选择失败：${String(err)}`);
    }
  }

  function zoomPreview(delta: number) {
    setPreviewZoom((value) => Math.max(0.5, Math.min(4, Number((value + delta).toFixed(2)))));
  }

  function timeFromPointer(event: ReactPointerEvent<HTMLElement>) {
    const rect = thumbStripRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    return Number((ratio * duration).toFixed(3));
  }

  function moveTrim(handle: TrimDrag, event: ReactPointerEvent<HTMLElement>) {
    if (!handle || !duration) return;
    const time = timeFromPointer(event);
    const minGap = Math.min(0.2, duration / 10);
    if (handle === "start") {
      setStart(Math.max(0, Math.min(time, (end || duration) - minGap)));
    } else {
      setEnd(Math.min(duration, Math.max(time, start + minGap)));
    }
  }

  return (
    <main
      className={`app theme-${theme} ${dragging ? "dragging" : ""}`}
      onDragEnter={() => setDragging(true)}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <header className="topbar">
        <div className="logo-card"><img src={LOGO_SRC} alt="GIF_P logo" /></div>
        <div className="title-block">
          <h1>GIF_P</h1>
          <p>一款2026年的GIF压缩工具。<b>by acekanon</b></p>
        </div>
        <div className="top-status">
          <span className="file-chip" title={activePath || "等待拖入视频"}>{activePath ? fileName(activePath) : "把 MP4 拖到窗口中"}</span>
          <span className="status-pill">{activePath ? "已加载" : "待导入"}</span>
          <span className="status-pill accent">{isVertical ? "竖屏适配" : `${width}x${effectiveHeight}`}</span>
        </div>
        <div className="top-actions">
          <button type="button" onClick={() => setTheme(theme === "kid" ? "animal" : theme === "animal" ? "handheld" : "kid")}>皮肤</button>
          <button type="button" onClick={() => void addByDialog()}>添加视频</button>
        </div>
      </header>

      <aside className="preset-panel">
        <div className="panel-title"><span>压缩预设</span><button type="button" onClick={() => setPresetId("custom")}>保存</button></div>
        <button
          className={presetId === "custom" ? "preset custom active" : "preset custom"}
          onClick={() => {
            setPresetId("custom");
            setStatus("正在使用自定义参数");
          }}
          type="button"
        >
          <span className="preset-preview custom-preview"><img src={selectedPreset.still} alt="自定义预设参考" loading="lazy" /></span>
          <strong>自定义预设</strong>
          <em>使用右侧当前参数</em>
          <small>手动调宽度、帧率、颜色和编码器</small>
          <i>{width}px / {colors} 色 / {fps} fps</i>
        </button>
        {PRESETS.map((preset) => (
          <button
            className={preset.id === presetId ? `preset ${preset.tone} active` : `preset ${preset.tone}`}
            key={preset.id}
            onClick={() => applyPreset(preset)}
            type="button"
          >
            <span className="preset-preview"><img src={playingPresetId === preset.id ? preset.preview : preset.still} alt={`${preset.name} 预览`} loading="lazy" /></span>
            <strong>{preset.name}</strong>
            <em>{preset.desc}</em>
            <small>{preset.route}</small>
            <i>{preset.width}px / {preset.colors} 色 / {preset.fps} fps / {compressionText(preset.previewBytes)}</i>
          </button>
        ))}
      </aside>

      <section className="stage">
        <div className="stage-title">
          <strong>预览 / 裁剪编辑</strong>
          <span>{status}</span>
        </div>
        <div
          className={isVertical ? "preview vertical-preview" : "preview"}
          onWheel={(event) => {
            if (!activeUrl) return;
            event.preventDefault();
            zoomPreview(event.deltaY > 0 ? -0.12 : 0.12);
          }}
        >
          {activeUrl ? (
            <div
              className="video-wrap"
              style={{
                ["--crop-left" as string]: `${cropEnabled ? cropLeft : 0}%`,
                ["--crop-top" as string]: `${cropEnabled ? cropTop : 0}%`,
                ["--crop-right" as string]: `${cropEnabled ? cropRight : 0}%`,
                ["--crop-bottom" as string]: `${cropEnabled ? cropBottom : 0}%`,
                ["--preview-zoom" as string]: previewZoom,
              }}
            >
              <video key={activeUrl} ref={videoRef} src={activeUrl} controls muted playsInline onLoadedMetadata={onLoadedMetadata} />
              {cropEnabled && <div className="crop-overlay"><span>裁剪区域</span></div>}
              <div className="zoom-tools">
                <button type="button" onClick={() => zoomPreview(-0.25)}>-</button>
                <span>{Math.round(previewZoom * 100)}%</span>
                <button type="button" onClick={() => zoomPreview(0.25)}>+</button>
                <button type="button" onClick={() => setPreviewZoom(1)}>1:1</button>
              </div>
            </div>
          ) : (
            <div className="drop-zone">
              <figure className="preset-showcase">
                <img src={selectedPreset.preview} alt={`${selectedPreset.name} 默认效果预览`} />
                <figcaption>
                  <b>{selectedPreset.name}</b>
                  <span>{selectedPreset.desc}</span>
                  <i>{selectedPreset.width}px / {selectedPreset.colors} 色 / {selectedPreset.fps} fps / {compressionText(selectedPreset.previewBytes)}</i>
                </figcaption>
              </figure>
              <strong>{dragging ? "松手导入" : "拖入 MP4"}</strong>
              <span>先点左侧预设看样片，再拖入自己的视频生成 GIF</span>
            </div>
          )}
        </div>
        <div
          className="timeline"
          style={{
            ["--select-left" as string]: `${selectionLeft}%`,
            ["--select-right" as string]: `${selectionRight}%`,
            ["--select-end" as string]: `${selectionEnd}%`,
          }}
        >
          <div
            className="thumb-strip"
            ref={thumbStripRef}
            onPointerMove={(event) => moveTrim(trimDrag, event)}
            onPointerUp={() => setTrimDrag(null)}
            onPointerCancel={() => setTrimDrag(null)}
          >
            {thumbs.length ? thumbs.map((thumb) => (
              <button
                key={thumb.time}
                type="button"
                style={{ backgroundImage: `url(${thumb.url})` }}
                title={`${thumb.time.toFixed(2)}s`}
                onMouseEnter={() => setHoverThumb(thumb)}
                onMouseLeave={() => setHoverThumb(null)}
                onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime = thumb.time;
                  setSelectedFrameTime(thumb.time);
                  setStatus(`已选中 ${thumb.time.toFixed(2)}s，可删除该帧`);
                }}
                className={selectedFrameTime !== null && Math.abs(selectedFrameTime - thumb.time) < 0.05 ? "selected-thumb" : ""}
              />
            )) : <span>加载视频后自动生成关键帧预览</span>}
            {hoverThumb && (
              <div className="hover-thumb-preview" style={{ left: `${duration ? (hoverThumb.time / duration) * 100 : 50}%` }}>
                <img src={hoverThumb.url} alt="关键帧预览" />
                <b>{hoverThumb.time.toFixed(2)}s</b>
              </div>
            )}
            <i className="selection-mask left" />
            <i className="selection-mask right" />
            {deletedFrames.map((time) => (
              <i
                className="deleted-frame-marker"
                key={time}
                style={{ left: `${duration ? (time / duration) * 100 : 0}%` }}
                title={`跳过 ${time.toFixed(2)}s`}
              />
            ))}
            {selectedFrameTime !== null && (
              <i
                className="selected-frame-marker"
                style={{ left: `${duration ? (selectedFrameTime / duration) * 100 : 0}%` }}
                title={`已选 ${selectedFrameTime.toFixed(2)}s`}
              />
            )}
            <button
              className="trim-handle start"
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                setTrimDrag("start");
                moveTrim("start", event);
              }}
            >
              {start.toFixed(1)}s
            </button>
            <button
              className="trim-handle end"
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                setTrimDrag("end");
                moveTrim("end", event);
              }}
            >
              {(end || duration).toFixed(1)}s
            </button>
          </div>
          <div className="timeline-summary">
            <span>输出 {selectedDuration.toFixed(2)}s</span>
            <span>片段 {start.toFixed(2)} - {(end || duration).toFixed(2)}s</span>
            <span>选中 {selectedFrameTime === null ? "未选" : `${selectedFrameTime.toFixed(2)}s`}</span>
            <span>预计 {width}x{effectiveHeight}</span>
            <span>删帧 {visibleDeletedFrames.length}</span>
          </div>
        </div>
        <div className="main-actions">
          <button type="button" onClick={resetEdit}>重置编辑状态</button>
          <button className="preview-btn" type="button" onClick={previewRange}>预览片段</button>
          <button type="button" onClick={deleteCurrentFrame} disabled={selectedFrameTime === null && !activeUrl}>删除已选帧</button>
          <button type="button" onClick={undoDeletedFrame} disabled={!deletedFrames.length}>撤销删帧</button>
          <button type="button" onClick={() => setDeletedFrames([])} disabled={!deletedFrames.length}>清空删帧</button>
          <button className="generate" type="button" disabled={!canRun} onClick={() => void runBatch()}>▶ 生成 GIF</button>
        </div>
      </section>

      <aside className="settings-panel">
        <div className="stats-grid">
          <span>队列<b>{queue.length}</b></span>
          <span>完成<b>{doneCount}</b></span>
          <span>进度<b>{progress}%</b></span>
          <span>预计尺寸<b>{width}x{effectiveHeight}</b></span>
        </div>
        <section className="box">
          <h2>输出参数</h2>
          <div className="form-grid">
            <label>宽度<input value={width} type="number" min={96} max={1920} onChange={(event) => setWidth(Number(event.target.value) || 320)} /></label>
            <label>帧率<input value={fps} type="number" min={1} max={60} onChange={(event) => setFps(Number(event.target.value) || 10)} /></label>
            <label>颜色数<input value={colors} type="number" min={2} max={256} onChange={(event) => setColors(Number(event.target.value) || 48)} /></label>
            <label>有损阈值<input value={lossy} type="number" min={0} max={100} onChange={(event) => setLossy(Number(event.target.value) || 0)} /></label>
          </div>
          <label>编码器
            <select value={encoder} onChange={(event) => setEncoder(event.target.value as GifEncoder)}>
              <option value="ffmpeg_fast">FFmpeg 快速</option>
              <option value="pngquant_opt">pngquant 优化</option>
              <option value="hybrid">智能混合</option>
              <option value="clean_opt">低噪干净</option>
            </select>
          </label>
          <label>滤镜
            <select value={filter} onChange={(event) => setFilter(event.target.value as FilterStyle)}>
              <option value="none">原味</option>
              <option value="vivid">鲜亮抗灰</option>
              <option value="gb">GB 绿屏</option>
              <option value="gba_lcd">GBA LCD</option>
              <option value="crt">CRT 扫描线</option>
              <option value="pixel">像素海报</option>
            </select>
          </label>
          <label>抖动
            <select value={dither} onChange={(event) => setDither(event.target.value)}>
              <option value="sierra2_4a">Sierra 高质量</option>
              <option value="floyd_steinberg">Floyd 细节</option>
              <option value="bayer">Bayer 小体积</option>
              <option value="none">无抖动</option>
            </select>
          </label>
          <label className="check-row">
            <input checked={cropEnabled} type="checkbox" onChange={(event) => setCropEnabled(event.target.checked)} />
            画面裁剪
          </label>
          {cropEnabled && (
            <div className="form-grid crop-grid">
              <label>左 {cropLeft}%<input value={cropLeft} type="range" min={0} max={45} onChange={(event) => setCropLeft(Number(event.target.value))} /></label>
              <label>上 {cropTop}%<input value={cropTop} type="range" min={0} max={45} onChange={(event) => setCropTop(Number(event.target.value))} /></label>
              <label>右 {cropRight}%<input value={cropRight} type="range" min={0} max={45} onChange={(event) => setCropRight(Number(event.target.value))} /></label>
              <label>下 {cropBottom}%<input value={cropBottom} type="range" min={0} max={45} onChange={(event) => setCropBottom(Number(event.target.value))} /></label>
            </div>
          )}
          <label>输出文件夹
            <div className="path-row"><input value={outputDir} onChange={(event) => setOutputDir(event.target.value)} /><button type="button" onClick={() => void browseOutput()}>浏览</button></div>
          </label>
        </section>
        <section className={recordOpen || recording ? "box record-box open" : "box record-box"}>
          <div className="record-head">
            <h2>屏幕录制</h2>
            <button type="button" onClick={() => setRecordOpen((value) => !value)}>{recordOpen ? "收起" : "展开"}</button>
          </div>
          <div className="record-quick">
            <button type="button" onClick={() => void pickScreenRegion()}>鼠标框选区域</button>
            <button className={recording ? "record-button recording" : "record-button"} type="button" onClick={() => void toggleRecording()}>
              {recording ? "■ 停止录制" : "● 开始录屏"}
            </button>
          </div>
          {(recordOpen || recording) && (
            <div className="record-detail">
              <label className="check-row">
                <input checked={recordRegion} type="checkbox" onChange={(event) => setRecordRegion(event.target.checked)} />
                录制指定区域
              </label>
              <div className="form-grid record-grid">
                <label>X<input value={recordX} type="number" min={0} onChange={(event) => setRecordX(Number(event.target.value) || 0)} /></label>
                <label>Y<input value={recordY} type="number" min={0} onChange={(event) => setRecordY(Number(event.target.value) || 0)} /></label>
                <label>宽<input value={recordWidth} type="number" min={120} onChange={(event) => setRecordWidth(Number(event.target.value) || 720)} /></label>
                <label>高<input value={recordHeight} type="number" min={120} onChange={(event) => setRecordHeight(Number(event.target.value) || 480)} /></label>
              </div>
              <label>录制帧率<input value={recordFps} type="number" min={5} max={30} onChange={(event) => setRecordFps(Number(event.target.value) || 15)} /></label>
              <label>录制后端
                <select value={recordBackend} onChange={(event) => setRecordBackend(event.target.value as "psgrab" | "gdigrab" | "ddagrab")}>
                  <option value="psgrab">截图序列模式</option>
                  <option value="gdigrab">兼容模式</option>
                  <option value="ddagrab">显卡模式</option>
                </select>
              </label>
              <p className="record-hint">默认截图序列模式更稳；显卡/兼容模式更快，但可能被系统权限拦截。</p>
            </div>
          )}
        </section>
        <section className="box queue-box">
          <h2>当前队列</h2>
          {queue.length ? queue.map((job) => (
            <button
              className={job.path === activePath ? "history active-job" : "history"}
              key={job.path}
              type="button"
              title={job.error || job.result?.output_path || job.path}
              onClick={() => setActivePath(job.path)}
            >
              <span>{fileName(job.path)}</span><b>{job.status}</b>
            </button>
          )) : <p className="empty">拖入视频后显示队列</p>}
        </section>
        <section className="box">
          <h2>最近导出</h2>
          {history.length ? history.map((item) => (
            <button className="history" key={item.output_path} type="button" title={item.output_path}>
              <span>{fileName(item.output_path)}</span><b>{sizeText(item.size_bytes)}</b>
            </button>
          )) : <p className="empty">还没有导出</p>}
          {activeJob?.error && <p className="error">{activeJob.error}</p>}
        </section>
      </aside>
    </main>
  );
}
