import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../workspaceApi";
import { clearArchivedInsightsCache, useArchivedInsights } from "./useArchivedInsights";

function Probe({ projects, enabled = true }: { projects?: ProjectSummary[]; enabled?: boolean }) {
  const state = useArchivedInsights(projects, enabled);
  return <output>{`${state.status}:${state.total}:${state.entries.length}:${state.completed}`}</output>;
}
const archived = { id: "a", state: "archived", published_url: "/v1/projects/a/assets/published?version=1" } as ProjectSummary;
describe("archived analysis initial states", () => {
  it("exposes pending works before the effect rather than an invented empty library", () => {
    expect(renderToStaticMarkup(<Probe projects={[archived]} />)).toBe("<output>loading:1:1:0</output>");
  });
  it("does not compute or expose private entries before enabled", () => {
    expect(renderToStaticMarkup(<Probe projects={[archived]} enabled={false} />)).toBe("<output>idle:1:0:0</output>");
  });
  it("keeps a list that was not read distinct from a confirmed empty list", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("<output>idle:0:0:0</output>");
    expect(renderToStaticMarkup(<Probe projects={[]} />)).toBe("<output>loading:0:0:0</output>");
  });
  it("allows cache invalidation without requiring a browser global", () => {
    expect(() => clearArchivedInsightsCache()).not.toThrow();
    expect(renderToStaticMarkup(<Probe projects={[archived]} />)).toBe("<output>loading:1:1:0</output>");
  });
});
