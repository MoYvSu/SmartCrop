import { fitCropToAspect, normalizedAspectRatio } from "./crop";
import type { AnalysisIntent, CropBox, JobResponse } from "../types";

export const DEMO_IMAGE_URL = "/demo/composition-sample.svg";
export const DEMO_IMAGE_WIDTH = 1600;
export const DEMO_IMAGE_HEIGHT = 1000;

export function createPregeneratedJob(intent: AnalysisIntent): JobResponse {
  const normalizedRatio = normalizedAspectRatio(
    intent.aspect_ratio,
    DEMO_IMAGE_WIDTH,
    DEMO_IMAGE_HEIGHT,
    intent.custom_ratio,
  );
  const boxes: Array<["balanced" | "subject" | "story", CropBox]> = [
    ["balanced", { x: 0.08, y: 0.08, width: 0.84, height: 0.84 }],
    ["subject", { x: 0.42, y: 0.08, width: 0.54, height: 0.82 }],
    ["story", { x: 0.03, y: 0.04, width: 0.94, height: 0.9 }],
  ];
  const candidates = boxes.map(([id, crop]) => ({
    id,
    crop: fitCropToAspect(crop, normalizedRatio),
  }));
  const now = Date.now();
  return {
    id: "demo-pregenerated",
    status: "succeeded",
    queue_position: null,
    progress_message: "预生成演示已载入",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    image_width: DEMO_IMAGE_WIDTH,
    image_height: DEMO_IMAGE_HEIGHT,
    mode: "crop",
    parent_job_id: null,
    intent,
    candidates,
    selected_candidate_id: "balanced",
    capability_status: "not_run",
    ai_crop: candidates[0].crop,
    final_crop: candidates[0].crop,
    manual_adjusted: false,
    manual_only: false,
    selection_confirmed: false,
    selection_reasons: [],
    selection_note: null,
    processing_duration_ms: null,
    report: {
      overview: "合成静物场景包含明确主体、环境窗口和可调节留白，适合演示构图选择。",
      strengths: ["主体与背景形成清楚层次。", "横向空间可用于比较紧凑与叙事构图。"],
      issues: ["左侧窗框和右侧花器之间的视觉权重需要按用途取舍。"],
      crop_rationale: "三个预生成框分别展示平衡、主体优先和环境叙事方向，不代表自动优劣排序。",
      shooting_tips: ["实时演示时可使用同一样例验证当前后端链路。"],
      language: "zh-CN",
      translation_provider: null,
    },
    artifacts: { preview: null, crop: null, plan: null },
    error: null,
  };
}

export async function loadAuthorizedDemoFile(): Promise<File> {
  const response = await fetch(DEMO_IMAGE_URL);
  if (!response.ok) throw new Error("演示样例加载失败");
  const source = await response.blob();
  const sourceUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = DEMO_IMAGE_WIDTH;
    canvas.height = DEMO_IMAGE_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持演示样例转换");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("演示样例转换失败"))),
        "image/png",
      );
    });
    return new File([png], "SmartCrop-authorized-demo.png", { type: "image/png" });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

export async function downloadDemoCrop(
  imageUrl: string,
  crop: CropBox,
  filename: string,
): Promise<void> {
  const image = new Image();
  image.src = imageUrl;
  await image.decode();
  const x1 = Math.max(0, Math.min(Math.round(crop.x * image.width), image.width - 1));
  const y1 = Math.max(0, Math.min(Math.round(crop.y * image.height), image.height - 1));
  const x2 = Math.max(
    x1 + 1,
    Math.min(Math.round((crop.x + crop.width) * image.width), image.width),
  );
  const y2 = Math.max(
    y1 + 1,
    Math.min(Math.round((crop.y + crop.height) * image.height), image.height),
  );
  const canvas = document.createElement("canvas");
  canvas.width = x2 - x1;
  canvas.height = y2 - y1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器不支持演示裁剪导出");
  context.drawImage(image, x1, y1, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("演示裁剪导出失败"))),
      "image/png",
    );
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${filename}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
