import { describe, expect, it } from "vitest";

import {
  cropEquals,
  fitCropToAspect,
  fitCropToIntent,
  moveCrop,
  normalizedAspectRatio,
} from "./crop";

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

  it("fits the model-failure fallback before the user saves a fixed-ratio crop", () => {
    const crop = fitCropToIntent(
      { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
      {
        scene: "product",
        aspect_ratio: "4:5",
        output_template: "product_main",
        custom_ratio: null,
      },
      800,
      600,
    );

    expect((crop.width * 800) / (crop.height * 600)).toBeCloseTo(0.8);
  });

  it("preserves an inward corner resize instead of turning it into a translation", () => {
    const start = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const afterHorizontalInset = { x: 0.11, y: 0.1, width: 0.79, height: 0.8 };
    const fitted = fitCropToAspect(afterHorizontalInset, 1);

    expect(fitted.width * fitted.height).toBeLessThan(start.width * start.height);
    expect(fitted.width).toBeCloseTo(0.79);
    expect(fitted.height).toBeCloseTo(0.79);
    expect(fitted.x).toBeCloseTo(0.11);
  });

  it.each([
    [400, 100, { width: 1, height: 10 }],
    [100, 400, { width: 10, height: 1 }],
    [4000, 90, { width: 1, height: 1 }],
  ] as const)("expands a near-boundary crop for %sx%s", (width, height, customRatio) => {
    const crop = fitCropToIntent(
      { x: 0.14, y: 0.14, width: 0.72, height: 0.72 },
      {
        scene: "general",
        aspect_ratio: "custom",
        output_template: "custom",
        custom_ratio: customRatio,
      },
      width,
      height,
    );

    expect(crop.width).toBeGreaterThanOrEqual(0.02);
    expect(crop.height).toBeGreaterThanOrEqual(0.02);
    expect((crop.width * width) / (crop.height * height)).toBeCloseTo(
      customRatio.width / customRatio.height,
    );
  });
});
