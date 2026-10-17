/**
 * Descriptive, model-independent measurements of gamma-encoded sRGB pixels.
 * These are pixel statistics, not exposure correctness or aesthetic scores.
 */
export const IMAGE_ANALYSIS_VERSION = "pixel-v1";
export const BRIGHTNESS_BIN_COUNT = 32;
export const HUE_BIN_COUNT = 12;

export interface PixelAnalysis {
  version: typeof IMAGE_ANALYSIS_VERSION;
  sampleWidth: number;
  sampleHeight: number;
  sampledPixels: number;
  visibleWeight: number;
  transparentFraction: number;
  meanBrightness: number | null;
  brightnessHistogram: number[];
  darkFraction: number;
  lightFraction: number;
  hueHistogram: number[];
  chromaticFraction: number;
  palette: Array<{ hex: string; rgb: [number, number, number]; fraction: number }>;
}

export interface PixelAnalysisAggregate {
  version: typeof IMAGE_ANALYSIS_VERSION;
  /** Includes fully transparent images, which have no visible color statistics. */
  imageCount: number;
  visibleImageCount: number;
  meanBrightness: number | null;
  brightnessHistogram: number[];
  darkFraction: number;
  lightFraction: number;
  hueHistogram: number[];
  chromaticFraction: number;
  palette: PixelAnalysis["palette"];
}

type Rgb = [number, number, number];
interface ColorBin {
  key: number;
  weight: number;
  sums: Rgb;
}
interface ColorPoint {
  key: number;
  weight: number;
  rgb: Rgb;
}

const MAX_PALETTE_COLORS = 5;
const SEED_DISTANCE_SQUARED = 32 ** 2;
const MERGE_DISTANCE_SQUARED = 24 ** 2;
const KMEANS_ITERATIONS = 12;

function rgbDistanceSquared(a: Rgb, b: Rgb): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function addColor(bins: Map<number, ColorBin>, rgb: Rgb, weight: number): void {
  if (weight <= 0) return;
  // Fixed 4-bit/channel buckets bound clustering work to at most 4096 points.
  const key = (Math.floor(rgb[0] / 16) << 8)
    | (Math.floor(rgb[1] / 16) << 4)
    | Math.floor(rgb[2] / 16);
  let bin = bins.get(key);
  if (!bin) {
    bin = { key, weight: 0, sums: [0, 0, 0] };
    bins.set(key, bin);
  }
  bin.weight += weight;
  bin.sums[0] += rgb[0] * weight;
  bin.sums[1] += rgb[1] * weight;
  bin.sums[2] += rgb[2] * weight;
}

function assignColors(points: ColorPoint[], centers: Rgb[]): ColorPoint[] {
  const clusters = centers.map((rgb, key): ColorBin => ({ key, weight: 0, sums: [0, 0, 0] }));
  for (const point of points) {
    let closest = 0;
    let distance = Infinity;
    centers.forEach((center, index) => {
      const nextDistance = rgbDistanceSquared(point.rgb, center);
      if (nextDistance < distance) {
        distance = nextDistance;
        closest = index;
      }
    });
    const cluster = clusters[closest];
    cluster.weight += point.weight;
    cluster.sums[0] += point.rgb[0] * point.weight;
    cluster.sums[1] += point.rgb[1] * point.weight;
    cluster.sums[2] += point.rgb[2] * point.weight;
  }
  return clusters.filter((cluster) => cluster.weight > 0).map((cluster) => ({
    key: cluster.key,
    weight: cluster.weight,
    rgb: cluster.sums.map((value) => value / cluster.weight) as Rgb,
  }));
}

