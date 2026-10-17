/** Fixed editorial descriptions of image colours, not inferred personal traits. */
export type ColorFamily = "black" | "white" | "grey" | "red" | "orange" | "yellow"
  | "green" | "cyan" | "blue" | "purple" | "pink" | "brown";

export interface ColorMood {
  family: ColorFamily;
  name: string;
  description: string;
  text: string;
}

type PaletteColor = { rgb: readonly [number, number, number]; fraction: number };

const MOODS: Record<ColorFamily, readonly [string, string]> = {
  black: ["黑色", "深邃而沉稳"],
  white: ["白色", "明净而轻盈"],
  grey: ["灰色", "克制而安静"],
  red: ["红色", "热烈而鲜明"],
  orange: ["橙色", "温暖而有活力"],
  yellow: ["黄色", "明快而轻松"],
  green: ["绿色", "自然且舒展"],
  cyan: ["青色", "清透而灵动"],
  blue: ["蓝色", "澄澈而宁静"],
  purple: ["紫色", "神秘而浪漫"],
  pink: ["粉色", "柔和而明媚"],
  brown: ["棕色", "温润而质朴"],
};

function colorFamily([red, green, blue]: PaletteColor["rgb"]): ColorFamily {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  const delta = max - min;
  const saturation = max ? delta / max : 0;
  if (max <= 0.2) return "black";
  if (min >= 0.86 && saturation <= 0.12) return "white";
  if (saturation <= 0.14) return "grey";

  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  let hue = max === r ? ((g - b) / delta) % 6
    : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue >= 12 && hue < 50 && max <= 0.68) return "brown";
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 200) return "cyan";
  if (hue < 260) return "blue";
  if (hue < 315) return "purple";
  return "pink";
}

/** Describes the largest real palette swatch, preserving input order on ties. */
export function describePaletteMood(palette: readonly PaletteColor[]): ColorMood | null {
  const dominant = palette.reduce<PaletteColor | null>((current, color) => {
    if (!Number.isFinite(color.fraction) || color.fraction <= 0
      || color.rgb.length !== 3 || color.rgb.some(value => !Number.isFinite(value) || value < 0 || value > 255)) return current;
    return !current || color.fraction > current.fraction ? color : current;
  }, null);
  if (!dominant) return null;
  const family = colorFamily(dominant.rgb);
  const [name, description] = MOODS[family];
  return { family, name, description, text: `${name}，${description}` };
}
