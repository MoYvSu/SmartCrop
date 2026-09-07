import type { AnalysisIntent, CropBox } from "../types";

export interface CropMetrics {
  retainedPercent: number;
  outputWidth: number;
  outputHeight: number;
  requestedRatio: string;
  ratioCompliant: boolean;
}

export function cropPixelSize(
  imageWidth: number,
  imageHeight: number,
  crop: CropBox,
): [number, number] {
  const x1 = Math.max(0, Math.min(Math.round(crop.x * imageWidth), imageWidth - 1));
  const y1 = Math.max(0, Math.min(Math.round(crop.y * imageHeight), imageHeight - 1));
  const x2 = Math.max(
    x1 + 1,
    Math.min(Math.round((crop.x + crop.width) * imageWidth), imageWidth),
  );
  const y2 = Math.max(
    y1 + 1,
    Math.min(Math.round((crop.y + crop.height) * imageHeight), imageHeight),
  );
  return [x2 - x1, y2 - y1];
}

export function ratioComponents(intent: AnalysisIntent): [number, number] | null {
  if (intent.aspect_ratio === "custom" && intent.custom_ratio) {
    return [intent.custom_ratio.width, intent.custom_ratio.height];
  }
  const ratios: Partial<Record<AnalysisIntent["aspect_ratio"], [number, number]>> = {
    "1:1": [1, 1],
    "4:5": [4, 5],
    "3:4": [3, 4],
    "16:9": [16, 9],
  };
  return ratios[intent.aspect_ratio] || null;
}

export function getCropMetrics(
  imageWidth: number,
  imageHeight: number,
  crop: CropBox,
  intent: AnalysisIntent,
): CropMetrics {
  const [outputWidth, outputHeight] = cropPixelSize(imageWidth, imageHeight, crop);
  const target = ratioComponents(intent);
  const ratioCompliant = target
    ? Math.abs(outputWidth * target[1] - outputHeight * target[0]) <= target[0] + target[1]
    : true;
  return {
    retainedPercent: crop.width * crop.height * 100,
    outputWidth,
    outputHeight,
    requestedRatio:
      intent.aspect_ratio === "custom" && intent.custom_ratio
        ? `${intent.custom_ratio.width}:${intent.custom_ratio.height}`
        : intent.aspect_ratio,
    ratioCompliant,
  };
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "未记录";
  if (milliseconds < 1000) return `${milliseconds} 毫秒`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} 秒`;
}
