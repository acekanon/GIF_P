import type { GifRequest, GifResult } from "../tauri";
import { MEME_TEMPLATES, settingsFromTemplate, type MemeOverlaySettings } from "./MemeWorkspace";

export type MemeItemStatus = "draft" | "queued" | "running" | "completed" | "failed" | "cancelled";
export type MemeItem = {
  id: string;
  revision: number;
  settings: MemeOverlaySettings;
  status: MemeItemStatus;
  request?: GifRequest;
  result?: GifResult;
  error?: string;
};
export type MemeCollection = { selectedId: string; items: MemeItem[]; outputKey: string };
export const MEME_SET_LIMIT = 20;
export function cloneMeme(settings: MemeOverlaySettings): MemeOverlaySettings {
  return { ...settings, topPosition: { ...settings.topPosition }, bottomPosition: { ...settings.bottomPosition } };
}
export function createMemeCollection(assetId: string, outputKey: string, draft?: MemeOverlaySettings): MemeCollection {
  const id = `${assetId}:first`;
  return { selectedId: id, outputKey, items: [{ id, revision: 0, status: "draft", settings: {
    ...cloneMeme(draft ?? settingsFromTemplate(MEME_TEMPLATES[0])), sourceAssetId: assetId,
  } }] };
}
export function editMemeItem(collection: MemeCollection, id: string, settings: MemeOverlaySettings): MemeCollection {
  return { ...collection, items: collection.items.map(item => item.id === id ? {
    id, revision: item.revision + 1, settings: cloneMeme(settings), status: "draft",
  } : item) };
}
export function addMemeItem(collection: MemeCollection, id: string, duplicate: boolean): MemeCollection {
  if (collection.items.length >= MEME_SET_LIMIT) return collection;
  const original = collection.items.find(item => item.id === collection.selectedId) ?? collection.items[0];
  const settings = cloneMeme(original.settings);
  if (!duplicate) { settings.topText = ""; settings.bottomText = ""; }
  return { ...collection, selectedId: id, items: [...collection.items, { id, revision: 0, settings, status: "draft" }] };
}
export function removeMemeItem(collection: MemeCollection, id: string): MemeCollection {
  if (collection.items.length <= 1) return collection;
  const index = collection.items.findIndex(item => item.id === id);
  const items = collection.items.filter(item => item.id !== id);
  return { ...collection, items, selectedId: collection.selectedId === id ? items[Math.min(index, items.length - 1)].id : collection.selectedId };
}
export function invalidateMemeOutputs(collection: MemeCollection, outputKey: string): MemeCollection {
  if (collection.outputKey === outputKey) return collection;
  return { ...collection, outputKey, items: collection.items.map(item => ({
    id: item.id, revision: item.revision + 1, settings: item.settings, status: "draft",
  })) };
}
export function memeExportItems(collection: MemeCollection, retry: boolean): MemeItem[] {
  if (retry) return collection.items.filter(item => item.status === "failed" && item.request);
  const pending = collection.items.filter(item => item.status !== "completed");
  return pending.length ? pending : collection.items;
}

export type MemeJob = Pick<MemeItem, "id" | "revision"> & { request: GifRequest };
/** Sequential dispatch keeps memory bounded. A failed item never aborts the remaining set. */
export async function runMemeQueue(
  jobs: MemeJob[],
  convert: (request: GifRequest) => Promise<GifResult>,
  isCurrent: () => boolean,
  publish: (job: MemeJob, patch: Partial<MemeItem>) => void,
) {
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    if (!isCurrent()) break;
    publish(job, { status: "running" });
    try {
      const result = await convert(job.request);
      if (!isCurrent()) break;
      publish(job, { status: "completed", result, error: undefined });
      completed++;
    } catch (error) {
      if (!isCurrent()) break;
      publish(job, { status: "failed", error: String(error) });
      failed++;
    }
  }
  return { completed, failed, cancelled: !isCurrent() };
}
