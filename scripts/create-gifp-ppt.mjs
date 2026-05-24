import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const outDir = resolve("docs");
const workDir = resolve("docs/.gifp_ppt_work");
const outPath = resolve("docs/GIF_P_2026_pitch.pptx");
const zipPath = resolve("docs/GIF_P_2026_pitch.zip");
const EMU = 914400;
const W = 13.333;
const H = 7.5;

const C = {
  paper: "FFF4C7",
  ink: "24190F",
  blue: "47A8FF",
  red: "FF5B4F",
  yellow: "FFD744",
  white: "FFF9DC",
};

const slides = [
  {
    title: "GIF_P",
    kicker: "2026 年了，GIF 不该还像 1997 年",
    body: [
      "一个观众只想要：把 15 秒视频变成表情包。",
      "结果打开工具箱：命令行、老算法、随机糊、随机大。",
      "于是我们决定：氛围编程一把，从零重做。",
    ],
    punch: "目标：别糊、别大、别变速、别让人读说明书。",
  },
  {
    title: "需求其实很朴素",
    kicker: "观众没有要登月，他只是想发群",
    body: [
      "输入：一个 MP4，通常 15 秒以内。",
      "输出：一张能发、能看、能笑的 GIF。",
      "最好：拖进去，点一下，别问我什么 paletteuse。",
    ],
    punch: "用户画像：想做表情包的人，不是想考 FFmpeg 证的人。",
  },
  {
    title: "然后发现现实很 2010",
    kicker: "2026 年的视频转 GIF，还是老三样",
    body: [
      "均匀降帧：重要动作不一定留下，尴尬帧倒是很稳定。",
      "Median-Cut 调色：颜色少了，灵魂也少了。",
      "命令行炼丹：压缩一次像启动小型仪式。",
    ],
    punch: "最离谱的 bug：去掉冗余帧以后，人物突然开始赶高铁。",
  },
  {
    title: "GIF_P 的答案",
    kicker: "把压缩工具做成一个小型游戏面板",
    body: [
      "拖拽导入 MP4，支持批量队列。",
      "左侧是预设，右侧是参数，中间是预览和裁剪。",
      "Windows 免安装 exe，FFmpeg 已装即可开跑。",
    ],
    punch: "看起来像儿童画，干活像生产工具。",
  },
  {
    title: "算法不再装作看不见画面",
    kicker: "不是更快的老工具，是更懂画面的新流程",
    body: [
      "Lab 感知量化：颜色按人眼感知距离聚类，不按 RGB 瞎猜。",
      "Smart Drop：去掉冗余帧，但保留原始 PTS，播放速度不乱飞。",
      "边缘感知有损：压小体积时，优先保护轮廓和表情。",
      "局部调色板 + 抖动策略：在糊和噪之间找一条能看的路。",
    ],
    punch: "一句话：少留废帧，多留表情。",
  },
  {
    title: "旧方案 vs GIF_P",
    kicker: "同样是 GIF，精神状态完全不同",
    table: [
      ["项目", "老工具", "GIF_P"],
      ["抽帧", "均匀抽，听天由命", "冗余检测，保节奏"],
      ["色彩", "传统切色", "Lab 感知量化"],
      ["裁剪", "填数字，靠想象", "画面上直接拖框"],
      ["批量", "脚本自己写", "队列 + 进度条"],
      ["分发", "环境随缘", "单个 GIF_P.exe"],
    ],
    punch: "不是把按钮做大，是把痛点做小。",
  },
  {
    title: "界面：四种颜色，十成功力",
    kicker: "P5 游戏风 + 儿童画，拒绝灰色工业废土",
    body: [
      "极小包：聊天发送，体积优先。",
      "观感优先：默认推荐，画质和压缩平衡。",
      "干净通过：字幕、录屏、界面素材更稳。",
      "表情包：强压缩，保动作和轮廓。",
    ],
    punch: "参数很多，但先给你四个能用的人话按钮。",
  },
  {
    title: "2026 年的 GIF 就该这样压",
    kicker: "最后成品",
    body: [
      "MP4 拖进去，GIF 吐出来。",
      "想懒：选预设。想控：调帧率、颜色、抖动、有损、裁剪。",
      "想批量：排队处理，看进度条。",
      "想发给别人：一个 exe，走起。",
    ],
    punch: "GIF 没有过时，过时的是我们对 GIF 的耐心。",
  },
];

