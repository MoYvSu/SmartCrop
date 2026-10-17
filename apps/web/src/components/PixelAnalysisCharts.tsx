import { useId } from "react";

import { describePaletteMood } from "../lib/colorMood";
import type { PixelAnalysis, PixelAnalysisAggregate } from "../lib/imageAnalysis";
import "./pixel-analysis.css";

export interface PixelAnalysisChartsProps {
  data: PixelAnalysis | PixelAnalysisAggregate;
  scope?: "image" | "archive";
  heading?: string;
  compact?: boolean;
}

const HUE_NAMES = ["红", "橙", "黄", "黄绿", "绿", "青绿", "青", "青蓝", "蓝", "蓝紫", "紫", "紫红"];
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
export function analysisPercent(value: number): string {
  if (value > 0 && value < 0.001) return "<0.1%";
  return `${number.format(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function Histogram({ values, kind, id }: { values: number[]; kind: "brightness" | "hue"; id: string }) {
  const peak = Math.max(0.01, ...values);
  const count = values.length;
  const width = 320;
  const step = width / count;
  const title = kind === "brightness" ? "亮度分布" : "有彩像素的色相分布";
  const summary = kind === "brightness" ? "横轴为亮度 0 至 255，纵轴为像素占比。完整数值见下方展开表格。"
    : "横轴为色相 0 至 360 度，纵轴为有彩像素占比。完整数值见下方展开表格。";
  return <figure className="sc-pixel-histogram">
    <svg viewBox="0 0 368 150" role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{title}</title><desc id={`${id}-description`}>{summary}</desc>
      <line x1="38" x2="358" y1="17" y2="17" className="sc-pixel-gridline" />
      <line x1="38" x2="358" y1="66" y2="66" className="sc-pixel-gridline" />
      <line x1="38" x2="358" y1="116" y2="116" className="sc-pixel-axis" />
      <text x="32" y="21" textAnchor="end" className="sc-pixel-axis-label">{analysisPercent(peak)}</text>
      <text x="32" y="120" textAnchor="end" className="sc-pixel-axis-label">0</text>
      {values.map((value, index) => <rect key={index} x={38 + index * step + 1} y={116 - value / peak * 99}
        width={Math.max(1, step - 2)} height={value / peak * 99} rx="1.5" className="sc-pixel-bar" />)}
      <text x="38" y="139" className="sc-pixel-axis-label">{kind === "brightness" ? "0 · 暗" : "0° · 红"}</text>
      <text x="198" y="139" textAnchor="middle" className="sc-pixel-axis-label">{kind === "brightness" ? "128" : "180° · 青"}</text>
      <text x="358" y="139" textAnchor="end" className="sc-pixel-axis-label">{kind === "brightness" ? "255 · 亮" : "360°"}</text>
    </svg>
    {kind === "hue" && <div className="sc-pixel-hue-spectrum" aria-hidden="true" />}
    <figcaption>纵轴：{kind === "brightness" ? "可见像素占比" : "有彩像素占比"} · 条高按当前峰值缩放</figcaption>
  </figure>;
}

function HistogramTable({ values, kind }: { values: number[]; kind: "brightness" | "hue" }) {
  return <details className="sc-pixel-data-table"><summary>查看{kind === "brightness" ? "亮度" : "色相"}分布数值</summary>
    <table><caption>{kind === "brightness" ? "32 个亮度区间，占全部可见像素的比例" : "12 个色相区间，仅占有彩像素的比例"}</caption>
      <thead><tr><th scope="col">{kind === "brightness" ? "亮度区间" : "色相区间"}</th><th scope="col">占比</th></tr></thead>
      <tbody>{values.map((value, index) => <tr key={index}><th scope="row">{kind === "brightness"
        ? `${index * 8}–${index * 8 + 7}` : `${index * 30}–${(index + 1) * 30}° · ${HUE_NAMES[index]}`}</th>
        <td>{analysisPercent(value)}</td></tr>)}</tbody></table>
  </details>;
}

/** Descriptive charts and fixed colour copy, never inferred personal traits. */
export function PixelAnalysisCharts({ data, scope = "image", heading, compact = false }: PixelAnalysisChartsProps) {
  const id = useId();
  const hasVisiblePixels = data.meanBrightness !== null && ("visibleImageCount" in data ? data.visibleImageCount > 0 : data.visibleWeight > 0);
  const aggregate = scope === "archive";
  const mood = aggregate ? describePaletteMood(data.palette) : null;
  if (!hasVisiblePixels) return <div className="sc-pixel-empty"><h3>没有可统计的可见像素</h3>
    <p>这{aggregate ? "些成片" : "个范围"}是透明内容，暂时无法生成明暗与色彩分析。</p></div>;
  return <div className={`sc-pixel-charts${compact ? " is-compact" : ""}`}>
    {heading && <p className="sc-pixel-scope-label">{heading}</p>}
    <section className="sc-pixel-chart-card" aria-labelledby={`${id}-brightness-heading`}>
      <div className="sc-pixel-chart-heading"><div><span className="sc-pixel-kicker">LIGHT / 01</span>
        <h3 id={`${id}-brightness-heading`}>亮度分布</h3></div><span className="sc-pixel-chart-unit">0—255</span></div>
      <dl className="sc-pixel-metrics">
        <div><dt>{aggregate ? "作品平均亮度" : "平均亮度"}</dt><dd>{number.format(data.meanBrightness!)}<small> / 255</small></dd></div>
        <div><dt>深暗区域</dt><dd>{analysisPercent(data.darkFraction)}</dd></div>
        <div><dt>明亮区域</dt><dd>{analysisPercent(data.lightFraction)}</dd></div>
      </dl>
      <Histogram values={data.brightnessHistogram} kind="brightness" id={`${id}-brightness`} />
      <p className="sc-pixel-explanation">从暗到亮，看看光线如何铺满画面。</p>
      <HistogramTable values={data.brightnessHistogram} kind="brightness" />
    </section>
    <section className="sc-pixel-chart-card" aria-labelledby={`${id}-hue-heading`}>
      <div className="sc-pixel-chart-heading"><div><span className="sc-pixel-kicker">COLOUR / 02</span>
        <h3 id={`${id}-hue-heading`}>色相分布</h3></div><span className="sc-pixel-chart-unit">12 个区间</span></div>
      <dl className="sc-pixel-metrics sc-pixel-metrics-two"><div><dt>有彩像素</dt><dd>{analysisPercent(data.chromaticFraction)}</dd></div>
        <div><dt>低彩／近黑像素</dt><dd>{analysisPercent(1 - data.chromaticFraction)}</dd></div></dl>
      {data.chromaticFraction > 0 && data.hueHistogram.some((value) => value > 0) ? <>
        <Histogram values={data.hueHistogram} kind="hue" id={`${id}-hue`} />
        <p className="sc-pixel-explanation">看看画面里的色彩，更偏暖调还是冷调。</p>
        <HistogramTable values={data.hueHistogram} kind="hue" />
      </> : <div className="sc-pixel-no-hue"><p>画面以中性色为主</p><span>黑白灰与低饱和色彩，呈现安静的画面氛围。</span></div>}
    </section>
    <section className="sc-pixel-chart-card sc-pixel-palette-card" aria-labelledby={`${id}-palette-heading`}>
      <div className="sc-pixel-chart-heading"><div><span className="sc-pixel-kicker">PALETTE / 03</span>
        <h3 id={`${id}-palette-heading`}>{aggregate ? "作品集主色" : "画面主色"}</h3></div><span className="sc-pixel-chart-unit">{data.palette.length} 种代表色</span></div>
      {mood && <div className="sc-pixel-colour-mood"><span>色彩气质</span><p>{mood.text}</p></div>}
      <div className="sc-pixel-palette-strip" aria-hidden="true">{data.palette.map((color) => <span key={color.hex} style={{ backgroundColor: color.hex, flexGrow: color.fraction }} />)}</div>
      <ul className="sc-pixel-palette-list">{data.palette.map((color, index) => <li key={color.hex}>
        <span className="sc-pixel-swatch" style={{ backgroundColor: color.hex }} aria-hidden="true" />
        <div><span className="sc-pixel-color-hex"><span className="sc-pixel-color-index">{String(index + 1).padStart(2, "0")}</span>{color.hex.toUpperCase()}</span>
          <span className="sc-pixel-color-rgb">RGB {color.rgb.join(" / ")}</span></div><strong>{analysisPercent(color.fraction)}</strong>
      </li>)}</ul>
      <p className="sc-pixel-explanation">{aggregate ? "从归档作品中提取配色，积累你的创作灵感。" : "画面里的代表配色，为下一次创作积累灵感。"}</p>
    </section>
  </div>;
}
