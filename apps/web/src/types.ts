export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AestheticReport {
  overview: string;
  strengths: string[];
  issues: string[];
  crop_rationale: string;
  shooting_tips: string[];
  language: "en" | "zh-CN";
  translation_provider: "deepseek" | null;
}

export interface JobResponse {
  id: string;
  status: JobStatus;
  queue_position: number | null;
  progress_message: string;
  created_at: string;
  expires_at: string;
  image_width: number;
  image_height: number;
  ai_crop: CropBox | null;
  final_crop: CropBox | null;
  manual_adjusted: boolean;
  manual_only: boolean;
  report: AestheticReport | null;
  artifacts: {
    preview: string | null;
    crop: string | null;
  };
  error: { code: string; message: string } | null;
}
