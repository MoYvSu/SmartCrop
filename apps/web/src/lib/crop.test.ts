import { describe, expect, it } from "vitest";

import {
  cropEquals,
  fitCropToAspect,
  fitCropToIntent,
  moveCrop,
  normalizedAspectRatio,
  resizeCrop,
  scaleCropAroundCenter,
} from "./crop";
import type { CropHandle } from "./crop";
import type { CropBox } from "../types";

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

const CORNERS = ["nw", "ne", "sw", "se"] as const;

function expectInsideImage(crop: CropBox) {
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.width).toBeGreaterThan(0);
  expect(crop.height).toBeGreaterThan(0);
  expect(crop.x + crop.width).toBeLessThanOrEqual(1 + Number.EPSILON);
  expect(crop.y + crop.height).toBeLessThanOrEqual(1 + Number.EPSILON);
}

function expectOppositeCornerUnchanged(start: CropBox, resized: CropBox, handle: CropHandle) {
  expect(handle.includes("e") ? resized.x : resized.x + resized.width).toBeCloseTo(
    handle.includes("e") ? start.x : start.x + start.width,
    12,
  );
  expect(handle.includes("s") ? resized.y : resized.y + resized.height).toBeCloseTo(
    handle.includes("s") ? start.y : start.y + start.height,
    12,
  );
}

describe("corner resizing", () => {
  const start = { x: 0.25, y: 0.3, width: 0.4, height: 0.2 };

  it.each(CORNERS)("enlarges and shrinks the %s corner using only horizontal movement", (handle) => {
    const outward = handle.includes("e") ? 0.05 : -0.05;
    const enlarged = resizeCrop(start, handle, outward, 0, 2);
    const shrunk = resizeCrop(start, handle, -outward, 0, 2);

    expect(enlarged.width).toBeCloseTo(0.45);
    expect(shrunk.width).toBeCloseTo(0.35);
    for (const resized of [enlarged, shrunk]) {
      expect(resized.width / resized.height).toBeCloseTo(2, 12);
      expectOppositeCornerUnchanged(start, resized, handle);
      expectInsideImage(resized);
    }
  });

  it.each(CORNERS)("enlarges and shrinks the %s corner using only vertical movement", (handle) => {
    const outward = handle.includes("s") ? 0.03 : -0.03;
    const enlarged = resizeCrop(start, handle, 0, outward, 2);
    const shrunk = resizeCrop(start, handle, 0, -outward, 2);

    expect(enlarged.height).toBeCloseTo(0.23);
    expect(shrunk.height).toBeCloseTo(0.17);
    for (const resized of [enlarged, shrunk]) {
      expect(resized.width / resized.height).toBeCloseTo(2, 12);
      expectOppositeCornerUnchanged(start, resized, handle);
      expectInsideImage(resized);
    }
  });

  it.each(CORNERS)("limits %s expansion and contraction without moving the opposite corner", (handle) => {
    const outwardX = handle.includes("e") ? 10 : -10;
    const outwardY = handle.includes("s") ? 10 : -10;
    const enlarged = resizeCrop(start, handle, outwardX, outwardY, 2);
    const shrunk = resizeCrop(start, handle, -outwardX, -outwardY, 2);
    for (const resized of [enlarged, shrunk]) {
      expectInsideImage(resized);
      expect(resized.width / resized.height).toBeCloseTo(2, 12);
      expectOppositeCornerUnchanged(start, resized, handle);
      expect(resized.width).toBeGreaterThanOrEqual(0.02);
      expect(resized.height).toBeGreaterThanOrEqual(0.02);
    }
  });

  it("keeps a valid narrow fixed-ratio crop stable on zero movement and editable on one axis", () => {
    const narrow = { x: 0.49, y: 0.08, width: 0.021, height: 0.84 };
    expect(cropEquals(resizeCrop(narrow, "se", 0, 0, 0.025), narrow)).toBe(true);
    const enlarged = resizeCrop(narrow, "se", 0.01, 0, 0.025);
    const shrunk = resizeCrop(narrow, "se", -0.01, 0, 0.025);
    expect(enlarged.width).toBeGreaterThan(narrow.width);
    expect(shrunk.width).toBeCloseTo(0.02);
    for (const resized of [enlarged, shrunk]) {
      expectInsideImage(resized);
      expect(resized.width / resized.height).toBeCloseTo(0.025, 12);
      expectOppositeCornerUnchanged(narrow, resized, "se");
    }
  });

  it("keeps a valid wide fixed-ratio crop editable below the old eight-percent height minimum", () => {
    const wide = { x: 0.1, y: 0.4, width: 0.8, height: 0.032 };
    const shrunk = resizeCrop(wide, "nw", 0.15, 0, 25);
    expect(shrunk.width).toBeCloseTo(0.65);
    expect(shrunk.height).toBeCloseTo(0.026);
    expectInsideImage(shrunk);
    expectOppositeCornerUnchanged(wide, shrunk, "nw");
  });

  it("does not accumulate ratio drift across repeated keyboard-sized resizes", () => {
    const ratio = 16 / 9 * 1000 / 1600;
    let crop = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 / ratio };
    for (let step = 0; step < 100; step++) {
      crop = resizeCrop(crop, "se", step % 2 ? -0.01 : 0.01, 0, ratio);
      expect(crop.width / crop.height).toBeCloseTo(ratio, 12);
      expectInsideImage(crop);
    }
    expect(crop.width).toBeCloseTo(0.4, 12);
  });

  it("preserves independent freeform axes and the usual interactive minimum", () => {
    const free = { x: 0.1, y: 0.15, width: 0.6, height: 0.4 };
    const resized = resizeCrop(free, "nw", 0.1, 0.02);
    expect(resized.x).toBeCloseTo(0.2);
    expect(resized.y).toBeCloseTo(0.17);
    expect(resized.width).toBeCloseTo(0.5);
    expect(resized.height).toBeCloseTo(0.38);
    const minimum = resizeCrop(free, "se", -10, -10);
    expect(minimum.width).toBeCloseTo(0.08);
    expect(minimum.height).toBeCloseTo(0.08);
  });

  it("does not enlarge a narrow existing freeform dimension when resizing the other axis", () => {
    const narrow = { x: 0.49, y: 0.1, width: 0.02, height: 0.8 };
    const resized = resizeCrop(narrow, "se", 0, 0.01);
    expect(resized.width).toBeCloseTo(0.02);
    expect(resized.height).toBeCloseTo(0.81);
    expectInsideImage(resized);
  });
});

