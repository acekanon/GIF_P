import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LivePhotoResult } from "../tauri";
import { LivePhotoPreview } from "./LivePhotoPreview";

const baseLivePhoto: LivePhotoResult = {
  still_path: "C:/exports/demo.jpg",
  motion_path: "C:/exports/demo.mov",
  asset_identifier: "asset-123",
  asset_identifier_verified: false,
  metadata_pairing_verified: false,
  compatibility_status: "unverified",
  validation_scope: "local_contract",
};

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPreview(livePhoto: LivePhotoResult = baseLivePhoto) {
  return render(
    <LivePhotoPreview
      stillSrc="/demo.jpg"
      motionSrc="/demo.mov"
      alt="测试实况照片"
      livePhoto={livePhoto}
    />,
  );
}

describe("LivePhotoPreview", () => {
  it("does not call a plain JPG and MOV pair Apple compatible", () => {
    renderPreview();
    expect(screen.getByText("待本地验证 · 不宣称 Apple Photos 已接收")).toBeVisible();
    expect(screen.queryByText("Apple 配对契约已本地验证")).not.toBeInTheDocument();
  });

  it("shows verified compatibility only when both pairing checks pass", () => {
    renderPreview({
      ...baseLivePhoto,
      compatibility_status: "locally_verified",
      asset_identifier_verified: true,
      metadata_pairing_verified: true,
    });
    expect(screen.getByText("Apple 配对契约已本地验证")).toBeVisible();
  });

  it("plays while held and rewinds to the still keyframe on release", () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    renderPreview();
    const hold = screen.getByRole("button", { name: "按住播放实况照片，松开回到关键帧" });
    Object.assign(hold, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(hold, { pointerId: 3 });
    expect(play).toHaveBeenCalledOnce();
    expect(hold).toHaveAttribute("aria-pressed", "true");

    fireEvent.pointerUp(hold, { pointerId: 3 });
    expect(pause).toHaveBeenCalled();
    expect(hold).toHaveAttribute("aria-pressed", "false");
    expect((screen.getByLabelText("测试实况照片 MOV 动态部分") as HTMLVideoElement).currentTime).toBe(0);
  });

  it("keeps a keyboard-accessible regular playback alternative", async () => {
    const user = userEvent.setup();
    renderPreview();

    await user.click(screen.getByRole("button", { name: "播放实况照片" }));
    expect(screen.getByRole("button", { name: "暂停实况照片" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "暂停实况照片" }));
    expect(screen.getByRole("button", { name: "播放实况照片" })).toHaveAttribute("aria-pressed", "false");
  });

  it("offers an explicit sound toggle for paired MOV playback", async () => {
    const user = userEvent.setup();
    renderPreview();
    const video = screen.getByLabelText("测试实况照片 MOV 动态部分") as HTMLVideoElement;

    expect(video.muted).toBe(true);
    await user.click(screen.getByRole("button", { name: "打开实况照片声音" }));
    expect(video.muted).toBe(false);
    expect(screen.getByRole("button", { name: "静音实况照片" })).toHaveAttribute("aria-pressed", "true");
  });

  it("supports keyboard hold and release on the poster", () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    renderPreview();
    const hold = screen.getByRole("button", { name: "按住播放实况照片，松开回到关键帧" });

    fireEvent.keyDown(hold, { key: " " });
    expect(play).toHaveBeenCalledOnce();
    expect(hold).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyUp(hold, { key: " " });
    expect(hold).toHaveAttribute("aria-pressed", "false");
  });

  it("falls back to the still poster when MOV playback is rejected", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("blocked"));
    renderPreview();
    const hold = screen.getByRole("button", { name: "按住播放实况照片，松开回到关键帧" });

    fireEvent.pointerDown(hold, { pointerId: 5 });
    await waitFor(() => expect(hold).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByText("MOV 无法播放，请打开成对资源检查。")).toBeVisible();
  });
});
