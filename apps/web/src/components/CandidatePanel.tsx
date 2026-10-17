import { Check, ChevronDown, Focus, Frame, Trees } from "lucide-react";
import { useRef, useState } from "react";

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
  referenceOnly?: boolean;
  disabled?: boolean;
  onSelect: (candidate: CropCandidate) => boolean | void;
}

export function CandidatePanel({
  imageUrl,
  candidates,
  selectedCandidateId,
  pregenerated = false,
  referenceOnly = false,
  disabled = false,
  onSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState("");
  if (!candidates.length) return null;

  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) || candidates[0];
  const alternatives = candidates.filter((candidate) => candidate.id !== selectedCandidate.id);
  const selectedCopy = COPY[selectedCandidate.id];
  const chooseCandidate = (candidate: CropCandidate, restoreToggleFocus = false) => {
    if (disabled || onSelect(candidate) === false) return;
    setExpanded(false);
    setAnnouncement(referenceOnly ? `已采用${COPY[candidate.id].name}构图参考。` : `已选择${COPY[candidate.id].name}。`);
    if (restoreToggleFocus) toggleRef.current?.focus({ preventScroll: true });
  };

  return (
    <section className="candidate-panel" aria-labelledby="candidate-heading">
      <div className="candidate-heading">
        <div>
          <p className="eyebrow">Composition directions</p>
          <h2 id="candidate-heading">{referenceOnly ? "选择构图参考" : "需要时切换构图方向"}</h2>
        </div>
        <span>{referenceOnly ? "仅供参考，主动采用才会改变取景" : pregenerated ? "固定示例方向，由你决定" : "AI 提供方向，由你决定"}</span>
      </div>

      <article className="candidate-current" aria-label={`${referenceOnly ? "构图参考" : "当前方案"}：${selectedCopy.name}`}>
        <span className="candidate-preview candidate-preview-current">
          <CropPreview imageUrl={imageUrl} crop={selectedCandidate.crop} />
        </span>
        <span className="candidate-copy">
          <span className="candidate-state">{referenceOnly ? <Frame size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{referenceOnly ? "参考方向" : "当前方案"}</span>
          <strong><selectedCopy.Icon size={17} aria-hidden="true" />{selectedCopy.name}</strong>
          <small>
            {selectedCopy.note}。
            {pregenerated ? "本地固定示例，未调用模型。" : "AI 已按此偏好独立生成。"}
          </small>
          {referenceOnly && <button type="button" className="candidate-toggle" disabled={disabled}
            aria-label={`采用构图参考：${selectedCopy.name}`} onClick={() => chooseCandidate(selectedCandidate)}>
            采用此构图参考
          </button>}
        </span>
      </article>

      {alternatives.length > 0 && <button
        type="button"
        className="candidate-toggle"
        ref={toggleRef}
        disabled={disabled}
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
              disabled={disabled}
              aria-label={referenceOnly ? `采用构图参考：${name}` : undefined}
              onClick={() => chooseCandidate(candidate, true)}
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
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
