import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const toolRoot = process.env.GIFP_PPT_TOOL_ROOT || join(process.env.TEMP || "", "gifp-ppt-tools");
const PptxGenJS = require(join(toolRoot, "node_modules", "pptxgenjs"));

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "acekanon";
pptx.company = "GIFP";
pptx.subject = "GIFP 4.0 产品功能介绍";
pptx.title = "GIFP 4.0 产品介绍";
pptx.lang = "zh-CN";
pptx.theme = {
  headFontFace: "Microsoft YaHei",
  bodyFontFace: "Microsoft YaHei",
  lang: "zh-CN",
};
pptx.defineSlideMaster({
  title: "GIFP_MASTER",
  background: { color: "F6F0DF" },
  objects: [],
  slideNumber: { x: 12.55, y: 7.04, w: 0.35, h: 0.18, color: "9A9385", fontSize: 8, align: "right" },
});

const S = pptx.ShapeType;
const W = 13.333;
const H = 7.5;
const FONT = "Microsoft YaHei";
const C = {
  bg: "F6F0DF",
  paper: "FFFDF5",
  paper2: "FBF7EA",
  ink: "2B342F",
  muted: "6E746E",
  line: "D9D0BB",
  teal: "43B4AA",
  tealDark: "207C78",
  tealPale: "DDF3EF",
  coral: "ED8177",
  coralDark: "A84F4A",
  coralPale: "F9E1DC",
  yellow: "F1CF68",
  yellowPale: "FBF0BD",
  green: "70B987",
  greenPale: "E1F3E4",
  blue: "6EA9C8",
  bluePale: "E1EFF5",
  purple: "9C88C7",
  purplePale: "EBE6F6",
  white: "FFFFFF",
  dark: "243C3A",
};

const root = resolve(".");
const docsDir = resolve("docs");
const outPath = resolve("docs/GIFP_4.0_产品介绍.pptx");
const logoPath = resolve("public/gifp-logo.jpg");
const editorShot = resolve("audits/gifp-3.2-alpha.4/01-editor.png");
const presetPortrait = resolve("public/preset-previews/perceptual.jpg");

for (const path of [logoPath, editorShot, presetPortrait]) {
  if (!existsSync(path)) throw new Error("Missing presentation asset: " + path);
}
mkdirSync(docsDir, { recursive: true });

function noLine() {
  return { color: C.bg, transparency: 100 };
}

function addText(slide, text, x, y, w, h, options = {}) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontFace: FONT,
    fontSize: 14,
    color: C.ink,
    margin: 0,
    breakLine: false,
    valign: "mid",
    fit: "shrink",
    ...options,
  });
}

function addCard(slide, x, y, w, h, options = {}) {
  slide.addShape(S.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.08,
    fill: { color: options.fill || C.paper, transparency: options.transparency || 0 },
    line: { color: options.line || C.line, width: options.lineWidth || 1 },
    shadow: options.shadow === false ? undefined : {
      type: "outer",
      color: "8B806E",
      opacity: 0.12,
      blur: 1.2,
      angle: 45,
      distance: 1,
    },
  });
}

function addPill(slide, text, x, y, w, h, fill, color = C.ink, line = fill, fontSize = 11, bold = true) {
  slide.addShape(S.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.1,
    fill: { color: fill },
    line: { color: line, width: 0.8 },
  });
  addText(slide, text, x + 0.08, y, w - 0.16, h, {
    fontSize,
    color,
    bold,
    align: "center",
  });
}

function addCircleLabel(slide, text, x, y, d, fill, color = C.white, fontSize = 14) {
  slide.addShape(S.ellipse, {
    x,
    y,
    w: d,
    h: d,
    fill: { color: fill },
    line: { color: C.white, width: 1.2 },
  });
  addText(slide, text, x, y, d, d, {
    fontSize,
    bold: true,
    color,
    align: "center",
  });
}

function addBullets(slide, items, x, y, w, options = {}) {
  const fontSize = options.fontSize || 12.5;
  const lineH = options.lineH || 0.42;
  const dotColor = options.dotColor || C.teal;
  items.forEach((item, index) => {
    const yy = y + index * lineH;
    slide.addShape(S.ellipse, {
      x,
      y: yy + 0.13,
      w: 0.08,
      h: 0.08,
      fill: { color: dotColor },
      line: noLine(),
    });
    addText(slide, item, x + 0.18, yy, w - 0.18, lineH - 0.02, {
      fontSize,
      color: options.color || C.ink,
      bold: options.bold || false,
      valign: "top",
    });
  });
}

