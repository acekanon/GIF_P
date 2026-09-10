import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MascotCompanion, resolveMascotMotion, resolveMascotPhase } from "./MascotCompanion";

afterEach(cleanup);

const baseProps = {
  busy: false,
  recording: false,
  progress: 0,
  status: "准备就绪",
  hasResult: false,
  completedCount: 0,
  onAddMedia: vi.fn(),
};

describe("resolveMascotPhase", () => {
  it("uses real workflow state with active work taking precedence", () => {
    expect(resolveMascotPhase({ ...baseProps, activeName: undefined })).toBe("welcome");
    expect(resolveMascotPhase({ ...baseProps, activeName: "loop.gif" })).toBe("ready");
    expect(resolveMascotPhase({ ...baseProps, activeName: "loop.gif", busy: true })).toBe("working");
    expect(resolveMascotPhase({ ...baseProps, activeName: "loop.gif", hasResult: true })).toBe("complete");
    expect(resolveMascotPhase({ ...baseProps, activeName: "loop.gif", status: "生成失败：编码器不可用" })).toBe("error");
    expect(resolveMascotPhase({ ...baseProps, activeName: "loop.gif", recording: true, status: "生成失败" })).toBe("recording");
  });
});

describe("resolveMascotMotion", () => {
  it("maps workflow phases onto the five production animation clips", () => {
    expect(resolveMascotMotion("welcome", { progress: 0 })).toBe("idle");
    expect(resolveMascotMotion("ready", { progress: 0 })).toBe("idle");
    expect(resolveMascotMotion("working", { progress: 0 })).toBe("loading");
    expect(resolveMascotMotion("working", { progress: 63 })).toBe("working");
    expect(resolveMascotMotion("working", { progress: 63, qualityScoring: true })).toBe("loading");
    expect(resolveMascotMotion("recording", { progress: 45 })).toBe("loading");
    expect(resolveMascotMotion("complete", { progress: 100 })).toBe("complete");
    expect(resolveMascotMotion("error", { progress: 0 })).toBe("error");
  });
});

describe("MascotCompanion", () => {
  it("reserves a text-free animation slot in the welcome state", () => {
    const { container } = render(<MascotCompanion {...baseProps} />);

    expect(screen.getByRole("complementary", { name: "角色动画" })).toHaveClass("phase-welcome", "mascot-companion--animation-only");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-motion", "idle");
    expect(container.querySelector(".mascot-sprite__strip")).toHaveAttribute("src", "/characters/gifp-main/v2/strips/idle.png");
    expect((container.querySelector(".mascot-sprite") as HTMLElement).style.backgroundImage).toContain("/characters/gifp-main/v2/poster.png");
    expect(container.querySelector(".mascot-companion__speed-lines, .mascot-companion__spark")).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain("/v1/");
    expect(screen.queryByText(/主角面板|当前任务|动图星屑/)).not.toBeInTheDocument();
  });

  it("maps working state directly onto the reserved animation", () => {
    const { container } = render(<MascotCompanion {...baseProps} activeName="loop.gif" busy progress={63} status="正在编码 loop.gif" />);

    expect(screen.getByRole("complementary", { name: "角色动画" })).toHaveClass("phase-working");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-motion", "working");
    expect(screen.queryByText(/正在编码/)).not.toBeInTheDocument();
  });

  it("maps completion onto the completion animation without extra copy", () => {
    const { container } = render(<MascotCompanion {...baseProps} activeName="loop.gif" progress={100} hasResult completedCount={5} />);

    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-motion", "complete");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("freezes the expanded sprite on its reduced-motion frame", () => {
    const { container } = render(<MascotCompanion {...baseProps} reducedMotion />);

    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-motion", "idle");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-reduced-motion", "true");
  });
});
