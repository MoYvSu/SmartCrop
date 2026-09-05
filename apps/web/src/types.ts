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

export type SceneType = "general" | "portrait" | "landscape" | "product" | "social";
export type AspectRatio = "free" | "1:1" | "4:5" | "3:4" | "16:9";

export interface AnalysisIntent {
  scene: SceneType;
  aspect_ratio: AspectRatio;
}

export interface CropCandidate {
  id: "balanced" | "subject" | "story";
  crop: CropBox;
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
  mode: "crop" | "review";
  parent_job_id: string | null;
  intent: AnalysisIntent;
  candidates: CropCandidate[];
  selected_candidate_id: CropCandidate["id"] | null;
  capability_status: "mock" | "unverified" | "verified";
  ai_crop: CropBox | null;
  final_crop: CropBox | null;
  manual_adjusted: boolean;
  manual_only: boolean;
  report: AestheticReport | null;
  artifacts: {
    preview: string | null;
    crop: string | null;
    plan: string | null;
  };
  error: { code: string; message: string } | null;
}