function addHeader(slide, index, title, subtitle) {
  slide.background = { color: C.bg };
  slide.addShape(S.rect, { x: 0, y: 0, w: 0.16, h: H, fill: { color: C.teal }, line: noLine() });
  addCircleLabel(slide, String(index).padStart(2, "0"), 0.48, 0.34, 0.46, index % 2 ? C.coral : C.teal, C.white, 11);
  addText(slide, title, 1.08, 0.27, 9.4, 0.5, { fontSize: 24, bold: true, color: C.ink });
  addText(slide, subtitle, 1.1, 0.78, 10.4, 0.28, { fontSize: 10.5, color: C.muted });
  addPill(slide, "GIFP 4.0", 11.62, 0.38, 1.08, 0.34, C.yellowPale, C.coralDark, C.yellow, 10, true);
  slide.addShape(S.line, { x: 0.5, y: 1.14, w: 12.22, h: 0, line: { color: C.line, width: 1 } });
}

function addFooter(slide, text) {
  addText(slide, text, 0.55, 7.05, 11.5, 0.17, { fontSize: 7.5, color: "8E8778" });
}

function addFlowArrow(slide, x1, y1, x2, y2, color = C.teal) {
  slide.addShape(S.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line: { color, width: 1.8, beginArrowType: "none", endArrowType: "triangle" },
  });
}

function addImageFrame(slide, path, x, y, w, h, lineColor = C.line) {
  addCard(slide, x - 0.06, y - 0.06, w + 0.12, h + 0.12, { fill: C.white, line: lineColor, lineWidth: 1.2 });
  slide.addImage({ path, x, y, w, h });
}

function addStage(slide, number, title, note, x, y, w, color, pale) {
  addCard(slide, x, y, w, 1.42, { fill: pale, line: color, lineWidth: 1.1, shadow: false });
  addCircleLabel(slide, String(number), x + 0.15, y + 0.15, 0.36, color, C.white, 11);
  addText(slide, title, x + 0.62, y + 0.12, w - 0.76, 0.35, { fontSize: 14, bold: true, color: C.dark });
  addText(slide, note, x + 0.16, y + 0.56, w - 0.32, 0.68, { fontSize: 10.5, color: C.muted, valign: "top" });
}

// 01 Cover
{
  const slide = pptx.addSlide("GIFP_MASTER");
  slide.background = { color: "F1DCCE" };
  slide.addImage({ path: logoPath, x: 0, y: 0, w: W, h: H });
  slide.addShape(S.rect, {
    x: 0,
    y: 0,
    w: 7.08,
    h: H,
    fill: { color: "FFF9EC", transparency: 8 },
    line: noLine(),
  });
  slide.addShape(S.rect, { x: 0, y: 0, w: 0.17, h: H, fill: { color: C.teal }, line: noLine() });
  addPill(slide, "GIFP 4.0 · 智能动画交付", 0.72, 0.65, 2.43, 0.4, C.tealPale, C.tealDark, C.teal, 11.5);
  addText(slide, "GIFP 4.0", 0.72, 1.32, 5.9, 0.88, { fontSize: 38, bold: true, color: C.ink });
  addText(slide, "让动图先“看懂内容”\n再决定怎么压", 0.72, 2.16, 5.9, 1.35, {
    fontSize: 27,
    bold: true,
    color: C.coralDark,
    breakLine: true,
    valign: "top",
  });
  addText(slide, "从感知 GIF 内核，到 GIF / WebP / APNG / MP4 / WebM 的一体化桌面工作流", 0.75, 3.75, 5.65, 0.78, {
    fontSize: 15,
    color: C.muted,
    breakLine: true,
    valign: "top",
  });
  slide.addShape(S.line, { x: 0.75, y: 4.74, w: 4.95, h: 0, line: { color: C.teal, width: 2.2 } });
  addPill(slide, "Windows", 0.75, 5.05, 1.08, 0.36, C.paper, C.ink, C.line, 10.5);
  addPill(slide, "Tauri / Rust", 1.94, 5.05, 1.36, 0.36, C.paper, C.ink, C.line, 10.5);
  addPill(slide, "FFmpeg", 3.42, 5.05, 1.12, 0.36, C.paper, C.ink, C.line, 10.5);
  addCard(slide, 0.72, 5.72, 5.48, 0.9, { fill: C.yellowPale, line: C.yellow, lineWidth: 1.2, shadow: false });
  addText(slide, "“不是 FFmpeg 参数壳，而是感知动画编译器。”", 1.0, 5.9, 4.95, 0.5, {
    fontSize: 15.5,
    bold: true,
    align: "center",
    color: C.dark,
  });
  addText(slide, "作者：acekanon  ·  2026.07", 0.75, 6.82, 4.1, 0.2, { fontSize: 9, color: C.muted });
  slide.addNotes("开场只讲一件事：GIFP 不只是视频转 GIF。它把内容理解、节奏保留、颜色规划、体积约束和交付格式统一起来。");
}

