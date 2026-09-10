import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AdvancedCompressionExecutionReport } from "../tauri";
import { AdvancedCompressionReport, advancedCompressionSummary } from "./AdvancedCompressionReport";

afterEach(cleanup);
const fixture = (): AdvancedCompressionExecutionReport => ({
  algorithm_version: "1", status: "optimized", before_bytes: 10000, after_bytes: 8000,
  adopted: true, verified: true, reference_kind: "prequantized_source", elapsed_ms: 10, estimated_peak_bytes: 20000,
  stages: [
    { method: "temporal_stability", status: "not_selected", before_bytes: 10000, candidate_bytes: 8500, writer_control_bytes: 9000, algorithm_saved_bytes: 500, adopted: false, verified: true, compression_probes: 2, changed_pixels: 12, elapsed_ms: 4 },
    { method: "lzw_cost_search", status: "adopted", before_bytes: 10000, candidate_bytes: 8000, writer_control_bytes: 9000, algorithm_saved_bytes: 1000, adopted: true, verified: true, compression_probes: 3, changed_pixels: 20, elapsed_ms: 6 },
  ],
});
it("distinguishes independent candidate selection and algorithm gains from writer gains", () => {
  render(<AdvancedCompressionReport report={fixture()} />);
  expect(screen.getByText(/新压缩阶段已采用 · 减少 20.0%（有损）/)).toBeVisible();
  expect(screen.getByText("候选合格，本次未采用")).toBeVisible();
  expect(screen.getByText("已采用 · 误差检查通过")).toBeVisible();
  expect(screen.getByText("算法增量节省 500 B（候选）")).toBeVisible();
  expect(screen.getByText("算法增量节省 1000 B")).toBeVisible();
  expect(screen.getByText("画质参考：量化前画面")).toBeVisible();
  expect(screen.queryByText(/无损/)).not.toBeInTheDocument();
});
it.each(["gif_only", "unavailable"] as const)("does not imply source quality verification for %s references", reference_kind => {
  const report = { ...fixture(), reference_kind, adopted: false, verified: false, status: "retained" as const, after_bytes: 10000, stages: [{ ...fixture().stages[1], status: "skipped" as const, candidate_bytes: null, writer_control_bytes: null, algorithm_saved_bytes: 0, adopted: false, verified: false, reason: "没有可验证的参考画面" }] };
  render(<AdvancedCompressionReport report={report} />);
  expect(screen.getByText(/新压缩阶段保留原结果/)).toBeVisible();
  expect(screen.getByText(reference_kind === "gif_only" ? /未验证相对源画面的画质/ : /不能确认相对源画面的画质/)).toBeVisible();
  expect(screen.getByText("本次跳过")).toBeVisible();
  expect(screen.queryByText(/已采用/)).not.toBeInTheDocument();
});
it("does not turn an unverified or missing report into an adoption claim", () => {
  expect(advancedCompressionSummary()).toBeUndefined();
  const report = { ...fixture(), verified: false };
  expect(advancedCompressionSummary(report)).toBe("新压缩阶段保留原结果");
  const { container } = render(<AdvancedCompressionReport />);
  expect(container).toBeEmptyDOMElement();
});
