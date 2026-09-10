import { Check, Drop, ImageSquare, Palette, Sparkle } from "@phosphor-icons/react";
import { useId } from "react";
import type { GifEncoder } from "../tauri";
import "./gif-treatment-picker.css";

const treatments = [
  { value: "hybrid", label: "自动选择", icon: Sparkle, effect: "按帧率与颜色上限选择处理偏好", tradeoff: "不会逐个比较所有方案", detail: "参数改变时，处理偏好也可能改变。" },
  { value: "ffmpeg_fast", label: "保持原貌", icon: ImageSquare, effect: "不额外启用色彩增强与降噪", tradeoff: "原有噪点也会保留", detail: "仍会进行缩放、GIF 调色及你另行选择的效果处理。" },
  { value: "pngquant_opt", label: "色彩增强", icon: Palette, effect: "调整色彩观感，配合轻度降噪", tradeoff: "可能改变原来的颜色", detail: "可用于插画、实拍；颜色需要严格还原时，优先保持原貌。" },
  { value: "clean_opt", label: "降噪平滑", icon: Drop, effect: "减轻颗粒，让渐变更平滑", tradeoff: "可能损失细小纹理", detail: "适合尝试改善噪点；文字、细线和像素画需检查是否被平滑。" },
] as const;

export function GifTreatmentPicker({ value, fps, colors, sourceHasAlpha, onChange }: {
  value: GifEncoder;
  fps: number;
  colors: number;
  sourceHasAlpha?: boolean;
  onChange: (value: GifEncoder) => void;
}) {
  const name = useId();
  const effectiveValue = sourceHasAlpha ? "ffmpeg_fast" : value;
  const selected = treatments.find(item => item.value === effectiveValue) ?? treatments[0];
  const preference = fps <= 15 && colors >= 96 ? "色彩增强" : "保持原貌";
  return <section className="gif-treatment" aria-label="画面处理偏好">
    <header><div><small>LOOK & FEEL</small><h3>画面处理</h3></div><span>选择偏好，查看取舍</span></header>
    <div className="gif-treatment__grid" role="radiogroup" aria-label="快速生成画面处理">
      {treatments.map(item => {
        const chosen = effectiveValue === item.value;
        const disabled = !!sourceHasAlpha && item.value !== "ffmpeg_fast";
        const Icon = item.icon;
        return <label key={item.value} className={`gif-treatment__card${chosen ? " selected" : ""}${disabled ? " unavailable" : ""}`}>
          <input type="radio" name={name} value={item.value} checked={chosen} disabled={disabled} onChange={() => { if (!disabled) onChange(item.value); }} />
          <span className="gif-treatment__icon"><Icon weight="duotone" aria-hidden="true" /></span>
          <strong>{item.label}</strong>
          <span className="gif-treatment__check">{chosen && <><Check weight="bold" aria-hidden="true" />已选</>}</span>
          <span className="gif-treatment__effect">{item.effect}</span>
          <small className="gif-treatment__tradeoff">{disabled ? "保留透明时不可用" : item.tradeoff}</small>
        </label>;
      })}
    </div>
    <div className="gif-treatment__detail" aria-live="polite" aria-atomic="true">
      <div key={`${effectiveValue}-${preference}-${!!sourceHasAlpha}`}>
        <strong>{sourceHasAlpha ? "已适配透明素材" : effectiveValue === "hybrid" ? `当前参数倾向：${preference}` : selected.label}</strong>
        <p>{sourceHasAlpha ? "为保留透明通道，使用保持原貌处理；生成目标仍可独立选择。" : effectiveValue === "hybrid" ? `${fps} FPS · ${colors} 色上限。${selected.detail}` : selected.detail}</p>
      </div>
    </div>
    {!sourceHasAlpha && <p className="gif-treatment__note">这是画面处理偏好；生成时可能根据素材检测适配。速度与体积由生成目标、文件大小上限控制。</p>}
  </section>;
}
