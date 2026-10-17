import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { CropBox } from "../types";
import type { PixelAnalysis } from "../lib/imageAnalysis";
import { analyzeImageSource, getImageAnalysisCacheGeneration, subscribeImageAnalysisCache } from "../lib/browserImageAnalysis";

type AnalysisState = { key: string; data: PixelAnalysis | null; status: "idle" | "loading" | "ready" | "error"; error: string };

export function useImageAnalysis(url: string, width: number, height: number, crop: CropBox | undefined, enabled: boolean): {
  data: PixelAnalysis | null; status: AnalysisState["status"]; error: string; retry: () => void;
} {
  const epoch = useSyncExternalStore(subscribeImageAnalysisCache, getImageAnalysisCacheGeneration, () => 0);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const key = JSON.stringify([url, width, height, crop?.x, crop?.y, crop?.width, crop?.height, attempt, epoch]);
  const [state, setState] = useState<AnalysisState>({ key: "", data: null, status: "idle", error: "" });
  const usable = enabled && Boolean(url);

  useEffect(() => {
    if (!usable) return;
    const controller = new AbortController();
    let live = true;
    setState({ key, data: null, status: "loading", error: "" });
    const timer = setTimeout(() => {
      void analyzeImageSource(url, { width, height, crop }, controller.signal).then(
        (data) => { if (live && !controller.signal.aborted) setState({ key, data, status: "ready", error: "" }); },
        (error: unknown) => {
          if (!live || controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
          setState({ key, data: null, status: "error", error: error instanceof Error ? error.message : "图像分析暂不可用，请重试" });
        },
      );
    }, 280);
    return () => { live = false; clearTimeout(timer); controller.abort(); };
    // Primitive key includes every input, including crop coordinates, retry and cache generation.
  }, [key, usable]);

  if (!usable) return { data: null, status: "idle", error: "", retry };
  // Do not show the previous crop's result during the debounce/effect boundary.
  if (state.key !== key) return { data: null, status: "loading", error: "", retry };
  return { data: state.data, status: state.status, error: state.error, retry };
}
