import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedMediaPlayer, MAX_EXACT_DECODE_BYTES } from "./AnimatedMediaPlayer";

const originalFetch = globalThis.fetch;
const originalImageDecoder = (window as typeof window & { ImageDecoder?: unknown }).ImageDecoder;

describe("AnimatedMediaPlayer", () => {
  const drawImage = vi.fn();
  const clearRect = vi.fn();

  beforeEach(() => {
    drawImage.mockReset();
    clearRect.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      clearRect,
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: originalImageDecoder,
    });
  });

  it("freezes the visible native frame when precise decoding is unavailable", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const user = userEvent.setup();
    const { container } = render(
      <AnimatedMediaPlayer src="/result.webp" format="webp" alt="压缩后的猫咪动画" />,
    );

    expect(await screen.findByText("兼容模式")).toBeVisible();
    expect(screen.getByRole("img", { name: "压缩后的猫咪动画，WEBP 动画预览" })).toBeVisible();
    const image = container.querySelector(".animated-media-player__image") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 320 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 180 });
    fireEvent.load(image);

    await user.click(screen.getByRole("button", { name: "暂停动画" }));

    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 320, 180);
    expect(container.querySelector(".animated-media-player__canvas")).toHaveClass("visible");
    expect(screen.getByText("已暂停")).toBeVisible();
    expect(screen.getByRole("group", { name: "预览播放速度" })).toBeVisible();
    expect(screen.getByRole("button", { name: "预览 0.5×" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "预览 2×" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: /循环/ })).toBeDisabled();
    expect(screen.getByText("支持暂停和重新播放；倍速与循环由文件格式决定。")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "从头继续播放动画" }));
    expect(screen.getByText("正在播放")).toBeVisible();
  });

  it("requests Animated AVIF through the image/avif decoder path", async () => {
    let decoderType = "";
    class MockAvifDecoder {
      static isTypeSupported = vi.fn(async () => true);
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: 1, repetitionCount: 0 },
      };
      constructor(options: { type: string }) {
        decoderType = options.type;
      }
      decode = vi.fn(async () => ({
        image: {
          displayWidth: 320,
          displayHeight: 180,
          duration: 100_000,
          timestamp: 0,
          close: vi.fn(),
        },
      }));
      close = vi.fn();
    }

    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: MockAvifDecoder,
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "8" },
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    render(<AnimatedMediaPlayer src="/result.avif" format="avif" alt="体积优先动画" reducedMotion />);

    expect(await screen.findByText("逐帧模式")).toBeVisible();
    expect(MockAvifDecoder.isTypeSupported).toHaveBeenCalledWith("image/avif");
    expect(decoderType).toBe("image/avif");
  });

  it("enables real pause, speed and loop controls with frame decoding", async () => {
    const closeDecoder = vi.fn();
    const closeFrame = vi.fn();
    const decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => ({
      image: {
        displayWidth: 320,
        displayHeight: 180,
        duration: 1_000_000,
        timestamp: frameIndex * 1_000_000,
        close: closeFrame,
      },
    }));

    class MockImageDecoder {
      static isTypeSupported = vi.fn(async () => true);
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: 2, repetitionCount: 0 },
      };
      decode = decode;
      close = closeDecoder;
    }

    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: MockImageDecoder,
    });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    const { unmount } = render(
      <AnimatedMediaPlayer src="/result.apng" format="apng" alt="透明贴纸动画" poster="/poster.png" />,
    );

    expect(await screen.findByText("逐帧模式")).toBeVisible();
    await waitFor(() => expect(decode).toHaveBeenCalledWith({ frameIndex: 0, completeFramesOnly: true }));
    expect(screen.getByText("帧 1/2")).toBeVisible();
    expect(drawImage).toHaveBeenCalled();
    expect(closeFrame).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "预览 2×" }));
    expect(screen.getByRole("button", { name: "预览 2×" })).toHaveAttribute("aria-pressed", "true");

    const loopSwitch = screen.getByRole("switch", { name: /循环/ });
    expect(loopSwitch).toHaveAttribute("aria-checked", "true");
    await user.click(loopSwitch);
    expect(loopSwitch).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByRole("button", { name: "暂停动画" }));
    expect(screen.getByText("已暂停")).toBeVisible();
    expect(screen.getByText("支持暂停、倍速和循环播放。")).toBeVisible();

    unmount();
    expect(closeDecoder).toHaveBeenCalled();
  });

  it("uses real frame timestamps and durations when driven by an external clock", async () => {
    const closeDecoder = vi.fn();
    const closeFrame = vi.fn();
    const timings = [
      { timestamp: 0, duration: 100_000 },
      { timestamp: 100_000, duration: 250_000 },
      { timestamp: 350_000, duration: 150_000 },
    ];
    const decode = vi.fn(async ({ frameIndex }: { frameIndex: number }) => ({
      image: {
        displayWidth: 320,
        displayHeight: 180,
        ...timings[frameIndex],
        close: closeFrame,
      },
    }));

    class MockImageDecoder {
      static isTypeSupported = vi.fn(async () => true);
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: timings.length, repetitionCount: 0 },
      };
      decode = decode;
      close = closeDecoder;
    }

    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: MockImageDecoder,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const onCapabilityChange = vi.fn();

    const { container, rerender } = render(
      <AnimatedMediaPlayer
        src="/clocked.apng"
        format="apng"
        alt="同步对比输出"
        stageOnly
        externalClock={{ timeMs: 220, playing: true, revision: 0 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("figure")).toHaveAttribute("data-playback-capability", "exact");
      expect(decode).toHaveBeenLastCalledWith({ frameIndex: 1, completeFramesOnly: true });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls.slice(0, 3).map(([options]) => options.frameIndex)).toEqual([0, 1, 2]);
    expect(onCapabilityChange).toHaveBeenCalledWith("loading");
    expect(onCapabilityChange).toHaveBeenCalledWith("exact");
    expect(drawImage).toHaveBeenCalledTimes(1);

    rerender(
      <AnimatedMediaPlayer
        src="/clocked.apng"
        format="apng"
        alt="同步对比输出"
        stageOnly
        externalClock={{ timeMs: 370, playing: false, revision: 0 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );
    await waitFor(() => {
      expect(decode).toHaveBeenLastCalledWith({ frameIndex: 2, completeFramesOnly: true });
      expect(screen.getByRole("img", { name: /已暂停，逐帧模式/ })).toBeVisible();
    });
    const pausedDecodeCount = decode.mock.calls.length;

    rerender(
      <AnimatedMediaPlayer
        src="/clocked.apng"
        format="apng"
        alt="同步对比输出"
        stageOnly
        externalClock={{ timeMs: 370, playing: false, revision: 0 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );
    expect(decode).toHaveBeenCalledTimes(pausedDecodeCount);

    rerender(
      <AnimatedMediaPlayer
        src="/clocked.apng"
        format="apng"
        alt="同步对比输出"
        stageOnly
        externalClock={{ timeMs: 50, playing: false, revision: 1 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );
    await waitFor(() => {
      expect(decode).toHaveBeenLastCalledWith({ frameIndex: 0, completeFramesOnly: true });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reloads and freezes native fallback playback under external clock control", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const onCapabilityChange = vi.fn();
    const { container, rerender } = render(
      <AnimatedMediaPlayer
        src="/clocked.webp"
        format="webp"
        alt="兼容对比输出"
        stageOnly
        externalClock={{ timeMs: 400, playing: true, revision: 0 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );

    await waitFor(() => expect(onCapabilityChange).toHaveBeenCalledWith("native"));
    const firstImage = container.querySelector(".animated-media-player__image") as HTMLImageElement;

    rerender(
      <AnimatedMediaPlayer
        src="/clocked.webp"
        format="webp"
        alt="兼容对比输出"
        stageOnly
        externalClock={{ timeMs: 0, playing: true, revision: 1 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".animated-media-player__image")).not.toBe(firstImage);
    });

    rerender(
      <AnimatedMediaPlayer
        src="/clocked.webp"
        format="webp"
        alt="兼容对比输出"
        stageOnly
        externalClock={{ timeMs: 240, playing: false, revision: 1 }}
        onPlaybackCapabilityChange={onCapabilityChange}
      />,
    );
    const pausedImage = container.querySelector(".animated-media-player__image") as HTMLImageElement;
    Object.defineProperty(pausedImage, "naturalWidth", { configurable: true, value: 320 });
    Object.defineProperty(pausedImage, "naturalHeight", { configurable: true, value: 180 });
    fireEvent.load(pausedImage);

    await waitFor(() => {
      expect(drawImage).toHaveBeenCalledWith(pausedImage, 0, 0, 320, 180);
      expect(container.querySelector(".animated-media-player__canvas")).toHaveClass("visible");
    });
    expect(screen.getByRole("img", { name: /已暂停，兼容模式/ })).toBeVisible();

    fireEvent.error(pausedImage);
    await waitFor(() => expect(onCapabilityChange).toHaveBeenCalledWith("error"));
  });

  it("aborts the single decoder fetch when an externally clocked player unmounts", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: class MockImageDecoder {},
    });
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_src: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { unmount } = render(
      <StrictMode>
        <AnimatedMediaPlayer
          src="/pending.gif"
          format="gif"
          alt="等待解码"
          stageOnly
          externalClock={{ timeMs: 0, playing: false, revision: 0 }}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(capturedSignal?.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(capturedSignal?.aborted).toBe(true));
  });

  it("cancels an unfinished decoder fetch when the source changes", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: class MockImageDecoder {},
    });
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_src: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { rerender, unmount } = render(
      <AnimatedMediaPlayer src="/old.gif" format="gif" alt="旧素材" />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<AnimatedMediaPlayer src="/new.gif" format="gif" alt="新素材" />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals[0]?.aborted).toBe(true);
    });
    expect(signals[1]?.aborted).toBe(false);

    unmount();
    await waitFor(() => expect(signals[1]?.aborted).toBe(true));
  });

  it("renders only an accessible animation stage when stageOnly is enabled", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const { container } = render(
      <AnimatedMediaPlayer
        src="/canvas.webp"
        format="webp"
        alt="表情包画布"
        stageOnly
        reducedMotion
      />,
    );

    const stage = await screen.findByRole("img", {
      name: "表情包画布，WEBP 动画预览，已暂停，兼容模式",
    });
    expect(stage).toHaveAttribute("aria-live", "polite");
    expect(stage).toHaveAttribute("aria-atomic", "true");
    expect(stage).toHaveAttribute("aria-busy", "false");
    expect(container.querySelector("figure")).toHaveAttribute("data-stage-only", "true");
    expect(container.querySelector("figcaption")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("falls back to native playback before buffering an oversized animation", async () => {
    const decoder = vi.fn();
    class MockImageDecoder {
      static isTypeSupported = vi.fn(async () => true);
      constructor() {
        decoder();
      }
    }
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: MockImageDecoder,
    });
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8));
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_EXACT_DECODE_BYTES + 1) },
      body: { cancel: vi.fn() },
      arrayBuffer,
    })) as unknown as typeof fetch;

    render(<AnimatedMediaPlayer src="/huge.apng" format="apng" alt="超大动画" />);

    expect(await screen.findByText("兼容模式")).toBeVisible();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(decoder).not.toHaveBeenCalled();
  });

  it("starts paused and immediately freezes again when reducedMotion becomes true", async () => {
    Object.defineProperty(window, "ImageDecoder", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const { container, rerender } = render(
      <AnimatedMediaPlayer
        src="/reduced.webp"
        format="webp"
        alt="低动态预览"
        reducedMotion
      />,
    );

    expect(await screen.findByText("兼容模式")).toBeVisible();
    const image = container.querySelector(".animated-media-player__image") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 320 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 180 });
    fireEvent.load(image);

    await waitFor(() => expect(screen.getByText("已暂停")).toBeVisible());
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 320, 180);

    rerender(
      <AnimatedMediaPlayer
        src="/reduced.webp"
        format="webp"
        alt="低动态预览"
        reducedMotion={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "从头继续播放动画" }));
    expect(screen.getByText("正在播放")).toBeVisible();

    rerender(
      <AnimatedMediaPlayer
        src="/reduced.webp"
        format="webp"
        alt="低动态预览"
        reducedMotion
      />,
    );
    await waitFor(() => expect(screen.getByText("已暂停")).toBeVisible());
    expect(container.querySelector(".animated-media-player__canvas")).toHaveClass("visible");
  });
});
