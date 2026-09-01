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
