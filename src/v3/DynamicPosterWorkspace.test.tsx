import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaAsset } from "./GifpV3";
import { DynamicPosterWorkspace } from "./DynamicPosterWorkspace";

const assets: MediaAsset[] = [
  { id: "still", path: "C:/media/poster.png", name: "poster.png", kind: "image", sourceUrl: "poster.png", status: "等待" },
  { id: "main", path: "C:/media/main.gif", name: "main.gif", kind: "gif", animated: true, sourceUrl: "main.gif", status: "等待" },
  { id: "detail", path: "C:/media/detail.webp", name: "detail.webp", kind: "webp", animated: true, sourceUrl: "detail.webp", status: "等待" },
];

afterEach(cleanup);

describe("DynamicPosterWorkspace", () => {
  it("builds a two-window GIF and WebP delivery request", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(
      <DynamicPosterWorkspace
        assets={assets}
        outputDir="C:/exports"
        busy={false}
        status="准备就绪"
        onAddAssets={() => undefined}
        onChooseOutput={() => undefined}
        onGenerate={onGenerate}
      />,
    );

    expect(screen.getByRole("heading", { name: "动态海报" })).toBeVisible();
    expect(screen.getByRole("button", { name: /主动态窗口/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /辅动态窗口/ })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: /生成动态海报/ })).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("静态底板"), "still");
    await user.click(screen.getByRole("button", { name: /生成动态海报/ }));

    expect(onGenerate).toHaveBeenCalledWith(expect.objectContaining({
      background_path: "C:/media/poster.png",
      export_mode: "gif_webp",
      width: 1200,
      height: 1920,
      slots: [
        expect.objectContaining({ input_path: "C:/media/main.gif" }),
        expect.objectContaining({ input_path: "C:/media/detail.webp" }),
      ],
    }));
  });

  it("lets the auxiliary motion window be disabled", async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    render(
      <DynamicPosterWorkspace
        assets={assets}
        outputDir="C:/exports"
        busy={false}
        status="准备就绪"
        onAddAssets={() => undefined}
        onChooseOutput={() => undefined}
        onGenerate={onGenerate}
      />,
    );
    await user.click(screen.getByRole("tab", { name: /辅动态窗/ }));
    await user.click(screen.getByRole("checkbox", { name: "启用这个窗口" }));
    await user.click(screen.getByRole("button", { name: /生成动态海报/ }));
    expect(onGenerate.mock.calls[0][0].slots).toHaveLength(1);
  });
});
