import { describe, expect, it, vi } from "vitest";
import {
  TaskRunGate,
  assessMaterialLoad,
  cancelBackendTasks,
  presentTaskStatus,
  taskControlPolicy,
  thumbnailSampleTimes,
} from "./taskControlModel";

describe("long material task control", () => {
  it("cancels every unique backend task once and starts all requests in parallel", async () => {
    const resolvers = new Map<string, (accepted: boolean) => void>();
    const cancelFn = vi.fn((taskId: string) => new Promise<boolean>((resolve) => {
      resolvers.set(taskId, resolve);
    }));

    const pending = cancelBackendTasks(["task-a", "task-b", "task-a", "task-c"], cancelFn);
    expect(cancelFn.mock.calls.map(([taskId]) => taskId)).toEqual(["task-a", "task-b", "task-c"]);
    expect(resolvers.size).toBe(3);
    resolvers.forEach((resolve) => resolve(true));

    await expect(pending).resolves.toEqual({ requested: 3, accepted: 3, failed: 0 });
    for (const taskId of ["task-a", "task-b", "task-c"]) {
      expect(cancelFn.mock.calls.filter(([calledId]) => calledId === taskId)).toHaveLength(1);
    }
  });

  it("counts false cancellation responses as requested but not accepted or failed", async () => {
    const cancelFn = vi.fn(async () => false);

    await expect(cancelBackendTasks(["task-a", "task-b"], cancelFn)).resolves.toEqual({
      requested: 2,
      accepted: 0,
      failed: 0,
    });
  });

  it("counts rejected cancellation RPCs as failed without rejecting the fan-out", async () => {
    const cancelFn = vi.fn(async (taskId: string) => {
      throw new Error(`cancel failed: ${taskId}`);
    });

    await expect(cancelBackendTasks(["task-a", "task-b"], cancelFn)).resolves.toEqual({
      requested: 2,
      accepted: 0,
      failed: 2,
    });
  });

  it("reports mixed accepted, false and rejected outcomes and deduplicates every id", async () => {
    const cancelFn = vi.fn(async (taskId: string) => {
      if (taskId === "task-a") return true;
      if (taskId === "task-b") return false;
      throw new Error("backend unavailable");
    });

    await expect(cancelBackendTasks(
      ["task-a", "task-b", "task-c", "task-b", "task-c"],
      cancelFn,
    )).resolves.toEqual({ requested: 3, accepted: 1, failed: 1 });
    for (const taskId of ["task-a", "task-b", "task-c"]) {
      expect(cancelFn.mock.calls.filter(([calledId]) => calledId === taskId)).toHaveLength(1);
    }
  });

  it("classifies duration, frame and pixel workload into stable tiers", () => {
    expect(assessMaterialLoad({ durationSeconds: 5, width: 480, height: 270, fps: 15 }).tier).toBe("short");
    expect(assessMaterialLoad({ durationSeconds: 60, width: 640, height: 360, fps: 20 }).tier).toBe("standard");
    expect(assessMaterialLoad({ durationSeconds: 130, width: 640, height: 360, fps: 30 }).tier).toBe("long");
    expect(assessMaterialLoad({ durationSeconds: 310, width: 1920, height: 1080, fps: 30 }).tier).toBe("extreme");
  });

  it("lets a short high-resolution source escalate on pixel-frame workload", () => {
    const load = assessMaterialLoad({ durationSeconds: 10, width: 3840, height: 2160, fps: 60 });
    expect(load.tier).toBe("long");
    expect(load.reasons).toContain("画面尺寸与帧数的组合负载较高");
  });

  it("returns bounded preview, cache and concurrency policy for each tier", () => {
    expect(taskControlPolicy("short")).toMatchObject({ thumbnailBudget: 20, useProxyPreview: false, useDiskCache: false, maxConcurrency: 4 });
    expect(taskControlPolicy("standard")).toMatchObject({ thumbnailBudget: 16, useProxyPreview: false, useDiskCache: true, maxConcurrency: 3 });
    expect(taskControlPolicy("long")).toMatchObject({ thumbnailBudget: 12, useProxyPreview: true, proxyMaxWidth: 960, maxConcurrency: 2 });
    expect(taskControlPolicy("extreme")).toMatchObject({ thumbnailBudget: 8, useProxyPreview: true, proxyMaxWidth: 720, maxConcurrency: 1 });
  });

  it("samples thumbnails uniformly without exceeding the budget", () => {
    expect(thumbnailSampleTimes(100, 5)).toEqual([10, 30, 50, 70, 90]);
    expect(thumbnailSampleTimes(100, 1)).toEqual([50]);
    expect(thumbnailSampleTimes(0, 20)).toEqual([]);
  });

  it("aborts previous runs and prevents stale async work from committing", () => {
    const gate = new TaskRunGate();
    const staleWrite = vi.fn();
    const currentWrite = vi.fn(() => "saved");
    const first = gate.start();
    const second = gate.start();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(first.commit(staleWrite)).toBeUndefined();
    expect(second.commit(currentWrite)).toBe("saved");
    expect(staleWrite).not.toHaveBeenCalled();
    expect(currentWrite).toHaveBeenCalledOnce();
    expect(gate.cancel()).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(gate.active).toBe(false);
    expect(gate.cancel()).toBe(false);
  });

  it("presents honest cancellable progress and terminal states", () => {
    expect(presentTaskStatus({ kind: "generating", progress: 0.426 })).toMatchObject({
      label: "正在生成 43%", progressPercent: 43, tone: "active", cancellable: true,
    });
    expect(presentTaskStatus({ kind: "generating" })).toMatchObject({
      label: "正在生成", progressPercent: null,
    });
    expect(presentTaskStatus({ kind: "cancelled" })).toMatchObject({
      label: "已停止", detail: "没有覆盖上一次可用结果", cancellable: false,
    });
    expect(presentTaskStatus({ kind: "failed", error: "磁盘空间不足" })).toMatchObject({
      label: "生成失败", detail: "磁盘空间不足", tone: "danger",
    });
  });
});
