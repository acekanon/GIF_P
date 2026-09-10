import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputComparison } from "./OutputComparison";

const animatedPlayerSpy = vi.hoisted(() => vi.fn());

vi.mock("./AnimatedMediaPlayer", () => ({
  AnimatedMediaPlayer: (props: { src: string; alt: string; className?: string }) => {
    animatedPlayerSpy(props);
    return <img src={props.src} alt={`${props.alt} 动画预览`} className={props.className} />;
  },
}));

afterEach(() => {
  cleanup();
  animatedPlayerSpy.mockClear();
  vi.restoreAllMocks();
});

function renderComparison() {
  return render(
    <OutputComparison
      source={{ src: "/source.png", kind: "image", alt: "测试原素材" }}
      output={{ src: "/result.gif", format: "gif", alt: "测试 GIF 成品" }}
      aspectRatio={16 / 9}
    />,
  );
}

describe("OutputComparison", () => {
  it("starts with a real 50/50 split and exposes keyboard slider controls", async () => {
    const user = userEvent.setup();
    renderComparison();

    const divider = screen.getByRole("slider", { name: "原素材与成品分割线" });
    expect(divider).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/原素材 50% · 成品 50%/)).toBeVisible();

    divider.focus();
    await user.keyboard("{ArrowRight}");
    expect(divider).toHaveAttribute("aria-valuenow", "51");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(divider).toHaveAttribute("aria-valuenow", "56");
    await user.keyboard("{Home}");
    expect(divider).toHaveAttribute("aria-valuenow", "0");
    await user.keyboard("{End}");
    expect(divider).toHaveAttribute("aria-valuenow", "100");
  });

  it("opens, adjusts, and resets the shared magnified view", async () => {
    const user = userEvent.setup();
    const { container } = renderComparison();

    const toggle = screen.getByRole("button", { name: "打开 2 倍放大镜" });
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "关闭放大镜" })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".output-comparison")).toHaveClass("is-zoomed");
    expect(screen.getByText("2.0×")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "放大放大镜" }));
    expect(screen.getByText("2.5×")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "复位" }));
    expect(screen.getByRole("button", { name: "打开 2 倍放大镜" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("slider", { name: "原素材与成品分割线" })).toHaveAttribute("aria-valuenow", "50");
  });

  it("maps the source crop into the same output canvas", () => {
    render(
      <OutputComparison
        source={{
          src: "/source.png",
          kind: "image",
          alt: "裁剪原素材",
          crop: { left: 10, top: 20, right: 10, bottom: 20 },
        }}
        output={{ src: "/result.webp", format: "webp", alt: "裁剪 WebP 成品" }}
        aspectRatio={4 / 3}
      />,
    );

    const sourceMedia = screen.getByRole("img", { name: "裁剪原素材" }).closest(".output-comparison__media");
    expect(sourceMedia).not.toBeNull();
    expect(sourceMedia).toHaveStyle({ left: "-12.5%", width: "125%" });
    expect(Number.parseFloat((sourceMedia as HTMLElement).style.top)).toBeCloseTo(-33.333, 2);
    expect(Number.parseFloat((sourceMedia as HTMLElement).style.height)).toBeCloseTo(166.667, 2);
    expect(screen.getByText("原素材 · 按导出裁剪")).toBeVisible();

    const divider = screen.getByRole("slider", { name: "原素材与成品分割线" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider).toHaveAttribute("aria-valuenow", "49");
  });

  it("keeps the divider inside a vertical canvas and supports real pointer dragging", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    const { container } = render(
      <OutputComparison
        source={{ src: "/vertical.png", kind: "image", alt: "竖屏原素材" }}
        output={{ src: "/vertical.gif", format: "gif", alt: "竖屏成品" }}
        aspectRatio={9 / 16}
      />,
    );

    const divider = screen.getByRole("slider", { name: "原素材与成品分割线" }) as HTMLDivElement;
    divider.setPointerCapture = vi.fn();
    divider.hasPointerCapture = vi.fn(() => true);
    divider.releasePointerCapture = vi.fn();
    expect(divider).toHaveStyle({ left: "200px" });
    expect(container.querySelector(".output-comparison__layer--output")).toHaveStyle({ clipPath: "inset(0 0 0 200px)" });

    fireEvent.pointerDown(divider, { pointerId: 7, clientX: 171.875, clientY: 100 });
    expect(divider).toHaveAttribute("aria-valuenow", "25");
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 228.125, clientY: 100 });
    expect(divider).toHaveAttribute("aria-valuenow", "75");
    fireEvent.pointerUp(divider, { pointerId: 7, clientX: 228.125, clientY: 100 });
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("maps one shared output clock to the exported source trim and speed", async () => {
    const user = userEvent.setup();
    render(
      <OutputComparison
        source={{ src: "/source.gif", kind: "gif", alt: "变速原素材" }}
        output={{ src: "/result.apng", format: "apng", alt: "变速成品" }}
        aspectRatio={1}
        timeline={{ startSeconds: 2, endSeconds: 6, playbackSpeed: 2 }}
      />,
    );

    const clockedCalls = animatedPlayerSpy.mock.calls
      .map(([props]) => props as { src: string; externalClock?: { timeMs: number; playing: boolean; revision: number } })
      .filter((props) => props.externalClock);
    const sourceCall = clockedCalls.find((props) => props.src === "/source.gif");
    const outputCall = clockedCalls.find((props) => props.src === "/result.apng");
    expect(sourceCall?.externalClock?.timeMs).toBe(2_000);
    expect(outputCall?.externalClock?.timeMs).toBe(0);
    expect(sourceCall?.externalClock?.playing).toBe(true);

    await user.click(screen.getByRole("button", { name: "暂停对比播放" }));
    const latestCalls = animatedPlayerSpy.mock.calls
      .map(([props]) => props as { src: string; externalClock?: { timeMs: number; playing: boolean } })
      .reverse();
    const latestSource = latestCalls.find((props) => props.src === "/source.gif");
    const latestOutput = latestCalls.find((props) => props.src === "/result.apng");
    expect(latestSource?.externalClock?.playing).toBe(false);
    expect(latestOutput?.externalClock?.playing).toBe(false);
    expect((latestSource?.externalClock?.timeMs ?? 0) - 2_000).toBeCloseTo((latestOutput?.externalClock?.timeMs ?? 0) * 2, 0);
  });

  it("restarts both sides together after exact and compatibility playback are ready", async () => {
    render(
      <OutputComparison
        source={{ src: "/source.gif", kind: "gif", alt: "同步原素材" }}
        output={{ src: "/result.apng", format: "apng", alt: "同步 APNG 成品" }}
        aspectRatio={1}
        timeline={{ startSeconds: 2, endSeconds: 6, playbackSpeed: 2 }}
        reducedMotion
      />,
    );

    type ClockedPlayerProps = {
      src: string;
      externalClock?: { timeMs: number; playing: boolean; revision: number };
      onPlaybackCapabilityChange: (capability: "exact" | "native") => void;
    };
    const initialCalls = animatedPlayerSpy.mock.calls.map(([props]) => props as ClockedPlayerProps);
    const initialSource = initialCalls.find((props) => props.src === "/source.gif");
    const initialOutput = initialCalls.find((props) => props.src === "/result.apng");
    expect(initialSource?.externalClock?.revision).toBe(0);
    expect(initialOutput?.externalClock?.revision).toBe(0);

    act(() => {
      initialSource?.onPlaybackCapabilityChange("exact");
      initialOutput?.onPlaybackCapabilityChange("native");
    });

    await waitFor(() => {
      const latestCalls = animatedPlayerSpy.mock.calls
        .map(([props]) => props as ClockedPlayerProps)
        .reverse();
      const latestSource = latestCalls.find((props) => props.src === "/source.gif");
      const latestOutput = latestCalls.find((props) => props.src === "/result.apng");
      expect(latestSource?.externalClock).toMatchObject({ timeMs: 2_000, playing: false, revision: 1 });
      expect(latestOutput?.externalClock).toMatchObject({ timeMs: 0, playing: false, revision: 1 });
    });
  });

  it("skips deleted source frames while keeping the compacted output clock at zero", () => {
    render(
      <OutputComparison
        source={{ src: "/source.gif", kind: "gif", alt: "删帧原素材" }}
        output={{ src: "/result.apng", format: "apng", alt: "删帧成品" }}
        aspectRatio={1}
        timeline={{
          startSeconds: 2,
          endSeconds: 6,
          playbackSpeed: 2,
          outputFps: 10,
          deletedFrameIndices: [0, 2],
        }}
        reducedMotion
      />,
    );

    const clockedCalls = animatedPlayerSpy.mock.calls
      .map(([props]) => props as { src: string; externalClock?: { timeMs: number; playing: boolean } })
      .filter((props) => props.externalClock);
    const sourceCall = clockedCalls.find((props) => props.src === "/source.gif");
    const outputCall = clockedCalls.find((props) => props.src === "/result.apng");
    expect(sourceCall?.externalClock?.timeMs).toBe(2_200);
    expect(outputCall?.externalClock?.timeMs).toBe(0);
    expect(sourceCall?.externalClock?.playing).toBe(false);
  });

  it("uses video elements for video formats instead of sending them through image preview", () => {
    render(
      <OutputComparison
        source={{ src: "/source.mp4", kind: "video", alt: "原视频" }}
        output={{ src: "/result.webm", format: "webm", alt: "WebM 成品" }}
        aspectRatio={16 / 9}
        timeline={{ startSeconds: 0, endSeconds: 2, playbackSpeed: 2, outputFps: 15 }}
        reducedMotion
      />,
    );

    expect(screen.getByLabelText("原视频").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("WebM 成品").tagName).toBe("VIDEO");
    expect(screen.getByLabelText("原视频")).not.toHaveAttribute("autoplay");
    expect((screen.getByLabelText("原视频") as HTMLVideoElement).playbackRate).toBe(2);
    expect((screen.getByLabelText("WebM 成品") as HTMLVideoElement).playbackRate).toBe(1);
  });

  it("uses the verified pair's still poster when comparing a Live Photo", () => {
    render(
      <OutputComparison
        source={{ src: "/source.png", kind: "image", alt: "实况原素材" }}
        output={{ src: "/paired-still.jpg", format: "live_photo", alt: "实况照片成品" }}
        aspectRatio={4 / 3}
        reducedMotion
      />,
    );

    expect(screen.getAllByRole("img", { name: "实况照片成品 静态关键帧" })).not.toHaveLength(0);
    expect(screen.getByText(/关键帧对照/)).toBeVisible();
    expect(screen.getByText(/实况照片以中点关键帧进行静态对照/)).toBeVisible();
    expect(animatedPlayerSpy).not.toHaveBeenCalledWith(expect.objectContaining({ src: "/paired-still.jpg" }));
  });

  it("forces the initial video seek when the first exported frame was deleted", () => {
    render(
      <OutputComparison
        source={{ src: "/source.mp4", kind: "video", alt: "首帧删除原视频" }}
        output={{ src: "/result.webm", format: "webm", alt: "首帧删除成品" }}
        aspectRatio={16 / 9}
        timeline={{
          startSeconds: 0,
          endSeconds: 1,
          playbackSpeed: 1,
          outputFps: 15,
          deletedFrameIndices: [0],
        }}
        reducedMotion
      />,
    );

    expect((screen.getByLabelText("首帧删除原视频") as HTMLVideoElement).currentTime).toBeCloseTo(1 / 15, 4);
    expect((screen.getByLabelText("首帧删除成品") as HTMLVideoElement).currentTime).toBe(0);
  });
});
