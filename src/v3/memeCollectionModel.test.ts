import { describe, it, expect, vi } from "vitest";
import type { GifRequest, GifResult } from "../tauri";
import { createMemeCollection, addMemeItem, editMemeItem, removeMemeItem, invalidateMemeOutputs, memeExportItems, runMemeQueue } from "./memeCollectionModel";

describe("meme collections", () => {
  it("keeps copy and positions independent, preserves at least one item", () => {
    const first = createMemeCollection("source", "settings");
    const copy = addMemeItem(first, "copy", true);
    copy.items[1].settings.topPosition.x = 4;
    expect(first.items[0].settings.topPosition.x).not.toBe(4);
    const blank = addMemeItem(copy, "blank", false);
    expect(blank.items[2].settings.bottomText).toBe("");
    expect(removeMemeItem(first, first.selectedId)).toBe(first);
    expect(removeMemeItem(blank, "blank").selectedId).toBe("copy");
  });
  it("invalidates edited outputs and retries only failures with their saved request", () => {
    const deck = addMemeItem(createMemeCollection("a", "v1"), "second", true);
    deck.items[0].status = "completed";
    deck.items[1].status = "failed";
    deck.items[1].request = { input_path: "original" } as GifRequest;
    expect(memeExportItems(deck, true).map(item => item.id)).toEqual(["second"]);
    expect(memeExportItems(deck, false)).toHaveLength(1);
    const edited = editMemeItem(deck, "second", { ...deck.items[1].settings, bottomText: "新文案" });
    expect(edited.items[1].request).toBeUndefined();
    expect(memeExportItems(edited, true)).toHaveLength(0);
    const changed = invalidateMemeOutputs(deck, "v2");
    expect(changed.items.every(item => item.status === "draft" && !item.request && !item.result)).toBe(true);
    expect(changed.items[0].revision).toBe(1);
  });
  it("continues after failure, and never publishes late results or dispatches after cancellation", async () => {
    const jobs = ["a", "b", "c"].map(id => ({ id, revision: 0, request: { input_path: id } as GifRequest }));
    const result = { output_path: "made.gif" } as GifResult;
    const convert = vi.fn().mockResolvedValueOnce(result).mockRejectedValueOnce("failed").mockResolvedValueOnce(result);
    const publish = vi.fn();
    expect(await runMemeQueue(jobs, convert, () => true, publish)).toEqual({ completed: 2, failed: 1, cancelled: false });
    expect(convert).toHaveBeenCalledTimes(3);
    let current = true;
    const late = vi.fn(async () => { current = false; return result; });
    const guarded = vi.fn();
    expect(await runMemeQueue(jobs, late, () => current, guarded)).toEqual({ completed: 0, failed: 0, cancelled: true });
    expect(late).toHaveBeenCalledTimes(1);
    expect(guarded).toHaveBeenCalledTimes(1);
    expect(guarded.mock.calls[0][1]).toEqual({ status: "running" });
  });
});