function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emu(n) {
  return Math.round(n * EMU);
}

function rel(p) {
  return p.replaceAll("\\", "/");
}

function shape(id, x, y, w, h, { fill = C.white, line = C.ink, lineW = 3, radius = false } = {}) {
  const geom = radius ? "roundRect" : "rect";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln w="${lineW * 12700}"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

function textBox(id, x, y, w, h, lines, {
  size = 24,
  color = C.ink,
  bold = false,
  align = "l",
  fill = null,
  line = null,
  margin = 0.08,
  font = "Microsoft YaHei",
} = {}) {
  const paragraphs = lines.map((lineText) => {
    const text = esc(lineText);
    return `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${size * 100}" ${bold ? 'b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/></a:rPr><a:t>${text}</a:t></a:r></a:p>`;
  }).join("");
  const fillXml = fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : `<a:noFill/>`;
  const lineXml = line ? `<a:ln w="25400"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : `<a:ln><a:noFill/></a:ln>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${emu(margin)}" tIns="${emu(margin)}" rIns="${emu(margin)}" bIns="${emu(margin)}"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function doodles(startId) {
  let id = startId;
  const parts = [];
  for (let x = 0; x <= W; x += 0.55) {
    parts.push(shape(id++, x, 0, 0.006, H, { fill: "FFFFFF", line: "E6DCA7", lineW: 0.5 }));
  }
  for (let y = 0; y <= H; y += 0.55) {
    parts.push(shape(id++, 0, y, W, 0.006, { fill: "FFFFFF", line: "E6DCA7", lineW: 0.5 }));
  }
  parts.push(shape(id++, 0.25, 0.22, 0.52, 0.52, { fill: C.yellow, lineW: 3 }));
  parts.push(textBox(id++, 0.36, 0.31, 0.3, 0.3, ["P"], { size: 18, bold: true, align: "ctr" }));
  parts.push(shape(id++, 11.85, 6.72, 0.28, 0.28, { fill: C.red, lineW: 2 }));
  parts.push(shape(id++, 12.2, 6.72, 0.28, 0.28, { fill: C.blue, lineW: 2 }));
  parts.push(shape(id++, 12.55, 6.72, 0.28, 0.28, { fill: C.yellow, lineW: 2 }));
  return parts.join("");
}

function slideXml(slide, idx) {
  let id = 10;
  const parts = [
    shape(id++, 0, 0, W, H, { fill: C.paper, line: C.paper, lineW: 0 }),
    doodles(300 + idx * 100),
    shape(id++, 0.55, 0.45, 12.25, 6.45, { fill: C.white, lineW: 4 }),
    shape(id++, 0.55, 0.45, 12.25, 0.72, { fill: idx % 2 ? C.blue : C.yellow, lineW: 4 }),
    textBox(id++, 0.78, 0.56, 7.2, 0.5, [slide.kicker], { size: 16, bold: true }),
    textBox(id++, 0.78, 1.38, 7.9, 1.1, [slide.title], { size: idx === 0 ? 56 : 38, bold: true, color: C.red, font: "Comic Sans MS" }),
  ];

  if (slide.table) {
    const x = 0.95;
    const y = 2.25;
    const rowH = 0.58;
    const cols = [2.0, 4.15, 4.65];
    slide.table.forEach((row, r) => {
      let cx = x;
      row.forEach((cell, c) => {
        const fill = r === 0 ? C.ink : c === 2 ? C.yellow : C.white;
        const color = r === 0 ? C.white : c === 2 ? C.red : C.ink;
        parts.push(shape(id++, cx, y + r * rowH, cols[c], rowH, { fill, lineW: 2 }));
        parts.push(textBox(id++, cx + 0.05, y + r * rowH + 0.06, cols[c] - 0.1, rowH - 0.08, [cell], {
          size: r === 0 ? 15 : 14,
          bold: true,
          color,
          margin: 0.02,
        }));
        cx += cols[c];
      });
    });
  } else {
    slide.body.forEach((line, lineIdx) => {
      const y = 2.55 + lineIdx * 0.62;
      parts.push(shape(id++, 1.0, y + 0.1, 0.17, 0.17, { fill: [C.red, C.blue, C.yellow, C.red][lineIdx % 4], lineW: 2 }));
      parts.push(textBox(id++, 1.32, y, 10.25, 0.48, [line], { size: 20, bold: true }));
    });
  }

  parts.push(shape(id++, 1.0, 5.9, 11.05, 0.72, { fill: idx === 7 ? C.red : C.yellow, lineW: 3 }));
  parts.push(textBox(id++, 1.18, 6.05, 10.65, 0.38, [slide.punch], {
    size: 18,
    bold: true,
    color: idx === 7 ? C.white : C.ink,
    align: "ctr",
  }));
  parts.push(textBox(id++, 9.72, 0.57, 2.75, 0.42, [`0${idx + 1} / 08`], { size: 14, bold: true, align: "r" }));
  if (idx === 0) {
    parts.push(textBox(id++, 0.8, 6.93, 9.8, 0.28, ["叙事节奏参考：何同学《有多快？5G在日常使用中的真实体验》（2019-06-06）。本稿未引用原视频台词。"], { size: 8, color: "6D6244" }));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(W)}" cy="${emu(H)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(W)}" cy="${emu(H)}"/></a:xfrm></p:grpSpPr>${parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function write(path, content) {
  const full = join(workDir, path);
  mkdirSync(full.slice(0, full.lastIndexOf("\\")), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function contentTypes() {
  const slideOverrides = slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`;
}

function presentation() {
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${emu(W)}" cy="${emu(H)}" type="wide"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

function presRels() {
  const rels = [`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>`];
  slides.forEach((_, i) => rels.push(`<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

const minimalSpTree = `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(W)}" cy="${emu(H)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(W)}" cy="${emu(H)}"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>`;

const slideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${minimalSpTree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
const slideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">${minimalSpTree}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="GIF_P"><a:themeElements><a:clrScheme name="GIF_P"><a:dk1><a:srgbClr val="${C.ink}"/></a:dk1><a:lt1><a:srgbClr val="${C.paper}"/></a:lt1><a:dk2><a:srgbClr val="000000"/></a:dk2><a:lt2><a:srgbClr val="FFFFFF"/></a:lt2><a:accent1><a:srgbClr val="${C.red}"/></a:accent1><a:accent2><a:srgbClr val="${C.blue}"/></a:accent2><a:accent3><a:srgbClr val="${C.yellow}"/></a:accent3><a:accent4><a:srgbClr val="FFFFFF"/></a:accent4><a:accent5><a:srgbClr val="666666"/></a:accent5><a:accent6><a:srgbClr val="999999"/></a:accent6><a:hlink><a:srgbClr val="${C.blue}"/></a:hlink><a:folHlink><a:srgbClr val="${C.red}"/></a:folHlink></a:clrScheme><a:fontScheme name="GIF_P"><a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:majorFont><a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme><a:fmtScheme name="GIF_P"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

rmSync(workDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

write("[Content_Types].xml", contentTypes());
write("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
write("ppt/presentation.xml", presentation());
write("ppt/_rels/presentation.xml.rels", presRels());
write("ppt/slideMasters/slideMaster1.xml", slideMaster);
write("ppt/slideMasters/_rels/slideMaster1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
write("ppt/slideLayouts/slideLayout1.xml", slideLayout);
write("ppt/slideLayouts/_rels/slideLayout1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
write("ppt/theme/theme1.xml", theme);
slides.forEach((slide, i) => write(`ppt/slides/slide${i + 1}.xml`, slideXml(slide, i)));

if (existsSync(outPath)) rmSync(outPath, { force: true });
if (existsSync(zipPath)) rmSync(zipPath, { force: true });
execFileSync("powershell", [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  `Compress-Archive -Path '${rel(workDir)}/*' -DestinationPath '${rel(zipPath)}' -Force; Move-Item -LiteralPath '${rel(zipPath)}' -Destination '${rel(outPath)}' -Force`,
], { stdio: "inherit" });

rmSync(workDir, { recursive: true, force: true });
console.log(outPath);