// 02 Overview map
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 2, "一张图看懂 GIFP", "从多源素材进入四个工作区，再由感知与交付内核输出五种真实格式");

  addCard(slide, 0.55, 1.43, 2.3, 4.96, { fill: C.paper, line: C.coral, lineWidth: 1.2 });
  addPill(slide, "输入素材", 0.82, 1.67, 1.2, 0.38, C.coralPale, C.coralDark, C.coral, 12);
  const inputs = [
    ["动图", "GIF · WebP · APNG", C.coral],
    ["图片", "PNG · JPG · WebP", C.yellow],
    ["视频", "MP4 · MOV\nMKV · WebM", C.blue],
    ["屏幕", "全屏 / 区域录制", C.green],
  ];
  inputs.forEach((item, i) => {
    const y = 2.25 + i * 0.86;
    addCircleLabel(slide, item[0].slice(0, 1), 0.82, y, 0.42, item[2], C.white, 11);
    addText(slide, item[0], 1.38, y - 0.02, 0.64, 0.28, { fontSize: 12.5, bold: true });
    addText(slide, item[1], 1.38, y + 0.28, 1.24, i === 2 ? 0.42 : 0.3, { fontSize: i === 2 ? 8.2 : 9.5, color: C.muted, valign: "top" });
  });
  addText(slide, "FFmpeg 可解码素材统一进入检查、缩略图与队列", 0.8, 5.76, 1.78, 0.42, { fontSize: 9.5, color: C.muted, align: "center" });

  addFlowArrow(slide, 2.9, 3.9, 3.32, 3.9, C.coral);
  addCard(slide, 3.38, 1.43, 6.18, 4.96, { fill: C.paper, line: C.teal, lineWidth: 1.2 });
  addPill(slide, "工作区 + 编译内核", 3.66, 1.67, 1.8, 0.38, C.tealPale, C.tealDark, C.teal, 12);

  const workspaces = [
    ["01", "快速生成", "高频选择 · 一次点击", C.coral, C.coralPale],
    ["02", "精细编辑", "裁剪 · 时间线 · 参数", C.teal, C.tealPale],
    ["03", "合并制作", "重排素材 · 图片停留", C.yellow, C.yellowPale],
    ["04", "屏幕录制", "区域 · FPS · 采集后端", C.blue, C.bluePale],
  ];
  workspaces.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 3.68 + col * 2.84;
    const y = 2.25 + row * 1.08;
    addCard(slide, x, y, 2.55, 0.86, { fill: item[4], line: item[3], lineWidth: 1, shadow: false });
    addCircleLabel(slide, item[0], x + 0.14, y + 0.18, 0.38, item[3], C.white, 8.5);
    addText(slide, item[1], x + 0.62, y + 0.1, 1.7, 0.28, { fontSize: 12.5, bold: true });
    addText(slide, item[2], x + 0.62, y + 0.4, 1.7, 0.22, { fontSize: 8.8, color: C.muted });
  });

  addText(slide, "编译链", 3.72, 4.54, 0.72, 0.3, { fontSize: 11.5, bold: true, color: C.tealDark });
  const pipeline = [
    ["内容探针", C.coralPale, C.coralDark],
    ["感知时间轴", C.tealPale, C.tealDark],
    ["OKLab / 体积", C.yellowPale, C.coralDark],
    ["能力路由", C.bluePale, "376C83"],
  ];
  pipeline.forEach((item, i) => {
    const x = 3.72 + i * 1.38;
    addPill(slide, item[0], x, 4.95, 1.12, 0.42, item[1], item[2], item[1], 9.4);
    if (i < pipeline.length - 1) addFlowArrow(slide, x + 1.13, 5.16, x + 1.34, 5.16, C.teal);
  });
  addPill(slide, "当前单个", 3.72, 5.7, 1.04, 0.36, C.paper2, C.ink, C.line, 9.5);
  addPill(slide, "3 个真实候选", 4.87, 5.7, 1.34, 0.36, C.paper2, C.ink, C.line, 9.5);
  addPill(slide, "批量队列", 6.32, 5.7, 1.04, 0.36, C.paper2, C.ink, C.line, 9.5);
  addPill(slide, "报告 / 历史", 7.47, 5.7, 1.18, 0.36, C.paper2, C.ink, C.line, 9.5);

  addFlowArrow(slide, 9.62, 3.9, 10.02, 3.9, C.teal);
  addCard(slide, 10.08, 1.43, 2.68, 4.96, { fill: C.paper, line: C.blue, lineWidth: 1.2 });
  addPill(slide, "真实交付", 10.36, 1.67, 1.2, 0.38, C.bluePale, "376C83", C.blue, 12);
  const outputs = [
    ["GIF", "最大兼容", C.coral, C.coralPale],
    ["WebP", "现代动图", C.teal, C.tealPale],
    ["APNG", "透明无损", C.yellow, C.yellowPale],
    ["MP4", "长时 / 高帧率", C.blue, C.bluePale],
    ["WebM", "透明视频", C.purple, C.purplePale],
  ];
  outputs.forEach((item, i) => {
    const y = 2.28 + i * 0.68;
    addPill(slide, item[0], 10.36, y, 0.8, 0.4, item[3], item[2] === C.yellow ? C.coralDark : item[2], item[2], 10.5);
    addText(slide, item[1], 11.35, y, 1.05, 0.4, { fontSize: 10.2, bold: true, color: C.ink });
  });
  addText(slide, "格式 / codec / alpha / 体积 / 帧数 / 耗时均进入结果报告", 10.34, 5.84, 2.0, 0.36, { fontSize: 9.2, color: C.muted, align: "center" });
  addFooter(slide, "当前能力依据 GIFP 4.0 代码、README、后端能力注册表与 4.0 验收基线整理。");
  slide.addNotes("这一页是全局地图。强调输入并不限于视频，输出也不再只有 GIF；四个工作区共享同一套编译与报告链。");
}

