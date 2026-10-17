import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, createJob, downloadArtifact, getJob, updateCrop } from "./api";
import type { AnalysisIntent, CropBox } from "./types";

const intent: AnalysisIntent = {
  scene: "general",
  aspect_ratio: "free",
  output_template: "freeform",
  custom_ratio: null,
};
const crop: CropBox = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("API cancellation", () => {
  it.each([
    {
      name: "createJob",
      path: "/v1/jobs",
      invoke: (signal: AbortSignal) => createJob(
        new File(["image"], "photo.png", { type: "image/png" }), intent, "secret", signal,
      ),
    },
    {
      name: "getJob",
      path: "/v1/jobs/job-id",
      invoke: (signal: AbortSignal) => getJob("job-id", "secret", signal),
    },
    {
      name: "updateCrop",
      path: "/v1/jobs/job-id/crop",
      invoke: (signal: AbortSignal) => updateCrop(
        "job-id", crop, "secret", "balanced", ["visual_balance"], "保留留白", signal,
      ),
    },
  ])("passes the cancellation signal to $name fetch", async ({ path, invoke }) => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "job-id" }));
    vi.stubGlobal("fetch", fetchMock);

    await invoke(controller.signal);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
      signal: controller.signal,
      headers: expect.objectContaining({ "X-SmartCrop-Access": "secret" }),
    }));
  });

  it("preserves fetch cancellation errors for callers to ignore", async () => {
    const aborted = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(aborted));

    await expect(getJob("job-id", "")).rejects.toBe(aborted);
  });

  it("passes the signal to artifact fetch and downloads the completed file", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Blob(["image"], { type: "image/png" }),
    ));
    vi.stubGlobal("fetch", fetchMock);
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    await downloadArtifact("/crop", "secret", "SmartCrop_job", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith("/crop", expect.objectContaining({
      signal: controller.signal,
    }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.download).toBe("SmartCrop_job.png");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("does not trigger a download if the task was cancelled while reading the file", async () => {
    const controller = new AbortController();
    let finishBlob!: (blob: Blob) => void;
    const blobPromise = new Promise<Blob>((resolve) => { finishBlob = resolve; });
    const blobRead = vi.fn(() => blobPromise);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: blobRead }));
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    const createObjectURL = vi.spyOn(URL, "createObjectURL");

    const downloading = downloadArtifact("/crop", "", "SmartCrop_job", controller.signal);
    await Promise.resolve();
    expect(blobRead).toHaveBeenCalledOnce();
    controller.abort();
    finishBlob(new Blob(["image"], { type: "image/png" }));

    await expect(downloading).rejects.toMatchObject({ name: "AbortError" });
    expect(createElement).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("API error messages", () => {
  it.each([
    { status: 404, body: { detail: "任务不存在或已过期" }, message: "任务不存在或已过期" },
    {
      status: 422,
      body: { detail: [{ msg: "裁剪框无效" }, { msg: "比例不匹配" }] },
      message: "裁剪框无效；比例不匹配",
    },
  ])("preserves structured HTTP $status errors", async ({ status, body, message }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));

    await expect(getJob("job-id", "")).rejects.toMatchObject({ status, message });
  });

  it("retains the HTTP fallback for a non-JSON error response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));

    const caught = await getJob("job-id", "").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 503, message: "请求失败（HTTP 503）" });
  });
});
