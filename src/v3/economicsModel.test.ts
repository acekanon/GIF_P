import { describe, expect, it } from "vitest";
import type { GifResult } from "../tauri";
import {
  ECONOMICS_FORMATS,
  buildFormatEconomicsRows,
  tightCapOutcome,
} from "./economicsModel";

describe("GIFP exact-size and format economics", () => {
  it("reports reachability against the hard cap", () => {
    expect(tightCapOutcome(800, 799)).toMatchObject({ status: "reachable", label: "可达" });
    expect(tightCapOutcome(800, 801)).toMatchObject({ status: "unreachable", label: "不可达" });
    expect(tightCapOutcome(800)).toMatchObject({ status: "unreachable", label: "不可达" });
  });

  it("builds a fixed six-format table from real results and explicit failures", () => {
    const gif = { size_bytes: 1_000_000, elapsed_ms: 1200 } as GifResult;
    const webp = { size_bytes: 300_000, elapsed_ms: 800 } as GifResult;
    const rows = buildFormatEconomicsRows({ gif, webp }, { avif: "backend unavailable" });
    expect(rows.map((row) => row.format)).toEqual(ECONOMICS_FORMATS);
    expect(rows.find((row) => row.format === "webp")).toMatchObject({
      sizeBytes: 300_000,
      elapsedMs: 800,
      status: "encoded",
    });
    expect(rows.find((row) => row.format === "avif")).toMatchObject({ status: "failed" });
    expect(rows.find((row) => row.format === "mp4")).toMatchObject({ status: "skipped" });
  });
});
