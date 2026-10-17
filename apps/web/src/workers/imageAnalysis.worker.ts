import { analyzePixels } from "../lib/imageAnalysis";

// This module is instantiated only in a dedicated Vite worker bundle.
self.onmessage = (event: MessageEvent<{ pixels: Uint8ClampedArray; width: number; height: number }>) => {
  try {
    const { pixels, width, height } = event.data;
    self.postMessage({ data: analyzePixels(pixels, width, height) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "像素分析失败" });
  }
};
