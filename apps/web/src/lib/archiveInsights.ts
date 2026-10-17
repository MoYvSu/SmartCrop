import type { ProjectSummary } from "../workspaceApi";
import { aggregatePixelAnalyses } from "./imageAnalysis";
import type { PixelAnalysis, PixelAnalysisAggregate } from "./imageAnalysis";

export type InsightRange = "all" | "30" | "90";
export interface ArchivedInsightEntry {
  project: ProjectSummary;
  analysis: PixelAnalysis | null;
  error: string | null;
}
export interface InsightCategory { key: string; label: string; count: number }
export interface ArchivedStatistics {
  archivedCount: number; pixelCount: number; visiblePixelCount: number; failedCount: number;
  meanRetainedFraction: number | null; retainedSampleCount: number;
  templates: InsightCategory[]; orientations: InsightCategory[]; pixels: PixelAnalysisAggregate;
}

const TEMPLATES: Record<string, string> = {
  freeform: "自由裁剪", avatar: "头像", social_cover: "社交封面", product_main: "商品主图",
  presentation: "演示配图", custom: "自定义比例", unknown: "未记录用途",
};

export function filterArchivedProjects(projects: readonly ProjectSummary[], range: InsightRange = "all", now = Date.now()): ProjectSummary[] {
  const cutoff = range === "all" ? -Infinity : now - Number(range) * 86400000;
  const unique = new Map<string, ProjectSummary>();
  for (const project of projects) {
    if (project.state !== "archived" || !project.published_url || project.source === "pregenerated"
      || project.published?.source === "pregenerated") continue;
    const date = Date.parse(project.archived_at || project.published?.created_at || "");
    if (range !== "all" && (!Number.isFinite(date) || date < cutoff || date > now)) continue;
    unique.set(project.id, project);
  }
  return [...unique.values()].sort((a, b) => (b.archived_at || "").localeCompare(a.archived_at || "") || a.id.localeCompare(b.id));
}

export function archivedAnalysisKey(project: ProjectSummary): string {
  // Immutable published URL includes its version. Draft revisions never invalidate it.
  return JSON.stringify([project.id, project.published_url, project.published?.width, project.published?.height]);
}

export function buildArchiveInsights(entries: readonly ArchivedInsightEntry[]): ArchivedStatistics {
  const unique = [...new Map(entries.filter(entry => filterArchivedProjects([entry.project]).length > 0)
    .map(entry => [entry.project.id, entry])).values()];
  const analyses = unique.flatMap(entry => entry.analysis ? [entry.analysis] : []);
  const templateCounts = new Map<string, number>();
  const orientationCounts = new Map<string, number>();
  const retained: number[] = [];
  for (const { project } of unique) {
    const published = project.published;
    const template = published?.intent?.output_template;
    const key = template && TEMPLATES[template] ? template : "unknown";
    templateCounts.set(key, (templateCounts.get(key) || 0) + 1);
    const width = published?.width || 0, height = published?.height || 0;
    const orientation = width > 0 && height > 0 ? width === height ? "square" : width > height ? "landscape" : "portrait" : "unknown";
    orientationCounts.set(orientation, (orientationCounts.get(orientation) || 0) + 1);
    const crop = published?.crop;
    if (crop && Number.isFinite(crop.width) && Number.isFinite(crop.height)
      && crop.width > 0 && crop.width <= 1 && crop.height > 0 && crop.height <= 1) retained.push(crop.width * crop.height);
  }
  const orientationLabels: Record<string, string> = { landscape: "横幅", portrait: "竖幅", square: "方形", unknown: "尺寸未记录" };
  const categories = (counts: Map<string, number>, labels: Record<string, string>) => [...counts].map(([key, count]) => ({ key, label: labels[key], count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const pixels = aggregatePixelAnalyses(analyses);
  return {
    archivedCount: unique.length, pixelCount: analyses.length, visiblePixelCount: pixels.visibleImageCount,
    failedCount: unique.filter(entry => entry.error).length,
    meanRetainedFraction: retained.length ? retained.reduce((sum, value) => sum + value, 0) / retained.length : null,
    retainedSampleCount: retained.length,
    templates: categories(templateCounts, TEMPLATES), orientations: categories(orientationCounts, orientationLabels), pixels,
  };
}
