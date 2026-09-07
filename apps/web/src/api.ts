import type { AnalysisIntent, CropBox, JobResponse } from "./types";

const ACCESS_HEADER = "X-SmartCrop-Access";

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headers(accessCode: string, json = false): HeadersInit {
  const result: Record<string, string> = {};
  if (accessCode) result[ACCESS_HEADER] = accessCode;
  if (json) result["Content-Type"] = "application/json";
  return result;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      detail?: string | Array<{ msg?: string }>;
    };
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      const messages = body.detail.flatMap((item) => item.msg ? [item.msg] : []);
      if (messages.length) return messages.join("；");
    }
    return `请求失败（HTTP ${response.status}）`;
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, await readError(response));
  return (await response.json()) as T;
}

export async function createJob(
  file: File,
  intent: AnalysisIntent,
  accessCode: string,
): Promise<JobResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("scene", intent.scene);
  form.append("aspect_ratio", intent.aspect_ratio);
  if (intent.output_template) form.append("output_template", intent.output_template);
  if (intent.custom_ratio) {
    form.append("custom_ratio_width", String(intent.custom_ratio.width));
    form.append("custom_ratio_height", String(intent.custom_ratio.height));
  }
  return expectJson<JobResponse>(
    await fetch("/v1/jobs", {
      method: "POST",
      headers: headers(accessCode),
      body: form,
    }),
  );
}

export async function getJob(jobId: string, accessCode: string): Promise<JobResponse> {
  return expectJson<JobResponse>(
    await fetch(`/v1/jobs/${jobId}`, { headers: headers(accessCode) }),
  );
}

export async function updateCrop(
  jobId: string,
  crop: CropBox,
  accessCode: string,
  candidateId?: string,
  selectionReasons: string[] = [],
  selectionNote?: string,
): Promise<JobResponse> {
  return expectJson<JobResponse>(
    await fetch(`/v1/jobs/${jobId}/crop`, {
      method: "POST",
      headers: headers(accessCode, true),
      body: JSON.stringify({
        crop,
        candidate_id: candidateId || null,
        selection_reasons: selectionReasons,
        selection_note: selectionNote || null,
      }),
    }),
  );
}

export async function downloadArtifact(
  path: string,
  accessCode: string,
  baseFilename: string,
): Promise<void> {
  const response = await fetch(path, { headers: headers(accessCode) });
  if (!response.ok) throw new ApiError(response.status, await readError(response));
  const blob = await response.blob();
  const extension = blob.type.includes("json") ? "json" : blob.type === "image/png" ? "png" : "jpg";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseFilename}.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
