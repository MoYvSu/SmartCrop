import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { cropEquals, normalizedAspectRatio } from "../lib/crop";
import { createPregeneratedJob, DEMO_IMAGE_URL, downloadDemoCrop } from "../lib/demo";
import type { AnalysisIntent, CompositionGuide, CropCandidate, SelectionReason } from "../types";
import { Workbench } from "./Workbench";

export interface SampleEditorHandle { isDirty: () => boolean }
interface Props { intent: AnalysisIntent; active: boolean; onNewCreation: () => void; onStatus: (status: string) => void }
export const SampleEditor = forwardRef<SampleEditorHandle, Props>(function SampleEditor({ intent, active, onNewCreation, onStatus }, ref) {
  const [job, setJob] = useState(() => createPregeneratedJob(intent));
  const [crop, setCrop] = useState(job.final_crop!);
  const [selected, setSelected] = useState<CropCandidate["id"] | null>(job.selected_candidate_id);
  const [reasons, setReasons] = useState<SelectionReason[]>([]);
  const [note, setNote] = useState("");
  const [guides, setGuides] = useState<CompositionGuide[]>(["thirds"]);
  const [busy, setBusy] = useState(false);
  const action = useRef(false);
  const [error, setError] = useState("");
  const dirty = !cropEquals(crop, job.final_crop!) || selected !== job.selected_candidate_id
    || note.trim() !== (job.selection_note || "") || reasons.join("|") !== job.selection_reasons.join("|");
  useImperativeHandle(ref, () => ({ isDirty: () => dirty }), [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => onStatus(dirty ? "使用样例 · 有未确认调整" : "固定使用样例 · 未调用模型"), [dirty, onStatus]);
  const confirm = () => setJob(current => ({ ...current, final_crop: crop, selected_candidate_id: selected,
    selection_note: note.trim() || null, selection_reasons: reasons, selection_confirmed: true }));
  const select = (candidate: CropCandidate) => {
    if (!active || action.current) return false;
    if (!job.candidates.some(item => cropEquals(item.crop, crop)) && !window.confirm("切换构图方向会替换当前调整，是否继续？")) return false;
    setSelected(candidate.id); setCrop(candidate.crop); return true;
  };
  const download = async () => {
    if (action.current) return;
    action.current = true; setBusy(true); setError("");
    try { confirm(); await downloadDemoCrop(DEMO_IMAGE_URL, crop, "SmartCrop_sample"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "样例下载失败，请重试。"); }
    finally { action.current = false; setBusy(false); }
  };
  return <>
    {error && <p className="field-error" role="alert">{error}</p>}
    <Workbench job={job} draftCrop={crop} sourceUrl={DEMO_IMAGE_URL} provenance="pregenerated" guides={guides}
      analysisEnabled={active}
      selectedCandidateId={selected} busy={busy} activity={busy ? "download" : null} cropDirty={!cropEquals(crop, job.final_crop!)}
      hasPendingChanges={dirty || !job.selection_confirmed} confirmationPending={!job.selection_confirmed}
      editingLocked={!active || busy} jobExpired={false} manualOnly={false}
      aspectRatio={normalizedAspectRatio(intent.aspect_ratio, job.image_width, job.image_height, intent.custom_ratio)}
      reportScopeChanged={!!job.ai_crop && !cropEquals(job.ai_crop, crop)} onReset={onNewCreation} onSave={confirm} onDownload={() => void download()}
      onCropChange={next => { if (active && !action.current) setCrop(next); }} onSelectCandidate={select}
      onRestoreSuggestion={() => { if (job.ai_crop && active && !action.current) { setCrop(job.ai_crop); setSelected(job.candidates[0]?.id || null); } }}
      onToggleGuide={guide => setGuides(current => current.includes(guide) ? current.filter(item => item !== guide) : [...current, guide])}
      selectionReasons={reasons} selectionNote={note} onReasonsChange={setReasons} onNoteChange={setNote} />
  </>;
});
