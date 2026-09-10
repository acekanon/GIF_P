import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GifTreatmentPicker } from "./GifTreatmentPicker";
afterEach(cleanup);

it("explains the parameter preference and forwards a treatment without changing other settings", () => {
  const onChange = vi.fn();
  const { rerender } = render(<GifTreatmentPicker value="hybrid" fps={12} colors={128} onChange={onChange} />);
  expect(screen.getByText("当前参数倾向：色彩增强")).toBeVisible();
  fireEvent.click(screen.getByRole("radio", { name: /降噪平滑/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("clean_opt");
  rerender(<GifTreatmentPicker value="hybrid" fps={30} colors={128} onChange={onChange} />);
  expect(screen.getByText("当前参数倾向：保持原貌")).toBeVisible();
});

it("makes the alpha-safe treatment explicit and prevents selecting incompatible processing", () => {
  const onChange = vi.fn();
  render(<GifTreatmentPicker value="clean_opt" fps={12} colors={128} sourceHasAlpha onChange={onChange} />);
  expect(screen.getByRole("radio", { name: /保持原貌/ })).toBeChecked();
  const smoothing = screen.getByRole("radio", { name: /降噪平滑/ });
  expect(smoothing).toBeDisabled();
  expect(screen.getByText("已适配透明素材")).toBeVisible();
  fireEvent.click(smoothing);
  expect(onChange).not.toHaveBeenCalled();
});
