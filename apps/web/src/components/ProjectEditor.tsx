import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { ApiError, downloadArtifact } from "../api";
import { cropEquals, normalizedAspectRatio } from "../lib/crop";
import type { CropCandidate } from "../types";
import { analyzeProject, archiveProject, getProject, projectToJob, saveProject } from "../workspaceApi";
import type { ProjectDetail, ProjectDraft } from "../workspaceApi";
import { Workbench } from "./Workbench";
import "./project-editor.css";

export interface ProjectEditorHandle { flush: () => Promise<void>; isDirty: () => boolean }
interface Props {
  initial: ProjectDetail; active: boolean; authenticated: boolean;
  onSaved: (project: ProjectDetail) => void; onStatus: (status: string) => void;
  onAuthExpired: () => void; onNewCreation: () => void;
}
const TERMINAL = new Set(["succeeded", "failed", "expired", "cancelled"]);
const message = (error: unknown) => error instanceof Error ? error.message : "暂时无法保存，请重试。";

export const ProjectEditor = forwardRef<ProjectEditorHandle, Props>(function ProjectEditor({
  initial, active, authenticated, onSaved, onStatus, onAuthExpired, onNewCreation,
}, ref) {
  const projectRef = useRef(initial);
  const [project, setProject] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [title, setTitle] = useState(initial.title);
  const latest = useRef({ draft: initial.draft, title: initial.title });
  const editSequence = useRef(0);
  const savedSequence = useRef(0);
  const [sequence, setSequence] = useState(0);
  const [saveTick, setSaveTick] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "pending" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const conflict = useRef(false);
  const inFlight = useRef<Promise<ProjectDetail> | null>(null);
  const alive = useRef(true);
  const [operation, setOperation] = useState<"save" | "archive" | "download" | "reload" | null>(null);
  const action = useRef(false);
  const guides = draft.guides ?? ["thirds"];
  const [activeJobId, setActiveJobId] = useState(initial.active_job_id);
  const [analysisStarting, setAnalysisStarting] = useState(false);
  const analysisRequest = useRef(false);
  const [analysisMessage, setAnalysisMessage] = useState("");

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const failure = useCallback((caught: unknown) => {
    if (!alive.current) return;
    setError(message(caught));
    setSaveState("error");
    if (caught instanceof ApiError && caught.status === 409) conflict.current = true;
    if (caught instanceof ApiError && caught.status === 401) onAuthExpired();
  }, [onAuthExpired]);

  const saveOnce = useCallback(async (): Promise<ProjectDetail> => {
    if (inFlight.current) return inFlight.current;
    if (editSequence.current === savedSequence.current) return projectRef.current;
    if (conflict.current) throw new ApiError(409, "另一个会话更新了作品，当前调整仍保留。请先重新载入服务器版本。");
    const snapshot = { ...latest.current, sequence: editSequence.current };
    if (!snapshot.title.trim()) throw new Error("作品名称不能为空，请先填写名称。");
    setSaveState("saving");
    const request = saveProject(projectRef.current.id, projectRef.current.revision, snapshot.draft, snapshot.title.trim());
    inFlight.current = request;
    try {
      const updated = await request;
      if (alive.current) {
        projectRef.current = updated;
        savedSequence.current = snapshot.sequence;
        setProject(updated);
        setError("");
        setSaveState(editSequence.current === savedSequence.current ? "saved" : "pending");
        onSaved(updated);
      }
      return updated;
    } finally {
      if (inFlight.current === request) inFlight.current = null;
      if (alive.current) setSaveTick(value => value + 1);
    }
  }, [onSaved]);

  const flush = useCallback(async () => {
    if (!authenticated) throw new Error("请重新登录后保存，当前调整仍保留。");
    if (inFlight.current) await inFlight.current;
    while (editSequence.current !== savedSequence.current) await saveOnce();
  }, [authenticated, saveOnce]);
  useImperativeHandle(ref, () => ({ flush, isDirty: () => editSequence.current !== savedSequence.current }), [flush]);

  useEffect(() => {
    if (authenticated && !conflict.current && editSequence.current !== savedSequence.current) setSaveState("pending");
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated || saveState === "error" || editSequence.current === savedSequence.current || conflict.current) return;
    const timer = window.setTimeout(() => { void saveOnce().catch(failure); }, 900);
    return () => window.clearTimeout(timer);
  }, [authenticated, sequence, saveTick, saveState, saveOnce, failure]);
  useEffect(() => {
    if (editSequence.current === savedSequence.current) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sequence, saveState]);

  useEffect(() => {
    if (!activeJobId || !authenticated) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        while (!controller.signal.aborted) {
          const fresh = await getProject(initial.id, controller.signal);
          if (controller.signal.aborted) return;
          // AI refreshes its own reference only; it cannot adopt another writer's
          // draft/revision or overwrite edits made while the request was running.
          const merged = { ...projectRef.current, reference: fresh.reference, active_job_id: fresh.active_job_id };
          projectRef.current = merged;
          setProject(merged);
          const reference = fresh.reference;
          if (reference?.job_id === activeJobId && TERMINAL.has(reference.status)) {
            setActiveJobId(null);
            setAnalysisMessage(reference.status === "succeeded"
              ? "新参考已就绪。主动选择候选才会改变取景，当前草稿未被覆盖。"
              : "本次 AI 参考未完成，作品保存与手动精修仍可使用。");
            return;
          }
          setAnalysisMessage("AI 参考正在生成，你可以继续精修。新结果不会覆盖当前草稿。");
          await new Promise<void>(resolve => {
            const timer = window.setTimeout(done, 1500);
            function done() { window.clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); }
            controller.signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch (caught) {
        if (controller.signal.aborted || !alive.current) return;
        setAnalysisMessage(`暂时无法查询参考：${message(caught)}。点击“获取 AI 构图参考”可恢复查询。`);
        if (caught instanceof ApiError && caught.status === 401) onAuthExpired();
        setActiveJobId(null);
      }
    };
    void poll();
    return () => controller.abort();
  }, [activeJobId, authenticated, initial.id, onAuthExpired]);

  const edit = (next: ProjectDraft, nextTitle = latest.current.title) => {
    if (!authenticated || !active || action.current) return;
    latest.current = { draft: next, title: nextTitle };
    editSequence.current += 1;
    setSequence(editSequence.current);
    setDraft(next);
    setTitle(nextTitle);
    setSaveState("pending");
    if (!conflict.current) setError("");
  };
  const perform = async (kind: "save" | "archive" | "download") => {
    if (action.current || !authenticated) return;
    action.current = true;
    setOperation(kind);
    try {
      await flush();
      if (kind === "archive") {
        const updated = await archiveProject(projectRef.current.id, projectRef.current.revision);
        if (!alive.current) return;
        projectRef.current = updated;
        setProject(updated);
        onSaved(updated);
      } else if (kind === "download") {
        const current = projectRef.current;
        await downloadArtifact(`${current.crop_url}${current.crop_url.includes("?") ? "&" : "?"}revision=${current.revision}`, "", `SmartCrop_${current.id.slice(0, 8)}`);
      }
      if (alive.current) {
        setError(""); setSaveState("saved");
        if (kind === "archive") setAnalysisMessage("当前成片已归档。继续精修会保存为草稿，不会悄悄替换归档版本。");
      }
    } catch (caught) { failure(caught); }
    finally { action.current = false; if (alive.current) setOperation(null); }
  };
  const runAnalysis = async () => {
    if (analysisRequest.current || action.current || activeJobId || !authenticated) return;
    analysisRequest.current = true; setAnalysisStarting(true);
    try {
      const job = await analyzeProject(initial.id);
      if (alive.current) setActiveJobId(job.id);
    } catch (caught) {
      if (alive.current) {
        setAnalysisMessage(`无法启动 AI 参考：${message(caught)}`);
        if (caught instanceof ApiError && caught.status === 401) onAuthExpired();
      }
    } finally { analysisRequest.current = false; if (alive.current) setAnalysisStarting(false); }
  };
  const reload = async () => {
    if (action.current || !authenticated) return;
    if (!window.confirm("重新载入会放弃尚未保存的本地调整，改用服务器当前草稿。是否继续？")) return;
    action.current = true;
    setOperation("reload");
    try {
      if (inFlight.current) await inFlight.current.catch(() => undefined);
      const fresh = await getProject(initial.id);
      if (!alive.current) return;
      projectRef.current = fresh; latest.current = { draft: fresh.draft, title: fresh.title };
      savedSequence.current = editSequence.current;
      conflict.current = false; setProject(fresh); setDraft(fresh.draft); setTitle(fresh.title);
      setError(""); setSaveState("saved"); onSaved(fresh);
    } catch (caught) { failure(caught); }
    finally { action.current = false; if (alive.current) setOperation(null); }
  };
  const dirty = editSequence.current !== savedSequence.current;
  const status = !authenticated ? "登录已过期，当前调整尚未保存"
    : saveState === "error" ? (dirty ? "保存失败，当前调整仍保留" : "操作未完成，草稿已保存")
      : saveState === "saving" ? "正在保存草稿" : dirty ? "有更新待保存" : "草稿已保存";
  useEffect(() => onStatus(status), [status, onStatus]);
  const job = projectToJob(project);
  const select = (candidate: CropCandidate) => {
    if (!authenticated || !active || action.current) return false;
    if (!cropEquals(latest.current.draft.crop, candidate.crop)
      && !window.confirm("采用这个参考会替换当前草稿的取景框，已归档成片不受影响。是否继续？")) return false;
    edit({ ...latest.current.draft, crop: candidate.crop, selected_candidate_id: candidate.id,
      reference_job_id: project.reference?.job_id || null, selection_explicit: true });
    return true;
  };
  return (
    <>
      <div className="project-name-row"><label>作品名称<input value={title} maxLength={120}
        disabled={!active || !authenticated || !!operation} onChange={event => edit(latest.current.draft, event.target.value)} /></label>
        <span role="status">{project.published ? `已归档 · 版本 ${project.published.version}` : "独立作品草稿"}</span></div>
      {error && <div className="project-save-error" role="alert"><p>{error}</p><button type="button" onClick={() => void reload()} disabled={!!operation}>重新载入服务器版本</button></div>}
      <Workbench job={job} draftCrop={draft.crop} sourceUrl={project.original_url} provenance="upload" guides={guides}
        analysisEnabled={active && authenticated}
        selectedCandidateId={draft.selected_candidate_id} busy={!!operation} activity={operation === "archive" ? "save" : operation === "reload" ? null : operation}
        cropDirty={dirty} hasPendingChanges={dirty} confirmationPending={false}
        editingLocked={!active || !authenticated || !!operation} jobExpired={false} manualOnly={!job.report}
        aspectRatio={normalizedAspectRatio(project.intent.aspect_ratio, project.image_width, project.image_height, project.intent.custom_ratio)}
        reportScopeChanged={!!job.ai_crop && !cropEquals(job.ai_crop, draft.crop)}
        onReset={onNewCreation} onSave={() => void perform("save")} onDownload={() => void perform("download")}
        onCropChange={crop => edit({ ...latest.current.draft, crop })} onSelectCandidate={select}
        onRestoreSuggestion={() => { const candidate = job.candidates.find(item => job.ai_crop && cropEquals(item.crop, job.ai_crop)); if (candidate) select(candidate); }}
        onToggleGuide={guide => {
          const current = latest.current.draft.guides ?? ["thirds"];
          edit({ ...latest.current.draft, guides: current.includes(guide) ? current.filter(item => item !== guide) : [...current, guide] });
        }}
        selectionReasons={draft.selection_reasons} selectionNote={draft.selection_note || ""}
        onReasonsChange={selection_reasons => edit({ ...latest.current.draft, selection_reasons })}
        onNoteChange={selection_note => edit({ ...latest.current.draft, selection_note })}
        persistence={{ title: project.title, state: project.state, hasDraftChanges: project.has_draft_changes, saveStatus: status,
          archiving: operation === "archive", analysisBusy: !!activeJobId || analysisStarting, analysisMessage,
          onArchive: () => void perform("archive"), onAnalyze: () => void runAnalysis() }} />
    </>
  );
});
