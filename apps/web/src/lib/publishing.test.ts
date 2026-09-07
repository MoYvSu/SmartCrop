import { describe, expect, it } from "vitest";

import {
  createAnalysisIntent,
  intentRatioLabel,
  isCustomRatioValid,
} from "./publishing";

describe("publishing presets", () => {
  it("maps an avatar template to a square intent", () => {
    const intent = createAnalysisIntent("portrait", "avatar", { width: 4, height: 3 });

    expect(intent).toEqual({
      scene: "portrait",
      aspect_ratio: "1:1",
      output_template: "avatar",
      custom_ratio: null,
    });
  });

  it("preserves a custom ratio in the intent and label", () => {
    const intent = createAnalysisIntent("general", "custom", { width: 7, height: 5 });

    expect(intentRatioLabel(intent)).toBe("7:5");
    expect(intent.custom_ratio).toEqual({ width: 7, height: 5 });
  });

  it.each([
    ["freeform", "free"],
    ["avatar", "1:1"],
    ["social_cover", "16:9"],
    ["product_main", "4:5"],
    ["presentation", "16:9"],
  ] as const)("maps %s to %s", (template, aspectRatio) => {
    expect(createAnalysisIntent("general", template, { width: 4, height: 3 }).aspect_ratio)
      .toBe(aspectRatio);
  });

  it("uses the same custom-ratio limits as the API contract", () => {
    expect(isCustomRatioValid({ width: 7, height: 5 })).toBe(true);
    expect(isCustomRatioValid({ width: 1.5, height: 1 })).toBe(false);
    expect(isCustomRatioValid({ width: 101, height: 100 })).toBe(false);
    expect(isCustomRatioValid({ width: 1, height: 11 })).toBe(false);
  });
});
