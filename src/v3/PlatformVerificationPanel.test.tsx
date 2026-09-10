import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformVerificationPanel, derivePlatformVerificationRows } from "./PlatformVerificationPanel";
import type { PlatformDeliveryEvidence } from "./platformDeliveryEvidence";
import { PLATFORM_POLICIES } from "./platformPolicy";

afterEach(cleanup);

function fullEvidence(overrides: Partial<PlatformDeliveryEvidence> = {}): PlatformDeliveryEvidence {
  const policy = PLATFORM_POLICIES[0];
  return {
    policyId: policy.id,
    policyRevision: policy.revision,
    testedAt: "2026-07-20T08:00:00.000Z",
    client: "QQ Windows 9.9",
    artifactSha256: "a".repeat(64),
    output: { format: "gif", width: 560, height: 420, fps: 18, durationSeconds: 2, sizeBytes: 1_000_000 },
    lifecycle: { send: true, receiverPlayback: true, forward: true, download: true, reopen: true },
    ...overrides,
  };
}

describe("PlatformVerificationPanel", () => {
  it("honestly renders all eight policies as awaiting device tests when evidence is empty", () => {
    render(<PlatformVerificationPanel onClose={() => undefined} />);

    expect(screen.getByRole("dialog", { name: "真实平台交付验证" })).toBeInTheDocument();
    const statusRegion = screen.getByLabelText("平台验证状态");
    expect(within(statusRegion).getAllByText("规则推断 · 待实测")).toHaveLength(8);
    expect(within(statusRegion).getAllByText(/revision 1/)).toHaveLength(8);
    expect(within(statusRegion).getAllByText("待实测")).toHaveLength(48);
    expect(screen.getByText("0 / 8 已实测")).toBeInTheDocument();
    expect(screen.getByText("当前没有可声明的实机验证")).toBeInTheDocument();
  });

  it("shows source, fallback format and every lifecycle requirement", () => {
    render(<PlatformVerificationPanel onClose={() => undefined} />);
    const qq = screen.getByLabelText("QQ 聊天动图 五步交付要求");

    for (const stage of ["发送", "接收端播放", "转发", "下载", "重新打开"]) {
      expect(within(qq).getByText(stage)).toBeInTheDocument();
    }
    expect(screen.getAllByText("客户端实测 · 待补当前稳定客户端全链路实测").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GIF").length).toBeGreaterThan(0);
  });

  it("derives device verified, expired and invalid states through the evidence assessor", () => {
    const verified = derivePlatformVerificationRows(
      [PLATFORM_POLICIES[0]],
      [fullEvidence()],
      new Date("2026-07-29T08:00:00.000Z"),
    );
    const expired = derivePlatformVerificationRows(
      [PLATFORM_POLICIES[0]],
      [fullEvidence()],
      new Date("2027-07-29T08:00:00.000Z"),
    );
    const invalid = derivePlatformVerificationRows(
      [PLATFORM_POLICIES[0]],
      [fullEvidence({ policyRevision: "old" })],
      new Date("2026-07-29T08:00:00.000Z"),
    );

    expect(verified[0].assessment.state).toBe("device_verified");
    expect(expired[0].assessment.state).toBe("evidence_expired");
    expect(invalid[0].assessment.state).toBe("invalid");
  });

  it("closes from the close button, backdrop and Escape", () => {
    const onClose = vi.fn();
    render(<PlatformVerificationPanel onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "关闭平台交付验证" }));
    fireEvent.click(screen.getByRole("button", { name: "点击遮罩关闭平台交付验证" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
