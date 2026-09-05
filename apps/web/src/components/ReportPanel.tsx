import { CircleAlert, Lightbulb, ScanSearch, Sparkles, Target } from "lucide-react";

import type { AestheticReport } from "../types";

interface Props {
  report: AestheticReport | null;
  adjusted: boolean;
  manualOnly: boolean;
  finalReview?: boolean;
}

export function ReportPanel({ report, adjusted, manualOnly, finalReview = false }: Props) {
  const isChinese = report?.language === "zh-CN";
  const translated = report?.language === "zh-CN" && report.translation_provider === "deepseek";

  return (
    <aside className="report-panel" aria-labelledby="report-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {finalReview
              ? "Final composition review"
              : manualOnly
              ? "Manual crop"
              : translated
                ? "Venus 分析 · DeepSeek 翻译"
                : isChinese
                  ? "AI 示例分析"
                  : "Venus 原始分析"}
          </p>
          <h2 id="report-heading">{manualOnly ? "手动裁剪模式" : finalReview ? "终稿复评报告" : "初始美学报告"}</h2>
          {!manualOnly && translated && (
            <p className="report-language-note">报告由 Venus 生成，并经 DeepSeek 翻译为简体中文。</p>
          )}
          {!manualOnly && isChinese && !translated && (
            <p className="report-language-note">当前为简体中文报告。</p>
          )}
          {!manualOnly && report && !isChinese && (
            <p className="report-language-note">翻译服务暂不可用，当前显示 Venus 英文原文。</p>
          )}
        </div>
        <Sparkles aria-hidden="true" size={22} />
      </div>

      {manualOnly && (
        <div className="manual-mode-note" role="status">
          <CircleAlert size={18} aria-hidden="true" />
          <span>
            模型分析失败，请稍后重试；也可继续使用手动裁剪。当前只提供手动裁剪，未生成分析报告。
          </span>
        </div>
      )}

      {!manualOnly && adjusted && !finalReview && (
        <div className="adjusted-note">
          <CircleAlert size={18} aria-hidden="true" />
          <span>画面已调整；点击“复评终稿”可生成针对最终成片的新报告。</span>
        </div>
      )}

      {report && <section className="report-section">
        <h3><ScanSearch size={17} aria-hidden="true" />整体观察</h3>
        <p>{report.overview}</p>
      </section>}
      {report && <section className="report-section">
        <h3><Sparkles size={17} aria-hidden="true" />画面优点</h3>
        <ul>{report.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>}
      {report && <section className="report-section">
        <h3><CircleAlert size={17} aria-hidden="true" />主要问题</h3>
        <ul>{report.issues.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>}
      {report && <section className="report-section">
        <h3><Target size={17} aria-hidden="true" />{finalReview ? "终稿构图" : "裁剪理由"}</h3>
        <p>{report.crop_rationale}</p>
      </section>}
      {report && <section className="report-section">
        <h3><Lightbulb size={17} aria-hidden="true" />下次拍摄建议</h3>
        <ul>{report.shooting_tips.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>}
    </aside>
  );
}
