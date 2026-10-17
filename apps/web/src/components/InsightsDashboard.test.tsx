import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ArchivedInsightsState } from "../hooks/useArchivedInsights";
import { buildArchiveInsights } from "../lib/archiveInsights";
import type { ArchivedInsightEntry } from "../lib/archiveInsights";
import { analyzePixels } from "../lib/imageAnalysis";
import type { ProjectSummary } from "../workspaceApi";
import { InsightsDashboard } from "./InsightsDashboard";

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.6 };
  const draft = { crop, selected_candidate_id: null, selection_reasons: [], selection_note: null, selection_explicit: false };
  return {
    id: "photo-1", title: "湖边傍晚", state: "archived", revision: 9, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-17T00:00:00Z",
    archived_at: "2026-10-17T00:00:00Z", image_width: 1600, image_height: 1200, original_url: "/original",
    preview_url: "/preview", crop_url: "/mutable-crop", published_url: "/fixed-published?version=2", has_draft_changes: false,
    published: { ...draft, version: 2, created_at: "2026-10-17T00:00:00Z", width: 1280, height: 720, draft,
      intent: { scene: "landscape", aspect_ratio: "16:9", output_template: "presentation", custom_ratio: null } }, ...overrides,
  };
}
function state(entries: ArchivedInsightEntry[], loading = false): ArchivedInsightsState {
  return { entries, status: loading ? "loading" : "ready", total: entries.length,
    completed: entries.filter(entry => entry.analysis || entry.error).length, retry: vi.fn() };
}
function buttons(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    // Dashboard actions are native children; do not manually execute chart
    // components, whose useId must remain inside React's normal render cycle.
    if (typeof child.type === "function") return [];
    const descendants = buttons(child.props.children as ReactNode);
    return child.type === "button" ? [child, ...descendants] : descendants;
  });
}

describe("archive insights dashboard", () => {
  it("keeps a genuine zero archive empty and offers the real library, not fake charts", () => {
    const onNavigateLibrary = vi.fn();
    const view = InsightsDashboard({ state: state([]), stats: buildArchiveInsights([]), onNavigateLibrary });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain("还没有已归档作品");
    expect(markup).toContain("回看明暗、配色与取景习惯");
    expect(markup).not.toContain("平均亮度");
    (buttons(view)[0].props.onClick as () => void)();
    expect(onNavigateLibrary).toHaveBeenCalledOnce();
  });

  it("shows published snapshots, real metadata counts and exact participation instead of mutable drafts", () => {
    const analysis = analyzePixels(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
    const entries = [{ project: project({ has_draft_changes: true }), analysis, error: null }];
    const onOpenProject = vi.fn();
    const view = InsightsDashboard({ state: state(entries), stats: buildArchiveInsights(entries), onOpenProject, onNavigateLibrary: vi.fn() });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain("48%");
    expect(markup).toContain("横幅");
    expect(markup).toContain("演示配图");
    expect(markup).toContain("归档版本 v2 · 1280 × 720");
    expect(markup).toContain("/fixed-published?version=2");
    expect(markup).not.toContain("/mutable-crop");
    expect(markup).toContain("有新草稿，未计入本次统计");
    expect(markup).toContain("作品平均亮度");
    expect(markup).toContain("作品集主色");
    expect(markup).toContain("演示账号共用作品库");
    expect(markup).toContain("红色，热烈而鲜明");
    expect(markup).not.toContain("确定性近似聚类");
    expect(markup).not.toContain("HSV");
    (buttons(view).find(button => button.props["aria-label"] === "继续编辑：湖边傍晚")?.props.onClick as () => void)();
    expect(onOpenProject).toHaveBeenCalledWith("photo-1");
  });

  it("labels a partial result and lets failed pixel analysis retry without hiding the collection metadata", () => {
    const entries = [{ project: project(), analysis: null, error: "图片暂时无法读取" }];
    const onRetry = vi.fn();
    const view = InsightsDashboard({ state: state(entries), stats: buildArchiveInsights(entries), onNavigateLibrary: vi.fn(), onRetry });
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain("1 张成片暂未能完成分析");
    expect(markup).toContain("暂时没有可用的图像分析");
    expect(markup).toContain("图片暂时无法读取");
    expect(markup).toContain("成片画幅");
    expect(markup).toContain("演示配图");
    expect(markup).not.toContain("作品平均亮度");
    (buttons(view).find(button => renderToStaticMarkup(button).includes("重试未完成的分析"))?.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("distinguishes an unfinished first read from no usable or zero-image data", () => {
    const entries = [{ project: project(), analysis: null, error: null }];
    const markup = renderToStaticMarkup(<InsightsDashboard state={state(entries, true)} stats={buildArchiveInsights(entries)} onNavigateLibrary={vi.fn()} />);
    expect(markup).toContain("已处理 0 / 1 张");
    expect(markup).toContain("正在读取首张成片");
    expect(markup).toContain("等待分析");
    expect(markup).not.toContain("暂时没有可用的图像分析");
    expect(markup).not.toContain("还没有已归档作品");
  });

  it("counts a successfully decoded transparent image without inventing colour data", () => {
    const analysis = analyzePixels(new Uint8ClampedArray([255, 0, 0, 0]), 1, 1);
    const entries = [{ project: project(), analysis, error: null }];
    const markup = renderToStaticMarkup(<InsightsDashboard state={state(entries)} stats={buildArchiveInsights(entries)} onNavigateLibrary={vi.fn()} />);
    expect(markup).toContain("0 张有可见画面");
    expect(markup).toContain("完全透明，无可见画面");
    expect(markup).toContain("没有可统计的可见像素");
    expect(markup).not.toContain("作品平均亮度");
  });
});
