import { Check, Download, ImagePlus, LoaderCircle, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError, createJob, downloadArtifact, getJob, updateCrop } from "./api";
import { CandidatePanel } from "./components/CandidatePanel";
import { CompositionTools } from "./components/CompositionTools";
import { CropEditor } from "./components/CropEditor";
import { CropPreview } from "./components/CropPreview";
import { ProcessingPanel } from "./components/ProcessingPanel";
import { ReportPanel } from "./components/ReportPanel";
import { SelectionReasonPanel } from "./components/SelectionReasonPanel";
import { UploadPanel } from "./components/UploadPanel";
import { cropEquals, fitCropToIntent, normalizedAspectRatio } from "./lib/crop";
import { createPregeneratedJob, DEMO_IMAGE_URL, downloadDemoCrop } from "./lib/demo";
import { intentRatioLabel, PUBLICATION_PRESETS } from "./lib/publishing";
import type {
  AnalysisIntent,
  CompositionGuide,
  CropBox,
  CropCandidate,
  JobResponse,
  RunProvenance,
  SelectionReason,
} from "./types";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const DEFAULT_MANUAL_CROP: CropBox = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
type Activity = "analysis" | "save" | "download";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof TypeError) return "网络连接失败，请检查网络和服务后重试。";
  return caught instanceof Error ? caught.message : fallback;
}

