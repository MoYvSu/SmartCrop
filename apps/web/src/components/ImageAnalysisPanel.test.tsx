import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useImageAnalysis } from "../hooks/useImageAnalysis";
import { analyzePixels } from "../lib/imageAnalysis";
import { ImageAnalysisPanel } from "./ImageAnalysisPanel";

vi.mock("../hooks/useImageAnalysis", () => ({ useImageAnalysis: vi.fn() }));

const crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.6 };
const source = { sourceUrl: "/private/original", width: 1200, height: 800, crop, enabled: true };
const idle = { data: null, status: "idle" as const, error: "", retry: vi.fn() };

describe("browser image analysis panel", () => {
  beforeEach(() => vi.mocked(useImageAnalysis).mockReturnValue(idle));

  it("analyzes the current crop by default and provides named scope controls", () => {
    const markup = renderToStaticMarkup(<ImageAnalysisPanel {...source} />);
    expect(useImageAnalysis).toHaveBeenCalledWith(source.sourceUrl, 1200, 800, crop, true);
    expect(markup).toContain('aria-label="图像分析范围"');
    expect(markup).toContain('aria-pressed="true">当前裁剪');
    expect(markup).toContain('aria-pressed="false">完整原图');
    expect(markup).toContain("读懂画面的光与色");
    expect(markup).toContain("随当前取景自动更新");
  });

  it("shows loading feedback instead of stale charts or invented metrics", () => {
    vi.mocked(useImageAnalysis).mockReturnValue({ ...idle, status: "loading" });
    const markup = renderToStaticMarkup(<ImageAnalysisPanel {...source} />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在读取像素");
    expect(markup).not.toContain("平均亮度");
    expect(markup).not.toContain("<svg viewBox");
  });

  it("offers retry after an explicit error while leaving core editing available", () => {
    vi.mocked(useImageAnalysis).mockReturnValue({ ...idle, status: "error", error: "图片无法读取，请重试。" });
    const markup = renderToStaticMarkup(<ImageAnalysisPanel {...source} />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("图片无法读取，请重试。");
    expect(markup).toContain("重新分析");
    expect(markup).not.toContain("平均亮度");
  });

  it("shows measured charts and labels fixed samples outside account statistics without implementation jargon", () => {
    const data = analyzePixels(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    vi.mocked(useImageAnalysis).mockReturnValue({ ...idle, data, status: "ready" });
    const markup = renderToStaticMarkup(<ImageAnalysisPanel {...source} sample />);
    expect(markup).toContain("当前裁剪");
    expect(markup).toContain("亮度分布");
    expect(markup).toContain("#FF0000");
    expect(markup).toContain("分析结果不计入作品库与摄影洞察");
    expect(markup).not.toContain("缩小采样");
    expect(markup).not.toContain("透明度加权");
  });

  it("does not compute hidden panels", () => {
    renderToStaticMarkup(<ImageAnalysisPanel {...source} enabled={false} />);
    expect(useImageAnalysis).toHaveBeenCalledWith(source.sourceUrl, 1200, 800, crop, false);
  });
});
