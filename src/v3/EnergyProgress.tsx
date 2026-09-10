import { CheckCircle, FilmStrip, Hamburger, Lightning, Sparkle, X } from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MASCOT_SRC = "/gacha/mascot-crank.png";

const RECIPES: Record<string, { name: string; layers: string[]; note: string }> = {
  GIF: { name: "经典兼容堡", layers: ["lettuce", "cheese", "patty"], note: "兼容优先" },
  WEBP: { name: "牛油果透明堡", layers: ["avocado", "onion", "patty"], note: "现代动图" },
  APNG: { name: "无损彩虹堡", layers: ["lettuce", "rainbow", "tomato"], note: "完整透明" },
  MP4: { name: "双层视频堡", layers: ["patty", "cheese", "patty"], note: "高帧率" },
  WEBM: { name: "夜色蔬菜堡", layers: ["onion", "lettuce", "avocado"], note: "网页视频" },
  LIVE_PHOTO: { name: "苹果实况堡", layers: ["avocado", "cheese", "patty"], note: "静态图 + MOV" },
};

const FORMAT_EASTER_EGGS: Record<string, "pickle" | "cheese" | "steam"> = {
  GIF: "pickle",
  WEBP: "steam",
  APNG: "cheese",
  MP4: "steam",
  WEBM: "pickle",
  LIVE_PHOTO: "steam",
};

type Props = {
  progress: number;
  busy: boolean;
  status: string;
  sourceLabel?: string;
  outputFormat?: string;
  resultUrl?: string;
  compressionPercent?: number;
};

