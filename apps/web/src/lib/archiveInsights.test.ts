import { describe, expect, it } from "vitest";
import type { ProjectSummary, PublishedProject } from "../workspaceApi";
import { archivedAnalysisKey, buildArchiveInsights, filterArchivedProjects } from "./archiveInsights";
import { analyzePixels } from "./imageAnalysis";

function project(id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary {
  const published = { version: 1, created_at: "2026-10-01T12:00:00Z", width: 600, height: 800,
    crop: { x: 0, y: 0, width: 0.5, height: 0.8 }, intent: { output_template: "product_main" } } as PublishedProject;
  return { id, title: id, source: "upload", state: "archived", revision: 2,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-17T00:00:00Z", archived_at: published.created_at,
    image_width: 1200, image_height: 1000, original_url: `/v1/projects/${id}/assets/original`,
    preview_url: `/v1/projects/${id}/assets/preview`, crop_url: `/v1/projects/${id}/assets/crop`,
    published_url: `/v1/projects/${id}/assets/published?version=1`, has_draft_changes: false, published, ...extra };
}
const red = analyzePixels(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);
const white = analyzePixels(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);

describe("archived photography statistics", () => {
  it("excludes drafts and fixed examples, and counts a project only once", () => {
    const items = filterArchivedProjects([project("a"), project("a", { revision: 8 }),
      project("b", { state: "draft", published_url: null, published: null }), project("sample", { source: "pregenerated" })]);
    expect(items.map(item => item.id)).toEqual(["a"]);
    expect(items[0].revision).toBe(8);
  });

  it("filters by archive time instead of recent draft edits", () => {
    const recent = project("recent", { archived_at: "2026-10-10T12:00:00Z" });
    const old = project("old", { archived_at: "2026-07-01T12:00:00Z", updated_at: "2026-10-17T12:00:00Z" });
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(filterArchivedProjects([recent, old], "30", now).map(item => item.id)).toEqual(["recent"]);
    expect(filterArchivedProjects([recent, old], "all", now)).toHaveLength(2);
  });

  it("uses frozen published geometry and purpose, not draft data", () => {
    const p = { ...project("a"), intent: { output_template: "avatar" }, draft: { crop: { width: 1, height: 1 } } };
    const stats = buildArchiveInsights([{ project: p, analysis: red, error: null }]);
    expect(stats.meanRetainedFraction).toBeCloseTo(0.4);
    expect(stats.templates).toEqual([{ key: "product_main", label: "商品主图", count: 1 }]);
    expect(stats.orientations).toEqual([{ key: "portrait", label: "竖幅", count: 1 }]);
  });

  it("averages works equally and keeps grayscale out of colored hue denominator", () => {
    const stats = buildArchiveInsights([{ project: project("a"), analysis: red, error: null },
      { project: project("b"), analysis: white, error: null }]);
    expect(stats.archivedCount).toBe(2);
    expect(stats.visiblePixelCount).toBe(2);
    expect(stats.pixels.meanBrightness).toBeCloseTo((red.meanBrightness! + 255) / 2);
    expect(stats.pixels.chromaticFraction).toBe(0.5);
    expect(stats.pixels.hueHistogram[0]).toBe(1);
  });

  it("reports failed, pending and entirely transparent works without fabricated zeros", () => {
    const transparent = analyzePixels(new Uint8ClampedArray([255, 0, 0, 0]), 1, 1);
    const stats = buildArchiveInsights([{ project: project("a"), analysis: transparent, error: null },
      { project: project("b"), analysis: null, error: "图片不可读" }, { project: project("c"), analysis: null, error: null }]);
    expect(stats.archivedCount).toBe(3); expect(stats.pixelCount).toBe(1);
    expect(stats.failedCount).toBe(1); expect(stats.visiblePixelCount).toBe(0);
    expect(stats.pixels.meanBrightness).toBeNull();
    expect(stats.pixels.palette).toEqual([]);
  });

  it("does not invent metadata when the archive snapshot is missing", () => {
    const stats = buildArchiveInsights([{ project: project("a", { published: undefined }), analysis: null, error: "尺寸缺失" }]);
    expect(stats.meanRetainedFraction).toBeNull(); expect(stats.retainedSampleCount).toBe(0);
    expect(stats.templates[0].label).toBe("未记录用途");
    expect(stats.orientations[0].label).toBe("尺寸未记录");
  });

  it("deletion removes every statistical contribution", () => {
    expect(buildArchiveInsights([])).toMatchObject({ archivedCount: 0, pixelCount: 0, meanRetainedFraction: null });
  });

  it("keys pixels to the immutable archive version, never a new draft revision", () => {
    const a = project("a");
    expect(archivedAnalysisKey({ ...a, revision: 10, has_draft_changes: true })).toBe(archivedAnalysisKey(a));
    expect(archivedAnalysisKey({ ...a, published_url: "/v1/projects/a/assets/published?version=2" })).not.toBe(archivedAnalysisKey(a));
  });

  it("does not count a fixed sample injected into the aggregate input", () => {
    const stats = buildArchiveInsights([{ project: project("sample", { source: "pregenerated" }), analysis: red, error: null }]);
    expect(stats.archivedCount).toBe(0); expect(stats.pixels.meanBrightness).toBeNull();
  });

  it("does not let a same-id draft or sample overwrite a valid archived entry", () => {
    const stats = buildArchiveInsights([{ project: project("a"), analysis: red, error: null },
      { project: project("a", { state: "draft", published_url: null }), analysis: white, error: null },
      { project: project("a", { source: "pregenerated" }), analysis: white, error: null }]);
    expect(stats.archivedCount).toBe(1);
    expect(stats.pixels.meanBrightness).toBeCloseTo(red.meanBrightness!);
  });
});
