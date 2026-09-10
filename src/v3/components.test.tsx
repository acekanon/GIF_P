import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompressionPresetSelect } from "./CompressionPresetSelect";
import { CropBox } from "./CropBox";
import { EnergyProgress } from "./EnergyProgress";
import { IslandRadioGroup } from "./IslandRadioGroup";
import { PlaybackSpeedControl } from "./PlaybackSpeedControl";
import { TrimRange } from "./TrimRange";
import type { CropInsets } from "./editorModel";

afterEach(cleanup);

describe("CompressionPresetSelect", () => {
  it("opens as a listbox and selects a preset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompressionPresetSelect value="perceptual" onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: /压缩预设/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox", { name: "压缩预设选项" })).toBeVisible();
    expect(screen.getByRole("option", { name: /观感优先/ })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("option", { name: /极小包/ }));
    expect(onChange).toHaveBeenCalledWith("tiny");
  });

  it("closes without resetting when the current option is selected again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<CompressionPresetSelect value="clean_noise" onChange={onChange} />);

    await user.click(within(container).getByRole("button", { name: /压缩预设/ }));
    await user.click(within(container).getByRole("option", { name: /低噪干净/ }));

    expect(onChange).not.toHaveBeenCalled();
    expect(within(container).getByRole("button", { name: /压缩预设/ })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("PlaybackSpeedControl", () => {
  it("offers 1x/2x shortcuts and a 1.0x-3.0x slider in 0.1 steps", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PlaybackSpeedControl value={1} onChange={onChange} />);

    const slider = screen.getByRole("slider", { name: "输出速度滑杆" });
    expect(slider).toHaveAttribute("min", "1");
    expect(slider).toHaveAttribute("max", "3");
    expect(slider).toHaveAttribute("step", "0.1");
    fireEvent.change(slider, { target: { value: "2.7" } });
    expect(onChange).toHaveBeenCalledWith(2.7);

    await user.click(screen.getByRole("button", { name: "2×" }));
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

describe("IslandRadioGroup", () => {
  it("moves the splash-bearing selected state on every radio change", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [value, setValue] = useState("gif");
      return (
        <IslandRadioGroup
          ariaLabel="输出格式"
          value={value}
          options={[
            { value: "gif", label: "GIF" },
            { value: "webp", label: "WebP" },
          ]}
          onChange={setValue}
        />
      );
    }

    const { container } = render(<Harness />);
    const gif = screen.getByRole("radio", { name: "GIF" });
    const webp = screen.getByRole("radio", { name: "WebP" });
    expect(gif).toBeChecked();
    expect(gif.parentElement?.querySelector(".island-radio__splash")).toBeInTheDocument();

    await user.click(webp);
    expect(gif).not.toBeChecked();
    expect(webp).toBeChecked();
    expect(webp.parentElement?.querySelector(".island-radio__splash")).toBeInTheDocument();
    expect(container.querySelectorAll(".island-radio__splash")).toHaveLength(2);
  });
});

describe("EnergyProgress", () => {
  it("keeps the kitchen off the main surface until its hidden trigger is used", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EnergyProgress
        progress={8}
        busy
        status="正在编码素材"
        sourceLabel="clip.mp4"
        outputFormat="webp"
      />,
    );

    const progress = within(container).getByRole("progressbar", { name: "生成进度" });
    expect(progress).toHaveAttribute("aria-valuenow", "8");
    expect(progress).toHaveClass("phase-busy");
    expect(progress).toHaveTextContent("正在锤出更小成品");
    expect(progress).toHaveAttribute("aria-valuetext", expect.stringContaining("WEBP，压缩 0%"));
    expect(container.querySelector(".burger-progress__stage")).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "打开压堡彩蛋" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "压堡小厨房" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("clip.mp4")).toBeInTheDocument();
    expect(dialog.querySelector(".burger-progress__stage")).toHaveAttribute("data-easter", "steam");
    expect(dialog.querySelector(".burger-progress__stage")).toHaveAttribute("data-contact-frame", "50");

    await user.click(within(dialog).getByRole("button", { name: "关闭压堡彩蛋" }));
    expect(screen.queryByRole("dialog", { name: "压堡小厨房" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("serves a format-specific compressed burger with the completed image preview", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EnergyProgress
        progress={100}
        busy={false}
        status="WEBP 生成完成"
        sourceLabel="clip.mp4"
        outputFormat="webp"
        resultUrl="/preset-previews/perceptual.gif"
      />,
    );

    const progress = within(container).getByRole("progressbar", { name: "生成进度" });
    expect(progress).toHaveClass("phase-complete");
    expect(progress).toHaveTextContent("已生成");
    expect(progress).not.toHaveTextContent("牛油果透明堡已完成");
    expect(progress).toHaveAttribute("data-format", "WEBP");
    await user.click(screen.getByRole("button", { name: "打开压堡彩蛋" }));
    expect(document.querySelector(".burger-result-ticket img")).toHaveAttribute(
      "src",
      "/preset-previews/perceptual.gif",
    );
  });

  it("keeps the strike anchors stable while compression and format replace only the burger recipe", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <EnergyProgress
        progress={40}
        busy
        status="正在编码素材"
        outputFormat="gif"
        compressionPercent={0}
      />,
    );
    await user.click(screen.getByRole("button", { name: "打开压堡彩蛋" }));

    const dialog = screen.getByRole("dialog", { name: "压堡小厨房" });
    const mascot = dialog.querySelector(".burger-mascot");
    const hammer = dialog.querySelector(".burger-hammer");
    const order = dialog.querySelector(".burger-order");
    const squishAt = () => (dialog.querySelector(".burger-progress__stage") as HTMLElement).style.getPropertyValue("--burger-squish");
    expect(squishAt()).toBe("1");

    rerender(<EnergyProgress progress={40} busy status="正在编码素材" outputFormat="webp" compressionPercent={30} />);
    expect(squishAt()).toBe("0.8");
    expect(dialog.querySelector(".burger-stack")).toHaveAttribute("data-recipe", "WEBP");
    expect(dialog.querySelector(".burger-layer--onion")).toBeInTheDocument();

    rerender(<EnergyProgress progress={40} busy status="正在编码素材" outputFormat="apng" compressionPercent={60} />);
    expect(squishAt()).toBe("0.6");
    expect(dialog.querySelector(".burger-stack")).toHaveAttribute("data-recipe", "APNG");
    expect(dialog.querySelector(".burger-layer--rainbow")).toBeInTheDocument();

    rerender(<EnergyProgress progress={40} busy status="正在编码素材" outputFormat="live_photo" compressionPercent={90} />);
    expect(squishAt()).toBe("0.4");
    expect(dialog.querySelector(".burger-stack")).toHaveAttribute("data-recipe", "LIVE_PHOTO");
    expect(dialog.querySelector(".burger-mascot")).toBe(mascot);
    expect(dialog.querySelector(".burger-hammer")).toBe(hammer);
    expect(dialog.querySelector(".burger-order")).toBe(order);
  });

  it("uses a distinct jammed state when generation fails", () => {
    const { container } = render(
      <EnergyProgress progress={8} busy={false} status="生成失败：编码器不可用" />,
    );

    const progress = within(container).getByRole("progressbar", { name: "生成进度" });
    expect(progress).toHaveClass("phase-error");
    expect(progress).toHaveTextContent("汉堡弹回来了");
    expect(progress).toHaveTextContent("生成失败：编码器不可用");
  });
});

