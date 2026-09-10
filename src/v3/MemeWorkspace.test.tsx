import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEME_TEMPLATES,
  MemeWorkspace,
  fitMemePreviewBox,
  parseMemeMediaDimensions,
  type MemeMediaAsset,
  type MemeOverlaySettings,
} from "./MemeWorkspace";

const videoAsset: MemeMediaAsset = {
  id: "clip-1",
  name: "reaction.mp4",
  kind: "video",
  sourceUrl: "https://assets.local/reaction.mp4",
  thumbnailUrl: "https://assets.local/reaction.jpg",
  dimensions: "1080x1080",
  duration: 3.2,
};

afterEach(cleanup);

describe("MemeWorkspace", () => {
  it("fits captions to the real contained media box", () => {
    expect(parseMemeMediaDimensions("1080 × 1920")).toEqual({ width: 1080, height: 1920 });
    expect(parseMemeMediaDimensions("640x640")).toEqual({ width: 640, height: 640 });
    expect(parseMemeMediaDimensions("读取中")).toBeNull();
    expect(fitMemePreviewBox(
      { width: 800, height: 450 },
      { width: 1080, height: 1920 },
    )).toEqual({ width: 253, height: 450 });
  });

  it("offers nine distinct expression templates and previews video assets", () => {
    const { container } = render(<MemeWorkspace asset={videoAsset} onApply={vi.fn()} />);

    expect(MEME_TEMPLATES).toHaveLength(9);
    const templateList = screen.getByRole("list", { name: "表情包预设模板" });
    expect(within(templateList).getAllByRole("listitem")).toHaveLength(9);
    expect(screen.getByRole("button", { name: /经典上下白字/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /黑框底字/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /电影黑边/ })).toBeVisible();
    expect(within(templateList).getByRole("button", { name: /热搜标题/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "GIF表情包制作" })).toBeVisible();
    expect(screen.getByLabelText("reaction.mp4 视频预览")).toHaveAttribute("src", videoAsset.sourceUrl);
    expect(container.querySelector("video")).toHaveAttribute("poster", videoAsset.thumbnailUrl);
  });

  it("keeps edited copy while templates update only the visual recipe", async () => {
    const user = userEvent.setup();
    render(<MemeWorkspace asset={videoAsset} onApply={vi.fn()} />);

    await user.click(within(screen.getByRole("list", { name: "表情包预设模板" })).getByRole("button", { name: /底部字幕/ }));
    expect(screen.getByLabelText("下方文字")).toHaveValue("事情开始变得有趣了");
    expect(screen.getByTestId("meme-preview")).toHaveClass("placement-lower");

    await user.clear(screen.getByLabelText("下方文字"));
    await user.type(screen.getByLabelText("下方文字"), "这下真的压缩了");
    expect(within(screen.getByTestId("meme-preview")).getByText("这下真的压缩了")).toBeVisible();

    await user.click(within(screen.getByRole("list", { name: "表情包预设模板" })).getByRole("button", { name: /弹幕 \/ 吐槽/ }));
    expect(screen.getByLabelText("上方文字")).toHaveValue("");
    expect(screen.getByLabelText("下方文字")).toHaveValue("这下真的压缩了");
    expect(screen.getByTestId("meme-preview")).toHaveClass("template-barrage", "placement-split", "align-left");
    expect(screen.getByTestId("meme-preview").querySelector(".meme-preview__captions")).toHaveClass("style-highlight");

    await user.click(screen.getByRole("button", { name: "文字右对齐" }));
    expect(screen.getByTestId("meme-preview")).toHaveClass("align-right");
  });

  it("clears copy and sends the current visual draft into export", async () => {
    const user = userEvent.setup();
    const onEnterExport = vi.fn();
    render(<MemeWorkspace asset={videoAsset} onApply={onEnterExport} />);

    await user.click(within(screen.getByRole("list", { name: "表情包预设模板" })).getByRole("button", { name: /双行对白/ }));
    await user.click(screen.getByRole("button", { name: /清空文字/ }));
    expect(screen.getByLabelText("上方文字")).toHaveValue("");
    expect(screen.getByLabelText("下方文字")).toHaveValue("");
    expect(screen.getByRole("button", { name: /应用到导出/ })).toBeDisabled();

    await user.click(within(screen.getByRole("list", { name: "表情包预设模板" })).getByRole("button", { name: /白边海报/ }));
    expect(screen.getByLabelText("上方文字")).toHaveValue("");
    expect(screen.getByLabelText("下方文字")).toHaveValue("");

    await user.type(screen.getByLabelText("下方文字"), "收到");
    await user.click(screen.getByRole("button", { name: /应用到导出/ }));

    expect(onEnterExport).toHaveBeenCalledWith(expect.objectContaining({
      sourceAssetId: "clip-1",
      templateId: "poster",
      topText: "",
      bottomText: "收到",
      style: "panel",
      textAlign: "center",
      position: "split",
      topPosition: { x: 50, y: 18 },
      bottomPosition: { x: 50, y: 82 },
    }));
  });

  it("lets the user drag each caption independently and keeps the coordinates for export", () => {
    const onDraftChange = vi.fn();
    const onApply = vi.fn();
    render(<MemeWorkspace asset={videoAsset} onApply={onApply} onDraftChange={onDraftChange} />);

    const canvas = screen.getByTestId("meme-preview-canvas");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    });

    const bottomCaption = screen.getByRole("button", { name: /拖动下方文字/ });
    fireEvent.pointerDown(bottomCaption, { pointerId: 7, button: 0, clientX: 200, clientY: 264 });
    fireEvent.pointerMove(bottomCaption, { pointerId: 7, clientX: 300, clientY: 150 });
    fireEvent.pointerUp(bottomCaption, { pointerId: 7, clientX: 300, clientY: 150 });

    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
      position: "free",
      topPosition: { x: 50, y: 12 },
      bottomPosition: { x: 75, y: 50 },
    }));
    expect(screen.getByTestId("meme-preview")).toHaveClass("placement-free");
    expect(bottomCaption).toHaveStyle({ left: "75%", top: "50%" });

    fireEvent.click(screen.getByRole("button", { name: /应用到导出/ }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      sourceAssetId: "clip-1",
      position: "free",
      bottomPosition: { x: 75, y: 50 },
    }));
  });

  it("supports a parent-controlled draft and reports every draft mutation", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const persistedDraft: MemeOverlaySettings = {
      templateId: "classic",
      topText: "父级保存的铺垫",
      bottomText: "父级保存的反转",
      style: "classic",
      fontSize: 44,
      textAlign: "center",
      position: "split",
      topPosition: { x: 50, y: 12 },
      bottomPosition: { x: 50, y: 88 },
    };

    function ControlledWorkspace() {
      const [value, setValue] = useState(persistedDraft);
      return (
        <MemeWorkspace
          asset={videoAsset}
          value={value}
          onDraftChange={(next) => {
            onDraftChange(next);
            setValue(next);
          }}
          onApply={vi.fn()}
        />
      );
    }

    render(<ControlledWorkspace />);
    expect(screen.getByLabelText("上方文字")).toHaveValue("父级保存的铺垫");

    await user.click(within(screen.getByRole("list", { name: "表情包预设模板" })).getByRole("button", { name: /底部字幕/ }));
    expect(screen.getByLabelText("上方文字")).toHaveValue("父级保存的铺垫");
    expect(screen.getByLabelText("下方文字")).toHaveValue("父级保存的反转");
    expect(screen.getByTestId("meme-preview")).toHaveClass("template-subtitle", "placement-lower");
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({
      templateId: "subtitle",
      topText: "父级保存的铺垫",
      bottomText: "父级保存的反转",
      style: "panel",
      position: "lower",
    }));

    await user.clear(screen.getByLabelText("上方文字"));
    expect(screen.getByLabelText("上方文字")).toHaveValue("");
    expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ topText: "" }));
  });

  it("uses image preview and keeps export unavailable without a selected asset", () => {
    const imageAsset: MemeMediaAsset = {
      ...videoAsset,
      id: "image-1",
      name: "reaction.webp",
      kind: "webp",
      sourceUrl: "https://assets.local/reaction.webp",
    };
    const { rerender } = render(<MemeWorkspace asset={imageAsset} onApply={vi.fn()} />);
    expect(screen.getByRole("img", { name: /reaction\.webp 动画预览，WEBP 动画预览/ })).toBeVisible();
    expect(document.querySelector(".meme-animation-player")).toHaveAttribute("data-stage-only", "true");
    expect(document.querySelector(".meme-animation-player figcaption")).not.toBeInTheDocument();

    rerender(<MemeWorkspace onApply={vi.fn()} />);
    expect(screen.getByRole("button", { name: /应用到导出/ })).toBeDisabled();
    expect(screen.getByText("选择素材后在这里排版")).toBeVisible();
  });

  it("previews chat backgrounds without mutating the caption recipe and exports the edited short reply", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onQuickExport = vi.fn();
    render(<MemeWorkspace asset={videoAsset} onApply={vi.fn()} onDraftChange={onDraftChange} onQuickExport={onQuickExport} />);
    await user.click(screen.getByRole("button", { name: "收到！" }));
    expect(screen.getByLabelText("上方文字")).toHaveValue("当我说只改一个参数");
    expect(screen.getByLabelText("下方文字")).toHaveValue("收到！");
    onDraftChange.mockClear();
    await user.click(screen.getByRole("button", { name: "浅色聊天" }));
    expect(screen.getByTestId("meme-preview")).toHaveClass("surface-chat_light");
    await user.click(screen.getByRole("button", { name: "深色聊天" }));
    expect(screen.getByTestId("meme-preview")).toHaveClass("surface-chat_dark");
    expect(onDraftChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /快速导出表情包/ }));
    expect(onQuickExport).toHaveBeenCalledWith(expect.objectContaining({ sourceAssetId: "clip-1", bottomText: "收到！", fontSize: 44 }));
  });

  it("scales the same cropped canvas and captions down to a 176px chat preview", async () => {
    const user = userEvent.setup();
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, toJSON: () => ({}),
    });
    try {
      render(<MemeWorkspace asset={videoAsset} crop={{ left: 25, right: 25, top: 0, bottom: 0 }} onApply={vi.fn()} />);
      expect(screen.getByTestId("meme-preview-canvas")).toHaveStyle({ width: "150px", height: "300px" });
      await user.click(screen.getByRole("button", { name: "浅色聊天" }));
      const canvas = screen.getByTestId("meme-preview-canvas");
      expect(canvas).toHaveStyle({ width: "88px", height: "176px" });
      expect(canvas.querySelector(".meme-preview__media")).toHaveStyle({ width: "200%", left: "-50%" });
      expect(canvas.querySelector(".meme-preview__captions")).toHaveStyle({ "--meme-font-size": `${44 * 88 / 420}px` });
    } finally { bounds.mockRestore(); }
  });
});
