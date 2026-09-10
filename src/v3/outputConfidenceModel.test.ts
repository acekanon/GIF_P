import { describe, expect, it } from "vitest";
import { assessOutputConfidence } from "./outputConfidenceModel";

describe("assessOutputConfidence", () => {
  it("waits for a real result", () => {
    expect(assessOutputConfidence()).toMatchObject({ level: "assessing", label: "正在评估" });
  });

  it("marks a measured high-quality file ready without claiming platform delivery", () => {
    expect(assessOutputConfidence({ quality: { status: "measured", vmafMean: 94 }, warnings: [] })).toMatchObject({
      level: "ready",
      label: "文件已就绪",
      qualityMeasured: true,
      qualityLabel: "VMAF 94.0",
    });
  });

  it("reserves confident delivery for current device evidence", () => {
    expect(assessOutputConfidence({
      quality: { status: "measured", vmafMean: 94 },
      warnings: [],
      platformAssessment: { status: "device_verified", label: "微信 Windows 3.9.12" },
    })).toMatchObject({ level: "ready", label: "放心交付" });
  });

  it("downgrades inferred and expired platform evidence", () => {
    expect(assessOutputConfidence({
      quality: { status: "measured", vmafMean: 94 },
      platformAssessment: { status: "rule_inferred", label: "微信聊天" },
    })).toMatchObject({ level: "check", label: "建议检查" });
    expect(assessOutputConfidence({
      quality: { status: "measured", vmafMean: 94 },
      platformAssessment: { status: "evidence_expired", label: "旧版 QQ" },
    })).toMatchObject({ level: "check", label: "建议检查" });
  });

  it("never presents unavailable quality as measured", () => {
    expect(assessOutputConfidence({ quality: { status: "unavailable", message: "unsupported" } })).toMatchObject({
      level: "check",
      qualityMeasured: false,
      qualityLabel: "暂无评分",
    });
  });

  it("recommends a smaller rerun when the size cap is missed", () => {
    expect(assessOutputConfidence({ status: "target_over", targetSizeBytes: 1024, targetDeviationPercent: 12 })).toMatchObject({
      level: "adjust",
      recommendedAction: "smaller",
    });
  });

  it("recommends clarity when measured quality is poor", () => {
    expect(assessOutputConfidence({ quality: { status: "measured", ssimMean: 0.82 } })).toMatchObject({
      level: "adjust",
      recommendedAction: "clearer",
    });
  });
});
