import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";

import { moveCrop, resizeCrop, scaleCropAroundCenter } from "../lib/crop";
import type { CropHandle } from "../lib/crop";
import type { CompositionGuide, CropBox } from "../types";

interface Interaction {
  handle: CropHandle;
  pointerId: number;
  pointerX: number;
  pointerY: number;
  crop: CropBox;
  width: number;
  height: number;
}

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  crop: CropBox;
  onChange: (crop: CropBox) => void;
  aspectRatio?: number | null;
  guides?: CompositionGuide[];
  disabled?: boolean;
}

const handleLabels: Record<Exclude<CropHandle, "move">, string> = {
  nw: "调整左上角",
  ne: "调整右上角",
  sw: "调整左下角",
  se: "调整右下角",
};

interface StageSize {
  width: number;
  height: number;
}

export function fitStageSize(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number,
  maxHeight: number,
): StageSize {
  const scale = Math.min(
    Math.max(maxWidth, 1) / Math.max(imageWidth, 1),
    Math.max(maxHeight, 1) / Math.max(imageHeight, 1),
  );
  return {
    width: Math.max(imageWidth, 1) * scale,
    height: Math.max(imageHeight, 1) * scale,
  };
}

export function CropEditor({
  imageUrl,
  imageWidth,
  imageHeight,
  crop,
  onChange,
  aspectRatio = null,
  guides = ["thirds"],
  disabled = false,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [stageSize, setStageSize] = useState<StageSize | null>(null);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const resize = () => {
      if (!shell.clientWidth) return;
      const next = fitStageSize(
        imageWidth,
        imageHeight,
        shell.clientWidth,
        Math.max(240, window.innerHeight - 245),
      );
      setStageSize((current) => (
        current
        && Math.abs(current.width - next.width) < 0.5
        && Math.abs(current.height - next.height) < 0.5
          ? current
          : next
      ));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    window.addEventListener("resize", resize);
    resize();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [imageHeight, imageWidth]);

  const startInteraction = useCallback(
    (handle: CropHandle, event: ReactPointerEvent) => {
      if (disabled || event.button !== 0) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction({
        handle,
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        crop,
        width: rect.width,
        height: rect.height,
      });
    },
    [crop, disabled],
  );

  useEffect(() => {
    if (disabled) setInteraction(null);
    if (!interaction || disabled) return;
    const move = (event: PointerEvent) => {
      if (event.pointerId !== interaction.pointerId) return;
      const dx = (event.clientX - interaction.pointerX) / interaction.width;
      const dy = (event.clientY - interaction.pointerY) / interaction.height;
      onChange(resizeCrop(interaction.crop, interaction.handle, dx, dy, aspectRatio));
    };
    const stop = (event: PointerEvent) => {
      if (event.pointerId === interaction.pointerId) setInteraction(null);
    };
    const blur = () => setInteraction(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", blur);
    };
  }, [aspectRatio, disabled, interaction, onChange]);

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
    if (disabled) return;
    const delta = keyboardDelta(event);
    if (!delta) return;
    event.preventDefault();
    onChange(moveCrop(crop, delta[0], delta[1]));
  };

  const onHandleKeyDown = (handle: Exclude<CropHandle, "move">, event: ReactKeyboardEvent) => {
    if (disabled) return;
    const delta = keyboardDelta(event);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(resizeCrop(crop, handle, delta[0], delta[1], aspectRatio));
  };

  return (
    <>
    <div className="crop-stage-shell" ref={shellRef}>
      <div
        className="crop-stage"
        ref={containerRef}
        style={{
          width: stageSize?.width ?? "100%",
          height: stageSize?.height,
          aspectRatio: `${imageWidth} / ${imageHeight}`,
        }}
      >
        <img src={imageUrl} alt="待裁剪原图" draggable={false} />
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
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          onPointerDown={(event) => startInteraction("move", event)}
          onKeyDown={onKeyDown}
        >
          <span className="crop-guides" aria-hidden="true">
            {guides.includes("thirds") && (
              <span className="thirds-guide">
                <i className="guide-vertical guide-first" />
                <i className="guide-vertical guide-second" />
                <i className="guide-horizontal guide-first" />
                <i className="guide-horizontal guide-second" />
              </span>
            )}
            {guides.includes("center") && (
              <span className="center-guide">
                <i className="guide-vertical" />
                <i className="guide-horizontal" />
              </span>
            )}
            {guides.includes("diagonal") && (
              <svg className="diagonal-guide" viewBox="0 0 100 100" preserveAspectRatio="none">
                <path d="M0 0 L100 100 M100 0 L0 100" />
              </svg>
            )}
            {guides.includes("safe") && <span className="safe-area-guide" />}
          </span>
          {(["nw", "ne", "sw", "se"] as const).map((handle) => (
            <button
              type="button"
              key={handle}
              className={`crop-handle crop-handle-${handle}`}
              aria-label={handleLabels[handle]}
              disabled={disabled}
              onPointerDown={(event) => startInteraction(handle, event)}
              onKeyDown={(event) => onHandleKeyDown(handle, event)}
            >
              <span aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </div>
    <details className="crop-fine-controls">
      <summary><SlidersHorizontal aria-hidden="true" size={16} />精细调整</summary>
      <p>无需拖动，也可微调位置与范围。方向按钮每次移动原图的 1%。</p>
      <div className="crop-fine-actions">
        <div className="crop-fine-move" role="group" aria-label="微调裁剪位置">
          {([
            ["向左微调", ArrowLeft, -0.01, 0],
            ["向上微调", ArrowUp, 0, -0.01],
            ["向下微调", ArrowDown, 0, 0.01],
            ["向右微调", ArrowRight, 0.01, 0],
          ] as const).map(([label, Icon, dx, dy]) => (
            <button type="button" key={label} aria-label={label} disabled={disabled}
              onClick={() => { if (!disabled) onChange(moveCrop(crop, dx, dy)); }}>
              <Icon aria-hidden="true" size={17} />{label.slice(0, 2)}
            </button>
          ))}
        </div>
        <div className="crop-fine-scale" role="group" aria-label="调整裁剪范围">
          <button type="button" aria-label="缩小裁剪范围" disabled={disabled}
            onClick={() => { if (!disabled) onChange(scaleCropAroundCenter(crop, 0.95, aspectRatio)); }}>
            <ZoomOut aria-hidden="true" size={17} />缩小范围
          </button>
          <button type="button" aria-label="扩大裁剪范围" disabled={disabled}
            onClick={() => { if (!disabled) onChange(scaleCropAroundCenter(crop, 1.05, aspectRatio)); }}>
            <ZoomIn aria-hidden="true" size={17} />扩大范围
          </button>
        </div>
      </div>
    </details>
    </>
  );
}
