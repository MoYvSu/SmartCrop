import { ApiError } from "./api";
import type { AnalysisIntent, CompositionGuide, CropBox, CropCandidate, JobResponse, JobStatus, SelectionReason } from "./types";

export interface WorkspaceUser { id: string; username: string; display_name: string }
export interface AuthSession { user: WorkspaceUser | null; csrf_token: string | null }
export interface WorkspacePreferences {
  revision: number;
  intent: AnalysisIntent;
  guides: CompositionGuide[];
}
export interface PhotoExif {
  camera_make?: string;
  camera_model?: string;
  lens_model?: string;
  focal_length_mm?: number;
  aperture?: number;
  exposure_seconds?: number;
  iso?: number;
}
export interface ProjectDraft {
  crop: CropBox;
  selected_candidate_id: CropCandidate["id"] | null;
  selection_reasons: SelectionReason[];
  selection_note: string | null;
  selection_explicit: boolean;
  reference_job_id?: string | null;
  guides?: CompositionGuide[];
}
export interface ProjectSummary {
  id: string; title: string; state: "draft" | "archived"; revision: number;
  created_at: string; updated_at: string; archived_at: string | null;
  image_width: number; image_height: number; original_url: string; preview_url: string;
  crop_url: string; published_url: string | null; has_draft_changes: boolean;
  source?: "upload" | "pregenerated";
  published?: PublishedProject | null;
}
export interface PublishedProject extends ProjectDraft {
  version: number; created_at: string; width: number; height: number;
  intent: AnalysisIntent; draft: ProjectDraft; source?: "upload" | "pregenerated";
}
export interface ProjectReference {
  job_id: string; status: JobStatus; candidates: CropCandidate[]; ai_crop: CropBox | null;
  report: JobResponse["report"]; capability_status: JobResponse["capability_status"];
  processing_duration_ms: number | null; error: JobResponse["error"];
}
export interface ProjectDetail extends ProjectSummary {
  intent: AnalysisIntent; draft: ProjectDraft; active_job_id: string | null;
  reference: ProjectReference | null;
  published: PublishedProject | null;
  exif?: PhotoExif;
}

// This token lives only in memory. The actual login credential is an HttpOnly cookie.
let csrfToken: string | null = null;
export function clearWorkspaceSession() { csrfToken = null; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) {
    headers.set("X-SmartCrop-CSRF", csrfToken);
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) {
    let detail = `请求失败（HTTP ${response.status}）`;
    try { const body = await response.json(); if (typeof body.detail === "string") detail = body.detail; } catch { /* Safe fallback. */ }
    if (response.status === 403 && init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      // Another tab may rotate the shared cookie. Refresh the CSRF token only;
      // never silently replay imports, deletions or archive operations.
      try {
        const session = await getAuthSession();
        if (session.user) detail += " 登录校验已同步，请再次执行此操作；当前调整仍保留。";
      } catch { /* Preserve the original failure and all local edits. */ }
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function json(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal };
}
export async function getAuthSession(signal?: AbortSignal): Promise<AuthSession> {
  const session = await request<AuthSession>("/v1/auth/session", { signal });
  signal?.throwIfAborted();
  csrfToken = session.csrf_token;
  return session;
}
export async function login(username: string, password: string): Promise<AuthSession> {
  const session = await request<AuthSession>("/v1/auth/login", json("POST", { username, password }));
  csrfToken = session.csrf_token;
  return session;
}
export async function logout(): Promise<void> {
  try { await request("/v1/auth/logout", json("POST", {})); }
  catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
  clearWorkspaceSession();
}
export function getPreferences(signal?: AbortSignal): Promise<WorkspacePreferences> {
  return request("/v1/preferences", { signal });
}
export function savePreferences(preferences: WorkspacePreferences): Promise<WorkspacePreferences> {
  return request("/v1/preferences", json("PUT", preferences));
}
export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const items: ProjectSummary[] = [];
  let offset = 0;
  while (true) {
    const page = await request<{ items: ProjectSummary[]; next_offset?: number | null }>(
      `/v1/projects?limit=200&offset=${offset}`, { signal },
    );
    signal?.throwIfAborted();
    items.push(...page.items);
    if (page.next_offset == null) return [...new Map(items.map(item => [item.id, item])).values()];
    if (page.next_offset <= offset) throw new Error("作品列表分页异常，请稍后重试。");
    offset = page.next_offset;
  }
}
export function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail> {
  return request(`/v1/projects/${encodeURIComponent(id)}`, { signal });
}
export function createProject(file: File, intent: AnalysisIntent, signal?: AbortSignal): Promise<ProjectDetail> {
  const body = new FormData();
  body.append("file", file, file.name);
  body.append("scene", intent.scene);
  body.append("aspect_ratio", intent.aspect_ratio);
  if (intent.output_template) body.append("output_template", intent.output_template);
  if (intent.custom_ratio) {
    body.append("custom_ratio_width", String(intent.custom_ratio.width));
    body.append("custom_ratio_height", String(intent.custom_ratio.height));
  }
  return request("/v1/projects", { method: "POST", body, signal });
}
export function saveProject(id: string, revision: number, draft: ProjectDraft, title?: string): Promise<ProjectDetail> {
  return request(`/v1/projects/${encodeURIComponent(id)}`, json("PATCH", { revision, ...draft, ...(title === undefined ? {} : { title }) }));
}
export function archiveProject(id: string, revision: number): Promise<ProjectDetail> {
  return request(`/v1/projects/${encodeURIComponent(id)}/archive`, json("POST", { revision }));
}
export function deleteProject(id: string): Promise<void> {
  return request(`/v1/projects/${encodeURIComponent(id)}`, json("DELETE", {}));
}
export function analyzeProject(id: string): Promise<JobResponse> {
  return request(`/v1/projects/${encodeURIComponent(id)}/analyze`, json("POST", {}));
}

/** Only the editor's presentation shape is reused; no temporary artifact URL is retained. */
export function projectToJob(project: ProjectDetail): JobResponse {
  const reference = project.reference;
  return {
    id: project.id, status: "succeeded", queue_position: null, progress_message: "作品已打开",
    created_at: project.created_at, expires_at: "9999-12-31T00:00:00Z",
    image_width: project.image_width, image_height: project.image_height, mode: "crop", parent_job_id: null,
    intent: project.intent, candidates: reference?.candidates || [], selected_candidate_id: project.draft.selected_candidate_id,
    capability_status: reference?.capability_status || "not_run", ai_crop: reference?.ai_crop || null,
    final_crop: project.draft.crop, manual_adjusted: true, manual_only: !reference?.report,
    selection_confirmed: true, selection_reasons: project.draft.selection_reasons,
    selection_note: project.draft.selection_note, processing_duration_ms: reference?.processing_duration_ms || null,
    report: reference?.report || null,
    artifacts: { preview: project.preview_url, crop: project.crop_url, plan: null }, error: reference?.error || null,
  };
}
