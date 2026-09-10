import type { OutputFormat } from "../tauri";

export type PlatformPolicyVerification = "verified" | "documented" | "unverified";

export type PlatformPolicyId =
  | "qq_chat"
  | "wechat_chat"
  | "wechat_sticker"
  | "feishu_chat"
  | "xiaohongshu_live"
  | "douyin_live"
  | "web_animation"
  | "web_transparent_ui";

export type PlatformPolicy = {
  id: PlatformPolicyId;
  revision: string;
  label: string;
  surface: string;
  acceptedFormats: readonly OutputFormat[];
  verification: PlatformPolicyVerification;
  source: {
    kind: "official" | "client_test" | "product_guidance";
    label: string;
    url?: string;
  };
  testedClients: readonly string[];
  fallbackFormat: OutputFormat;
  guidance: {
    maxWidth?: number;
    maxFps?: number;
    maxDurationSeconds?: number;
    targetSizeMb?: number;
    aspect?: number;
  };
};

export const PLATFORM_POLICY_SET_VERSION = "2026.07.27";

export const PLATFORM_POLICIES: readonly PlatformPolicy[] = [
  {
    id: "qq_chat",
    revision: "1",
    label: "QQ 聊天动图",
    surface: "QQ 聊天发送、转发与保存",
    acceptedFormats: ["gif"],
    verification: "unverified",
    source: { kind: "client_test", label: "待补当前稳定客户端全链路实测" },
    testedClients: [],
    fallbackFormat: "gif",
    guidance: { maxWidth: 560, maxFps: 18, targetSizeMb: 1.9 },
  },
  {
    id: "wechat_chat",
    revision: "1",
    label: "微信聊天动图",
    surface: "微信聊天发送、转发与保存",
    acceptedFormats: ["gif"],
    verification: "unverified",
    source: { kind: "client_test", label: "待补当前稳定客户端全链路实测" },
    testedClients: [],
    fallbackFormat: "gif",
    guidance: { maxWidth: 420, maxFps: 15, targetSizeMb: 1.9 },
  },
  {
    id: "wechat_sticker",
    revision: "1",
    label: "微信收藏表情",
    surface: "微信收藏表情导入、播放与转发",
    acceptedFormats: ["gif"],
    verification: "unverified",
    source: { kind: "client_test", label: "500 KB 等参数仅作保守模板，待当前客户端实测" },
    testedClients: [],
    fallbackFormat: "gif",
    guidance: { maxWidth: 240, maxFps: 12, maxDurationSeconds: 3, targetSizeMb: 0.48, aspect: 1 },
  },
  {
    id: "feishu_chat",
    revision: "1",
    label: "飞书聊天动图",
    surface: "飞书聊天发送、转发与下载",
    acceptedFormats: ["gif"],
    verification: "unverified",
    source: { kind: "client_test", label: "待补桌面端与移动端全链路实测" },
    testedClients: [],
    fallbackFormat: "gif",
    guidance: { maxWidth: 560, maxFps: 18 },
  },
  {
    id: "xiaohongshu_live",
    revision: "1",
    label: "小红书 Live 图",
    surface: "小红书 Live 图发布",
    acceptedFormats: ["live_photo"],
    verification: "unverified",
    source: { kind: "client_test", label: "待补当前移动客户端发布与下载恢复实测" },
    testedClients: [],
    fallbackFormat: "mp4",
    guidance: { maxWidth: 1080, maxFps: 30, maxDurationSeconds: 3, aspect: 3 / 4 },
  },
  {
    id: "douyin_live",
    revision: "1",
    label: "抖音 Live 图",
    surface: "抖音 Live 图发布",
    acceptedFormats: ["live_photo"],
    verification: "unverified",
    source: { kind: "client_test", label: "待补当前移动客户端发布与下载恢复实测" },
    testedClients: [],
    fallbackFormat: "mp4",
    guidance: { maxWidth: 1080, maxFps: 30, maxDurationSeconds: 3, aspect: 9 / 16 },
  },
  {
    id: "web_animation",
    revision: "1",
    label: "网页轻量动图",
    surface: "现代浏览器图片动画",
    acceptedFormats: ["webp", "gif"],
    verification: "documented",
    source: {
      kind: "official",
      label: "Google WebP 动画格式说明；具体站点仍需部署验证",
      url: "https://developers.google.com/speed/webp",
    },
    testedClients: [],
    fallbackFormat: "gif",
    guidance: { maxWidth: 960, maxFps: 24 },
  },
  {
    id: "web_transparent_ui",
    revision: "1",
    label: "网页透明 UI 动效",
    surface: "现代浏览器透明 UI 动画",
    acceptedFormats: ["apng", "webp"],
    verification: "documented",
    source: {
      kind: "official",
      label: "APNG 格式文档；具体站点仍需部署验证",
      url: "https://developer.mozilla.org/docs/Web/Media/Guides/Formats/Image_types#apng_animated_portable_network_graphics",
    },
    testedClients: [],
    fallbackFormat: "webp",
    guidance: { maxWidth: 960, maxFps: 30 },
  },
];

export function platformPolicyById(id: PlatformPolicyId) {
  return PLATFORM_POLICIES.find((policy) => policy.id === id);
}

export function platformPolicyVerificationLabel(verification: PlatformPolicyVerification) {
  if (verification === "verified") return "已实机验证";
  if (verification === "documented") return "有文档依据 · 待端到端验证";
  return "待客户端实测";
}
