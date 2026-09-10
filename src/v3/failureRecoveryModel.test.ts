import { describe, expect, it } from "vitest";
import {
  buildFailureDiagnostic,
  classifyDesktopFailure,
  redactDiagnosticText,
} from "./failureRecoveryModel";

describe("desktop failure recovery", () => {
  it.each([
    ["ENOSPC: no space left on device", "disk-space", true],
    ["EACCES: permission denied", "permission", true],
    ["invalid output path: parent directory does not exist", "output-path", true],
    ["ffmpeg: unknown encoder gif", "dependency", true],
    ["moov atom not found; invalid data found", "input-media", false],
    ["GIFP_TASK_CANCELLED:task-a", "cancelled", true],
    ["something unexpected happened", "unknown", true],
  ] as const)("classifies %s", (message, category, retryable) => {
    const result = classifyDesktopFailure(new Error(message));
    expect(result.category).toBe(category);
    expect(result.retryable).toBe(retryable);
    expect(result.message).not.toBe("");
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.technicalDetails).toContain(message);
  });

  it("keeps raw technical details locally", () => {
    const result = classifyDesktopFailure("failed at C:\\Users\\Alice\\secret.mp4 task-id=task-private");
    expect(result.technicalDetails).toContain("C:\\Users\\Alice\\secret.mp4");
    expect(result.technicalDetails).toContain("task-private");
  });

  it("redacts Windows and Unix paths, task ids and UUIDs", () => {
    const redacted = redactDiagnosticText(
      "C:\\Users\\Alice\\Videos\\secret clip.mp4 /home/alice/video.mov task_id=task-123 550e8400-e29b-41d4-a716-446655440000",
    );
    expect(redacted).not.toContain("Alice");
    expect(redacted).not.toContain("/home/alice");
    expect(redacted).not.toContain("task-123");
    expect(redacted).not.toContain("550e8400");
    expect(redacted).toContain("[本地路径已隐藏]");
    expect(redacted).toContain("[任务编号已隐藏]");
  });

  it("builds a complete shareable diagnostic without source or output paths", () => {
    const failure = classifyDesktopFailure(
      "ffmpeg unknown encoder input=C:\\Users\\Alice\\source.mp4 output=/home/alice/out.gif task-id=task-secret",
    );
    const diagnostic = buildFailureDiagnostic({
      version: "5.7.18",
      operation: "生成 GIF",
      occurredAt: new Date("2026-07-29T08:30:00.000Z"),
      failure,
      backend: {
        ffmpegAvailable: true,
        ffprobeAvailable: true,
        gifEncoderAvailable: false,
        hardwareAcceleration: "D3D11VA",
      },
      resources: {
        freeDiskBytes: 1024,
        memoryUsedBytes: 2048,
        memoryTotalBytes: 4096,
        activeTasks: 2,
      },
    });

    expect(diagnostic).toContain("GIFP 版本：5.7.18");
    expect(diagnostic).toContain("操作：生成 GIF");
    expect(diagnostic).toContain("时间：2026-07-29T08:30:00.000Z");
    expect(diagnostic).toContain("错误分类：dependency（转换组件不可用）");
    expect(diagnostic).toContain("FFmpeg=可用");
    expect(diagnostic).toContain("可用磁盘=1024 B");
    expect(diagnostic).toContain("安全建议：");
    expect(diagnostic).not.toContain("技术细节");
    expect(diagnostic).not.toContain("Alice");
    expect(diagnostic).not.toContain("source.mp4");
    expect(diagnostic).not.toContain("out.gif");
    expect(diagnostic).not.toContain("task-secret");
  });

  it("does not accept material or output paths in diagnostic metadata", () => {
    const failure = classifyDesktopFailure("unknown");
    const diagnostic = buildFailureDiagnostic({
      version: "5.7.18",
      operation: "导出",
      occurredAt: "2026-07-29T08:30:00Z",
      failure,
      resources: {},
    });
    expect(diagnostic).toContain("后端能力：FFmpeg=未知");
    expect(diagnostic).toContain("资源快照：可用磁盘=未知");
  });

  it.each([
    "https://evil.example/export.gif?token=top-secret",
    "\\\\attacker\\share\\private.mp4",
    "C:\\Users\\Alice\\private.mov",
    "/home/alice/private.mov",
    "550e8400-e29b-41d4-a716-446655440000",
    "alice@example.com",
    "客户名单-final-secret.mp4",
    "task-id=task-private",
  ])("never copies attacker-controlled operation metadata: %s", (payload) => {
    const failure = classifyDesktopFailure(`failed input=${payload}`);
    const diagnostic = buildFailureDiagnostic({
      version: `5.7.18-${payload}`,
      operation: `生成当前动画 ${payload}`,
      occurredAt: "2026-07-29T08:30:00Z",
      failure: {
        ...failure,
        label: payload,
        suggestions: [payload],
        technicalDetails: `raw secret ${payload}`,
      },
      backend: { hardwareAcceleration: payload },
    });

    expect(diagnostic).not.toContain(payload);
    expect(diagnostic).toContain("GIFP 版本：未知");
    expect(diagnostic).toContain("操作：未识别操作");
    expect(diagnostic).not.toContain("raw secret");
  });

  it("normalizes dynamic operation counts without copying arbitrary text", () => {
    const diagnostic = buildFailureDiagnostic({
      version: "5.7.18",
      operation: "批量生成（12 个失败）",
      occurredAt: "not-a-date",
      failure: classifyDesktopFailure("EACCES: C:\\secret\\客户.mp4"),
      resources: { activeTasks: 2.9, freeDiskBytes: -20 },
    });

    expect(diagnostic).toContain("操作：批量生成");
    expect(diagnostic).toContain("时间：未知");
    expect(diagnostic).toContain("活动任务=2");
    expect(diagnostic).toContain("可用磁盘=0 B");
    expect(diagnostic).not.toContain("客户.mp4");
  });
});
