import { ArrowRight, FolderHeart, RefreshCw } from "lucide-react";

import type { ArchivedInsightsState } from "../hooks/useArchivedInsights";
import type { ArchivedStatistics } from "../lib/archiveInsights";
import { analysisPercent, PixelAnalysisCharts } from "./PixelAnalysisCharts";
import "./pixel-analysis.css";

export interface InsightsDashboardProps {
  state: ArchivedInsightsState;
  stats: ArchivedStatistics;
  onOpenProject?: (id: string) => void;
  onNavigateLibrary: () => void;
  onRetry?: () => void;
}

function DistributionList({ title, description, items, total }: {
  title: string; description: string; items: Array<{ key: string; label: string; count: number }>; total: number;
}) {
  return <section className="sc-insight-distribution"><h3>{title}</h3><p>{description}</p>
    <ul>{items.map((item) => <li key={item.key}><div><span>{item.label}</span><strong>{item.count} 张 <small>· {analysisPercent(total ? item.count / total : 0)}</small></strong></div>
      <span className="sc-insight-count-track" aria-hidden="true"><span style={{ width: `${total ? item.count / total * 100 : 0}%` }} /></span></li>)}</ul>
  </section>;
}

export function InsightsDashboard({ state, stats, onOpenProject, onNavigateLibrary, onRetry }: InsightsDashboardProps) {
  if (!stats.archivedCount) return <section className="sc-insight-empty" aria-labelledby="sc-insight-empty-title">
    <FolderHeart size={30} aria-hidden="true" /><div><h2 id="sc-insight-empty-title">这个范围内，还没有已归档作品</h2>
      <p>在工作台完成并归档照片后，就能在这里回看明暗、配色与取景习惯。</p></div>
    <button type="button" className="sc-workspace-outline-button" onClick={onNavigateLibrary}>前往作品库<ArrowRight size={16} aria-hidden="true" /></button>
  </section>;

  return <div className="sc-insights-dashboard" aria-busy={state.status === "loading"}>
    <dl className="sc-insight-stat-cards">
      <div><dt>已归档作品</dt><dd>{stats.archivedCount}<small> 张</small></dd><span>每项目只计最新归档版本</span></div>
      <div><dt>已完成分析</dt><dd>{stats.pixelCount}<small> / {stats.archivedCount}</small></dd><span>{stats.visiblePixelCount} 张有可见画面</span></div>
      <div><dt>平均保留面积</dt><dd>{stats.meanRetainedFraction === null ? "—" : analysisPercent(stats.meanRetainedFraction)}</dd><span>按 {stats.retainedSampleCount} 张有效归档取景计算</span></div>
      <div><dt>暂未完成分析</dt><dd>{stats.failedCount}<small> 张</small></dd><span>{state.status === "loading" ? "正在继续分析其余成片" : stats.failedCount ? "可重试未完成的作品" : "成片分析一切顺利"}</span></div>
    </dl>

    {state.status === "loading" && <p className="sc-insight-progress" role="status">正在分析归档成片：已处理 {state.completed} / {state.total} 张。图表随分析进度更新。</p>}
    {stats.failedCount > 0 && <div className="sc-insight-partial-error" role="status"><p>{stats.failedCount} 张成片暂未能完成分析，其他作品的洞察已保留。</p>
      {onRetry && <button type="button" className="sc-workspace-text-button" onClick={onRetry} disabled={state.status === "loading"}><RefreshCw size={16} aria-hidden="true" />重试未完成的分析</button>}</div>}

    <section className="sc-insight-pixels" aria-labelledby="sc-insight-pixels-title">
      <div className="sc-workspace-section-heading"><div><p className="sc-workspace-eyebrow">Light & colour</p><h2 id="sc-insight-pixels-title">这组作品的明暗与配色</h2></div><span>本机计算 · 不调用 AI</span></div>
      <p className="sc-insight-subtitle">汇集所选范围内的最新归档成片，回看这段创作里的光线与色彩。</p>
      {stats.pixelCount > 0 ? <PixelAnalysisCharts data={stats.pixels} scope="archive" />
        : state.status === "loading" ? <div className="sc-pixel-loading" role="status"><span aria-hidden="true" />正在读取首张成片，准备生成图表…</div>
          : <div className="sc-pixel-empty"><h3>暂时没有可用的图像分析</h3><p>成片暂时无法读取，请重试分析，或返回作品库检查图片。</p></div>}
    </section>

    <section className="sc-insight-structure" aria-labelledby="sc-insight-structure-title">
      <div className="sc-workspace-section-heading"><div><p className="sc-workspace-eyebrow">Frames & intentions</p><h2 id="sc-insight-structure-title">取景与发布用途</h2></div><span>来自已归档作品</span></div>
      <div className="sc-insight-distribution-grid">
        <DistributionList title="成片画幅" description="横向、纵向或方形，回看你的取景选择。" items={stats.orientations} total={stats.archivedCount} />
        <DistributionList title="发布模板" description="作品归档时选择的发布用途。" items={stats.templates} total={stats.archivedCount} />
      </div>
      <p className="sc-insight-subtitle sc-insight-retained-note">保留面积反映裁剪后留下了多少原始画面。</p>
    </section>

    <section className="sc-insight-participants" aria-labelledby="sc-insight-participants-title">
      <div className="sc-workspace-section-heading"><div><p className="sc-workspace-eyebrow">The photographs behind the numbers</p><h2 id="sc-insight-participants-title">参与统计的作品</h2></div><span>{state.entries.length} 个项目 · 各取一个归档版本</span></div>
      <div className="sc-insight-participant-grid">{state.entries.map(({ project, analysis, error }) => <article className="sc-insight-participant" key={project.id}>
        <div className="sc-insight-participant-image">{project.published_url && <img src={project.published_url} alt={`${project.title}：参与统计的归档成片`} loading="lazy" />}</div>
        <div className="sc-insight-participant-copy"><h3>{project.title}</h3><p>{project.published ? `归档版本 v${project.published.version} · ${project.published.width} × ${project.published.height}` : "归档快照信息缺失"}</p>
          <p className={error ? "sc-insight-participant-failed" : "sc-insight-participant-status"}>{error ? "分析暂未完成" : analysis ? analysis.visibleWeight > 0 ? "分析已完成" : "完全透明，无可见画面" : "等待分析"}</p>
          {error && <span className="sc-insight-participant-error">{error}</span>}
          {project.has_draft_changes && <span className="sc-insight-draft-note">有新草稿，未计入本次统计</span>}
          {onOpenProject && <button type="button" className="sc-workspace-text-button" onClick={() => onOpenProject(project.id)} aria-label={`继续编辑：${project.title}`}>继续编辑<ArrowRight size={15} aria-hidden="true" /></button>}
        </div>
      </article>)}</div>
    </section>

    <details className="sc-insight-method"><summary>关于这份摄影洞察</summary><div>
      <p>每个作品只统计最新归档成片，每张作品等权参与；草稿与固定样例不计入。</p>
      <p>明暗、色相与主色由浏览器计算，不需要等待 AI。色彩气质使用预设文案，描述作品集的配色氛围。</p>
      <p>当前展示演示账号共用作品库的统计。</p>
    </div></details>
  </div>;
}
