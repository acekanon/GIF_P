import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CropRulers, cropPixelRect } from "./GifpV3";

afterEach(cleanup);

describe("CropRulers", () => {
  it("labels both axes with source pixel dimensions", () => {
    render(<div><CropRulers width={1920} height={1080} /></div>);

    expect(screen.getByLabelText("水平像素标尺，0 至 1920 像素")).toBeInTheDocument();
    expect(screen.getByLabelText("垂直像素标尺，0 至 1080 像素")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(2);
    expect(screen.getByText("1920")).toBeInTheDocument();
    expect(screen.getByText("1080")).toBeInTheDocument();
  });

  it("converts inset percentages into exact pixel coordinates and size", () => {
    expect(cropPixelRect({ left: 10, top: 20, right: 25, bottom: 30 }, 1920, 1080)).toEqual({
      x: 192,
      y: 216,
      width: 1248,
      height: 540,
    });
  });
});
