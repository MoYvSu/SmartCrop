import type { CropBox, JobResponse } from "./types";

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
    const body = (await response.json()) as { detail?: string };
    return body.detail || `请求失败（HTTP ${response.status}）`;
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
}

async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, await readError(response));
  return (await response.json()) as T;
}

export async function createJob(file: File, accessCode: string): Promise<JobResponse> {
  const form = new FormData();
  form.append("file", file, file.name);
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
): Promise<JobResponse> {
  return expectJson<JobResponse>(
    await fetch(`/v1/jobs/${jobId}/crop`, {
      method: "POST",
      headers: headers(accessCode, true),
      body: JSON.stringify({ crop }),
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
  const extension = blob.type === "image/png" ? "png" : "jpg";
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseFilename}.${extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
