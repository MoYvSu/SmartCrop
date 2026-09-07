import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { firstPastedImage, UploadPanel } from "./UploadPanel";

describe("UploadPanel", () => {
  it("offers one quiet usage sample entry without presentation-only controls", () => {
    const markup = renderToStaticMarkup(
      <UploadPanel
        accessCode=""
        onAccessCodeChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenPregeneratedDemo={vi.fn()}
        busy={false}
      />,
    );

    expect(markup.match(/查看使用样例/g)).toHaveLength(1);
    expect(markup).toContain('class="sample-link"');
    expect(markup).not.toContain("答辩演示入口");
    expect(markup).not.toContain("载入实时样例");
    expect(markup).not.toContain("预生成导览");
    expect(markup).not.toContain("方案文件");
    expect(markup).toContain("不进入训练集");
    expect(markup).toContain("Ctrl / ⌘ + V 粘贴");
    expect(markup).toContain('aria-live="polite"');
  });

  it("selects the first image from mixed clipboard content", () => {
    const pasted = { name: "clipboard.png" } as File;
    const result = firstPastedImage([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => pasted },
    ]);

    expect(result).toBe(pasted);
  });

  it("ignores clipboard content without an image", () => {
    expect(firstPastedImage([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "string", type: "image/png", getAsFile: () => null },
    ])).toBeNull();
  });
});
