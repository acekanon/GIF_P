import { Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { LivePhotoResult } from "../tauri";
import "./live-photo-preview.css";

export type LivePhotoPreviewProps = {
  stillSrc: string;
  motionSrc: string;
  alt: string;
  livePhoto: LivePhotoResult;
  stageOnly?: boolean;
  reducedMotion?: boolean;
};

export function isLivePhotoCompatibilityVerified(livePhoto: LivePhotoResult) {
  return livePhoto.compatibility_status === "locally_verified"
    && livePhoto.validation_scope === "local_contract"
    && Boolean(livePhoto.still_path?.trim())
    && Boolean(livePhoto.motion_path?.trim())
    && Boolean(livePhoto.asset_identifier?.trim())
    && livePhoto.asset_identifier_verified
    && livePhoto.metadata_pairing_verified;
}

export function livePhotoValidationLabel(livePhoto: LivePhotoResult) {
  if (isLivePhotoCompatibilityVerified(livePhoto)) return "Apple 配对契约已本地验证";
  if (livePhoto.compatibility_status === "failed") return "本地配对验证失败";
  return "待本地验证 · 不宣称 Apple Photos 已接收";
}

export function LivePhotoPreview({
  stillSrc,
  motionSrc,
  alt,
  livePhoto,
  stageOnly = false,
  reducedMotion = false,
}: LivePhotoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [holding, setHolding] = useState(false);
  const [controlPlaying, setControlPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const motionVisible = holding || controlPlaying;
  const compatibilityVerified = isLivePhotoCompatibilityVerified(livePhoto);

  function rewindToPoster() {
    const video = videoRef.current;
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // Some media engines reject seeking until metadata has loaded. The
        // poster remains visible and loadedmetadata will perform the rewind.
      }
    }
    setHolding(false);
    setControlPlaying(false);
  }

  function playMotion(mode: "hold" | "control") {
    const video = videoRef.current;
    if (!video) return;
    setPlaybackFailed(false);
    setHolding(mode === "hold");
    setControlPlaying(mode === "control");
    try {
      video.currentTime = 0;
    } catch {
      // See rewindToPoster: playback can still begin once media is ready.
    }
    let playback: Promise<void> | undefined;
    try {
      playback = video.play();
    } catch {
      setPlaybackFailed(true);
      rewindToPoster();
      return;
    }
    if (playback) {
      void playback.catch(() => {
        setPlaybackFailed(true);
        rewindToPoster();
      });
    }
  }

  function startHolding(event?: React.PointerEvent<HTMLButtonElement>) {
    if (event && event.currentTarget.setPointerCapture) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    playMotion("hold");
  }

  function stopHolding(event?: React.PointerEvent<HTMLButtonElement>) {
    if (!holding) return;
    if (event && event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    rewindToPoster();
  }

  useEffect(() => {
    rewindToPoster();
  }, [stillSrc, motionSrc]);

  return (
    <figure className={`live-photo-preview${motionVisible ? " is-playing" : ""}${stageOnly ? " is-stage-only" : ""}`}>
      <div className="live-photo-preview__stage">
        <img className="live-photo-preview__still" src={stillSrc} alt={`${alt} 静态关键帧`} draggable={false} />
        <video
          ref={videoRef}
          className="live-photo-preview__motion"
          src={motionSrc}
          poster={stillSrc}
          aria-label={`${alt} MOV 动态部分`}
          aria-hidden={!motionVisible}
          muted={muted}
          playsInline
          preload={reducedMotion ? "metadata" : "auto"}
          onEnded={rewindToPoster}
          onLoadedMetadata={() => {
            if (!motionVisible && videoRef.current) videoRef.current.currentTime = 0;
          }}
          onError={() => {
            setPlaybackFailed(true);
            rewindToPoster();
          }}
        />
        <button
          type="button"
          className="live-photo-preview__hold"
          aria-label="按住播放实况照片，松开回到关键帧"
          aria-pressed={holding}
          onPointerDown={startHolding}
          onPointerUp={stopHolding}
          onPointerCancel={stopHolding}
          onPointerLeave={stopHolding}
          onBlur={rewindToPoster}
          onKeyDown={(event) => {
            if ((event.key === " " || event.key === "Enter") && !event.repeat) {
              event.preventDefault();
              playMotion("hold");
            } else if (event.key === "Escape") {
              event.preventDefault();
              rewindToPoster();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              rewindToPoster();
            }
          }}
        >
          <span>{holding ? "松开回到关键帧" : "按住播放"}</span>
        </button>
      </div>
      <figcaption className="live-photo-preview__caption">
        <span className={`live-photo-preview__verification ${compatibilityVerified ? "verified" : livePhoto.compatibility_status === "failed" ? "failed" : "unverified"}`}>
          {livePhotoValidationLabel(livePhoto)}
        </span>
        <div className="live-photo-preview__controls">
          <button
            type="button"
            className="live-photo-preview__play-control"
            aria-label={controlPlaying ? "暂停实况照片" : "播放实况照片"}
            aria-pressed={controlPlaying}
            onClick={() => (controlPlaying ? rewindToPoster() : playMotion("control"))}
          >
            {controlPlaying ? <Pause weight="fill" /> : <Play weight="fill" />}
            <span>{controlPlaying ? "暂停并归位" : "常规播放"}</span>
          </button>
          <button
            type="button"
            className="live-photo-preview__sound-control"
            aria-label={muted ? "打开实况照片声音" : "静音实况照片"}
            aria-pressed={!muted}
            onClick={() => setMuted((value) => !value)}
          >
            {muted ? <SpeakerSlash weight="fill" /> : <SpeakerHigh weight="fill" />}
          </button>
        </div>
        {(playbackFailed || livePhoto.validation_message) && (
          <small>{playbackFailed ? "MOV 无法播放，请打开成对资源检查。" : livePhoto.validation_message}</small>
        )}
      </figcaption>
    </figure>
  );
}
