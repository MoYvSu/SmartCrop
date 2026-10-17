import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzePixels } from "./imageAnalysis";
import {
  analyzeImageSource, clearImageAnalysisCache, getImageAnalysisCacheGeneration,
  imageAnalysisSampleRect, ImageAnalysisError, subscribeImageAnalysisCache,
} from "./browserImageAnalysis";

const projectUrl = (id = "a".repeat(32)) => `/v1/projects/${id}/assets/original`;
const source = { width: 2000, height: 1000 };
type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };
const bitmaps: FakeBitmap[] = [];
const draws: unknown[][] = [];
let alpha = 255;

class FakeCanvas {
  constructor(public width: number, public height: number) {}
  getContext = vi.fn(() => ({
    drawImage: (...args: unknown[]) => { draws.push(args); },
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < data.length; index += 4) { data[index] = 255; data[index + 3] = alpha; }
      return { data, width, height };
    },
  }));
}

function imageResponse() { return new Response(new Blob(["image"], { type: "image/png" })); }

beforeEach(() => {
  clearImageAnalysisCache();
  bitmaps.length = 0;
  draws.length = 0;
  alpha = 255;
  vi.stubGlobal("location", new URL("http://localhost:8000/studio/workbench"));
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("Worker", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));
  vi.stubGlobal("createImageBitmap", vi.fn(async (_blob: Blob, options: { resizeWidth: number; resizeHeight: number }) => {
    const bitmap = { width: options.resizeWidth, height: options.resizeHeight, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  }));
});