export function EnergyProgress({
  progress,
  busy,
  status,
  sourceLabel = "等待投放素材",
  outputFormat = "GIF",
  resultUrl = "",
  compressionPercent = 0,
}: Props) {
  const [kitchenOpen, setKitchenOpen] = useState(false);
  const kitchenId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hasOpenedRef = useRef(false);
  const value = Math.max(0, Math.min(100, Math.round(progress)));
  const compression = Math.max(0, Math.min(100, Math.round(compressionPercent)));
  const failed = !busy && /失败|错误|不可用/.test(status);
  const phase = failed ? "error" : value >= 100 ? "complete" : busy ? "busy" : "idle";
  const pace = value >= 66 ? "fast" : value >= 30 ? "medium" : "slow";
  const label = phase === "error"
    ? "汉堡弹回来了"
    : phase === "complete"
      ? "已生成"
      : phase === "busy"
        ? "正在锤出更小成品"
        : "等待开始压制";
  const normalizedFormat = outputFormat.toUpperCase();
  const displayFormat = normalizedFormat === "LIVE_PHOTO" ? "实况" : normalizedFormat;
  const recipe = RECIPES[normalizedFormat] ?? RECIPES.GIF;
  const canPreviewImage = Boolean(resultUrl) && !["MP4", "WEBM"].includes(normalizedFormat);
  const flattenProgress = Math.min(1, compression / 90);
  const squish = Number((1 - 0.6 * flattenProgress).toFixed(3));
  const spread = Number((1 + 0.16 * flattenProgress).toFixed(3));
  const reboundSquish = Number(Math.min(1, squish + 0.08).toFixed(3));
  const easterEgg = failed ? "none" : FORMAT_EASTER_EGGS[normalizedFormat] ?? "pickle";
  const stageStyle = {
    "--burger-squish": squish,
    "--burger-spread": spread,
    "--burger-rebound-squish": reboundSquish,
    "--compression-level": compression / 100,
  } as CSSProperties;

  useEffect(() => {
    if (!kitchenOpen) {
      if (hasOpenedRef.current) triggerRef.current?.focus();
      return undefined;
    }

    hasOpenedRef.current = true;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setKitchenOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [kitchenOpen]);

  return (
    <section
      className={`energy-progress burger-progress phase-${phase} pace-${pace}`}
      data-format={normalizedFormat}
      data-compression={compression}
    >
      <div
        className={`energy-progress__meter phase-${phase} pace-${pace}`}
        role="progressbar"
        aria-label="生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${label}，${displayFormat}，压缩 ${compression}%，进度 ${value}%`}
        aria-live="polite"
        aria-atomic="true"
        title={status}
        data-format={normalizedFormat}
        data-compression={compression}
      >
        <div className="energy-progress__heading">
          <span>{phase === "complete" ? <CheckCircle weight="fill" /> : <Lightning weight="fill" />}<strong>{label}</strong></span>
          <b>{value}%</b>
        </div>

        <div className="energy-progress__track">
          <div className="energy-progress__fill" style={{ width: `${value}%` }}>
            <span className="energy-progress__shine" />
            <Sparkle className="energy-progress__spark spark-one" weight="fill" />
            <Sparkle className="energy-progress__spark spark-two" weight="fill" />
            <Sparkle className="energy-progress__spark spark-three" weight="fill" />
            <span className="energy-progress__front" />
          </div>
        </div>
        {phase !== "complete" && (
          <small>{busy || phase === "error" || status !== "准备就绪" ? status : "选择方案后开始生成"}</small>
        )}
      </div>

      <button
        ref={triggerRef}
        className="burger-easter-trigger"
        type="button"
        aria-label="打开压堡彩蛋"
        aria-expanded={kitchenOpen}
        aria-controls={kitchenId}
        onClick={() => setKitchenOpen(true)}
      >
        <Hamburger weight="fill" aria-hidden="true" />
      </button>

      {kitchenOpen && typeof document !== "undefined" && createPortal(
        <div
          className="burger-kitchen-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setKitchenOpen(false);
          }}
        >
          <div
            id={kitchenId}
            className={`burger-kitchen burger-progress ${failed ? "phase-error" : "phase-strike"}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${kitchenId}-title`}
            data-format={normalizedFormat}
            data-phase={phase}
            data-compression={compression}
          >
            <div className="burger-kitchen__heading">
              <span><Sparkle weight="fill" /><strong id={`${kitchenId}-title`}>压堡小厨房</strong></span>
              <span>{displayFormat} · 压缩 {compression}%</span>
              <button ref={closeRef} type="button" aria-label="关闭压堡彩蛋" onClick={() => setKitchenOpen(false)}><X /></button>
            </div>

            <div className="burger-progress__stage" data-easter={easterEgg} data-contact-frame="50" style={stageStyle} aria-hidden="true">
              <div className="burger-source-ticket">
                <FilmStrip weight="fill" />
                <span>{sourceLabel}</span>
              </div>

              <img className="burger-mascot" src={MASCOT_SRC} alt="" />
              <span className="burger-hammer"><i className="burger-hammer__head" /><i className="burger-hammer__handle" /></span>

              <div className="burger-order">
                <span className="burger-steam steam-one">♡</span>
                <span className="burger-steam steam-two">•</span>
                <div className="burger-stack" data-recipe={normalizedFormat}>
                  <span className="burger-bun burger-bun--top"><i /><b>{displayFormat}</b></span>
                  {recipe.layers.map((layer, index) => <span className={`burger-layer burger-layer--${layer}`} key={`${layer}-${index}`} />)}
                  <span className="burger-bun burger-bun--bottom" />
                </div>
                <span className="burger-plate" />
                <div className="burger-recipe"><strong>{recipe.name}</strong><small>{recipe.note} · 压缩 {compression}%</small></div>
              </div>

              <span className="burger-pickle-easter" />
              <span className="burger-cheese-easter" />
              <Sparkle className="burger-burst burst-one" weight="fill" />
              <Sparkle className="burger-burst burst-two" weight="fill" />

              {phase === "complete" && (
                <div className="burger-result-ticket">
                  {canPreviewImage ? <img src={resultUrl} alt="" /> : <Hamburger weight="fill" />}
                  <b>{displayFormat}</b>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.querySelector(".gifp-v3") ?? document.body,
      )}
    </section>
  );
}
