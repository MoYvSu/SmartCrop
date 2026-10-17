import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SelectionReasonPanel } from "./SelectionReasonPanel";

describe("SelectionReasonPanel", () => {
  it("states that preference notes remain temporary and are not training consent", () => {
    const markup = renderToStaticMarkup(
      <SelectionReasonPanel
        reasons={[]}
        note=""
        onReasonsChange={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );

    expect(markup).toContain("仅随当前任务暂存");
    expect(markup).toContain("本版本不用于模型训练");
    expect(markup).not.toContain("随最终方案导出");
    expect(markup).not.toContain("答辩回溯");
  });

  it("explains that project notes persist without granting training consent", () => {
    const markup = renderToStaticMarkup(<SelectionReasonPanel persistent reasons={[]} note=""
      onReasonsChange={vi.fn()} onNoteChange={vi.fn()} />);
    expect(markup).toContain("说明随作品保存");
    expect(markup).toContain("本版本不用于模型训练");
    expect(markup).not.toContain("仅随当前任务暂存");
  });
});
