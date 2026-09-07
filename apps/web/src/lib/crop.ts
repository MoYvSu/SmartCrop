import type { AnalysisIntent, CropBox } from "../types";

export const MIN_CROP_SIZE = 0.08;
const MIN_NORMALIZED_CROP_DIMENSION = 0.02;

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

/** Reference lines a moved box may magnet to: edges and the composition guides. */
export const SNAP_LINES = [0, 1 / 3, 0.5, 2 / 3, 1];
const SNAP_EPSILON = 0.012;

function snapAxisPosition(value: number, size: number): number {
  // A box can align to a line with any of its left/top, center, or right/bottom
  // edge. Choose the closest legal target and keep the box size untouched.
  let best = value;
  let bestDelta = SNAP_EPSILON;
  for (const line of SNAP_LINES) {
    for (const offset of [0, -size / 2, -size]) {
      const candidate = line + offset;
      const delta = Math.abs(candidate - value);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Snap an entire (size-preserving) move to the active composition lines.
 * Only used for whole-box moves, never for resizing, so a locked ratio is
 * never silently broken.
 */
export function snapMovedCrop(crop: CropBox): CropBox {
  return {
    x: clamp(snapAxisPosition(crop.x, crop.width), 0, 1 - crop.width),
    y: clamp(snapAxisPosition(crop.y, crop.height), 0, 1 - crop.height),
    width: crop.width,
    height: crop.height,
  };
}
