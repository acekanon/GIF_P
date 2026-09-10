import { describe, expect, it } from "vitest";
import { exportHeartbeatForElapsed } from "./exportHeartbeat";

describe("exportHeartbeatForElapsed", () => {
  it("moves a one-shot export past its initial state without reporting completion", () => {
    expect(exportHeartbeatForElapsed(0, false)).toMatchObject({ progress: 8, stage: "读取素材与时间线" });
    expect(exportHeartbeatForElapsed(8_000, false).progress).toBeGreaterThan(20);
    expect(exportHeartbeatForElapsed(10 * 60_000, false).progress).toBeLessThan(100);
  });

  it("keeps target-size search distinct and capped until the backend verifies the file", () => {
    const heartbeat = exportHeartbeatForElapsed(60_000, true);
    expect(heartbeat.stage).toBe("搜索目标体积并核验候选");
    expect(heartbeat.progress).toBeLessThan(100);
    expect(exportHeartbeatForElapsed(60 * 60_000, true).progress).toBeLessThanOrEqual(94);
  });
});