export default function App() {
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem("smartcrop-access") || "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [job, setJob] = useState<JobResponse | null>(null);
  const [draftCrop, setDraftCrop] = useState<CropBox | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<CropCandidate["id"] | null>(null);
  const [selectionReasons, setSelectionReasons] = useState<SelectionReason[]>([]);
  const [selectionNote, setSelectionNote] = useState("");
  const [guides, setGuides] = useState<CompositionGuide[]>(["thirds"]);
  const [provenance, setProvenance] = useState<RunProvenance>("upload");
  const [phase, setPhase] = useState<"upload" | "processing" | "result">("upload");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connectionError, setConnectionError] = useState("");
  // A workspace generation rejects late responses even if abort arrives after
  // a request has completed. The controller also locks double-clicks immediately.
  const pollToken = useRef(0);
  const request = useRef<AbortController | null>(null);
  const previousPhase = useRef(phase);
  const busy = activity !== null;

  useEffect(() => {
    sessionStorage.setItem("smartcrop-access", accessCode);
  }, [accessCode]);

  useEffect(() => () => {
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  useEffect(() => () => {
    pollToken.current += 1;
    request.current?.abort();
    request.current = null;
  }, []);

  useEffect(() => {
    if (previousPhase.current === phase) return undefined;
    previousPhase.current = phase;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0 });
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phase]);

  const clearWorkspace = () => {
    pollToken.current += 1;
    request.current?.abort();
    request.current = null;
    setSourceUrl("");
    setJob(null);
    setDraftCrop(null);
    setSelectedCandidateId(null);
    setSelectionReasons([]);
    setSelectionNote("");
    setGuides(["thirds"]);
    setProvenance("upload");
    setError("");
    setNotice("");
    setConnectionError("");
    setActivity(null);
    setPhase("upload");
  };

  const beginOperation = (nextActivity: Activity) => {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    setActivity(nextActivity);
    setError("");
    setNotice("");
    return { token: pollToken.current, controller };
  };

  const isCurrent = (token: number, controller: AbortController) => (
    token === pollToken.current && request.current === controller && !controller.signal.aborted
  );

  const endOperation = (token: number, controller: AbortController) => {
    if (!isCurrent(token, controller)) return;
    request.current = null;
    setActivity(null);
  };

  const finishAnalysis = (current: JobResponse) => {
    setConnectionError("");
    if (current.status === "failed") {
      setDraftCrop(fitCropToIntent(
        DEFAULT_MANUAL_CROP,
        current.intent,
        current.image_width,
        current.image_height,
      ));
      setSelectedCandidateId(null);
      setPhase("result");
      return;
    }
    if (current.status !== "succeeded" || !current.final_crop) {
      setError(current.status === "expired"
        ? "任务已过期，请返回上传页重新选择照片。"
        : current.error?.message || "任务未能完成，请返回上传页重试。");
      return;
    }
    setDraftCrop(current.final_crop);
    setSelectedCandidateId(current.selected_candidate_id || current.candidates[0]?.id || null);
    setSelectionReasons(current.selection_reasons || []);
    setSelectionNote(current.selection_note || "");
    setPhase("result");
  };

  const pollJob = async (initial: JobResponse, token: number, controller: AbortController) => {
    let current = initial;
    while (!TERMINAL.has(current.status)) {
      await sleep(1500);
      if (!isCurrent(token, controller)) return;
      current = await getJob(current.id, accessCode, controller.signal);
      if (!isCurrent(token, controller)) return;
      setJob(current);
    }
    if (isCurrent(token, controller)) finishAnalysis(current);
  };

  const analysisFailed = (caught: unknown, created: JobResponse | null) => {
    if (created) {
      if (caught instanceof ApiError && (caught.status === 404 || caught.status === 410)) {
        setJob((current) => current ? { ...current, status: "expired" } : current);
        setError("任务已过期，请返回上传页重新选择照片。");
        setConnectionError("");
      } else {
        setConnectionError(errorMessage(caught, "暂时无法获取任务状态。"));
      }
      return;
    }
    setError(errorMessage(caught, "提交失败，请稍后重试"));
    setPhase("upload");
  };

  const analyze = async (
    file: File,
    intent: AnalysisIntent,
    runProvenance: RunProvenance,
  ) => {
    if (request.current) return;
    pollToken.current += 1;
    const operation = beginOperation("analysis");
    if (!operation) return;
    const { token, controller } = operation;
    const localUrl = URL.createObjectURL(file);
    setSourceUrl(localUrl);
    setProvenance(runProvenance);
    setJob(null);
    setDraftCrop(null);
    setSelectedCandidateId(null);
    setSelectionReasons([]);
    setSelectionNote("");
    setConnectionError("");
    let created: JobResponse | null = null;
    try {
      created = await createJob(file, intent, accessCode, controller.signal);
      if (!isCurrent(token, controller)) return;
      setJob(created);
      setPhase("processing");
      await pollJob(created, token, controller);
    } catch (caught) {
      if (isCurrent(token, controller)) analysisFailed(caught, created);
    } finally {
      endOperation(token, controller);
    }
  };

  const reconnect = async () => {
    if (!job) return;
    const operation = beginOperation("analysis");
    if (!operation) return;
    const { token, controller } = operation;
    setConnectionError("");
    try {
      const current = await getJob(job.id, accessCode, controller.signal);
      if (!isCurrent(token, controller)) return;
      setJob(current);
      await pollJob(current, token, controller);
    } catch (caught) {
      if (isCurrent(token, controller)) analysisFailed(caught, job);
    } finally {
      endOperation(token, controller);
    }
  };

  const openPregeneratedDemo = (intent: AnalysisIntent) => {
    if (request.current) return;
    pollToken.current += 1;
    const demo = createPregeneratedJob(intent);
    setSourceUrl(DEMO_IMAGE_URL);
    setJob(demo);
    setDraftCrop(demo.final_crop);
    setSelectedCandidateId(demo.selected_candidate_id);
    setSelectionReasons([]);
    setSelectionNote("");
    setGuides(["thirds"]);
    setProvenance("pregenerated");
    setError("");
    setNotice("");
    setConnectionError("");
    setActivity(null);
    setPhase("result");
  };

  const cropDirty = Boolean(
    draftCrop && (!job?.final_crop || !cropEquals(job.final_crop, draftCrop)),
  );
  const selectionDirty = Boolean(
    selectedCandidateId && selectedCandidateId !== job?.selected_candidate_id,
  );
  const reasonDirty = Boolean(
    job && (
      selectionNote.trim() !== (job.selection_note || "")
      || selectionReasons.join("|") !== (job.selection_reasons || []).join("|")
    ),
  );
  const confirmationPending = Boolean(job && !job.selection_confirmed);
  const hasPendingChanges = cropDirty || selectionDirty || reasonDirty || confirmationPending;
  const jobExpired = job?.status === "expired";
  const editingLocked = busy || jobExpired;
  const manualOnly = Boolean(job && (job.manual_only || !job.report));

  const reset = () => {
    if (phase === "result" && request.current) return;
    if (phase === "result" && (cropDirty || selectionDirty || reasonDirty)
      && !window.confirm("当前还有未保存的调整，离开后将丢失。是否重新选择照片？")) return;
    clearWorkspace();
  };

  const persistCrop = async (token: number, controller: AbortController): Promise<JobResponse | null> => {
    if (!job || !draftCrop) return null;
    if (provenance === "pregenerated") {
      const referenceCrop =
        job.candidates.find((candidate) => candidate.id === selectedCandidateId)?.crop
        || job.ai_crop;
      const updated: JobResponse = {
        ...job,
        selected_candidate_id: selectedCandidateId,
        final_crop: draftCrop,
        manual_adjusted: referenceCrop ? !cropEquals(referenceCrop, draftCrop) : true,
        selection_confirmed: true,
        selection_reasons: selectionReasons,
        selection_note: selectionNote.trim() || null,
      };
      setJob(updated);
      return updated;
    }
    const updated = await updateCrop(
      job.id,
      draftCrop,
      accessCode,
      selectedCandidateId || undefined,
      selectionReasons,
      selectionNote.trim() || undefined,
      controller.signal,
    );
    if (!isCurrent(token, controller)) return null;
    setJob(updated);
    setDraftCrop(updated.final_crop);
    setSelectedCandidateId(updated.selected_candidate_id || selectedCandidateId);
    setSelectionReasons(updated.selection_reasons || []);
    setSelectionNote(updated.selection_note || "");
    return updated;
  };

  const resultFailed = (caught: unknown, fallback: string) => {
    if (caught instanceof ApiError && (caught.status === 404 || caught.status === 410)) {
      setJob((current) => current ? { ...current, status: "expired" } : current);
      setError("任务已过期，无法继续保存或下载。请重新上传照片。");
      return;
    }
    setError(errorMessage(caught, fallback));
  };

  const saveCrop = async () => {
    if (jobExpired) return;
    const operation = beginOperation("save");
    if (!operation) return;
    const { token, controller } = operation;
    try {
      const updated = await persistCrop(token, controller);
      if (updated && isCurrent(token, controller)) setNotice("当前方案已保存，可以下载成片。");
    } catch (caught) {
      if (isCurrent(token, controller)) resultFailed(caught, "保存裁剪失败");
    } finally {
      endOperation(token, controller);
    }
  };

  const download = async () => {
    if (!job || jobExpired) return;
    const operation = beginOperation("download");
    if (!operation) return;
    const { token, controller } = operation;
    try {
      let current = job;
      if (hasPendingChanges) {
        const updated = await persistCrop(token, controller);
        if (!updated || !isCurrent(token, controller)) return;
        current = updated;
      }
      if (provenance === "pregenerated" && current.final_crop) {
        await downloadDemoCrop(
          sourceUrl,
          current.final_crop,
          `SmartCrop_${current.id.slice(0, 8)}`,
        );
      } else if (current.artifacts.crop) {
        await downloadArtifact(
          current.artifacts.crop,
          accessCode,
          `SmartCrop_${current.id.slice(0, 8)}`,
          controller.signal,
        );
      } else {
        throw new Error("成片暂不可下载，请重新保存当前方案。");
      }
      if (isCurrent(token, controller)) setNotice("下载已开始，请在浏览器下载列表中查看成片。");
    } catch (caught) {
      if (isCurrent(token, controller)) resultFailed(caught, "下载失败，请重试");
    } finally {
      endOperation(token, controller);
    }
  };

  const selectCandidate = (candidate: CropCandidate): boolean => {
    if (request.current || jobExpired) return false;
    const currentCropIsGenerated = Boolean(
      draftCrop && job?.candidates.some((item) => cropEquals(item.crop, draftCrop)),
    );
    if (
      draftCrop
      && !currentCropIsGenerated
      && !window.confirm("切换构图方向会替换你在画布上的当前调整。是否继续？")
    ) {
      return false;
    }
    setDraftCrop(candidate.crop);
    setSelectedCandidateId(candidate.id);
    setNotice("");
    return true;
  };

  const restoreAiSuggestion = () => {
    if (request.current || jobExpired) return;
    const aiCrop = job?.ai_crop;
    if (!job || !aiCrop) return;
    setDraftCrop(aiCrop);
    const sourceCandidate = job.candidates.find((candidate) => cropEquals(candidate.crop, aiCrop));
    setSelectedCandidateId(sourceCandidate?.id || job.selected_candidate_id || null);
    setNotice("");
  };

  const toggleGuide = (guide: CompositionGuide) => {
    setGuides((current) => (
      current.includes(guide)
        ? current.filter((candidate) => candidate !== guide)
        : [...current, guide]
    ));
  };

  const aspectRatio = job
    ? normalizedAspectRatio(
      job.intent.aspect_ratio,
      job.image_width,
      job.image_height,
      job.intent.custom_ratio,
    )
    : null;
  const reportScopeChanged = Boolean(
    job?.ai_crop && draftCrop && !cropEquals(job.ai_crop, draftCrop),
  );
  const currentStep = phase === "upload" ? 0 : phase === "processing" ? 1 : 2;

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="desktop-app">
        <header className="app-header">
          <a className="brand" href="/" onClick={(event) => { event.preventDefault(); reset(); }}>
            <span className="brand-mark" aria-hidden="true"><CropMark /></span>
            <span><strong>SmartCrop</strong><small>美境智剪</small></span>
          </a>
          <nav className="header-nav" aria-label="主导航">
            <a href={phase === "upload" ? "#upload-workbench" : "#main-content"} className="is-active" aria-current="page">创作工作台</a>
            {phase === "upload" && <><a href="#inspiration">构图灵感</a><a href="#guide">使用指南</a></>}
          </nav>
          <div className="header-trust"><ShieldCheck aria-hidden="true" size={17} />任务文件 1 小时后自动清理</div>
        </header>

        <div className="workflow-bar">
          <ol className="workflow-steps" aria-label="创作进度">
            {["上传照片", "AI 构图", "精修与下载"].map((label, index) => (
              <li className={index === currentStep ? "is-current" : index < currentStep ? "is-complete" : ""} key={label} aria-current={index === currentStep ? "step" : undefined}>
                <span className="step-number">{index < currentStep ? <Check aria-hidden="true" size={13} /> : `0${index + 1}`}</span>{label}
              </li>
            ))}
          </ol>
          <span className="workflow-caption">留住精彩，只需一个新视角</span>
        </div>

        {error && (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {notice && <div className="global-notice" role="status"><Check aria-hidden="true" size={17} />{notice}</div>}

        {phase === "upload" && (
          <UploadPanel
            accessCode={accessCode}
            onAccessCodeChange={setAccessCode}
            onSubmit={analyze}
            onOpenPregeneratedDemo={openPregeneratedDemo}
            busy={busy}
          />
        )}

        {phase === "processing" && job && <ProcessingPanel
          job={job}
          connectionError={connectionError}
          onReconnect={reconnect}
          onReset={reset}
        />}

        {phase === "result" && job && draftCrop && sourceUrl && (
          <main className="result-shell" id="main-content" tabIndex={-1}>
            <div className="result-page-heading">
              <div><p className="eyebrow">Your creative workspace</p><h1>让这一帧，恰到好处。</h1></div>
              <span className="workspace-status"><span aria-hidden="true" />{jobExpired ? "任务已过期" : job.selection_confirmed && !hasPendingChanges ? "当前方案已确认" : job.selection_confirmed ? "有未应用的调整" : "取景方向，由你决定"}</span>
            </div>
            <section className="workspace-panel" aria-labelledby="workspace-heading">
              <div className="workspace-toolbar">
                <div>
                  <p className="eyebrow">{provenance === "pregenerated" ? "固定使用样例" : PUBLICATION_PRESETS.find((preset) => preset.id === job.intent.output_template)?.name || "自由裁剪"} · {intentRatioLabel(job.intent)}</p>
                  <h2 id="workspace-heading">调整最终构图</h2>
                </div>
                <div className="toolbar-actions">
                  <button type="button" className="secondary-button" disabled={busy} onClick={reset}>
                    <ImagePlus aria-hidden="true" size={18} />分析另一张
                  </button>
                  <button type="button" className="secondary-button" disabled={!hasPendingChanges || editingLocked} onClick={saveCrop} aria-busy={activity === "save"}>
                    {activity === "save" ? <LoaderCircle className="is-spinning" aria-hidden="true" size={18} /> : <Save aria-hidden="true" size={18} />}
                    {activity === "save" ? "正在保存" : confirmationPending ? "确认当前方案" : "应用裁剪"}
                  </button>
                  <button type="button" className="primary-button compact" disabled={editingLocked} onClick={download} aria-busy={activity === "download"}>
                    {activity === "download" ? <LoaderCircle className="is-spinning" aria-hidden="true" size={18} /> : <Download aria-hidden="true" size={18} />}
                    {activity === "download" ? "正在准备下载" : "下载裁剪图"}
                  </button>
                </div>
              </div>

              <div className={`capability-banner status-${job.capability_status}`} role="status">
                <strong>
                  {jobExpired ? "任务已过期" : manualOnly ? "手动裁剪可继续使用" : provenance === "pregenerated"
                    ? "使用样例 · 固定展示"
                    : job.capability_status === "mock" ? "Mock 演示模式" : "AI 构图建议"}
                </strong>
                <span>
                  {jobExpired ? "当前图片仅供查看，已无法保存或下载。请重新上传照片开始新的任务。" : manualOnly ? "本次分析没有生成可用结果。你可以调整取景框并下载，当前没有 AI 候选或画面分析。" : provenance === "pregenerated"
                    ? "这是用于了解操作流程的固定结果，没有调用当前模型。"
                    : job.capability_status === "mock"
                      ? "当前结果用于验证交互与制品链路。"
                      : "三个方案按不同构图偏好分别生成，最终方向由你选择。"}
                </span>
              </div>

              <div className="comparison-grid">
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>原图</span><small>拖动框或四角调整，也可使用方向键</small></div>
                    {cropDirty && <span className="change-badge">未应用修改</span>}
                  </div>
                  <CropEditor
                    imageUrl={sourceUrl}
                    imageWidth={job.image_width}
                    imageHeight={job.image_height}
                    crop={draftCrop}
                    onChange={(crop) => {
                      if (request.current || jobExpired) return;
                      setDraftCrop(crop);
                      setNotice("");
                    }}
                    aspectRatio={aspectRatio}
                    guides={guides}
                    disabled={editingLocked}
                  />
                </article>
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>裁剪预览</span><small>下载时使用原始分辨率</small></div>
                    <button
                      type="button"
                      className="icon-text-button"
                      onClick={restoreAiSuggestion}
                      disabled={editingLocked || !job.ai_crop || cropEquals(job.ai_crop, draftCrop)}
                    >
                      <RotateCcw aria-hidden="true" size={16} />
                      {provenance === "pregenerated" ? "恢复固定示例" : "恢复 AI 建议"}
                    </button>
                  </div>
                  <div className="preview-stage"><CropPreview imageUrl={sourceUrl} crop={draftCrop} /></div>
                </article>
              </div>

              <CandidatePanel
                imageUrl={sourceUrl}
                candidates={job.candidates}
                selectedCandidateId={selectedCandidateId}
                pregenerated={provenance === "pregenerated"}
                disabled={editingLocked}
                onSelect={selectCandidate}
              />

              <CompositionTools
                crop={draftCrop}
                imageWidth={job.image_width}
                imageHeight={job.image_height}
                intent={job.intent}
                guides={guides}
                processingDurationMs={job.processing_duration_ms}
                pregenerated={provenance === "pregenerated"}
                onToggleGuide={toggleGuide}
              />

              <SelectionReasonPanel
                disabled={editingLocked}
                reasons={selectionReasons}
                note={selectionNote}
                onReasonsChange={(reasons) => { setSelectionReasons(reasons); setNotice(""); }}
                onNoteChange={(note) => { setSelectionNote(note); setNotice(""); }}
              />
            </section>
            <ReportPanel
              report={job.report}
              adjusted={job.manual_adjusted || cropDirty || reportScopeChanged}
              manualOnly={manualOnly}
              source={
                provenance === "pregenerated"
                  ? "pregenerated"
                  : job.capability_status === "mock" ? "mock" : "model"
              }
            />
          </main>
        )}
        <footer className="app-footer"><span><strong>SmartCrop</strong> 美境智剪</span><span>用新的视角，看见照片的可能。</span><span>AI 提供灵感 · 你决定画面</span></footer>
      </div>
    </>
  );
}

function CropMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22">
      <path d="M7 3v14h14M3 7h14v14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
