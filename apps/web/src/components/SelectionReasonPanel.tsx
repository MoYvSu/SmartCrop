import { MessageSquareText } from "lucide-react";

import type { SelectionReason } from "../types";

const REASONS: Array<{ id: SelectionReason; label: string }> = [
  { id: "subject_emphasis", label: "主体突出" },
  { id: "context_preservation", label: "环境完整" },
  { id: "visual_balance", label: "画面平衡" },
  { id: "platform_fit", label: "适配平台" },
  { id: "other", label: "其他考虑" },
];

interface Props {
  reasons: SelectionReason[];
  note: string;
  onReasonsChange: (reasons: SelectionReason[]) => void;
  onNoteChange: (note: string) => void;
}

export function SelectionReasonPanel({
  reasons,
  note,
  onReasonsChange,
  onNoteChange,
}: Props) {
  const toggle = (reason: SelectionReason) => {
    onReasonsChange(
      reasons.includes(reason)
        ? reasons.filter((candidate) => candidate !== reason)
        : [...reasons, reason],
    );
  };

  return (
    <fieldset className="selection-reason-panel">
      <legend><MessageSquareText aria-hidden="true" size={17} />记录选择依据</legend>
      <p>按需选择一项或多项，内容会随最终方案导出，方便答辩回溯。</p>
      <div className="reason-options">
        {REASONS.map((reason) => (
          <button
            type="button"
            key={reason.id}
            className={reasons.includes(reason.id) ? "reason-chip is-active" : "reason-chip"}
            aria-pressed={reasons.includes(reason.id)}
            onClick={() => toggle(reason.id)}
          >
            {reason.label}
          </button>
        ))}
      </div>
      <label htmlFor="selection-note">补充说明（可选）</label>
      <textarea
        id="selection-note"
        value={note}
        maxLength={200}
        rows={2}
        placeholder="例如：为标题文字保留右侧空间"
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <small>{note.length}/200</small>
    </fieldset>
  );
}
