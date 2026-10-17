import type { AnalysisIntent, CropBox } from "../types";

export const MIN_CROP_SIZE = 0.08;
const MIN_NORMALIZED_CROP_DIMENSION = 0.02;
export type CropHandle = "move" | "nw" | "ne" | "sw" | "se";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function cropEquals(left: CropBox, right: CropBox, epsilon = 0.0001): boolean {
  return (
    Math.abs(left.x - right.x) < epsilon &&
    Math.abs(left.y - right.y) < epsilon &&
    Math.abs(left.width - right.width) < epsilon &&
    Math.abs(left.height - right.height) < epsilon
  );
}

export function moveCrop(crop: CropBox, dx: number, dy: number): CropBox {
  return {
    ...crop,
    x: clamp(crop.x + dx, 0, 1 - crop.width),
    y: clamp(crop.y + dy, 0, 1 - crop.height),
  };
}

export function resizeCrop(
  start: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  aspectRatio: number | null = null,
): CropBox {
  if (handle === "move") return moveCrop(start, dx, dy);
  const east = handle.includes("e");
  const south = handle.includes("s");
  const anchorX = east ? start.x : start.x + start.width;
  const anchorY = south ? start.y : start.y + start.height;

  if (aspectRatio) {
    // Express either pointer axis as a width change, so a single arrow key can
    // enlarge a locked crop too. The opposite corner remains the fixed anchor.
    const horizontalChange = east ? dx : -dx;
    const verticalChange = (south ? dy : -dy) * aspectRatio;
    const change = Math.abs(horizontalChange) >= Math.abs(verticalChange)
      ? horizontalChange
      : verticalChange;
    const maxWidth = Math.min(
      east ? 1 - anchorX : anchorX,
      (south ? 1 - anchorY : anchorY) * aspectRatio,
    );
    const minimumWidth = Math.min(
      maxWidth,
      Math.max(MIN_NORMALIZED_CROP_DIMENSION, MIN_NORMALIZED_CROP_DIMENSION * aspectRatio),
    );
    const width = clamp(start.width + change, minimumWidth, maxWidth);
    const height = width / aspectRatio;
    return {
      x: east ? anchorX : Math.max(0, anchorX - width),
      y: south ? anchorY : Math.max(0, anchorY - height),
      width,
      height,
    };
  }

  // Existing narrow candidates stay narrow instead of jumping up to the usual
  // interactive minimum as soon as the user touches an unrelated axis.
  const minimumWidth = Math.min(MIN_CROP_SIZE, start.width);
  const minimumHeight = Math.min(MIN_CROP_SIZE, start.height);
  const x = east ? start.x : clamp(start.x + dx, 0, anchorX - minimumWidth);
  const y = south ? start.y : clamp(start.y + dy, 0, anchorY - minimumHeight);
  const right = east ? clamp(anchorX + start.width + dx, anchorX + minimumWidth, 1) : anchorX;
  const bottom = south ? clamp(anchorY + start.height + dy, anchorY + minimumHeight, 1) : anchorY;
  return { x, y, width: right - x, height: bottom - y };
}

export function scaleCropAroundCenter(
  crop: CropBox,
  scale: number,
  aspectRatio: number | null = null,
): CropBox {
  const resized = resizeCrop(
    { ...crop, x: 0, y: 0 },
    "se",
    crop.width * (scale - 1),
    crop.height * (scale - 1),
    aspectRatio,
  );
  return moveCrop(
    resized,
    crop.x + (crop.width - resized.width) / 2,
    crop.y + (crop.height - resized.height) / 2,
  );
}

export function normalizedAspectRatio(
  aspect: string,
  imageWidth: number,
  imageHeight: number,
  customRatio?: { width: number; height: number } | null,
): number | null {
  const ratios: Record<string, number> = { "1:1": 1, "4:5": 4 / 5, "3:4": 3 / 4, "16:9": 16 / 9 };
  const pixelRatio = aspect === "custom" && customRatio
    ? customRatio.width / customRatio.height
    : ratios[aspect];
  return pixelRatio ? pixelRatio * imageHeight / imageWidth : null;
}

export function fitCropToAspect(crop: CropBox, ratio: number | null): CropBox {
  if (!ratio) return crop;
  let width = crop.width;
  let height = crop.height;
  if (width / height < ratio) height = width / ratio;
  else width = height * ratio;
  if (width < MIN_NORMALIZED_CROP_DIMENSION) {
    width = MIN_NORMALIZED_CROP_DIMENSION;
    height = width / ratio;
  } else if (height < MIN_NORMALIZED_CROP_DIMENSION) {
    height = MIN_NORMALIZED_CROP_DIMENSION;
    width = height * ratio;
  }
  if (width > 1 || height > 1) throw new Error("目标比例无法保留有效裁剪区域");
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  return {
    x: clamp(centerX - width / 2, 0, 1 - width),
    y: clamp(centerY - height / 2, 0, 1 - height),
    width,
    height,
  };
}

export function fitCropToIntent(
  crop: CropBox,
  intent: AnalysisIntent,
  imageWidth: number,
  imageHeight: number,
): CropBox {
  return fitCropToAspect(
    crop,
    normalizedAspectRatio(
      intent.aspect_ratio,
      imageWidth,
      imageHeight,
      intent.custom_ratio,
    ),
  );
}
