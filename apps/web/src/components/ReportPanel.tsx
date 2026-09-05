import { CircleAlert, Lightbulb, ScanSearch, Sparkles, Target } from "lucide-react";

import type { AestheticReport } from "../types";

interface Props {
  report: AestheticReport | null;
  adjusted: boolean;
  manualOnly: boolean;
}

export function ReportPanel({ report, adjusted, manualOnly }: Props) {
  return (
    <aside className="report-panel" aria-labelledby="report-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{manualOnly ? "Manual crop" : "Venus 原生输出"}</p>
          <h2 id="report-heading">{manualOnly ? "手动裁剪模式" : "美学分析报告"}</h2>
          {!manualOnly && <p className="report-language-note">报告正文由 Venus 直接生成，目前为英文。</p>}
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

      {!manualOnly && adjusted && (
        <div className="adjusted-note">
          <CircleAlert size={18} aria-hidden="true" />
          <span>最终裁剪已由用户调整，报告解释的是 AI 初始建议。</span>
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
        <h3><Target size={17} aria-hidden="true" />裁剪理由</h3>
        <p>{report.crop_rationale}</p>
      </section>}
      {report && <section className="report-section">
        <h3><Lightbulb size={17} aria-hidden="true" />下次拍摄建议</h3>
        <ul>{report.shooting_tips.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>}
    </aside>
  );
}
