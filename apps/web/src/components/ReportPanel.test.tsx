import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AestheticReport } from "../types";
import { ReportPanel } from "./ReportPanel";

const translated: AestheticReport = {
  overview: "主体明确，画面安静。",
  strengths: ["明暗层次清晰。"],
  issues: ["边缘亮部有些抢眼。"],
  crop_rationale: "收紧取景，避开边缘亮部。",
  shooting_tips: ["拍摄时留意画面边缘。"],
  language: "zh-CN",
  translation_provider: "deepseek",
};

describe("report translation presentation", () => {
  it("keeps DeepSeek attribution on translated model reports", () => {
    const markup = renderToStaticMarkup(
      <ReportPanel report={translated} adjusted={false} manualOnly={false} source="model" />,
    );
    expect(markup).toContain("Venus 分析 · DeepSeek 翻译");
    expect(markup).toContain("报告由 Venus 生成，并经 DeepSeek 翻译为简体中文。");
    expect(markup).toContain(translated.overview);
    expect(markup).not.toContain("翻译服务暂不可用");
  });

  it("keeps the original English report readable when translation is unavailable", () => {
    const english: AestheticReport = {
      overview: "A quiet composition with a clear subject.",
      strengths: ["Clear separation."],
      issues: ["A bright frame edge."],
      crop_rationale: "Remove the bright edge.",
      shooting_tips: ["Check the edges."],
      language: "en",
      translation_provider: null,
    };
    const markup = renderToStaticMarkup(
      <ReportPanel report={english} adjusted={false} manualOnly={false} source="model" />,
    );
    expect(markup).toContain("翻译服务暂不可用，当前显示 Venus 英文原文。");
    expect(markup).toContain(english.overview);
    expect(markup).not.toContain("DeepSeek 翻译");
  });

  it.each(["mock", "pregenerated"] as const)("does not present %s examples as real translated model reports", (source) => {
    const markup = renderToStaticMarkup(
      <ReportPanel report={translated} adjusted={false} manualOnly={false} source={source} />,
    );
    expect(markup).toContain(source === "mock" ? "Mock 示例报告" : "使用样例");
    expect(markup).not.toContain("Venus 分析 · DeepSeek 翻译");
    expect(markup).not.toContain("报告由 Venus 生成，并经 DeepSeek 翻译为简体中文。");
  });
});
