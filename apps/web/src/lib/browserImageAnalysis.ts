import type { CropBox } from "../types";
import { analyzePixels, IMAGE_ANALYSIS_VERSION, type PixelAnalysis } from "./imageAnalysis";

const BASE_MAX_EDGE = 1280;
const SAMPLE_MAX_EDGE = 384;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_RESULTS = 64;
const ANALYSIS_TIMEOUT_MS = 30_000;

export interface ImageAnalysisSource {
  width: number;
  height: number;
  crop?: CropBox;
}

export class ImageAnalysisError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "ImageAnalysisError";
  }
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type DecodedImage = { image: CanvasImageSource; width: number; height: number; close: () => void };

const bases = new Map<string, DecodedImage>();
const results = new Map<string, PixelAnalysis>();
const running = new Set<AbortController>();
const subscribers = new Set<() => void>();
let generation = 0;

function aborted(): DOMException {
  return new DOMException("图像分析已取消", "AbortError");
}

function check(signal: AbortSignal, expectedGeneration: number): void {
  if (signal.aborted || expectedGeneration !== generation) throw aborted();
}

export function getImageAnalysisCacheGeneration(): number { return generation; }
export function subscribeImageAnalysisCache(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

/** Private, short-lived memory only. Logout/deletion also cancels in-flight work. */
export function clearImageAnalysisCache(): void {
  generation += 1;
  for (const controller of running) controller.abort();
  for (const entry of bases.values()) entry.close();
  bases.clear();
  results.clear();
  for (const listener of subscribers) listener();
}

function allowedUrl(source: string): string {
  if (typeof location === "undefined") {
    throw new ImageAnalysisError("当前环境不支持浏览器图像分析", "unsupported");
  }
  let url: URL;
  try { url = new URL(source, location.href); }
  catch { throw new ImageAnalysisError("图像地址无效", "invalid-source"); }
  const sameOrigin = url.origin === location.origin;
  const isAsset = /^\/v1\/projects\/[a-f0-9]{32}\/assets\/(?:original|preview|crop|published)$/.test(url.pathname)
    || /^\/v1\/jobs\/[a-f0-9]{32}\/artifacts\/(?:preview|crop)$/.test(url.pathname)
    || url.pathname === "/demo/composition-sample.svg";
  const isBlob = url.protocol === "blob:" && sameOrigin;
  if (url.username || url.password || !sameOrigin || (!isBlob && (!isAsset || !["http:", "https:"].includes(url.protocol)))) {
    throw new ImageAnalysisError("仅支持本应用中的图像，不会向外部站点发送照片", "invalid-source");
  }
  url.hash = "";
  return url.href;
}

function normalizedSource(source: ImageAnalysisSource): Required<ImageAnalysisSource> {
  if (![source.width, source.height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new ImageAnalysisError("图像尺寸无效，无法进行像素分析", "invalid-source");
  }
  const crop = source.crop || { x: 0, y: 0, width: 1, height: 1 };
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.width <= 0 || crop.height <= 0) {
    throw new ImageAnalysisError("裁剪区域无效，无法进行像素分析", "invalid-source");
  }
  const x = Math.max(0, crop.x);
  const y = Math.max(0, crop.y);
  const right = Math.min(1, crop.x + crop.width);
  const bottom = Math.min(1, crop.y + crop.height);
  if (x >= right || y >= bottom) {
    throw new ImageAnalysisError("裁剪区域不在图像范围内", "invalid-source");
  }
  return { width: source.width, height: source.height, crop: { x, y, width: right - x, height: bottom - y } };
}

/** Exported for boundary tests; dimensions never upscale the sampled crop. */
export function imageAnalysisSampleRect(width: number, height: number, crop: CropBox): {
  x: number; y: number; width: number; height: number; sampleWidth: number; sampleHeight: number;
} {
  const normalized = normalizedSource({ width, height, crop }).crop;
  const x = Math.min(width - 1, Math.round(normalized.x * width));
  const y = Math.min(height - 1, Math.round(normalized.y * height));
  const right = Math.max(x + 1, Math.min(width, Math.round((normalized.x + normalized.width) * width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.round((normalized.y + normalized.height) * height)));
  const scale = Math.min(1, SAMPLE_MAX_EDGE / Math.max(right - x, bottom - y));
  return {
    x, y, width: right - x, height: bottom - y,
    sampleWidth: Math.max(1, Math.round((right - x) * scale)),
    sampleHeight: Math.max(1, Math.round((bottom - y) * scale)),
  };
}

function canvas(width: number, height: number): { canvas: Canvas; context: Context } {
  let target: Canvas;
  if (typeof OffscreenCanvas !== "undefined") target = new OffscreenCanvas(width, height);
  else if (typeof document !== "undefined") {
    target = document.createElement("canvas");
    target.width = width;
    target.height = height;
  } else throw new ImageAnalysisError("当前浏览器不支持图像采样", "unsupported");
  let context: Context | null = null;
  try { context = target.getContext("2d", { colorSpace: "srgb", willReadFrequently: true }) as Context | null; }
  catch { /* Older browsers may not recognize the color-space option. */ }
  if (!context) context = target.getContext("2d") as Context | null;
  if (!context) throw new ImageAnalysisError("无法读取图像像素，请换用支持 Canvas 的浏览器", "canvas");
  return { canvas: target, context };
}

async function imageElement(blob: Blob, width: number, height: number, signal: AbortSignal): Promise<DecodedImage> {
  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new ImageAnalysisError("当前浏览器无法解码这张图片", "decode");
  }
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  const abort = () => { image.src = ""; };
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener("abort", cancelled); image.onload = null; image.onerror = null; };
      const cancelled = () => { cleanup(); abort(); reject(aborted()); };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new ImageAnalysisError("图片解码失败，请重新打开作品后重试", "decode")); };
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
      else image.src = objectUrl;
    });
    if (signal.aborted) throw aborted();
    const scale = Math.min(1, BASE_MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const actualWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const actualHeight = Math.max(1, Math.round(image.naturalHeight * scale));
    const base = canvas(actualWidth || width, actualHeight || height);
    base.context.drawImage(image, 0, 0, actualWidth, actualHeight);
    return { image: base.canvas, width: actualWidth, height: actualHeight, close: () => { base.canvas.width = 0; base.canvas.height = 0; } };
  } finally {
    image.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

async function decode(url: string, width: number, height: number, signal: AbortSignal, epoch: number): Promise<DecodedImage> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal, credentials: "same-origin", cache: "no-store", mode: "same-origin", redirect: "error", referrerPolicy: "same-origin",
    });
  } catch (error) {
    check(signal, epoch);
    throw new ImageAnalysisError(error instanceof Error && error.name === "AbortError" ? "图像读取已取消" : "图像读取失败，请检查网络后重试", "image-load");
  }
  check(signal, epoch);
  if (!response.ok) {
    throw new ImageAnalysisError(response.status === 401 ? "登录已失效，请重新登录后读取图像" : `图像读取失败（${response.status}），请重新打开作品后重试`, response.status === 401 ? "unauthorized" : "image-load", response.status);
  }
  let blob: Blob;
  try { blob = await response.blob(); }
  catch {
    check(signal, epoch);
    throw new ImageAnalysisError("图像传输未完成，请检查网络后重试", "image-load");
  }
  check(signal, epoch);
  if (blob.size > MAX_IMAGE_BYTES || (blob.type && !blob.type.toLowerCase().startsWith("image/"))) {
    throw new ImageAnalysisError("图像文件过大或格式不受支持，无法读取像素", "decode");
  }
  const scale = Math.min(1, BASE_MAX_EDGE / Math.max(width, height));
  const baseWidth = Math.max(1, Math.round(width * scale));
  const baseHeight = Math.max(1, Math.round(height * scale));
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob, { resizeWidth: baseWidth, resizeHeight: baseHeight, resizeQuality: "high", colorSpaceConversion: "default" });
      check(signal, epoch);
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => { bitmap?.close(); } };
    } catch (error) {
      bitmap?.close();
      check(signal, epoch);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // SVG and older browser bitmap decoders can require the Image fallback.
    }
  }
  const decoded = await imageElement(blob, baseWidth, baseHeight, signal);
  try { check(signal, epoch); }
  catch (error) { decoded.close(); throw error; }
  return decoded;
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}

