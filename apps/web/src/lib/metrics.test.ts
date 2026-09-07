import { describe, expect, it } from "vitest";

import { getCropMetrics } from "./metrics";

describe("objective crop metrics", () => {
  it("reports pixel size, retained area, and ratio compliance", () => {
    const metrics = getCropMetrics(
      800,
      600,
      { x: 0.2, y: 0.1, width: 0.48, height: 0.8 },
      {
        scene: "product",
        aspect_ratio: "4:5",
        output_template: "product_main",
        custom_ratio: null,
      },
    );

    expect(metrics.outputWidth).toBe(384);
    expect(metrics.outputHeight).toBe(480);
    expect(metrics.retainedPercent).toBeCloseTo(38.4);
    expect(metrics.ratioCompliant).toBe(true);
  });

  it("flags a visibly non-compliant custom crop", () => {
    const metrics = getCropMetrics(
      800,
      600,
      { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      {
        scene: "general",
        aspect_ratio: "custom",
        output_template: "custom",
        custom_ratio: { width: 7, height: 5 },
      },
    );

    expect(metrics.ratioCompliant).toBe(false);
  });
});