// 03 Workspaces
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 3, "四个工作区，覆盖一次点击到精细制作", "同一份素材和参数可以在快速、编辑、合并与录制之间连续工作");
  const cards = [
    {
      title: "快速生成",
      sub: "一次点击完成常规任务",
      color: C.coral,
      pale: C.coralPale,
      bullets: ["拖入素材 + 画面预设", "智能交付与结果切换", "当前 / 3 候选 / 批量"],
    },
    {
      title: "精细编辑",
      sub: "所见即所得地控制画面",
      color: C.teal,
      pale: C.tealPale,
      bullets: ["真实缩略图时间线", "裁剪、删帧、范围与缩放", "滤镜、抖动、Alpha 等参数"],
    },
    {
      title: "合并制作",
      sub: "把动图和图片串成新 GIF",
      color: C.yellow,
      pale: C.yellowPale,
      bullets: ["GIF / PNG / JPG / WebP", "重排、移除、图片停留时间", "宽度、FPS、颜色与循环"],
    },
    {
      title: "屏幕录制",
      sub: "从屏幕直接获得源素材",
      color: C.blue,
      pale: C.bluePale,
      bullets: ["全屏或区域选择", "录制 FPS 与保存目录", "自动 / 序列 / GDI / DDA"],
    },
  ];
  cards.forEach((item, i) => {
    const x = 0.55 + i * 3.08;
    addCard(slide, x, 1.5, 2.78, 4.62, { fill: C.paper, line: item.color, lineWidth: 1.2 });
    slide.addShape(S.roundRect, { x: x + 0.15, y: 1.68, w: 2.48, h: 0.9, fill: { color: item.pale }, line: { color: item.color, width: 0.8 } });
    addCircleLabel(slide, String(i + 1), x + 0.3, 1.88, 0.42, item.color, C.white, 12);
    addText(slide, item.title, x + 0.84, 1.75, 1.57, 0.35, { fontSize: 16, bold: true, color: C.dark });
    addText(slide, item.sub, x + 0.84, 2.1, 1.58, 0.26, { fontSize: 9, color: C.muted });
    addBullets(slide, item.bullets, x + 0.28, 2.88, 2.24, { fontSize: 11.2, lineH: 0.62, dotColor: item.color });
    slide.addShape(S.line, { x: x + 0.28, y: 4.89, w: 2.18, h: 0, line: { color: C.line, width: 0.8, dash: "dash" } });
    const bottom = [
      "高频操作留在首屏",
      "素材与参数切换不丢",
      "至少 2 个素材即可执行",
      "兼容保留，不是 4.0 核心门禁",
    ][i];
    addText(slide, bottom, x + 0.3, 5.06, 2.16, 0.55, { fontSize: 9.5, color: C.muted, align: "center" });
  });
  addCard(slide, 0.55, 6.35, 12.22, 0.53, { fill: C.paper2, line: C.line, shadow: false });
  addText(slide, "交互与外观", 0.78, 6.46, 1.05, 0.27, { fontSize: 11, bold: true, color: C.tealDark });
  addPill(slide, "4 套皮肤", 1.98, 6.42, 1.0, 0.34, C.coralPale, C.coralDark, C.coral, 9.5);
  addPill(slide, "减少动态效果", 3.14, 6.42, 1.28, 0.34, C.tealPale, C.tealDark, C.teal, 9.5);
  addPill(slide, "右栏折叠", 4.58, 6.42, 1.0, 0.34, C.yellowPale, C.coralDark, C.yellow, 9.5);
  addPill(slide, "动态能量进度", 5.74, 6.42, 1.26, 0.34, C.greenPale, "34704C", C.green, 9.5);
  addPill(slide, "键盘 / 状态反馈", 7.16, 6.42, 1.36, 0.34, C.bluePale, "376C83", C.blue, 9.5);
  addPill(slide, "输出历史", 8.68, 6.42, 1.0, 0.34, C.purplePale, "66548E", C.purple, 9.5);
  addPill(slide, "统一结果预览", 9.84, 6.42, 1.25, 0.34, C.paper, C.ink, C.line, 9.5);
  addPill(slide, "自定义参数", 11.25, 6.42, 1.05, 0.34, C.paper, C.ink, C.line, 9.5);
  addFooter(slide, "屏幕录制为兼容保留能力；Windows 采集稳定性不属于 4.0 智能交付核心验收范围。");
  slide.addNotes("四个工作区不是四套互相割裂的工具。快速生成负责少选择；精细编辑负责深控制；合并和录屏补齐内容生产入口。");
}

