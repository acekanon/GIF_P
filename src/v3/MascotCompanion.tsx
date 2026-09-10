import { useEffect } from "react";
import { MascotSprite } from "./mascot/MascotSprite";
import { preloadMascotAssets } from "./mascot/motionManifest";
import type { MascotMotionKey } from "./mascot/motionTypes";
import "./mascot-companion.css";

export type MascotPhase = "welcome" | "ready" | "working" | "recording" | "complete" | "error";

type Props = {
  activeName?: string;
  busy: boolean;
  recording: boolean;
  progress: number;
  status: string;
  hasResult: boolean;
  completedCount: number;
  qualityScoring?: boolean;
  qualityCancelPending?: boolean;
  reducedMotion?: boolean;
  onAddMedia: () => void;
  onOpenResult?: () => void;
  onCancelQualityScoring?: () => void;
};

export function resolveMascotPhase({
  activeName,
  busy,
  recording,
  status,
  hasResult,
  qualityScoring = false,
}: Pick<Props, "activeName" | "busy" | "recording" | "status" | "hasResult" | "qualityScoring">): MascotPhase {
  if (recording) return "recording";
  if (busy || qualityScoring) return "working";
  if (/失败|错误|不可用|中断/.test(status)) return "error";
  if (hasResult) return "complete";
  if (activeName) return "ready";
  return "welcome";
}

export function resolveMascotMotion(
  phase: MascotPhase,
  { progress, qualityScoring }: Pick<Props, "progress" | "qualityScoring">,
): MascotMotionKey {
  if (phase === "recording") return "loading";
  if (phase === "working") {
    return qualityScoring || progress <= 5 ? "loading" : "working";
  }
  if (phase === "complete" || phase === "error") return phase;
  return "idle";
}

export function MascotCompanion({
  activeName,
  busy,
  recording,
  progress,
  status,
  hasResult,
  qualityScoring = false,
  reducedMotion = false,
}: Props) {
  const phase = resolveMascotPhase({ activeName, busy, recording, status, hasResult, qualityScoring });
  const motion = resolveMascotMotion(phase, { progress, qualityScoring });

  useEffect(() => {
    preloadMascotAssets("eager");
    const timer = window.setTimeout(() => preloadMascotAssets("idle"), 600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <aside className={`mascot-companion mascot-companion--animation-only phase-${phase}`} data-phase={phase} aria-label="角色动画">
      <div className="mascot-companion__stage" aria-hidden="true">
        <MascotSprite motion={motion} reducedMotion={reducedMotion} className="mascot-companion__sprite" />
      </div>
    </aside>
  );
}