afterEach(() => { clearImageAnalysisCache(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("browser image sampling", () => {
  it("reads authorized same-origin images without an HTTP or browser storage cache", async () => {
    const data = await analyzeImageSource(projectUrl(), source);
    expect(fetch).toHaveBeenCalledWith(`http://localhost:8000${projectUrl()}`, expect.objectContaining({
      credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
    }));
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ resizeWidth: 1280, resizeHeight: 640 }));
    expect(data.sampleWidth).toBe(384);
    expect(data.sampleHeight).toBe(192);
    expect(data.sampledPixels).toBe(384 * 192);
    expect(draws[0].slice(1)).toEqual([0, 0, 1280, 640, 0, 0, 384, 192]);
  });

  it("samples the current crop and preserves alpha rather than painting a background", async () => {
    alpha = 0;
    const data = await analyzeImageSource(projectUrl(), { ...source, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    expect(draws[0].slice(1)).toEqual([320, 160, 640, 320, 0, 0, 384, 192]);
    expect(data.meanBrightness).toBeNull();
    expect(data.palette).toEqual([]);
    expect(data.transparentFraction).toBe(1);
  });

  it("never enlarges a small photo or tiny edge crop", async () => {
    const data = await analyzeImageSource(projectUrl(), { width: 20, height: 10 });
    expect(data.sampleWidth).toBe(20);
    expect(data.sampleHeight).toBe(10);
    expect(imageAnalysisSampleRect(20, 10, { x: 0.9999, y: 0.9999, width: 0.0001, height: 0.0001 })).toEqual({
      x: 19, y: 9, width: 1, height: 1, sampleWidth: 1, sampleHeight: 1,
    });
  });

  it("clips a partly off-image rectangle but rejects a crop with no visible intersection", () => {
    expect(imageAnalysisSampleRect(100, 100, { x: -0.1, y: 0.1, width: 0.4, height: 2 })).toEqual({
      x: 0, y: 10, width: 30, height: 90, sampleWidth: 30, sampleHeight: 90,
    });
    expect(() => imageAnalysisSampleRect(100, 100, { x: 1, y: 0, width: 0.1, height: 1 })).toThrow("不在图像范围内");
    expect(() => imageAnalysisSampleRect(0, 100, { x: 0, y: 0, width: 1, height: 1 })).toThrow("图像尺寸无效");
  });

  it.each(["https://foreign.example/photo.jpg", "http://localhost:8001/v1/projects/abc/assets/original", "/not-an-app-image.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "http://name:password@localhost:8000/demo/composition-sample.svg"])("rejects foreign or non-image application paths before any fetch: %s", async (url) => {
    await expect(analyzeImageSource(url, source)).rejects.toMatchObject({ code: "invalid-source" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the fixed built-in sample and same-origin blob URLs", async () => {
    await analyzeImageSource("/demo/composition-sample.svg", source);
    await analyzeImageSource("blob:http://localhost:8000/local-id", source);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces HTTP 401 explicitly and never caches a fabricated empty result", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("expired", { status: 401 }));
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toMatchObject({ name: "ImageAnalysisError", code: "unauthorized", status: 401, message: expect.stringContaining("重新登录") });
    const data = await analyzeImageSource(projectUrl(), source);
    expect(data.meanBrightness).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports a failed read, invalid content and unavailable canvas rather than zero measurements", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toMatchObject({ code: "image-load" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not an image", { headers: { "Content-Type": "application/json" } }));
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toMatchObject({ code: "decode" });
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", undefined);
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("has no module-level browser requirement and reports unsupported server-side calls", async () => {
    vi.stubGlobal("location", undefined);
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toBeInstanceOf(ImageAnalysisError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an interrupted response body as a readable network error", async () => {
    const response = imageResponse();
    vi.spyOn(response, "blob").mockRejectedValueOnce(new TypeError("connection closed"));
    vi.mocked(fetch).mockResolvedValueOnce(response);
    await expect(analyzeImageSource(projectUrl(), source)).rejects.toMatchObject({ code: "image-load", message: expect.stringContaining("传输未完成") });
  });

  it("can fall back from bitmap decoding to an Image and immediately shrinks the retained base", async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error("SVG bitmap decoding unsupported"));
    class FakeImage {
      naturalWidth = 100;
      naturalHeight = 50;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost:8000/fallback");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const data = await analyzeImageSource("/demo/composition-sample.svg", { width: 100, height: 50 });
    expect(data.sampleWidth).toBe(100);
    expect(data.sampleHeight).toBe(50);
    expect(revoke).toHaveBeenCalledWith("blob:http://localhost:8000/fallback");
  });
});

describe("private memory cache and cancellation", () => {
  it("keys results by every crop/dimension parameter and reuses only the same decoded source", async () => {
    const first = await analyzeImageSource(projectUrl(), source);
    expect(await analyzeImageSource(projectUrl(), source)).toBe(first);
    const crop = { x: 0, y: 0, width: 0.5, height: 1 };
    await analyzeImageSource(projectUrl(), { ...source, crop });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(draws).toHaveLength(2);
    await analyzeImageSource(projectUrl(), { width: 1000, height: 500, crop });
    await analyzeImageSource(`${projectUrl()}?version=2`, { ...source, crop });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retains at most two decoded bases and closes the least recently used bitmap", async () => {
    await analyzeImageSource(projectUrl("a".repeat(32)), source);
    await analyzeImageSource(projectUrl("b".repeat(32)), source);
    await analyzeImageSource(projectUrl("a".repeat(32)), { ...source, crop: { x: 0, y: 0, width: 0.5, height: 1 } });
    await analyzeImageSource(projectUrl("c".repeat(32)), source);
    expect(bitmaps[0].close).not.toHaveBeenCalled();
    expect(bitmaps[1].close).toHaveBeenCalledOnce();
    expect(bitmaps[2].close).not.toHaveBeenCalled();
  });

  it("clearing closes bitmaps, invalidates results and notifies hook subscribers", async () => {
    await analyzeImageSource(projectUrl(), source);
    const listener = vi.fn();
    const unsubscribe = subscribeImageAnalysisCache(listener);
    const before = getImageAnalysisCacheGeneration();
    clearImageAnalysisCache();
    expect(getImageAnalysisCacheGeneration()).toBe(before + 1);
    expect(listener).toHaveBeenCalledOnce();
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
    await analyzeImageSource(projectUrl(), source);
    expect(fetch).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not read a source already cancelled by its caller", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(analyzeImageSource(projectUrl(), source, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight HTTP read and allows an uncancelled retry", async () => {
    vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const pending = analyzeImageSource(projectUrl(), source, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await analyzeImageSource(projectUrl(), source);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refill a cleared cache when a non-cancellable bitmap decode completes late", async () => {
    let finishDecode: ((value: FakeBitmap) => void) | undefined;
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise((resolve) => { finishDecode = resolve; }));
    const pending = analyzeImageSource(projectUrl(), source);
    await vi.waitFor(() => expect(finishDecode).toBeTypeOf("function"));
    clearImageAnalysisCache();
    const late = { width: 1280, height: 640, close: vi.fn() };
    finishDecode!(late);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(late.close).toHaveBeenCalled();
    await analyzeImageSource(projectUrl(), source);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("background pixel computation", () => {
  it("uses a dedicated Vite worker and terminates it after the result", async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn(function (this: { onmessage: (event: unknown) => void }, value: { pixels: Uint8ClampedArray; width: number; height: number }) {
      queueMicrotask(() => this.onmessage({ data: { data: analyzePixels(value.pixels, value.width, value.height) } }));
    });
    class FakeWorker { onmessage: unknown; onerror: unknown; onmessageerror: unknown; terminate = terminate; postMessage = postMessage; }
    vi.stubGlobal("Worker", FakeWorker);
    const data = await analyzeImageSource(projectUrl(), source);
    expect(data.sampleWidth).toBe(384);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ pixels: expect.any(Uint8ClampedArray) }), [expect.any(ArrayBuffer)]);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("falls back to bounded local computation if the worker cannot start", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("blocked by browser"); } });
    const data = await analyzeImageSource(projectUrl(), source);
    expect(data.sampledPixels).toBe(384 * 192);
    expect(data.meanBrightness).not.toBeNull();
  });

  it("retains the small input buffer for fallback if an already-started worker fails", async () => {
    const terminate = vi.fn();
    class FailedWorker {
      onerror?: (event: { preventDefault: () => void }) => void;
      terminate = terminate;
      postMessage = () => queueMicrotask(() => this.onerror?.({ preventDefault: () => undefined }));
    }
    vi.stubGlobal("Worker", FailedWorker);
    const data = await analyzeImageSource(projectUrl(), source);
    expect(data.sampleWidth).toBe(384);
    expect(data.meanBrightness).not.toBeNull();
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("terminates a cancelled worker and ignores a late worker response", async () => {
    let worker: { onmessage?: (event: unknown) => void; terminate: ReturnType<typeof vi.fn> } | undefined;
    class FakeWorker {
      onmessage?: (event: unknown) => void;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() { worker = this; }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const controller = new AbortController();
    const pending = analyzeImageSource(projectUrl(), source, controller.signal);
    await vi.waitFor(() => expect(worker).toBeDefined());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(worker!.terminate).toHaveBeenCalledOnce();
    worker!.onmessage?.({ data: { data: analyzePixels(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1) } });
    vi.stubGlobal("Worker", undefined);
    const data = await analyzeImageSource(projectUrl(), source);
    expect(data.sampleWidth).toBe(384);
    expect(draws).toHaveLength(2);
  });
});

describe("per-image total time budget", () => {
  it("fails a permanently pending fetch after 30 seconds and aborts the request", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined));
    const pending = analyzeImageSource(projectUrl(), source);
    const failure = expect(pending).rejects.toMatchObject({ name: "ImageAnalysisError", code: "timeout", message: expect.stringContaining("30 秒") });
    await vi.advanceTimersByTimeAsync(29_999);
    const options = vi.mocked(fetch).mock.calls[0][1]!;
    expect(options.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(options.signal!.aborted).toBe(true);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a permanently pending response body without caching empty measurements", async () => {
    vi.useFakeTimers();
    const response = imageResponse();
    vi.spyOn(response, "blob").mockImplementationOnce(() => new Promise(() => undefined));
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const pending = analyzeImageSource(projectUrl(), source);
    const failure = expect(pending).rejects.toMatchObject({ name: "ImageAnalysisError", code: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(createImageBitmap).not.toHaveBeenCalled();
    vi.useRealTimers();
    const retry = await analyzeImageSource(projectUrl(), source);
    expect(retry.meanBrightness).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns before an uninterruptible bitmap decode settles and closes its late result", async () => {
    vi.useFakeTimers();
    const response = imageResponse();
    vi.spyOn(response, "blob").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.mocked(fetch).mockResolvedValueOnce(response);
    let finishDecode: ((value: ImageBitmap) => void) | undefined;
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise((resolve) => { finishDecode = resolve; }));
    const pending = analyzeImageSource(projectUrl(), source);
    const failure = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(finishDecode).toBeTypeOf("function");
    const late = { width: 1280, height: 640, close: vi.fn() };
    finishDecode!(late as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
    await analyzeImageSource(projectUrl(), source);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps external cancellation distinct from timeout even if fetch ignores abort", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = analyzeImageSource(projectUrl(), source, controller.signal);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await failure;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps cache clearing distinct from timeout and consumes a late fetch rejection", async () => {
    vi.useFakeTimers();
    let rejectFetch: ((reason: unknown) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
    const pending = analyzeImageSource(projectUrl(), source);
    const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    clearImageAnalysisCache();
    await failure;
    rejectFetch!(new TypeError("late request failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a still-running worker when slow decoding used most of the total budget", async () => {
    vi.useFakeTimers();
    const response = imageResponse();
    vi.spyOn(response, "blob").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const terminate = vi.fn();
    class PendingWorker { terminate = terminate; postMessage = vi.fn(); }
    vi.stubGlobal("Worker", PendingWorker);
    vi.mocked(createImageBitmap).mockImplementationOnce(() => new Promise((resolve) => {
      setTimeout(() => resolve({ width: 1280, height: 640, close: vi.fn() } as unknown as ImageBitmap), 28_000);
    }));
    const pending = analyzeImageSource(projectUrl(), source);
    const failure = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(28_000);
    expect(terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await failure;
    expect(terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
