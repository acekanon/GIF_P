import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  insetsToRect,
  rectFromDrag,
  rectToInsets,
  type CropInsets,
  type CropRect,
  type Point,
} from "./editorModel";

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type CropChangeReason = "draw" | "move" | "resize" | "keyboard";
type DragState =
  | { mode: "draw"; start: Point }
  | { mode: "move"; start: Point; rect: CropRect }
  | { mode: "resize"; start: Point; rect: CropRect; handle: Handle };

type Props = {
  value: CropInsets;
  onChange: (value: CropInsets, reason?: CropChangeReason) => void;
  onCommit?: (value: CropInsets) => void;
  onApply?: (value: CropInsets) => void;
  onCancel?: () => void;
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const MIN_CROP_SIZE = 4;

function isEmptyCrop(value: CropInsets) {
  return value.left <= 0.01
    && value.top <= 0.01
    && value.right <= 0.01
    && value.bottom <= 0.01;
}

function minimumDragRect(start: Point, current: Point): CropRect | null {
  const delta = { x: current.x - start.x, y: current.y - start.y };
  if (Math.abs(delta.x) < 0.01 && Math.abs(delta.y) < 0.01) return null;

  const rect = rectFromDrag(start, current);
  if (rect.width < MIN_CROP_SIZE) {
    if (delta.x < 0) {
      const right = clamp(start.x, MIN_CROP_SIZE, 100);
      rect.x = right - MIN_CROP_SIZE;
    } else {
      rect.x = clamp(start.x, 0, 100 - MIN_CROP_SIZE);
    }
    rect.width = MIN_CROP_SIZE;
  }
  if (rect.height < MIN_CROP_SIZE) {
    if (delta.y < 0) {
      const bottom = clamp(start.y, MIN_CROP_SIZE, 100);
      rect.y = bottom - MIN_CROP_SIZE;
    } else {
      rect.y = clamp(start.y, 0, 100 - MIN_CROP_SIZE);
    }
    rect.height = MIN_CROP_SIZE;
  }
  return rect;
}

function resizeRect(rect: CropRect, handle: Handle, delta: Point): CropRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = clamp(left + delta.x, 0, right - MIN_CROP_SIZE);
  if (handle.includes("e")) right = clamp(right + delta.x, left + MIN_CROP_SIZE, 100);
  if (handle.includes("n")) top = clamp(top + delta.y, 0, bottom - MIN_CROP_SIZE);
  if (handle.includes("s")) bottom = clamp(bottom + delta.y, top + MIN_CROP_SIZE, 100);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function CropBox({ value, onChange, onCommit, onApply, onCancel }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const latestValueRef = useRef(value);
  latestValueRef.current = value;
  const [drag, setDrag] = useState<DragState | null>(null);
  const rect = isEmptyCrop(value) ? null : insetsToRect(value);

  function emit(next: CropInsets, reason: CropChangeReason) {
    latestValueRef.current = next;
    onChange(next, reason);
  }

  function point(event: ReactPointerEvent<HTMLDivElement>): Point {
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    };
  }

  function begin(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const start = point(event);
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined;
    const selection = (event.target as HTMLElement).closest(".crop-box__selection");
    if (handle && rect) setDrag({ mode: "resize", start, rect, handle });
    else if (selection && rect) setDrag({ mode: "move", start, rect });
    else {
      setDrag({ mode: "draw", start });
    }
    rootRef.current?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const current = point(event);
    if (drag.mode === "draw") {
      const nextRect = minimumDragRect(drag.start, current);
      if (nextRect) emit(rectToInsets(nextRect), "draw");
      return;
    }
    const delta = { x: current.x - drag.start.x, y: current.y - drag.start.y };
    if (drag.mode === "move") {
      emit(rectToInsets({
        ...drag.rect,
        x: clamp(drag.rect.x + delta.x, 0, 100 - drag.rect.width),
        y: clamp(drag.rect.y + delta.y, 0, 100 - drag.rect.height),
      }), "move");
      return;
    }
    emit(rectToInsets(resizeRect(drag.rect, drag.handle, delta)), "resize");
  }

  function end(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    move(event);
    setDrag(null);
    rootRef.current?.releasePointerCapture?.(event.pointerId);
    onCommit?.(latestValueRef.current);
  }

  function adjustHandleWithKeyboard(handle: Handle, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!rect || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const step = event.shiftKey ? 5 : 1;
    const delta = {
      x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
      y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
    };
    const affectsHorizontal = delta.x !== 0 && (handle.includes("w") || handle.includes("e"));
    const affectsVertical = delta.y !== 0 && (handle.includes("n") || handle.includes("s"));
    if (!affectsHorizontal && !affectsVertical) return;
    event.preventDefault();
    emit(rectToInsets(resizeRect(rect, handle, delta)), "keyboard");
  }

  function handleCropKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key === "Enter" && rect) {
      event.preventDefault();
      onApply?.(latestValueRef.current);
    }
  }

  return (
    <div
      ref={rootRef}
      className={drag ? "crop-box dragging" : "crop-box"}
      role="region"
      aria-label="裁剪画布"
      tabIndex={0}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={() => setDrag(null)}
      onKeyDown={handleCropKeyboard}
    >
      {rect ? (
        <div
          className="crop-box__selection"
          style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.width}%`, height: `${rect.height}%` }}
        >
          <span className="crop-box__grid grid-one" />
          <span className="crop-box__grid grid-two" />
          <span className="crop-box__grid grid-three" />
          <span className="crop-box__grid grid-four" />
          {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((handle) => (
            <button
              key={handle}
              type="button"
              className={`crop-box__handle handle-${handle}`}
              data-handle={handle}
              aria-label={`调整裁剪 ${handle}`}
              onKeyDown={(event) => adjustHandleWithKeyboard(handle, event)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
