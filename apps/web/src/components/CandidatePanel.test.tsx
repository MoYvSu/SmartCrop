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
});
