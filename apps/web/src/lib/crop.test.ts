import { describe, expect, it } from "vitest";

import { cropEquals, fitCropToAspect, moveCrop, normalizedAspectRatio } from "./crop";

describe("crop helpers", () => {
  it("keeps a moved crop inside the image", () => {
    expect(moveCrop({ x: 0.8, y: 0.8, width: 0.3, height: 0.3 }, 0.2, 0.2)).toEqual({
      x: 0.7,
      y: 0.7,
      width: 0.3,
      height: 0.3,
    });
  });

  it("compares crops with a small tolerance", () => {
    expect(
      cropEquals(
        { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        { x: 0.10001, y: 0.1, width: 0.8, height: 0.8 },
      ),
    ).toBe(true);
  });

  it("fits a crop to a requested pixel ratio", () => {
    const ratio = normalizedAspectRatio("4:5", 800, 600);
    const crop = fitCropToAspect({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, ratio);
    expect((crop.width * 800) / (crop.height * 600)).toBeCloseTo(0.8);
  });
});
