import { BarChart3, RefreshCw } from "lucide-react";
import { useId, useState } from "react";

import { useImageAnalysis } from "../hooks/useImageAnalysis";
import type { CropBox } from "../types";
import { PixelAnalysisCharts } from "./PixelAnalysisCharts";
import "./pixel-analysis.css";

export interface ImageAnalysisPanelProps {
  sourceUrl: string;
  width: number;
  height: number;
  crop: CropBox;
  enabled: boolean;
  sample?: boolean;
}

export function ImageAnalysisPanel({ sourceUrl, width, height, crop, enabled, sample = false }: ImageAnalysisPanelProps) {
  const id = useId();
  const [scope, setScope] = useState<"crop" | "original">("crop");
  const analysis = useImageAnalysis(sourceUrl, width, height, scope === "crop" ? crop : undefined, enabled);
  return <section className="sc-image-analysis-panel" aria-labelledby={`${id}-heading`} aria-busy={analysis.status === "loading"}>
    <header className="sc-pixel-panel-heading"><div><p className="sc-pixel-kicker">Light & colour</p>
      <h2 id={`${id}-heading`}>读懂画面的光与色</h2></div><BarChart3 size={21} aria-hidden="true" /></header>
    <p className="sc-pixel-panel-description">用亮度、色相与主色，发现照片的另一面。</p>
    {sample && <p className="sc-pixel-sample-note">正在体验固定样例，分析结果不计入作品库与摄影洞察。</p>}
    <div className="sc-pixel-scope-switch" role="group" aria-label="图像分析范围">
      <button type="button" aria-pressed={scope === "crop"} onClick={() => setScope("crop")}>当前裁剪</button>
      <button type="button" aria-pressed={scope === "original"} onClick={() => setScope("original")}>完整原图</button>
    </div>
    <p className="sc-pixel-range-note">{scope === "crop" ? "随当前取景自动更新，观察裁剪后的明暗与配色。" : "查看整张原图的明暗与配色。"}</p>
    {analysis.status === "loading" && <div className="sc-pixel-loading" role="status"><span aria-hidden="true" />正在读取像素，生成图表…</div>}
    {analysis.status === "error" && <div className="sc-pixel-error" role="alert"><p>{analysis.error || "未能读取图片像素，裁剪、保存和下载仍可继续使用。"}</p>
      <button type="button" onClick={analysis.retry}><RefreshCw size={15} aria-hidden="true" />重新分析</button></div>}
    {analysis.status === "idle" && <p className="sc-pixel-idle">打开图像分析后，再在当前浏览器计算。</p>}
    {analysis.status === "ready" && analysis.data && <>
      <PixelAnalysisCharts data={analysis.data} heading={scope === "crop" ? "当前裁剪" : "完整原图"} compact />
    </>}
  </section>;
}
