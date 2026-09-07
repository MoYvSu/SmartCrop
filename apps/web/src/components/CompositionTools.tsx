import { Crosshair, Grid3X3, Ruler, Shield, Slash } from "lucide-react";

import { formatDuration, getCropMetrics } from "../lib/metrics";
import { intentRatioLabel } from "../lib/publishing";
import type { AnalysisIntent, CompositionGuide, CropBox } from "../types";

const GUIDE_OPTIONS: Array<{
  id: CompositionGuide;
  label: string;
  Icon: typeof Grid3X3;
}> = [
  { id: "thirds", label: "三分线", Icon: Grid3X3 },
  { id: "center", label: "中心线", Icon: Crosshair },
  { id: "diagonal", label: "对角线", Icon: Slash },
  { id: "safe", label: "安全区域", Icon: Shield },
];

interface Props {
  crop: CropBox;
  imageWidth: number;
  imageHeight: number;
  intent: AnalysisIntent;
  guides: CompositionGuide[];
  processingDurationMs: number | null;
  pregenerated?: boolean;
  onToggleGuide: (guide: CompositionGuide) => void;
}

export function CompositionTools({
  crop,
  imageWidth,
  imageHeight,
  intent,
  guides,
  processingDurationMs,
  pregenerated = false,
  onToggleGuide,
}: Props) {
  const metrics = getCropMetrics(imageWidth, imageHeight, crop, intent);
  return (
    <section className="composition-tools" aria-labelledby="composition-tools-heading">
      <div className="composition-tools-heading">
        <div>
          <p className="eyebrow">Composition aids</p>
          <h2 id="composition-tools-heading">构图辅助与客观结果</h2>
        </div>
        <span><Ruler aria-hidden="true" size={16} />辅助线不会写入成片</span>
      </div>

      <div className="guide-controls" role="group" aria-label="构图辅助线">
        {GUIDE_OPTIONS.map(({ id, label, Icon }) => {
          const active = guides.includes(id);
          return (
            <button
              type="button"
              key={id}
              className={active ? "guide-toggle is-active" : "guide-toggle"}
              aria-pressed={active}
              onClick={() => onToggleGuide(id)}
            >
              <Icon aria-hidden="true" size={16} />{label}
            </button>
          );
        })}
      </div>

      <dl className="objective-metrics">
        <div><dt>保留面积</dt><dd>{metrics.retainedPercent.toFixed(1)}%</dd></div>
        <div><dt>原始尺寸</dt><dd>{imageWidth} × {imageHeight}</dd></div>
        <div><dt>预计输出</dt><dd>{metrics.outputWidth} × {metrics.outputHeight}</dd></div>
        <div>
          <dt>比例状态</dt>
          <dd className={metrics.ratioCompliant ? "metric-pass" : "metric-fail"}>
            {metrics.ratioCompliant ? "符合" : "需调整"} · {intentRatioLabel(intent)}
          </dd>
        </div>
        <div>
          <dt>后端处理耗时</dt>
          <dd>{pregenerated ? "未调用" : formatDuration(processingDurationMs)}</dd>
        </div>
      </dl>
      <p className="metrics-disclaimer">仅展示尺寸、面积与比例等可复核事实，不生成美学分数。</p>
    </section>
  );
}