// 04 Editing controls
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 4, "编辑与输出控制：所见即所得，参数可深挖", "时间、画面、颜色和生产效率集中在同一屏，右栏按需展开");
  addImageFrame(slide, editorShot, 0.55, 1.48, 7.28, 4.095, C.teal);
  addPill(slide, "精细编辑实机界面", 0.82, 5.73, 1.55, 0.34, C.tealPale, C.tealDark, C.teal, 9.8);
  addText(slide, "素材队列 · 画面预览 · 时间线 · 输出控制台", 2.54, 5.76, 4.7, 0.25, { fontSize: 10, color: C.muted });

  const callouts = [
    {
      title: "时间线与删帧",
      body: "双手柄裁切；真实缩略图；精确删帧、撤销、清空与重置；删除链同步进入分析、调色板与最终输出。",
      color: C.coral,
      pale: C.coralPale,
    },
    {
      title: "裁剪与预览",
      body: "自由拖框 + 1:1 / 4:3 / 16:9 / 9:16；0.5–4× 缩放；1× / 2× 播放；源素材与结果一键切换。",
      color: C.teal,
      pale: C.tealPale,
    },
    {
      title: "画质参数",
      body: "宽度 96–1920、FPS 1–60、GIF 颜色 3–256；6 滤镜、4 抖动、Bayer 0–5、Alpha 0–255。",
      color: C.yellow,
      pale: C.yellowPale,
    },
    {
      title: "生产效率",
      body: "内置 9 个场景预设；可保存自定义；当前、3 个真实候选、批量队列；输出目录、进度、诊断与历史。",
      color: C.blue,
      pale: C.bluePale,
    },
  ];
  callouts.forEach((item, i) => {
    const y = 1.48 + i * 1.12;
    addCard(slide, 8.08, y, 4.68, 0.96, { fill: item.pale, line: item.color, lineWidth: 1, shadow: false });
    addCircleLabel(slide, String(i + 1), 8.28, y + 0.19, 0.38, item.color, C.white, 11);
    addText(slide, item.title, 8.8, y + 0.1, 1.44, 0.27, { fontSize: 12.2, bold: true });
    addText(slide, item.body, 8.8, y + 0.39, 3.62, 0.42, { fontSize: 9.4, color: C.muted, valign: "top" });
  });

  addText(slide, "画面预设", 8.1, 6.1, 0.9, 0.26, { fontSize: 10.5, bold: true, color: C.coralDark });
  const presetNames = ["极小包", "观感优先", "低噪干净", "字幕保真", "表情包", "竖屏", "微信", "QQ", "B 站"];
  presetNames.forEach((name, i) => {
    const row = Math.floor(i / 5);
    const col = i % 5;
    const x = 9.02 + col * 0.72;
    const y = 6.03 + row * 0.42;
    addPill(slide, name, x, y, 0.64, 0.3, i % 3 === 0 ? C.coralPale : i % 3 === 1 ? C.tealPale : C.yellowPale, C.ink, C.line, 7.9);
  });
  addFooter(slide, "截图来自当前项目的 3.2 Alpha 4 编辑回归；上述编辑能力已在 4.0 中保留并接入智能交付。");
  slide.addNotes("这一页要突出“简单入口和高级控制共存”。删帧不只是 UI 标记，它会进入分析、调色板采样和最终编码链。");
}

