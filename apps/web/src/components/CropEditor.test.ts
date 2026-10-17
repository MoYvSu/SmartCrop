import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CropEditor, fitStageSize } from "./CropEditor";

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

describe("CropEditor accessible controls", () => {
  const props = {
    imageUrl: "/test.jpg",
    imageWidth: 1600,
    imageHeight: 1000,
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    onChange: () => undefined,
  };

  it("provides collapsed single-click alternatives for dragging", () => {
    const markup = renderToStaticMarkup(createElement(CropEditor, props));
    expect(markup).toContain('<details class="crop-fine-controls">');
    expect(markup).not.toContain('<details class="crop-fine-controls" open');
    for (const label of ["向左微调", "向上微调", "向下微调", "向右微调", "扩大裁剪范围", "缩小裁剪范围"]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain('tabindex="0"');
  });

  it("removes the crop from keyboard navigation and disables all editing buttons while saving", () => {
    const markup = renderToStaticMarkup(createElement(CropEditor, { ...props, disabled: true }));
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    const buttonTags = markup.match(/<button\b[^>]*>/g) || [];
    expect(buttonTags).toHaveLength(10);
    expect(buttonTags.every((tag) => tag.includes('disabled=""'))).toBe(true);
  });
});
