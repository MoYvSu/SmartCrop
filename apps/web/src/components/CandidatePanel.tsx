import { Check, Focus, Frame, Trees } from "lucide-react";

import type { CropBox, CropCandidate } from "../types";
import { cropEquals } from "../lib/crop";
import { CropPreview } from "./CropPreview";

const COPY = {
  balanced: { name: "平衡构图", note: "兼顾主体、留白与视觉秩序", Icon: Frame },
  subject: { name: "主体优先", note: "收紧画面，让注意力更集中", Icon: Focus },
  story: { name: "环境叙事", note: "保留现场信息与空间关系", Icon: Trees },
};

interface Props {
  imageUrl: string;
  candidates: CropCandidate[];
  crop: CropBox;
  onSelect: (candidate: CropCandidate) => void;
}

export function CandidatePanel({ imageUrl, candidates, crop, onSelect }: Props) {
  if (!candidates.length) return null;
  return (
    <section className="candidate-panel" aria-labelledby="candidate-heading">
      <div className="candidate-heading">
        <div>
          <p className="eyebrow">Composition directions</p>
          <h2 id="candidate-heading">先选方向，再做精修</h2>
        </div>
        <span>共 {candidates.length} 个候选</span>
      </div>
      <div className="candidate-grid">
        {candidates.map((candidate) => {
          const { name, note, Icon } = COPY[candidate.id];
          const selected = cropEquals(candidate.crop, crop);
          return (
            <button
              type="button"
              key={candidate.id}
              className={`candidate-card ${selected ? "is-selected" : ""}`}
              onClick={() => onSelect(candidate)}
              aria-pressed={selected}
            >
              <span className="candidate-preview"><CropPreview imageUrl={imageUrl} crop={candidate.crop} /></span>
              <span className="candidate-copy">
                <strong><Icon size={16} aria-hidden="true" />{name}</strong>
                <small>{note}</small>
              </span>
              {selected && <Check className="candidate-check" size={17} aria-label="已选择" />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