// 05 GIF kernel
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 5, "真正的 GIF 编码内核：空间 × 时间 × 颜色联合优化", "三种生成方式对应速度、感知质量与目标体积，而不是三个换皮预设");
  const modes = [
    {
      title: "快速 GIF",
      tag: "FFmpeg 基线",
      color: C.coral,
      pale: C.coralPale,
      points: ["单次编码，速度与稳定优先", "full / diff / single 策略", "rectangle 差分与 GIF 压缩标志"],
    },
    {
      title: "最佳 GIF",
      tag: "Rust 感知优先",
      color: C.teal,
      pale: C.tealPale,
      points: ["8 类帧信号 + 5 种内容重点", "Drop-and-Hold 保节奏抽帧", "加权 OKLab 全局调色板"],
    },
    {
      title: "精确体积",
      tag: "真实多轮编码",
      color: C.yellow,
      pale: C.yellowPale,
      points: ["宽度 → FPS → 颜色 → Bayer", "容差与最大尝试次数", "exact / under / unreachable"],
    },
  ];
  modes.forEach((item, i) => {
    const x = 0.55 + i * 4.1;
    addCard(slide, x, 1.45, 3.82, 1.62, { fill: item.pale, line: item.color, lineWidth: 1.2, shadow: false });
    addText(slide, item.title, x + 0.22, 1.65, 1.65, 0.34, { fontSize: 17, bold: true, color: C.dark });
    addPill(slide, item.tag, x + 2.05, 1.65, 1.46, 0.34, C.paper, C.ink, item.color, 9.2);
    addBullets(slide, item.points, x + 0.24, 2.13, 3.22, { fontSize: 9.6, lineH: 0.29, dotColor: item.color });
  });

  addText(slide, "最佳 GIF 的真实执行链", 0.58, 3.44, 2.2, 0.34, { fontSize: 13, bold: true, color: C.tealDark });
  addStage(slide, 1, "统一解码", "FFmpeg 完成裁剪、缩放、滤镜与颜色变换。", 0.55, 3.9, 2.14, C.coral, C.coralPale);
  addStage(slide, 2, "感知信号", "动作、切镜、边缘/文字、主体、肤色、噪声、变化面积、压缩成本。", 3.04, 3.9, 2.14, C.teal, C.tealPale);
  addStage(slide, 3, "时间调度", "Drop-and-Hold 合并低价值帧时长；首尾与强切镜强制保留。", 5.53, 3.9, 2.14, C.green, C.greenPale);
  addStage(slide, 4, "颜色规划", "按停留时长和重要性加权，生成确定性 OKLab 全局调色板。", 8.02, 3.9, 2.14, C.yellow, C.yellowPale);
  addStage(slide, 5, "索引与写入", "FFmpeg paletteuse 映射、差分矩形、循环与 GIF 写入。", 10.51, 3.9, 2.14, C.blue, C.bluePale);
  for (let i = 0; i < 4; i += 1) {
    const start = 2.72 + i * 2.49;
    addFlowArrow(slide, start, 4.6, start + 0.26, 4.6, C.teal);
  }
  addCard(slide, 0.55, 5.67, 5.94, 0.9, { fill: C.paper, line: C.teal, lineWidth: 1, shadow: false });
  addPill(slide, "时间守恒", 0.79, 5.93, 1.02, 0.32, C.tealPale, C.tealDark, C.teal, 9.3);
  addText(slide, "可变延迟总和严格保持源节奏；超出 GIF 延迟上限时安全回落 CFR。", 1.98, 5.87, 4.12, 0.44, { fontSize: 10.4, color: C.ink });
  addCard(slide, 6.75, 5.67, 5.9, 0.9, { fill: C.paper, line: C.coral, lineWidth: 1, shadow: false });
  addPill(slide, "Alpha 安全门", 6.98, 5.93, 1.2, 0.32, C.coralPale, C.coralDark, C.coral, 9.3);
  addText(slide, "当前 RGB 感知分析不冒充透明感知；检测到真实 alpha 时明确降级。", 8.36, 5.87, 3.95, 0.44, { fontSize: 10.4, color: C.ink });
  addFooter(slide, "gifski 未进入产品运行时；复杂纹理优势保留为离线研发对照，不改变当前自研 + FFmpeg 路线。");
  slide.addNotes("核心差异是同时优化时间、空间和颜色。快速 GIF 是稳定基线；最佳 GIF 才进入感知链；精确体积则用真实多轮编码逼近约束。");
}

