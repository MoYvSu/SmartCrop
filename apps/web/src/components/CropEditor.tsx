import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { clamp, MIN_CROP_SIZE, moveCrop } from "../lib/crop";
import type { CropBox } from "../types";

type Handle = "move" | "nw" | "ne" | "sw" | "se";

interface Interaction {
  handle: Handle;
  pointerX: number;
  pointerY: number;
  crop: CropBox;
  width: number;
  height: number;
}

interface Props {
  imageUrl: string;
  crop: CropBox;
  onChange: (crop: CropBox) => void;
}

const handleLabels: Record<Exclude<Handle, "move">, string> = {
  nw: "调整左上角",
  ne: "调整右上角",
  sw: "调整左下角",
  se: "调整右下角",
};

function resizeCrop(start: CropBox, handle: Handle, dx: number, dy: number): CropBox {
  if (handle === "move") return moveCrop(start, dx, dy);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  let x = start.x;
  let y = start.y;
  let nextRight = right;
  let nextBottom = bottom;

  if (handle.includes("w")) x = clamp(start.x + dx, 0, right - MIN_CROP_SIZE);
  if (handle.includes("e")) nextRight = clamp(right + dx, start.x + MIN_CROP_SIZE, 1);
  if (handle.includes("n")) y = clamp(start.y + dy, 0, bottom - MIN_CROP_SIZE);
  if (handle.includes("s")) nextBottom = clamp(bottom + dy, start.y + MIN_CROP_SIZE, 1);
  return { x, y, width: nextRight - x, height: nextBottom - y };
}

export function CropEditor({ imageUrl, crop, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);

  const startInteraction = useCallback(
    (handle: Handle, event: ReactPointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      event.stopPropagation();
      setInteraction({
        handle,
        pointerX: event.clientX,
        pointerY: event.clientY,
        crop,
        width: rect.width,
        height: rect.height,
      });
    },
    [crop],
  );

  useEffect(() => {
    if (!interaction) return;
    const move = (event: PointerEvent) => {
      const dx = (event.clientX - interaction.pointerX) / interaction.width;
      const dy = (event.clientY - interaction.pointerY) / interaction.height;
      onChange(resizeCrop(interaction.crop, interaction.handle, dx, dy));
    };
    const stop = () => setInteraction(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [interaction, onChange]);

  const keyboardDelta = (event: ReactKeyboardEvent): [number, number] | null => {
    const amount = event.shiftKey ? 0.05 : 0.01;
    return ({
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    } as Record<string, [number, number]>)[event.key] ?? null;
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const delta = keyboardDelta(event);
    if (!delta) return;
    event.preventDefault();
    onChange(moveCrop(crop, delta[0], delta[1]));
  };

  const onHandleKeyDown = (handle: Exclude<Handle, "move">, event: ReactKeyboardEvent) => {
    const delta = keyboardDelta(event);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(resizeCrop(crop, handle, delta[0], delta[1]));
  };

  return (
    <div className="crop-stage" ref={containerRef}>
      <img src={imageUrl} alt="待裁剪原图" draggable={false} />
      <div className="crop-shade" aria-hidden="true" />
      <div
        className={`crop-box ${interaction ? "is-dragging" : ""}`}
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`,
        }}
        role="group"
        aria-label="裁剪框。可拖动位置，方向键微调，按住 Shift 加速。"
        tabIndex={0}
        onPointerDown={(event) => startInteraction("move", event)}
        onKeyDown={onKeyDown}
      >
        <span className="crop-grid grid-one" aria-hidden="true" />
        <span className="crop-grid grid-two" aria-hidden="true" />
        {(["nw", "ne", "sw", "se"] as const).map((handle) => (
          <button
            type="button"
            key={handle}
            className={`crop-handle crop-handle-${handle}`}
            aria-label={handleLabels[handle]}
            onPointerDown={(event) => startInteraction(handle, event)}
            onKeyDown={(event) => onHandleKeyDown(handle, event)}
          >
            <span aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