async function calculate(pixels: Uint8ClampedArray, width: number, height: number, signal: AbortSignal, epoch: number): Promise<PixelAnalysis> {
  if (typeof Worker !== "undefined") {
    try {
      return await new Promise<PixelAnalysis>((resolve, reject) => {
        let worker: Worker;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = () => { if (timeout) clearTimeout(timeout); signal.removeEventListener("abort", cancel); worker?.terminate(); };
        const cancel = () => { finish(); reject(aborted()); };
        try { worker = new Worker(new URL("../workers/imageAnalysis.worker.ts", import.meta.url), { type: "module" }); }
        catch (error) { reject(error); return; }
        worker.onmessage = (event: MessageEvent<{ data?: PixelAnalysis; error?: string }>) => {
          finish();
          if (event.data.data) resolve(event.data.data);
          else reject(new Error(event.data.error || "像素分析失败"));
        };
        worker.onerror = (event) => { event.preventDefault(); finish(); reject(new Error("图像分析线程不可用")); };
        worker.onmessageerror = () => { finish(); reject(new Error("图像分析线程响应无效")); };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) { cancel(); return; }
        timeout = setTimeout(() => { finish(); reject(new Error("图像分析线程超时")); }, 10_000);
        // Keep one small copy so a failed worker can safely use the fallback.
        const copy = pixels.slice();
        try { worker.postMessage({ pixels: copy, width, height }, [copy.buffer]); }
        catch (error) { finish(); reject(error); }
      });
    } catch {
      check(signal, epoch);
      // No worker support is not an analysis failure. At most 384² pixels.
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  check(signal, epoch);
  return analyzePixels(pixels, width, height);
}

export async function analyzeImageSource(url: string, source: ImageAnalysisSource, signal?: AbortSignal): Promise<PixelAnalysis> {
  if (signal?.aborted) throw aborted();
  const safeUrl = allowedUrl(url);
  const normalized = normalizedSource(source);
  const baseKey = JSON.stringify([safeUrl, normalized.width, normalized.height, BASE_MAX_EDGE]);
  const key = JSON.stringify([IMAGE_ANALYSIS_VERSION, baseKey, normalized.crop.x, normalized.crop.y, normalized.crop.width, normalized.crop.height, SAMPLE_MAX_EDGE, "srgb"]);
  const cached = results.get(key);
  if (cached) { touch(results, key, cached); return cached; }
  const epoch = generation;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  running.add(controller);
  const execute = async (): Promise<PixelAnalysis> => {
    let base = bases.get(baseKey);
    if (base) touch(bases, baseKey, base);
    else {
      base = await decode(safeUrl, normalized.width, normalized.height, controller.signal, epoch);
      try { check(controller.signal, epoch); }
      catch (error) { base.close(); throw error; }
      // Another request may have finished decoding this same image meanwhile.
      const previous = bases.get(baseKey);
      if (previous) base.close();
      base = previous || base;
      touch(bases, baseKey, base);
      while (bases.size > 2) {
        const oldest = bases.keys().next().value!;
        bases.get(oldest)?.close();
        bases.delete(oldest);
      }
    }
    check(controller.signal, epoch);
    const rect = imageAnalysisSampleRect(base.width, base.height, normalized.crop);
    const sample = canvas(rect.sampleWidth, rect.sampleHeight);
    let pixels: ImageData;
    try {
      sample.context.drawImage(base.image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.sampleWidth, rect.sampleHeight);
      pixels = sample.context.getImageData(0, 0, rect.sampleWidth, rect.sampleHeight, { colorSpace: "srgb" });
    } catch (error) {
      if (error instanceof ImageAnalysisError) throw error;
      throw new ImageAnalysisError("浏览器无法读取图像像素，请重新打开作品后重试", "canvas");
    } finally { sample.canvas.width = 0; sample.canvas.height = 0; }
    const result = await calculate(pixels.data, rect.sampleWidth, rect.sampleHeight, controller.signal, epoch);
    check(controller.signal, epoch);
    touch(results, key, result);
    while (results.size > MAX_RESULTS) results.delete(results.keys().next().value!);
    return result;
  };
  let timeoutError: ImageAnalysisError | undefined;
  let rejectCancellation: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const onCancelled = () => rejectCancellation(timeoutError || aborted());
  controller.signal.addEventListener("abort", onCancelled, { once: true });
  const budget = setTimeout(() => {
    timeoutError = new ImageAnalysisError("图像分析超过 30 秒，请检查网络后重试；其他作品仍会继续分析", "timeout");
    controller.abort();
  }, ANALYSIS_TIMEOUT_MS);
  try {
    // Fetch and ImageBitmap implementations can fail to settle after abort.
    // Racing the explicit cancellation guarantees the caller can move on;
    // execute still observes abort before publishing and closes late bitmaps.
    return await Promise.race([execute(), cancellation]);
  } catch (error) {
    if (timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(budget);
    controller.signal.removeEventListener("abort", onCancelled);
    signal?.removeEventListener("abort", cancel);
    running.delete(controller);
  }
}
