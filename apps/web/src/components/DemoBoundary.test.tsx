import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AestheticReport } from "../types";
import { CompositionTools } from "./CompositionTools";
import { ReportPanel } from "./ReportPanel";

const report: AestheticReport = {
  overview: "示例观察",
  strengths: ["示例优点"],
  issues: ["示例问题"],
  crop_rationale: "示例理由",
  shooting_tips: ["示例建议"],
  language: "zh-CN",
  translation_provider: null,
};

describe("pregenerated demo boundaries", () => {
  it("marks the report and objective panel as not invoking a model", () => {
    const reportMarkup = renderToStaticMarkup(
      <ReportPanel report={report} adjusted={false} manualOnly={false} source="pregenerated" />,
    );
    const toolsMarkup = renderToStaticMarkup(
      <CompositionTools
        crop={{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }}
        imageWidth={1600}
        imageHeight={1000}
        intent={{
          scene: "general",
          aspect_ratio: "free",
          output_template: "freeform",
          custom_ratio: null,
        }}
        guides={["thirds"]}
        processingDurationMs={null}
        pregenerated
        onToggleGuide={vi.fn()}
      />,
    );

    expect(reportMarkup).toContain("预生成示例报告");
    expect(reportMarkup).toContain("没有调用当前模型");
    expect(reportMarkup).not.toContain("AI 示例分析");
    expect(toolsMarkup).toContain("后端处理耗时");
    expect(toolsMarkup).toContain("未调用");
  });
});
