import "./gif-compression-options.css";

export type GifCompressionSwitches = {
  smartLossless?: boolean;
  mergeFrames: boolean;
  compactPalette: boolean;
  smallerGif: boolean;
  indexCompression: boolean;
  gentleIndex: boolean;
};

export function GifCompressionOptions({ value, optimizerReady, disabled = false, onChange, onReset }: {
  value: GifCompressionSwitches;
  optimizerReady: boolean;
  disabled?: boolean;
  onChange: (key: keyof GifCompressionSwitches, checked: boolean) => void;
  onReset: () => void;
}) {
  const enabledCount = Number(Boolean(value.smartLossless)) + Number(value.mergeFrames) + Number(value.compactPalette) + Number(value.smallerGif && optimizerReady)
    + Number(value.indexCompression) + Number(value.gentleIndex && value.indexCompression);
  const options = [
    { key: "smartLossless", label: "智能无损优化", tag: "6.0 · 内置", note: "联合优化局部画面、透明复用与播放结构；只采用画面一致的更小文件。" },
    { key: "mergeFrames", label: "合并重复帧", tag: "内置 · 无损", note: "合并相邻重复帧，累计原延时；画面和总时长保持。" },
    { key: "compactPalette", label: "调色表整理", tag: "内置 · 无损", note: "整理未用颜色与索引，尝试减小文件；不改变画面。" },
    { key: "smallerGif", label: "更小优先", tag: "外部 · 无损", unavailable: !optimizerReady,
      note: optimizerReady ? "使用 Gifsicle 进一步整理；只采用更小且验证通过的结果。" : "未检测到 Gifsicle；内置开关仍可使用。" },
    { key: "indexCompression", label: "索引压缩", tag: "内置 · 有损", note: "合并接近颜色的索引；保留尺寸与延时，渐变可能出现色带。" },
    { key: "gentleIndex", label: "温和模式", tag: "更少色差", unavailable: !value.indexCompression,
      note: value.indexCompression ? "降低索引压缩的额外色差，可能减少体积收益。" : "开启索引压缩后可用；更优先保留细微颜色差别。" },
  ] as const;
  return <section className="gif-compression-panel" aria-label="GIF 压缩工具">
    <header><strong>压缩工具</strong><span key={enabledCount} className="gif-compression-count" role="status">已启用 {enabledCount} 项</span>
      <button type="button" disabled={disabled || !Object.values(value).some(Boolean)} onClick={() => { if (!disabled) onReset(); }}>恢复默认</button></header>
    <div className="gif-compression-options">
      {options.map((option, index) => {
        const unavailable = "unavailable" in option && option.unavailable;
        return <div key={option.key}>
          {(index === 0 || option.key === "indexCompression") && <p className="gif-compression-section">{index === 0 ? "无损整理" : "有损压缩"}</p>}
          <label className={`gif-postprocess-option${unavailable || disabled ? " is-disabled" : ""}${option.key === "gentleIndex" ? " is-dependent" : ""}`}>
            <span><strong>{option.label}<em>{option.tag}</em></strong><small>{option.note}</small></span>
            <input type="checkbox" role="switch" aria-label={option.label} checked={Boolean(value[option.key])} disabled={disabled || unavailable}
              onChange={event => { if (!disabled && !unavailable) onChange(option.key, event.currentTarget.checked); }} />
          </label>
        </div>;
      })}
    </div>
    <p className="gif-compression-footnote">生成后逐项验证；没有合格收益就保留原结果。可能增加等待时间。</p>
  </section>;
}
