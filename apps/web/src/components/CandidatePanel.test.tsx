import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CropCandidate } from "../types";
import { CandidatePanel } from "./CandidatePanel";

const candidates: CropCandidate[] = [
  { id: "balanced", crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } },
  { id: "subject", crop: { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } },
  { id: "story", crop: { x: 0.01, y: 0.01, width: 0.98, height: 0.98 } },
];

describe("CandidatePanel", () => {
  it("shows the selected direction and keeps alternatives collapsed initially", () => {
    const markup = renderToStaticMarkup(
      <CandidatePanel
        imageUrl="data:image/png;base64,AA=="
        candidates={candidates}
        selectedCandidateId="subject"
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("当前方案：主体优先");
    expect(markup).toContain("查看其他 2 个构图");
    expect(markup).not.toContain("环境叙事");
  });

  it("falls back to the first candidate when no selection is recorded", () => {
    const markup = renderToStaticMarkup(
      <CandidatePanel
        imageUrl="data:image/png;base64,AA=="
        candidates={candidates}
        selectedCandidateId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("当前方案：平衡构图");
  });

  it("does not attribute fixed pregenerated candidates to AI", () => {
    const markup = renderToStaticMarkup(
      <CandidatePanel
        imageUrl="data:image/png;base64,AA=="
        candidates={candidates}
        selectedCandidateId="balanced"
        pregenerated
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain("本地固定示例，未调用模型");
    expect(markup).not.toContain("AI 已按此偏好独立生成");
  });

  it("offers the first persistent reference for explicit adoption without pretending it is selected", () => {
    const onSelect = vi.fn();
    const markup = renderToStaticMarkup(
      <CandidatePanel imageUrl="/original.jpg" candidates={candidates} selectedCandidateId={null}
        referenceOnly onSelect={onSelect} />,
    );
    expect(markup).toContain('aria-label="构图参考：平衡构图"');
    expect(markup).toContain("参考方向");
    expect(markup).toContain('aria-label="采用构图参考：平衡构图"');
    expect(markup).toContain("采用此构图参考");
    expect(markup).toContain("主动采用才会改变取景");
    expect(markup).toContain("查看其他 2 个构图");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("当前方案");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ["balanced", "平衡构图"], ["subject", "主体优先"], ["story", "环境叙事"],
  ] as const)("keeps the featured %s reference adoptable even when an old selection id exists", (id, name) => {
    const markup = renderToStaticMarkup(
      <CandidatePanel imageUrl="/original.jpg" candidates={candidates} selectedCandidateId={id}
        referenceOnly onSelect={vi.fn()} />,
    );
    expect(markup).toContain(`aria-label="构图参考：${name}"`);
    const adoptionButton = (markup.match(/<button\b[^>]*>/g) || [])
      .find((button) => button.includes(`aria-label="采用构图参考：${name}"`));
    expect(adoptionButton).toBeTruthy();
    expect(adoptionButton).not.toContain('disabled=""');
    expect(markup).not.toContain("当前方案");
    expect(markup).toContain("查看其他 2 个构图");
  });

  it("disables both adopting the featured reference and expanding alternatives while locked", () => {
    const markup = renderToStaticMarkup(
      <CandidatePanel imageUrl="/original.jpg" candidates={candidates} selectedCandidateId={null}
        referenceOnly disabled onSelect={vi.fn()} />,
    );
    const buttons = markup.match(/<button\b[^>]*>/g) || [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
  });

  it("does not add reference adoption controls to the default fixed-sample experience", () => {
    const markup = renderToStaticMarkup(
      <CandidatePanel imageUrl="/sample.jpg" candidates={candidates} selectedCandidateId="balanced"
        pregenerated onSelect={vi.fn()} />,
    );
    expect(markup).toContain("当前方案：平衡构图");
    expect(markup).not.toContain("采用此构图参考");
    expect(markup).not.toContain("主动采用才会改变取景");
  });
});
