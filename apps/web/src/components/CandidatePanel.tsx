import { Check, ChevronDown, Focus, Frame, Trees } from "lucide-react";
import { useState } from "react";

import type { CropCandidate } from "../types";
import { CropPreview } from "./CropPreview";

const COPY = {
  balanced: { name: "平衡构图", note: "兼顾主体、留白与视觉秩序", Icon: Frame },
  subject: { name: "主体优先", note: "收紧画面，让注意力更集中", Icon: Focus },
  story: { name: "环境叙事", note: "保留现场信息与空间关系", Icon: Trees },
};

interface Props {
  imageUrl: string;
  candidates: CropCandidate[];
  selectedCandidateId: CropCandidate["id"] | null;
  pregenerated?: boolean;
  onSelect: (candidate: CropCandidate) => void;
}

export function CandidatePanel({
  imageUrl,
  candidates,
  selectedCandidateId,
  pregenerated = false,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  if (!candidates.length) return null;

  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) || candidates[0];
  const alternatives = candidates.filter((candidate) => candidate.id !== selectedCandidate.id);
  const selectedCopy = COPY[selectedCandidate.id];

  return (
    <section className="candidate-panel" aria-labelledby="candidate-heading">
      <div className="candidate-heading">
        <div>
          <p className="eyebrow">Composition directions</p>
          <h2 id="candidate-heading">先选方向，再做精修</h2>
        </div>
        <span>{pregenerated ? "固定示例方向，由你决定" : "AI 提供方向，由你决定"}</span>
      </div>

      <article className="candidate-current" aria-label={`当前方案：${selectedCopy.name}`}>
        <span className="candidate-preview candidate-preview-current">
          <CropPreview imageUrl={imageUrl} crop={selectedCandidate.crop} />
        </span>
        <span className="candidate-copy">
          <span className="candidate-state"><Check size={14} aria-hidden="true" />当前方案</span>
          <strong><selectedCopy.Icon size={17} aria-hidden="true" />{selectedCopy.name}</strong>
          <small>
            {selectedCopy.note}。
            {pregenerated ? "本地固定示例，未调用模型。" : "AI 已按此偏好独立生成。"}
          </small>
        </span>
      </article>

      {alternatives.length > 0 && <button
        type="button"
        className="candidate-toggle"
        aria-expanded={expanded}
        aria-controls="candidate-alternatives"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "收起其他构图" : `查看其他 ${alternatives.length} 个构图`}
        <ChevronDown className={expanded ? "is-expanded" : ""} size={17} aria-hidden="true" />
      </button>}

      {expanded && <div className="candidate-grid candidate-alternatives" id="candidate-alternatives">
        {alternatives.map((candidate) => {
          const { name, note, Icon } = COPY[candidate.id];
          return (
            <button
              type="button"
              key={candidate.id}
              className="candidate-card"
              onClick={() => {
                onSelect(candidate);
                setExpanded(false);
              }}
            >
              <span className="candidate-preview"><CropPreview imageUrl={imageUrl} crop={candidate.crop} /></span>
              <span className="candidate-copy">
                <strong><Icon size={16} aria-hidden="true" />{name}</strong>
                <small>{note}</small>
              </span>
            </button>
          );
        })}
      </div>}
    </section>
  );
}