function extractPalette(bins: Map<number, ColorBin>): PixelAnalysis["palette"] {
  const points = [...bins.values()].sort((a, b) => a.key - b.key).map((bin): ColorPoint => ({
    key: bin.key,
    weight: bin.weight,
    rgb: bin.sums.map((value) => value / bin.weight) as Rgb,
  }));
  if (!points.length) return [];

  // A fixed starting color and weighted farthest-point seeds avoid random runs.
  const first = points.reduce((best, point) => point.weight > best.weight ? point : best);
  let centers: Rgb[] = [first.rgb];
  while (centers.length < MAX_PALETTE_COLORS) {
    let next: ColorPoint | undefined;
    let bestScore = -1;
    for (const point of points) {
      const distance = Math.min(...centers.map((center) => rgbDistanceSquared(point.rgb, center)));
      if (distance <= SEED_DISTANCE_SQUARED) continue;
      const score = distance * point.weight;
      if (score > bestScore) {
        next = point;
        bestScore = score;
      }
    }
    if (!next) break;
    centers.push(next.rgb);
  }

  let clusters: ColorPoint[] = [];
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
    clusters = assignColors(points, centers);
    const nextCenters = clusters.map((cluster) => cluster.rgb);
    const unchanged = nextCenters.length === centers.length
      && nextCenters.every((center, index) => rgbDistanceSquared(center, centers[index]) < 0.01);
    centers = nextCenters;
    if (unchanged) break;
  }

  // Do not present five almost-identical swatches for a nearly uniform image.
  while (clusters.length > 1) {
    let pair: [number, number] | undefined;
    let nearest = MERGE_DISTANCE_SQUARED;
    for (let firstIndex = 0; firstIndex < clusters.length; firstIndex++) {
      for (let secondIndex = firstIndex + 1; secondIndex < clusters.length; secondIndex++) {
        const distance = rgbDistanceSquared(clusters[firstIndex].rgb, clusters[secondIndex].rgb);
        if (distance < nearest) {
          nearest = distance;
          pair = [firstIndex, secondIndex];
        }
      }
    }
    if (!pair) break;
    const [firstIndex, secondIndex] = pair;
    const firstCluster = clusters[firstIndex];
    const secondCluster = clusters[secondIndex];
    const weight = firstCluster.weight + secondCluster.weight;
    clusters[firstIndex] = {
      key: firstCluster.key,
      weight,
      rgb: firstCluster.rgb.map((value, channel) => (
        value * firstCluster.weight + secondCluster.rgb[channel] * secondCluster.weight
      ) / weight) as Rgb,
    };
    clusters.splice(secondIndex, 1);
  }

  const totalWeight = clusters.reduce((total, cluster) => total + cluster.weight, 0);
  return clusters.map((cluster) => {
    const rgb = cluster.rgb.map((channel) => Math.round(channel)) as Rgb;
    return {
      hex: `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
      rgb,
      fraction: cluster.weight / totalWeight,
    };
  }).sort((a, b) => Math.abs(b.fraction - a.fraction) > 1e-12
    ? b.fraction - a.fraction
    : a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0);
}

/**
 * Analyze an already sampled RGBA image. Alpha is a fractional visible weight:
 * invisible pixels do not influence brightness, hue, or the palette.
 * Dimensions describe this pixel buffer, not the original photograph.
 */
export function analyzePixels(rgba: Uint8ClampedArray, width: number, height: number): PixelAnalysis {
  if (!(rgba instanceof Uint8ClampedArray)) throw new TypeError("Expected a Uint8ClampedArray pixel buffer.");
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0 || !Number.isSafeInteger(width * height * 4)) {
    throw new RangeError("Sample dimensions must be positive, safe integers.");
  }
  const sampledPixels = width * height;
  if (rgba.length !== sampledPixels * 4) throw new RangeError("Pixel buffer length does not match sample dimensions.");

  const brightnessHistogram = Array<number>(BRIGHTNESS_BIN_COUNT).fill(0);
  const hueHistogram = Array<number>(HUE_BIN_COUNT).fill(0);
  const bins = new Map<number, ColorBin>();
  let visibleWeight = 0;
  let brightnessSum = 0;
  let darkWeight = 0;
  let lightWeight = 0;
  let chromaticWeight = 0;

  for (let offset = 0; offset < rgba.length; offset += 4) {
    const weight = rgba[offset + 3] / 255;
    if (weight === 0) continue;
    const red = rgba[offset];
    const green = rgba[offset + 1];
    const blue = rgba[offset + 2];
    // Algebraically equivalent weights, while keeping exact gray levels exact
    // at thresholds (e.g. gray 239 must not become 238.99999999999997).
    const brightness = green + 0.2126 * (red - green) + 0.0722 * (blue - green);
    visibleWeight += weight;
    brightnessSum += brightness * weight;
    brightnessHistogram[Math.min(BRIGHTNESS_BIN_COUNT - 1, Math.floor(brightness / 8))] += weight;
    if (brightness <= 16) darkWeight += weight;
    if (brightness >= 239) lightWeight += weight;
    addColor(bins, [red, green, blue], weight);

    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const difference = maximum - minimum;
    if (maximum / 255 < 0.1 || difference / maximum < 0.15 || difference === 0) continue;
    let hue: number;
    if (maximum === red) hue = ((green - blue) / difference) % 6;
    else if (maximum === green) hue = (blue - red) / difference + 2;
    else hue = (red - green) / difference + 4;
    const degrees = ((hue * 60) + 360) % 360;
    hueHistogram[Math.floor(degrees / 30)] += weight;
    chromaticWeight += weight;
  }

  return {
    version: IMAGE_ANALYSIS_VERSION,
    sampleWidth: width,
    sampleHeight: height,
    sampledPixels,
    visibleWeight,
    transparentFraction: Math.max(0, Math.min(1, 1 - visibleWeight / sampledPixels)),
    meanBrightness: visibleWeight ? brightnessSum / visibleWeight : null,
    brightnessHistogram: brightnessHistogram.map((weight) => visibleWeight ? weight / visibleWeight : 0),
    darkFraction: visibleWeight ? darkWeight / visibleWeight : 0,
    lightFraction: visibleWeight ? lightWeight / visibleWeight : 0,
    hueHistogram: hueHistogram.map((weight) => chromaticWeight ? weight / chromaticWeight : 0),
    chromaticFraction: visibleWeight ? chromaticWeight / visibleWeight : 0,
    palette: extractPalette(bins),
  };
}

/**
 * Aggregate archived photographs, giving each visible photograph equal weight,
 * irrespective of resolution. Hue is conditional on chromatic pixels: a gray
 * photograph must not invent a hue or outweigh a photograph's colorful area.
 * Palette aggregation summarizes each photograph's extracted palette, not its
 * original pixels, and is therefore an approximation.
 */
export function aggregatePixelAnalyses(analyses: readonly PixelAnalysis[]): PixelAnalysisAggregate {
  if (analyses.some((analysis) => analysis.version !== IMAGE_ANALYSIS_VERSION)) {
    throw new TypeError("Cannot aggregate a different image-analysis version.");
  }
  const visible = analyses.filter((analysis) => analysis.visibleWeight > 0 && analysis.meanBrightness !== null);
  const brightnessHistogram = Array<number>(BRIGHTNESS_BIN_COUNT).fill(0);
  const hueHistogram = Array<number>(HUE_BIN_COUNT).fill(0);
  const bins = new Map<number, ColorBin>();
  let brightnessSum = 0;
  let darkSum = 0;
  let lightSum = 0;
  let chromaticSum = 0;
  for (const analysis of visible) {
    brightnessSum += analysis.meanBrightness!;
    darkSum += analysis.darkFraction;
    lightSum += analysis.lightFraction;
    chromaticSum += analysis.chromaticFraction;
    for (let index = 0; index < BRIGHTNESS_BIN_COUNT; index++) {
      brightnessHistogram[index] += analysis.brightnessHistogram[index];
    }
    for (let index = 0; index < HUE_BIN_COUNT; index++) {
      hueHistogram[index] += analysis.hueHistogram[index] * analysis.chromaticFraction;
    }
    for (const color of analysis.palette) addColor(bins, color.rgb, color.fraction);
  }
  const count = visible.length;
  return {
    version: IMAGE_ANALYSIS_VERSION,
    imageCount: analyses.length,
    visibleImageCount: count,
    meanBrightness: count ? brightnessSum / count : null,
    brightnessHistogram: brightnessHistogram.map((value) => count ? value / count : 0),
    darkFraction: count ? darkSum / count : 0,
    lightFraction: count ? lightSum / count : 0,
    hueHistogram: hueHistogram.map((value) => chromaticSum ? value / chromaticSum : 0),
    chromaticFraction: count ? chromaticSum / count : 0,
    palette: extractPalette(bins),
  };
}
