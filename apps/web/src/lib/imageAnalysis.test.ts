import { describe, expect, it } from "vitest";

import { aggregatePixelAnalyses, analyzePixels, IMAGE_ANALYSIS_VERSION } from "./imageAnalysis";

function pixels(...colors: Array<[number, number, number, number?]>): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flatMap(([red, green, blue, alpha = 255]) => [red, green, blue, alpha]));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

describe("browser-independent pixel analysis", () => {
  it.each([
    [[255, 0, 0], 54.213, 0, "#ff0000"],
    [[0, 255, 0], 182.376, 4, "#00ff00"],
    [[0, 0, 255], 18.411, 8, "#0000ff"],
  ] as const)("measures a pure %j sample without a model", (rgb, mean, hueBin, hex) => {
    const result = analyzePixels(pixels([...rgb]), 1, 1);
    expect(result.version).toBe(IMAGE_ANALYSIS_VERSION);
    expect(result.meanBrightness).toBeCloseTo(mean, 8);
    expect(result.hueHistogram[hueBin]).toBe(1);
    expect(sum(result.hueHistogram)).toBe(1);
    expect(result.palette).toEqual([{ hex, rgb: [...rgb], fraction: 1 }]);
    expect(result.chromaticFraction).toBe(1);
    expect(result.transparentFraction).toBe(0);
  });

  it("keeps all 256 grayscale levels and their normalized brightness bins", () => {
    const values = new Uint8ClampedArray(Array.from({ length: 256 }, (_, index) => [index, index, index, 255]).flat());
    const result = analyzePixels(values, 64, 4);
    expect(result.sampleWidth).toBe(64);
    expect(result.sampleHeight).toBe(4);
    expect(result.sampledPixels).toBe(256);
    expect(result.meanBrightness).toBeCloseTo(127.5);
    expect(sum(result.brightnessHistogram)).toBeCloseTo(1);
    expect(result.darkFraction).toBeCloseTo(17 / 256);
    expect(result.lightFraction).toBeCloseTo(17 / 256);
    expect(result.chromaticFraction).toBe(0);
    expect(result.hueHistogram).toEqual(Array(12).fill(0));
    expect(result.palette.length).toBeLessThanOrEqual(5);
    expect(result.palette.length).toBeGreaterThan(1);
    expect(sum(result.palette.map((color) => color.fraction))).toBeCloseTo(1);
  });

  it("excludes fully transparent pixels from every visible-color measurement", () => {
    const result = analyzePixels(pixels([255, 0, 0], [0, 255, 0, 0], [0, 0, 255, 0]), 3, 1);
    expect(result.visibleWeight).toBe(1);
    expect(result.transparentFraction).toBeCloseTo(2 / 3);
    expect(result.meanBrightness).toBeCloseTo(54.213);
    expect(result.palette).toEqual([{ hex: "#ff0000", rgb: [255, 0, 0], fraction: 1 }]);
    expect(result.hueHistogram[0]).toBe(1);
  });

  it("weights semitransparent pixels instead of flattening them onto a background", () => {
    const result = analyzePixels(pixels([0, 0, 0], [255, 255, 255, 128]), 1, 2);
    const alpha = 128 / 255;
    expect(result.visibleWeight).toBeCloseTo(1 + alpha);
    expect(result.transparentFraction).toBeCloseTo(1 - (1 + alpha) / 2);
    expect(result.meanBrightness).toBeCloseTo(255 * alpha / (1 + alpha));
    expect(result.darkFraction).toBeCloseTo(1 / (1 + alpha));
    expect(result.lightFraction).toBeCloseTo(alpha / (1 + alpha));
    expect(result.palette.find((color) => color.hex === "#000000")?.fraction).toBeCloseTo(1 / (1 + alpha));
    expect(sum(result.brightnessHistogram)).toBeCloseTo(1);
  });

  it("returns explicit absence, not black or a made-up hue, for invisible images", () => {
    const result = analyzePixels(pixels([255, 0, 0, 0], [255, 255, 255, 0]), 2, 1);
    expect(result.visibleWeight).toBe(0);
    expect(result.transparentFraction).toBe(1);
    expect(result.meanBrightness).toBeNull();
    expect(result.brightnessHistogram).toEqual(Array(32).fill(0));
    expect(result.hueHistogram).toEqual(Array(12).fill(0));
    expect(result.darkFraction).toBe(0);
    expect(result.lightFraction).toBe(0);
    expect(result.chromaticFraction).toBe(0);
    expect(result.palette).toEqual([]);
  });

  it("excludes nearly gray and very dark pixels only from hue", () => {
    const result = analyzePixels(pixels([100, 99, 99], [25, 0, 0], [255, 0, 0], [127, 127, 127]), 2, 2);
    expect(result.chromaticFraction).toBe(0.25);
    expect(result.hueHistogram[0]).toBe(1);
    expect(sum(result.brightnessHistogram)).toBeCloseTo(1);
    expect(sum(result.palette.map((color) => color.fraction))).toBeCloseTo(1);
  });

  it("honors the inclusive brightness-region and HSV thresholds", () => {
    const result = analyzePixels(pixels([16, 16, 16], [17, 17, 17], [238, 238, 238], [239, 239, 239]), 4, 1);
    expect(result.darkFraction).toBe(0.25);
    expect(result.lightFraction).toBe(0.25);
    expect(analyzePixels(pixels([200, 170, 170]), 1, 1).chromaticFraction).toBe(1);
    expect(analyzePixels(pixels([200, 171, 171]), 1, 1).chromaticFraction).toBe(0);
    expect(analyzePixels(pixels([26, 0, 0]), 1, 1).chromaticFraction).toBe(1);
  });

  it("wraps red hue across zero degrees without putting it in unrelated bins", () => {
    const result = analyzePixels(pixels([255, 1, 0], [255, 0, 1]), 2, 1);
    expect(result.hueHistogram[0]).toBe(0.5);
    expect(result.hueHistogram[11]).toBe(0.5);
    expect(sum(result.hueHistogram.slice(1, 11))).toBe(0);
  });

  it("keeps pure red, green, and blue separate with stable proportions and ordering", () => {
    const colors: Array<[number, number, number]> = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 0, 0]];
    const result = analyzePixels(pixels(...colors), 4, 1);
    expect(result.palette).toEqual([
      { hex: "#ff0000", rgb: [255, 0, 0], fraction: 0.5 },
      { hex: "#0000ff", rgb: [0, 0, 255], fraction: 0.25 },
      { hex: "#00ff00", rgb: [0, 255, 0], fraction: 0.25 },
    ]);
    expect(analyzePixels(pixels(...[...colors].reverse()), 2, 2).palette).toEqual(result.palette);
  });

  it("does not force nearly identical colors into five swatches", () => {
    const result = analyzePixels(pixels([252, 0, 0], [253, 0, 0], [254, 0, 0], [255, 0, 0]), 4, 1);
    expect(result.palette).toHaveLength(1);
    expect(result.palette[0].fraction).toBe(1);
    expect(result.palette[0].rgb).toEqual([254, 0, 0]);
  });

  it("bounds a varied deterministic sample to five normalized colors", () => {
    const values = new Uint8ClampedArray(Array.from({ length: 900 }, (_, index) => [
      index * 37 % 256, index * 101 % 256, index * 13 % 256, index % 256,
    ]).flat());
    const first = analyzePixels(values, 45, 20);
    expect(first).toEqual(analyzePixels(values, 45, 20));
    expect(first.palette.length).toBeLessThanOrEqual(5);
    expect(sum(first.palette.map((color) => color.fraction))).toBeCloseTo(1);
    expect(sum(first.brightnessHistogram)).toBeCloseTo(1);
    expect(sum(first.hueHistogram)).toBeCloseTo(1);
    for (const color of first.palette) {
      expect(color.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(color.fraction).toBeGreaterThan(0);
      for (const channel of color.rgb) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it.each([
    [0, 1], [1, 0], [-1, 1], [0.5, 2], [1, Number.NaN], [Infinity, 1],
    [Number.MAX_SAFE_INTEGER, 2],
  ])("rejects invalid sample dimensions %s x %s", (width, height) => {
    expect(() => analyzePixels(pixels([0, 0, 0]), width, height)).toThrow(RangeError);
  });

  it("rejects mismatched buffers and incorrectly typed data", () => {
    expect(() => analyzePixels(pixels([0, 0, 0]), 2, 1)).toThrow(RangeError);
    expect(() => analyzePixels(new Uint8ClampedArray(5), 1, 1)).toThrow(RangeError);
    expect(() => analyzePixels(new Uint8Array(4) as unknown as Uint8ClampedArray, 1, 1)).toThrow(TypeError);
  });
});

describe("equal-photograph statistics", () => {
  it("gives differently sized photographs equal weight", () => {
    const black = analyzePixels(pixels([0, 0, 0]), 1, 1);
    const white = analyzePixels(pixels(...Array<[number, number, number]>(12).fill([255, 255, 255])), 4, 3);
    const result = aggregatePixelAnalyses([black, white]);
    expect(result.imageCount).toBe(2);
    expect(result.visibleImageCount).toBe(2);
    expect(result.meanBrightness).toBeCloseTo(127.5);
    expect(result.darkFraction).toBe(0.5);
    expect(result.lightFraction).toBe(0.5);
    expect(result.brightnessHistogram[0]).toBe(0.5);
    expect(result.brightnessHistogram[31]).toBe(0.5);
    expect(result.palette).toEqual([
      { hex: "#000000", rgb: [0, 0, 0], fraction: 0.5 },
      { hex: "#ffffff", rgb: [255, 255, 255], fraction: 0.5 },
    ]);
  });

  it("weights hue by each photograph's chromatic area, not pixel count or gray hue", () => {
    const halfRed = analyzePixels(pixels([255, 0, 0], [128, 128, 128]), 2, 1);
    const blue = analyzePixels(pixels([0, 0, 255]), 1, 1);
    const gray = analyzePixels(pixels([128, 128, 128]), 1, 1);
    const result = aggregatePixelAnalyses([halfRed, blue, gray]);
    expect(result.chromaticFraction).toBe(0.5);
    expect(result.hueHistogram[0]).toBeCloseTo(1 / 3);
    expect(result.hueHistogram[8]).toBeCloseTo(2 / 3);
    expect(sum(result.hueHistogram)).toBeCloseTo(1);
    expect(sum(result.brightnessHistogram)).toBeCloseTo(1);
    expect(sum(result.palette.map((color) => color.fraction))).toBeCloseTo(1);
  });

  it("reports transparent sources without inventing a visible photo", () => {
    const invisible = analyzePixels(pixels([255, 255, 255, 0]), 1, 1);
    const red = analyzePixels(pixels([255, 0, 0]), 1, 1);
    expect(aggregatePixelAnalyses([invisible, red])).toMatchObject({
      imageCount: 2,
      visibleImageCount: 1,
      meanBrightness: red.meanBrightness,
      hueHistogram: red.hueHistogram,
      palette: red.palette,
    });
    for (const result of [aggregatePixelAnalyses([]), aggregatePixelAnalyses([invisible])]) {
      expect(result.visibleImageCount).toBe(0);
      expect(result.meanBrightness).toBeNull();
      expect(result.palette).toEqual([]);
      expect(result.brightnessHistogram).toEqual(Array(32).fill(0));
      expect(result.hueHistogram).toEqual(Array(12).fill(0));
      expect(result.chromaticFraction).toBe(0);
    }
  });

  it("does not mutate source results and uses stable palette order", () => {
    const sources = [[255, 0, 0], [0, 255, 0], [0, 0, 255]].map((rgb) => analyzePixels(pixels(rgb as [number, number, number]), 1, 1));
    const snapshot = structuredClone(sources);
    const first = aggregatePixelAnalyses(sources);
    expect(sources).toEqual(snapshot);
    const reversed = aggregatePixelAnalyses([...sources].reverse());
    expect(reversed.palette).toEqual(first.palette);
    expect(reversed.meanBrightness).toBeCloseTo(first.meanBrightness!, 12);
  });

  it("rejects incompatible cached analysis versions", () => {
    const source = analyzePixels(pixels([0, 0, 0]), 1, 1);
    expect(() => aggregatePixelAnalyses([{ ...source, version: "pixel-v0" as typeof IMAGE_ANALYSIS_VERSION }])).toThrow(TypeError);
  });
});
