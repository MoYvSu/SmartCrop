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
