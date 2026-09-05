import type { CropBox } from "../types";

export const MIN_CROP_SIZE = 0.08;

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
): number | null {
  const ratios: Record<string, number> = { "1:1": 1, "4:5": 4 / 5, "3:4": 3 / 4, "16:9": 16 / 9 };
  return ratios[aspect] ? ratios[aspect] * imageHeight / imageWidth : null;
}

export function fitCropToAspect(crop: CropBox, ratio: number | null): CropBox {
  if (!ratio) return crop;
  let width = crop.width;
  let height = crop.height;
  if (width / height < ratio) height = width / ratio;
  else width = height * ratio;
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  return {
    x: clamp(centerX - width / 2, 0, 1 - width),
    y: clamp(centerY - height / 2, 0, 1 - height),
    width,
    height,
  };
}
