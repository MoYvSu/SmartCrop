import { describe, expect, it } from "vitest";

import { describePaletteMood } from "./colorMood";

describe("fixed palette mood copy", () => {
  it.each([
    [[0, 0, 0], "black", "黑色，深邃而沉稳"],
    [[255, 255, 255], "white", "白色，明净而轻盈"],
    [[128, 128, 128], "grey", "灰色，克制而安静"],
    [[255, 0, 0], "red", "红色，热烈而鲜明"],
    [[255, 128, 0], "orange", "橙色，温暖而有活力"],
    [[255, 255, 0], "yellow", "黄色，明快而轻松"],
    [[0, 200, 0], "green", "绿色，自然且舒展"],
    [[0, 200, 200], "cyan", "青色，清透而灵动"],
    [[0, 0, 255], "blue", "蓝色，澄澈而宁静"],
    [[128, 0, 255], "purple", "紫色，神秘而浪漫"],
    [[255, 0, 153], "pink", "粉色，柔和而明媚"],
    [[128, 80, 48], "brown", "棕色，温润而质朴"],
  ] as const)("describes RGB %j using the %s colour family", (rgb, family, text) => {
    expect(describePaletteMood([{ rgb, fraction: 1 }])).toEqual({ family, name: text.split("，")[0], description: text.split("，")[1], text });
  });

  it("uses the dominant fraction rather than sorting or mutating the palette", () => {
    const palette = [
      { rgb: [255, 255, 255] as const, fraction: 0.2 },
      { rgb: [12, 12, 12] as const, fraction: 0.8 },
    ];
    const before = JSON.stringify(palette);
    expect(describePaletteMood(palette)?.family).toBe("black");
    expect(JSON.stringify(palette)).toBe(before);
    expect(describePaletteMood(palette.map(color => ({ ...color, fraction: 0.5 })))?.family).toBe("white");
  });

  it("does not invent a description for an empty or invalid palette", () => {
    expect(describePaletteMood([])).toBeNull();
    expect(describePaletteMood([
      { rgb: [0, 0, 0], fraction: 0 },
      { rgb: [255, 255, 255], fraction: Number.NaN },
      { rgb: [-1, 10, 10], fraction: 1 },
      { rgb: [0, Number.NaN, 0], fraction: 1 },
    ])).toBeNull();
  });

  it("retains neutral descriptions for dark, light and low-saturation shades", () => {
    expect(describePaletteMood([{ rgb: [35, 30, 32], fraction: 1 }])?.family).toBe("black");
    expect(describePaletteMood([{ rgb: [245, 240, 230], fraction: 1 }])?.family).toBe("white");
    expect(describePaletteMood([{ rgb: [120, 125, 123], fraction: 1 }])?.family).toBe("grey");
  });
});
