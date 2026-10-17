import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { firstPastedImage, UploadPanel } from "./UploadPanel";

describe("UploadPanel", () => {
  it("starts a new import with the saved purpose and custom crop ratio", () => {
    const markup = renderToStaticMarkup(<UploadPanel persistent defaultsRequired defaults={{ revision: 3,
      intent: { scene: "landscape", aspect_ratio: "custom", output_template: "custom", custom_ratio: { width: 3, height: 2 } }, guides: [] }}
      accessCode="" onAccessCodeChange={vi.fn()} onSubmit={vi.fn()} onOpenPregeneratedDemo={vi.fn()} busy={false} />);
    expect(markup).toContain('<option value="landscape" selected="">');
    expect(markup).toContain('<option value="custom" selected="">');
    expect(markup).toContain('value="3"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain("已采用摄影档案中的创作偏好");
  });

  it("offers retry when saved defaults are unavailable rather than pretending to have loaded them", () => {
    const markup = renderToStaticMarkup(<UploadPanel persistent defaultsRequired defaultsError="offline" onRetryDefaults={vi.fn()}
      accessCode="" onAccessCodeChange={vi.fn()} onSubmit={vi.fn()} onOpenPregeneratedDemo={vi.fn()} busy={false} />);
    expect(markup).toContain("重试读取偏好");
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain("已采用摄影档案");
  });
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

  it("uses the same upload tools in a focused workspace layout without repeating the landing page", () => {
    const markup = renderToStaticMarkup(
      <UploadPanel variant="workspace" active={false} mainId="workbench-content"
        accessCode="" onAccessCodeChange={vi.fn()} onSubmit={vi.fn().mockResolvedValue(undefined)}
        onOpenPregeneratedDemo={vi.fn()} busy={false} />,
    );
    expect(markup).toContain('id="workbench-content"');
    expect(markup).not.toContain('id="main-content"');
    expect(markup).toContain("构图工作台</h1>");
    expect(markup).toContain("尚未启用自动归档");
    expect(markup).toContain("开始美学分析");
    expect(markup).toContain('aria-label="选择待裁剪照片"');
    expect(markup).not.toContain('id="inspiration"');
    expect(markup).not.toContain("每一张照片，");
  });

  it("ignores clipboard content without an image", () => {
    expect(firstPastedImage([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "string", type: "image/png", getAsFile: () => null },
    ])).toBeNull();
  });

  it.each(["showcase", "workspace"] as const)("uses persistent import copy without temporary retention or mandatory AI: %s", (variant) => {
    const markup = renderToStaticMarkup(
      <UploadPanel variant={variant} persistent accessCode="" onAccessCodeChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)} onOpenPregeneratedDemo={vi.fn()} busy={false} />,
    );
    expect(markup).toContain("导入并开始创作");
    expect(markup).toContain("登录后存入共用演示账号，保留至主动删除");
    expect(markup).toContain("不进入训练集");
    expect(markup).not.toMatch(/1\s*小时|一小时|临时分析任务|尚未启用自动归档/);
    expect(markup).not.toContain("开始美学分析");
    expect(markup).not.toContain("演示访问码");
    if (variant === "workspace") {
      expect(markup).toContain("不必先运行模型");
      expect(markup).toContain("刷新或重新登录后仍可继续");
    } else {
      expect(markup).toContain("精修，参考按需");
      expect(markup).toContain("需要灵感时，再获取 AI 构图参考");
      expect(markup).toContain("草稿自动保存，完成后归档");
      expect(markup).not.toContain("探索，选择方向");
    }
  });

  it("locks persistent import controls with truthful progress instead of claiming model inference", () => {
    const markup = renderToStaticMarkup(
      <UploadPanel variant="workspace" persistent accessCode="" onAccessCodeChange={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(undefined)} onOpenPregeneratedDemo={vi.fn()} busy />,
    );
    expect(markup).toContain("正在导入");
    expect(markup).not.toContain("正在分析");
    expect(markup).toContain('<fieldset class="intent-fieldset" disabled=""');
    expect(markup).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
  });
});
