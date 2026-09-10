import type { AdvancedCompressionExecutionReport, AdvancedCompressionStageReport } from "../tauri";
import "./advanced-compression-report.css";

const size = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(2)} MB`;
const methodLabels = { temporal_stability: "跨帧稳定优化", lzw_cost_search: "LZW 成本搜索" };
const referenceLabels = {
  prequantized_source: "画质参考：量化前画面",
  gif_only: "画质参考：编码后的 GIF；未验证相对源画面的画质",
  unavailable: "缺少画质参考，不能确认相对源画面的画质",
};
const statusLabels = {
  not_selected: "候选合格，本次未采用",
  no_gain: "没有更小结果",
  rejected: "误差检查未通过",
  skipped: "本次跳过",
  budget_exhausted: "已达到搜索预算",
};
function stageStatus(stage: AdvancedCompressionStageReport): string {
  if (stage.status === "adopted") return stage.adopted && stage.verified ? "已采用 · 误差检查通过" : "未确认采用，验证未完成";
  return statusLabels[stage.status] ?? stage.status;
}

/** Describes only this optional lossy stage, never labels the final GIF lossless. */
export function advancedCompressionSummary(report?: AdvancedCompressionExecutionReport | null): string | undefined {
  if (!report) return undefined;
  return report.adopted && report.verified
    ? `新压缩阶段已采用 · 减少 ${((1 - report.after_bytes / Math.max(1, report.before_bytes)) * 100).toFixed(1)}%（有损）`
    : "新压缩阶段保留原结果";
}

export function AdvancedCompressionReport({ report }: { report?: AdvancedCompressionExecutionReport | null }) {
  if (!report) return null;
  return <section className="advanced-compression-report" aria-label="新压缩算法报告">
    <strong>新压缩阶段 · 低误差有损</strong>
    <p>{advancedCompressionSummary(report)} · {size(report.before_bytes)} → {size(report.after_bytes)}</p>
    <p>{referenceLabels[report.reference_kind] ?? referenceLabels.unavailable}</p>
    <ul>{report.stages.map((stage, index) => <li key={`${stage.method}-${index}`}>
      <b>{methodLabels[stage.method] ?? stage.method}</b><span>{stageStatus(stage)}</span>
      {stage.candidate_bytes != null && <span>候选 {size(stage.candidate_bytes)}{stage.writer_control_bytes == null ? "" : ` · 同写入器对照 ${size(stage.writer_control_bytes)}`}</span>}
      {stage.writer_control_bytes != null && <span>算法增量节省 {size(Math.max(0, stage.algorithm_saved_bytes))}{!stage.adopted ? "（候选）" : ""}</span>}
      <small>{stage.compression_probes} 次压缩实测 · {(stage.elapsed_ms / 1000).toFixed(2)}s</small>
      {stage.reason && <small>{stage.reason}</small>}
    </li>)}</ul>
    {report.reason && <p>{report.reason}</p>}
  </section>;
}
