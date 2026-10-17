import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { aggregatePixelAnalyses, analyzePixels } from "../lib/imageAnalysis";
import { analysisPercent, PixelAnalysisCharts } from "./PixelAnalysisCharts";

const colour = analyzePixels(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1);

describe("descriptive pixel charts", () => {
  it("shows real numeric summaries, accessible chart descriptions and complete data tables", () => {
    const markup = renderToStaticMarkup(<PixelAnalysisCharts data={colour} heading="当前裁剪" />);
    expect(markup).toContain("当前裁剪");
    expect(markup).toContain("亮度分布");
    expect(markup).toContain("色相分布");
    expect(markup).toContain("画面主色");
    expect(markup).toContain("#FF0000");
    expect(markup).toContain("RGB 255 / 0 / 0");
    expect(markup).toContain("50%");
    expect(markup.match(/role="img"/g)).toHaveLength(2);
    expect(markup).toContain("<desc");
    expect(markup.match(/<details/g)).toHaveLength(2);
    expect(markup).toContain("248–255");
    expect(markup).toContain("330–360°");
    expect(markup).toContain("从暗到亮，看看光线如何铺满画面");
    expect(markup).not.toContain("审美得分");
    expect(markup).not.toContain("曝光合格");
  });

  it("does not force grayscale into hue bins or pad the palette to five colours", () => {
    const grey = analyzePixels(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1);
    const markup = renderToStaticMarkup(<PixelAnalysisCharts data={grey} compact />);
    expect(markup).toContain("画面以中性色为主");
    expect(markup).toContain("黑白灰与低饱和色彩");
    expect(markup).not.toContain("查看色相分布数值");
    expect(markup.match(/class="sc-pixel-swatch"/g)).toHaveLength(1);
    expect(markup).toContain("#808080");
  });

  it("does not represent a fully transparent range as black or numeric zero brightness", () => {
    const transparent = analyzePixels(new Uint8ClampedArray([200, 100, 50, 0]), 1, 1);
    const markup = renderToStaticMarkup(<PixelAnalysisCharts data={transparent} />);
    expect(markup).toContain("没有可统计的可见像素");
    expect(markup).toContain("是透明内容");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("平均亮度");
    expect(markup).not.toContain("#000000");
  });

  it("labels archive aggregation as a collection instead of pretending to be one image", () => {
    const markup = renderToStaticMarkup(<PixelAnalysisCharts data={aggregatePixelAnalyses([colour])} scope="archive" />);
    expect(markup).toContain("作品平均亮度");
    expect(markup).toContain("作品集主色");
    expect(markup).not.toContain("画面主色");
    expect(markup).toContain("色彩气质");
    expect(markup).not.toContain("相近颜色会合并");
    expect(markup).not.toContain("聚类");
  });

  it("describes the real dominant archive colour without creating a personality label", () => {
    const black = analyzePixels(new Uint8ClampedArray([0, 0, 0, 255]), 1, 1);
    const markup = renderToStaticMarkup(<PixelAnalysisCharts data={aggregatePixelAnalyses([black])} scope="archive" />);
    expect(markup).toContain("黑色，深邃而沉稳");
    expect(markup).not.toContain("性格");
    expect(markup).not.toContain("人格");
  });

  it("rounds readable percentages without hiding small nonzero fractions", () => {
    expect(analysisPercent(0)).toBe("0%");
    expect(analysisPercent(0.51234)).toBe("51.2%");
    expect(analysisPercent(0.0001)).toBe("<0.1%");
    expect(analysisPercent(1)).toBe("100%");
  });
});