describe("TrimRange", () => {
  it("separates nearly overlapping handles and raises the active one", () => {
    const { container } = render(<TrimRange duration={100} start={50} end={50.1} onStart={vi.fn()} onEnd={vi.fn()} />);
    const rail = container.querySelector(".trim-range__rail");
    const start = screen.getByLabelText("开始时间");
    const end = screen.getByLabelText("结束时间");

    expect(rail).toHaveClass("handles-overlap");
    fireEvent.focus(start);
    expect(start).toHaveStyle({ zIndex: "5" });
    expect(end).toHaveStyle({ zIndex: "3" });
  });
});

describe("CropBox", () => {
  it("draws a crop rectangle from pointer movement", () => {
    let latest: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };
    const onCommit = vi.fn();

    function Harness() {
      const [crop, setCrop] = useState(latest);
      return (
        <CropBox
          value={crop}
          onChange={(next) => {
            latest = next;
            setCrop(next);
          }}
          onCommit={onCommit}
        />
      );
    }

    const { container } = render(<Harness />);
    const canvas = within(container).getByRole("region", { name: "裁剪画布" });
    expect(container.querySelector(".crop-box__selection")).not.toBeInTheDocument();
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 160, clientY: 80 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 160, clientY: 80 });

    expect(latest).toEqual({ left: 10, top: 20, right: 20, bottom: 20 });
    expect(onCommit).toHaveBeenCalledWith(latest);
    expect(container.querySelector(".crop-box__selection")).toBeInTheDocument();
  });

  it("keeps an empty crop empty on a click without a drag", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CropBox value={{ left: 0, top: 0, right: 0, bottom: 0 }} onChange={onChange} />,
    );
    const canvas = within(container).getByRole("region", { name: "裁剪画布" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 50 });

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".crop-box__selection")).not.toBeInTheDocument();
  });

  it("allows a minimum-size crop against the bottom-right edge", () => {
    let latest: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };

    function Harness() {
      const [crop, setCrop] = useState(latest);
      return (
        <CropBox
          value={crop}
          onChange={(next) => {
            latest = next;
            setCrop(next);
          }}
        />
      );
    }

    const { container } = render(<Harness />);
    const canvas = within(container).getByRole("region", { name: "裁剪画布" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(canvas, { pointerId: 2, clientX: 198, clientY: 99 });
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 200, clientY: 100 });

    expect(latest).toEqual({ left: 96, top: 96, right: 0, bottom: 0 });
  });

  it("lets keyboard users adjust an existing crop handle", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CropBox value={{ left: 10, top: 10, right: 10, bottom: 10 }} onChange={onChange} />,
    );

    fireEvent.keyDown(within(container).getByRole("button", { name: "调整裁剪 e" }), {
      key: "ArrowRight",
    });

    expect(onChange).toHaveBeenCalledWith({ left: 10, top: 10, right: 9, bottom: 10 }, "keyboard");
  });

  it("applies or goes back from the crop with keyboard shortcuts", () => {
    const value = { left: 10, top: 10, right: 10, bottom: 10 };
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<CropBox value={value} onChange={vi.fn()} onApply={onApply} onCancel={onCancel} />);
    const canvas = screen.getByRole("region", { name: "裁剪画布" });

    fireEvent.keyDown(canvas, { key: "Enter" });
    fireEvent.keyDown(canvas, { key: "Escape" });
    fireEvent.keyDown(canvas, { key: "Backspace" });

    expect(onApply).toHaveBeenCalledWith(value);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
