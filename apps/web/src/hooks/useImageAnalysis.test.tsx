import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useImageAnalysis } from "./useImageAnalysis";

function Probe({ enabled }: { enabled: boolean }) {
  const analysis = useImageAnalysis("/demo/composition-sample.svg", 1600, 1000, undefined, enabled);
  return createElement("output", null, `${analysis.status}:${analysis.data === null ? "none" : "data"}`);
}

describe("image analysis hook rendering", () => {
  it("does not require browser globals or show a fabricated result before sampling", () => {
    expect(renderToStaticMarkup(createElement(Probe, { enabled: true }))).toBe("<output>loading:none</output>");
  });

  it("returns idle with no retained pixels when analysis is disabled", () => {
    expect(renderToStaticMarkup(createElement(Probe, { enabled: false }))).toBe("<output>idle:none</output>");
  });
});