// 06 Smart delivery
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 6, "GIFP 4.0 智能交付：用户选意图，系统选格式", "一级入口不要求用户理解 codec；格式选择由内容特征、透明度、时长和目标平台驱动");
  const intents = [
    ["智能推荐", C.tealPale, C.tealDark, C.teal],
    ["最大兼容", C.coralPale, C.coralDark, C.coral],
    ["现代动图", C.yellowPale, C.coralDark, C.yellow],
    ["视频", C.bluePale, "376C83", C.blue],
    ["目标平台", C.purplePale, "66548E", C.purple],
  ];
  intents.forEach((item, i) => addPill(slide, item[0], 0.55 + i * 1.53, 1.39, 1.32, 0.4, item[1], item[2], item[3], 10.5));
  addText(slide, "按时长 / FPS / Alpha / 内容重点 / 源类型自动路由", 8.36, 1.43, 4.18, 0.3, { fontSize: 10.5, color: C.muted, align: "right" });

  const cols = [
    { x: 0.55, w: 1.3, label: "格式" },
    { x: 1.86, w: 3.2, label: "最适合的场景" },
    { x: 5.07, w: 1.5, label: "透明度" },
    { x: 6.58, w: 2.25, label: "真实编码" },
    { x: 8.84, w: 3.93, label: "典型路由" },
  ];
  cols.forEach((col) => {
    slide.addShape(S.rect, { x: col.x, y: 1.99, w: col.w - 0.01, h: 0.48, fill: { color: C.dark }, line: { color: C.dark } });
    addText(slide, col.label, col.x + 0.1, 1.99, col.w - 0.2, 0.48, { fontSize: 10.5, bold: true, color: C.white, align: col.x === 0.55 ? "center" : "left" });
  });
  const rows = [
    ["GIF", "未知平台、聊天粘贴、严格兼容", "索引透明", "FFmpeg GIF + 感知链", "聊天 / 未知平台 → GIF", C.coral, C.coralPale],
    ["WebP", "短动图、现代网页、完整 alpha", "完整 Alpha", "libwebp_anim", "现代网页 → Animated WebP", C.teal, C.tealPale],
    ["APNG", "UI、文字、像素画、透明无损", "完整 Alpha", "APNG encoder + muxer", "透明 UI / 平面动画 → APNG", C.yellow, C.yellowPale],
    ["MP4", "长时长、高帧率、照片运动", "不保留", "libx264 · yuv420p · faststart", "社交视频 / 普通长素材 → MP4", C.blue, C.bluePale],
    ["WebM", "长时透明素材、网页透明视频", "完整 Alpha", "libvpx-vp9 · yuva420p", "透明 + 长时 / 高 FPS → WebM", C.purple, C.purplePale],
  ];
  rows.forEach((row, i) => {
    const y = 2.48 + i * 0.72;
    slide.addShape(S.rect, {
      x: 0.55,
      y,
      w: 12.22,
      h: 0.69,
      fill: { color: i % 2 === 0 ? C.paper : C.paper2 },
      line: { color: C.line, width: 0.5 },
    });
    addPill(slide, row[0], 0.75, y + 0.15, 0.9, 0.36, row[6], row[5] === C.yellow ? C.coralDark : row[5], row[5], 10.5);
    addText(slide, row[1], 1.98, y + 0.05, 2.9, 0.58, { fontSize: 10.2, color: C.ink });
    addText(slide, row[2], 5.18, y + 0.05, 1.28, 0.58, { fontSize: 10, bold: true, color: row[2] === "不保留" ? C.coralDark : C.tealDark });
    addText(slide, row[3], 6.7, y + 0.05, 2.02, 0.58, { fontSize: 9.5, color: C.ink });
    addText(slide, row[4], 8.98, y + 0.05, 3.56, 0.58, { fontSize: 9.8, color: C.muted });
  });
  addCard(slide, 0.55, 6.28, 12.22, 0.58, { fill: C.greenPale, line: C.green, lineWidth: 1, shadow: false });
  addText(slide, "运行时能力探测", 0.78, 6.42, 1.4, 0.28, { fontSize: 10.5, bold: true, color: "34704C" });
  addFlowArrow(slide, 2.28, 6.55, 3.0, 6.55, C.green);
  addText(slide, "验证 encoder + muxer 对", 3.14, 6.42, 2.05, 0.28, { fontSize: 10.2, color: C.ink });
  addFlowArrow(slide, 5.32, 6.55, 6.05, 6.55, C.green);
  addText(slide, "缺失目标格式时回落 GIF", 6.18, 6.42, 2.16, 0.28, { fontSize: 10.2, color: C.ink });
  addFlowArrow(slide, 8.48, 6.55, 9.22, 6.55, C.green);
  addText(slide, "报告真实格式、codec 与原因", 9.34, 6.42, 2.98, 0.28, { fontSize: 10.2, color: C.ink });
  addFooter(slide, "Animated AVIF 仍处于 Labs 方向，未作为 GIFP 4.0 稳定格式暴露。");
  slide.addNotes("用户选择的是意图，而不是六个编码器按钮。重点讲清 GIF 仍保留为兼容出口，WebP/APNG/视频负责突破体积、透明度和时长上限。");
}

