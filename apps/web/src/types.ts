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

export type CompositionGuide = "thirds" | "center" | "diagonal" | "safe";
export type RunProvenance = "upload" | "authorized_realtime" | "pregenerated";

export type SceneType = "general" | "portrait" | "landscape" | "product" | "social";
export type AspectRatio = "free" | "1:1" | "4:5" | "3:4" | "16:9";
export type OutputTemplate =
  | "freeform"
  | "avatar"
  | "social_cover"
  | "product_main"
  | "presentation"
  | "custom";
export type SelectionReason =
  | "subject_emphasis"
  | "context_preservation"
  | "visual_balance"
  | "platform_fit"
  | "other";

export interface CustomRatio {
  width: number;
  height: number;
}

export interface AnalysisIntent {
  scene: SceneType;
  aspect_ratio: AspectRatio | "custom";
  output_template: OutputTemplate | null;
  custom_ratio: CustomRatio | null;
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
  capability_status: "not_run" | "mock" | "unverified" | "verified";
  ai_crop: CropBox | null;
  final_crop: CropBox | null;
  manual_adjusted: boolean;
  manual_only: boolean;
  selection_confirmed: boolean;
  selection_reasons: SelectionReason[];
  selection_note: string | null;
  processing_duration_ms: number | null;
  report: AestheticReport | null;
  artifacts: {
    preview: string | null;
    crop: string | null;
    plan: string | null;
  };
  error: { code: string; message: string } | null;
}
