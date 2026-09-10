import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MascotSprite } from "./MascotSprite";
import type { MascotMotionManifest } from "./motionTypes";

const TEST_MANIFEST: MascotMotionManifest = {
  version: 2,
  poster: "/poster.png",
  frame: { width: 360, height: 360 },
  anchor: { x: 180, y: 342 },
  clips: {
    idle: { src: "/idle.png", frameCount: 3, fps: 10, playback: "loop", reducedFrame: 1, fallback: "poster", preload: "eager" },
    loading: { src: "/loading.png", frameCount: 3, fps: 10, playback: "loop", reducedFrame: 0, fallback: "poster", preload: "eager" },
    working: { src: "/working.png", frameCount: 3, fps: 10, playback: "loop", reducedFrame: 0, fallback: "poster", preload: "eager" },
    complete: { src: "/complete.png", frameCount: 3, fps: 10, playback: "once-hold", reducedFrame: 2, fallback: "poster", preload: "idle" },
    error: { src: "/error.png", frameCount: 3, fps: 10, playback: "loop", reducedFrame: 0, fallback: "poster", preload: "idle" },
  },
};

function pendingImage(container: HTMLElement) {
  return container.querySelector(".mascot-sprite__strip.is-pending") as HTMLImageElement;
}

function activeImage(container: HTMLElement) {
  return container.querySelector(".mascot-sprite__strip.is-active") as HTMLImageElement;
}

describe("MascotSprite", () => {
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders the configured reduced-motion frame without advancing", () => {
    const { container } = render(<MascotSprite motion="idle" reducedMotion manifest={TEST_MANIFEST} />);

    fireEvent.load(pendingImage(container));
    const stage = container.querySelector(".mascot-sprite");
    const image = activeImage(container);
    expect(stage).toHaveAttribute("data-reduced-motion", "true");
    expect(stage).toHaveAttribute("data-frame-index", "1");
    expect(image).toHaveStyle({ transform: "translate3d(-33.33333333333333%, 0, 0)" });
    act(() => vi.advanceTimersByTime(1_000));
    expect(stage).toHaveAttribute("data-frame-index", "1");
  });

  it("advances and wraps a looping strip after it loads", () => {
    const { container } = render(<MascotSprite motion="working" manifest={TEST_MANIFEST} />);
    fireEvent.load(pendingImage(container));

    act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "1");
    act(() => vi.advanceTimersByTime(200));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "0");
  });

  it("keeps the loaded scene visible until the next strip has loaded", () => {
    const { container, rerender } = render(<MascotSprite motion="idle" manifest={TEST_MANIFEST} />);
    fireEvent.load(pendingImage(container));
    expect(activeImage(container).src).toContain("/idle.png");

    rerender(<MascotSprite motion="working" manifest={TEST_MANIFEST} />);
    expect(activeImage(container).src).toContain("/idle.png");
    expect(activeImage(container)).toHaveStyle({ opacity: "1" });
    expect(pendingImage(container).src).toContain("/working.png");
    expect(pendingImage(container)).toHaveStyle({ opacity: "0" });
    expect((container.querySelector(".mascot-sprite") as HTMLElement).style.backgroundImage).toBe("");

    fireEvent.load(pendingImage(container));
    expect(activeImage(container).src).toContain("/working.png");
    expect(container.querySelectorAll(".mascot-sprite__strip")).toHaveLength(1);
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-visible-motion", "working");
  });

  it("removes the poster backing after the first strip loads", () => {
    const { container } = render(<MascotSprite motion="idle" manifest={TEST_MANIFEST} />);
    const stage = container.querySelector(".mascot-sprite") as HTMLElement;

    expect(stage.style.backgroundImage).toContain("/poster.png");
    fireEvent.load(pendingImage(container));
    expect(stage.style.backgroundImage).toBe("");
  });

  it("reacts when the operating-system motion preference changes", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() { return matches; },
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    const { container } = render(<MascotSprite motion="working" manifest={TEST_MANIFEST} />);
    fireEvent.load(pendingImage(container));
    act(() => vi.advanceTimersByTime(100));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "1");

    matches = true;
    act(() => listeners.forEach((listener) => listener()));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-reduced-motion", "true");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "0");
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "0");
  });

  it("holds the final frame and reports the end of a one-shot clip", () => {
    const onPlaybackEnd = vi.fn();
    const { container } = render(
      <MascotSprite motion="complete" manifest={TEST_MANIFEST} onPlaybackEnd={onPlaybackEnd} />,
    );
    fireEvent.load(pendingImage(container));

    act(() => vi.advanceTimersByTime(300));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "2");
    expect(onPlaybackEnd).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1_000));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-index", "2");
    expect(onPlaybackEnd).toHaveBeenCalledOnce();
  });

  it("falls back to the poster when the initial strip fails", () => {
    const onAssetError = vi.fn();
    const { container } = render(
      <MascotSprite motion="error" manifest={TEST_MANIFEST} onAssetError={onAssetError} />,
    );
    expect(pendingImage(container).src).toContain("/error.png");

    fireEvent.error(pendingImage(container));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-fallback", "poster");
    expect(pendingImage(container).src).toContain("/poster.png");
    fireEvent.load(pendingImage(container));
    expect(activeImage(container).src).toContain("/poster.png");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-frame-count", "1");
    expect(onAssetError).toHaveBeenCalledWith("/error.png");
  });

  it("keeps the previous loaded scene when a replacement fails", () => {
    const { container, rerender } = render(<MascotSprite motion="idle" manifest={TEST_MANIFEST} />);
    fireEvent.load(pendingImage(container));

    rerender(<MascotSprite motion="error" manifest={TEST_MANIFEST} />);
    fireEvent.error(pendingImage(container));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-motion", "error");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-visible-motion", "idle");
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-fallback", "previous");
    expect(activeImage(container).src).toContain("/idle.png");
    expect(container.querySelectorAll(".mascot-sprite__strip")).toHaveLength(1);
  });

  it("uses the CSS stage if both the initial strip and poster fail", () => {
    const onAssetError = vi.fn();
    const { container } = render(
      <MascotSprite motion="error" manifest={TEST_MANIFEST} onAssetError={onAssetError} />,
    );

    fireEvent.error(pendingImage(container));
    fireEvent.error(pendingImage(container));
    expect(container.querySelector(".mascot-sprite")).toHaveAttribute("data-fallback", "stage");
    expect(container.querySelector(".mascot-sprite__strip")).not.toBeInTheDocument();
    expect(onAssetError).toHaveBeenNthCalledWith(1, "/error.png");
    expect(onAssetError).toHaveBeenNthCalledWith(2, "/poster.png");
  });
});