// 07 Delivery quality
{
  const slide = pptx.addSlide("GIFP_MASTER");
  addHeader(slide, 7, "可交付，不只可生成", "每次输出都有可解释报告、能力探测与分发边界，结果可以复现和审计");
  const x1 = 0.55;
  const x2 = 4.71;
  const x3 = 8.87;
  const cw = 3.9;
  addCard(slide, x1, 1.45, cw, 4.75, { fill: C.paper, line: C.teal, lineWidth: 1.2 });
  addPill(slide, "可解释结果", x1 + 0.24, 1.68, 1.25, 0.38, C.tealPale, C.tealDark, C.teal, 11);
  addText(slide, "一次导出报告包含", x1 + 0.25, 2.25, 2.2, 0.3, { fontSize: 12.5, bold: true });
  const reportRows = [
    ["交付", "格式 · codec · Alpha"],
    ["结果", "体积 · 帧数 · 宽度 · FPS · 颜色"],
    ["执行", "后端 · 版本 · 耗时 · 尝试次数"],
    ["约束", "目标偏差 · 最终参数 · 状态"],
    ["诊断", "警告 · 降级原因 · 调色板策略"],
    ["感知", "时间轴摘要 · OKLab 指标 · SHA-256"],
  ];
  reportRows.forEach((row, i) => {
    const y = 2.75 + i * 0.5;
    addPill(slide, row[0], x1 + 0.25, y, 0.63, 0.31, i % 2 ? C.paper2 : C.tealPale, C.tealDark, C.line, 8.8);
    addText(slide, row[1], x1 + 1.02, y - 0.02, 2.5, 0.34, { fontSize: 9.8, color: C.ink });
  });

  addCard(slide, x2, 1.45, cw, 4.75, { fill: C.paper, line: C.green, lineWidth: 1.2 });
  addPill(slide, "工程可靠性", x2 + 0.24, 1.68, 1.25, 0.38, C.greenPale, "34704C", C.green, 11);
  addBullets(slide, [
    "后端能力注册表：FFmpeg 动画交付 + Rust 感知核心",
    "从应用同目录 / bin / sidecars / PATH 发现 FFmpeg",
    "逐项探测调色板、差分矩形与五种格式能力",
    "真实缩略图、真实候选、真实编码 smoke",
    "透明输出按解码像素验证，不靠源素材推断",
    "前端 + Rust 自动化测试与 release 门禁",
    "便携 EXE / ZIP 记录版本、构建、SHA 与许可证",
  ], x2 + 0.27, 2.33, 3.35, { fontSize: 10.2, lineH: 0.48, dotColor: C.green });

  addCard(slide, x3, 1.45, cw, 4.75, { fill: C.paper, line: C.coral, lineWidth: 1.2 });
  addPill(slide, "明确边界", x3 + 0.24, 1.68, 1.14, 0.38, C.coralPale, C.coralDark, C.coral, 11);
  addBullets(slide, [
    "gifski 仅作离线研发基准，不进入运行时 / UI / 降级链",
    "外置 GIF 后处理器当前只保留能力占位",
    "Animated AVIF 仍是 Labs，未作为稳定格式暴露",
    "屏幕录制是兼容保留项，不代表 4.0 核心验收",
    "公开分发前需审查 FFmpeg / GPL 对应源码与分发方式",
  ], x3 + 0.27, 2.33, 3.32, { fontSize: 10.4, lineH: 0.61, dotColor: C.coral });
  slide.addImage({ path: presetPortrait, x: x3 + 2.94, y: 5.18, w: 0.55, h: 0.91 });

  addCard(slide, 0.55, 6.39, 12.22, 0.58, { fill: C.yellowPale, line: C.yellow, lineWidth: 1.1, shadow: false });
  addText(slide, "GIF 是最大兼容出口", 0.85, 6.49, 2.06, 0.34, { fontSize: 13.2, bold: true, color: C.coralDark });
  addFlowArrow(slide, 3.03, 6.68, 3.78, 6.68, C.coral);
  addText(slide, "WebP / APNG / MP4 / WebM 负责突破透明度、体积和时长上限", 3.96, 6.48, 7.9, 0.36, {
    fontSize: 13,
    bold: true,
    color: C.dark,
    align: "center",
  });
  addFooter(slide, "GIFP 4.0 · 感知动画编译器 · 作者 acekanon");
  slide.addNotes("收束在“可交付”。GIFP 会说明到底用了什么格式、什么后端、是否保留 alpha、为什么降级；同时不把规划项或许可未决项包装成已完成能力。");
}

await pptx.writeFile({ fileName: outPath, compression: true });
console.log(outPath);
