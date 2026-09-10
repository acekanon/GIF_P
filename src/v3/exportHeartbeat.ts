export type ExportHeartbeat = {
  progress: number;
  stage: string;
};

/**
 * The encoder currently returns one final Tauri response.  While it is doing
 * real work, keep the interface responsive without pretending that we know an
 * exact FFmpeg frame percentage.  The value is deliberately capped below 100;
 * only a verified output may complete the progress bar.
 */
export function exportHeartbeatForElapsed(elapsedMs: number, targetSizeSearch: boolean): ExportHeartbeat {
  const seconds = Math.max(0, elapsedMs) / 1000;

  if (seconds < 4) {
    return {
      progress: Math.min(19, 8 + Math.floor(seconds * 3)),
      stage: "读取素材与时间线",
    };
  }

  if (seconds < 15) {
    return {
      progress: Math.min(42, 20 + Math.floor((seconds - 4) * 2)),
      stage: "整理画面与调色板",
    };
  }

  const tailSeconds = seconds - 15;
  const cap = targetSizeSearch ? 94 : 92;
  const growth = targetSizeSearch ? 48 : 45;
  const progress = Math.min(cap, 43 + Math.floor(growth * (1 - Math.exp(-tailSeconds / 38))));

  return {
    progress,
    stage: targetSizeSearch
      ? "搜索目标体积并核验候选"
      : "编码成品并核验文件",
  };
}