describe("single-click range adjustment", () => {
  it("keeps the center and ratio when space is available", () => {
    const crop = { x: 0.3, y: 0.35, width: 0.4, height: 0.2 };
    for (const scale of [0.95, 1.05]) {
      const resized = scaleCropAroundCenter(crop, scale, 2);
      expect(resized.width).toBeCloseTo(crop.width * scale);
      expect(resized.x + resized.width / 2).toBeCloseTo(crop.x + crop.width / 2);
      expect(resized.y + resized.height / 2).toBeCloseTo(crop.y + crop.height / 2);
      expect(resized.width / resized.height).toBeCloseTo(2, 12);
    }
  });

  it("can enlarge a crop touching the image edge by using the space on the other side", () => {
    const crop = { x: 0.8, y: 0.8, width: 0.2, height: 0.1 };
    const resized = scaleCropAroundCenter(crop, 1.05, 2);
    expect(resized.width).toBeGreaterThan(crop.width);
    expectInsideImage(resized);
    expect(resized.width / resized.height).toBeCloseTo(2, 12);
  });

  it("limits repeated expansion to the image while preserving the requested ratio", () => {
    let crop = { x: 0.3, y: 0.35, width: 0.4, height: 0.2 };
    for (let step = 0; step < 100; step++) crop = scaleCropAroundCenter(crop, 1.05, 2);
    expectInsideImage(crop);
    expect(crop.width).toBeCloseTo(1);
    expect(crop.height).toBeCloseTo(0.5);
  });
});
