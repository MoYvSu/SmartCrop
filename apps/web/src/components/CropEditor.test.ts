import { describe, expect, it } from "vitest";

import { fitStageSize } from "./CropEditor";

describe("fitStageSize", () => {
  it("keeps a portrait image box aligned with its aspect ratio when height-limited", () => {
    const size = fitStageSize(100, 400, 396, 655);

    expect(size.width).toBeCloseTo(163.75);
    expect(size.height).toBeCloseTo(655);
    expect(size.width / size.height).toBeCloseTo(0.25);
  });

  it("fills the available width for a landscape image without distortion", () => {
    const size = fitStageSize(1600, 900, 396, 655);

    expect(size.width).toBeCloseTo(396);
    expect(size.height).toBeCloseTo(222.75);
    expect(size.width / size.height).toBeCloseTo(16 / 9);
  });
});
