import { Download, FileJson, ImagePlus, RotateCcw, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
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
import { getCropMetrics } from "./lib/metrics";
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function downloadJson(payload: object, filename: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pollToken = useRef(0);

  useEffect(() => {
    sessionStorage.setItem("smartcrop-access", accessCode);
  }, [accessCode]);

  useEffect(() => () => {
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  const reset = () => {
    pollToken.current += 1;
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
    setSourceUrl("");
    setJob(null);
    setDraftCrop(null);
    setSelectedCandidateId(null);
    setSelectionReasons([]);
    setSelectionNote("");
    setGuides(["thirds"]);
    setProvenance("upload");
    setError("");
    setBusy(false);
    setPhase("upload");
  };

  const analyze = async (
    file: File,
    intent: AnalysisIntent,
    runProvenance: RunProvenance,
  ) => {
    setBusy(true);
    setError("");
    const token = ++pollToken.current;
    const localUrl = URL.createObjectURL(file);
    setSourceUrl(localUrl);
    setProvenance(runProvenance);
    try {
      let current = await createJob(file, intent, accessCode);
      if (token !== pollToken.current) return;
      setJob(current);
      setPhase("processing");
      while (!TERMINAL.has(current.status)) {
        await sleep(1500);
        if (token !== pollToken.current) return;
        current = await getJob(current.id, accessCode);
        setJob(current);
      }
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
        throw new Error(current.error?.message || "任务未能完成，请重新上传图片");
      }
      setDraftCrop(current.final_crop);
      setSelectedCandidateId(current.selected_candidate_id || current.candidates[0]?.id || null);
      setSelectionReasons(current.selection_reasons || []);
      setSelectionNote(current.selection_note || "");
      setPhase("result");
    } catch (caught) {
      if (token !== pollToken.current) return;
      const message = caught instanceof Error ? caught.message : "提交失败，请稍后重试";
      setError(message);
      setPhase("upload");
    } finally {
      setBusy(false);
    }
  };

  const openPregeneratedDemo = (intent: AnalysisIntent) => {
    pollToken.current += 1;
    if (sourceUrl.startsWith("blob:")) URL.revokeObjectURL(sourceUrl);
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
    setBusy(false);
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

  const saveCrop = async (): Promise<JobResponse | null> => {
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
    setBusy(true);
    setError("");
    try {
      const updated = await updateCrop(
        job.id,
        draftCrop,
        accessCode,
        selectedCandidateId || undefined,
        selectionReasons,
        selectionNote.trim() || undefined,
      );
      setJob(updated);
      setDraftCrop(updated.final_crop);
      setSelectedCandidateId(updated.selected_candidate_id || selectedCandidateId);
      setSelectionReasons(updated.selection_reasons || []);
      setSelectionNote(updated.selection_note || "");
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存裁剪失败");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!job) return;
    let current = job;
    if (hasPendingChanges) {
      const updated = await saveCrop();
      if (!updated) return;
      current = updated;
    }
    if (provenance === "pregenerated" && current.final_crop) {
      try {
        await downloadDemoCrop(
          sourceUrl,
          current.final_crop,
          `SmartCrop_${current.id.slice(0, 8)}`,
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "演示裁剪下载失败");
      }
      return;
    }
    if (!current.artifacts.crop) return;
    try {
      await downloadArtifact(
        current.artifacts.crop,
        accessCode,
        `SmartCrop_${current.id.slice(0, 8)}`,
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "下载失败");
    }
  };

  const downloadPlan = async () => {
    if (!job) return;
    try {
      let current = job;
      if (hasPendingChanges) {
        const updated = await saveCrop();
        if (!updated) return;
        current = updated;
      }
      if (provenance !== "pregenerated" && current.artifacts.plan) {
        await downloadArtifact(
          current.artifacts.plan,
          accessCode,
          `SmartCrop_${current.id.slice(0, 8)}_plan`,
        );
        return;
      }
      const metrics = current.final_crop
        ? getCropMetrics(
          current.image_width,
          current.image_height,
          current.final_crop,
          current.intent,
        )
        : null;
      downloadJson({
        schema_version: "1.2",
        job_id: current.id,
        intent: current.intent,
        selection_mode: current.selection_confirmed ? "human" : "unconfirmed",
        selection_confirmed: current.selection_confirmed,
        selected_candidate_id: current.selected_candidate_id,
        selection_reasons: current.selection_reasons,
        selection_note: current.selection_note,
        manual_adjusted: current.manual_adjusted,
        processing_duration_ms: current.processing_duration_ms,
        final_crop: current.final_crop,
        initial_report: current.report,
        capability_status: current.capability_status,
        provenance: "pregenerated",
        output: metrics && {
          source_size: { width: current.image_width, height: current.image_height },
          crop_size: { width: metrics.outputWidth, height: metrics.outputHeight },
          requested_ratio: metrics.requestedRatio,
          ratio_compliant: metrics.ratioCompliant,
        },
      }, `SmartCrop_${current.id.slice(0, 8)}_plan.json`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "方案导出失败");
    }
  };

  const selectCandidate = (candidate: CropCandidate) => {
    setDraftCrop(candidate.crop);
    setSelectedCandidateId(candidate.id);
  };

  const restoreAiSuggestion = () => {
    const aiCrop = job?.ai_crop;
    if (!job || !aiCrop) return;
    setDraftCrop(aiCrop);
    const sourceCandidate = job.candidates.find((candidate) => cropEquals(candidate.crop, aiCrop));
    setSelectedCandidateId(sourceCandidate?.id || job.selected_candidate_id || null);
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

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="mobile-unsupported">
        <div><SlidersHorizontal aria-hidden="true" size={30} /></div>
        <h1>请使用桌面浏览器</h1>
        <p>SmartCrop 当前暂不支持手机端。API 已保留未来扩展能力。</p>
      </div>

      <div className="desktop-app">
        <header className="app-header">
          <a className="brand" href="/" onClick={(event) => { event.preventDefault(); reset(); }}>
            <span className="brand-mark" aria-hidden="true"><CropMark /></span>
            <span><strong>SmartCrop</strong><small>美境智剪</small></span>
          </a>
          <div className="header-trust"><ShieldCheck aria-hidden="true" size={17} />任务文件 1 小时后自动清理</div>
        </header>

        {error && (
          <div className="global-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>关闭</button>
          </div>
        )}

        {phase === "upload" && (
          <UploadPanel
            accessCode={accessCode}
            onAccessCodeChange={setAccessCode}
            onSubmit={analyze}
            onOpenPregeneratedDemo={openPregeneratedDemo}
            busy={busy}
          />
        )}

        {phase === "processing" && job && <ProcessingPanel job={job} onReset={reset} />}

        {phase === "result" && job && draftCrop && sourceUrl && (
          <main className="result-shell" id="main-content">
            <section className="workspace-panel" aria-labelledby="workspace-heading">
              <div className="workspace-toolbar">
                <div>
                  <p className="eyebrow">任务 {job.id.slice(0, 8)}</p>
                  <h1 id="workspace-heading">调整最终构图</h1>
                </div>
                <div className="toolbar-actions">
                  <button type="button" className="secondary-button" onClick={reset}>
                    <ImagePlus aria-hidden="true" size={18} />分析另一张
                  </button>
                  <button type="button" className="secondary-button" disabled={!hasPendingChanges || busy} onClick={saveCrop}>
                    <Save aria-hidden="true" size={18} />
                    {confirmationPending ? "确认当前方案" : "应用裁剪"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy || (provenance !== "pregenerated" && !job.artifacts.plan)}
                    onClick={downloadPlan}
                  >
                    <FileJson aria-hidden="true" size={18} />导出方案
                  </button>
                  <button type="button" className="primary-button compact" disabled={busy} onClick={download}>
                    <Download aria-hidden="true" size={18} />下载裁剪图
                  </button>
                </div>
              </div>

              <div className={`capability-banner status-${job.capability_status}`} role="status">
                <strong>
                  {provenance === "pregenerated"
                    ? "预生成演示样例"
                    : provenance === "authorized_realtime"
                      ? job.capability_status === "mock"
                        ? "授权样例 · Mock 实时处理"
                        : "授权样例 · 实时处理"
                      : job.capability_status === "mock" ? "Mock 演示模式" : "AI 构图建议"}
                </strong>
                <span>
                  {provenance === "pregenerated"
                    ? "本结果用于离线导览，没有调用当前模型。"
                    : provenance === "authorized_realtime"
                      ? job.capability_status === "mock"
                        ? "当前 Mock 后端已实际处理仓库自制合成样例，仅验证功能链路。"
                        : "当前后端已实际处理仓库自制合成样例。"
                      : job.capability_status === "mock"
                        ? "当前结果用于验证交互与制品链路。"
                        : "三个方案按不同构图偏好分别生成，最终方向由你选择。"}
                </span>
              </div>

              <CandidatePanel
                imageUrl={sourceUrl}
                candidates={job.candidates}
                selectedCandidateId={selectedCandidateId}
                pregenerated={provenance === "pregenerated"}
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

              <div className="comparison-grid">
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>原图</span><small>拖动框或四角调整，也可使用方向键</small></div>
                    {cropDirty && <span className="change-badge">未应用修改</span>}
                  </div>
                  <CropEditor
                    imageUrl={sourceUrl}
                    crop={draftCrop}
                    onChange={setDraftCrop}
                    aspectRatio={aspectRatio}
                    guides={guides}
                  />
                </article>
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>裁剪预览</span><small>下载时使用原始分辨率</small></div>
                    <button
                      type="button"
                      className="icon-text-button"
                      onClick={restoreAiSuggestion}
                      disabled={!job.ai_crop || cropEquals(job.ai_crop, draftCrop)}
                    >
                      <RotateCcw aria-hidden="true" size={16} />
                      {provenance === "pregenerated" ? "恢复固定示例" : "恢复 AI 建议"}
                    </button>
                  </div>
                  <div className="preview-stage"><CropPreview imageUrl={sourceUrl} crop={draftCrop} /></div>
                </article>
              </div>
              <SelectionReasonPanel
                reasons={selectionReasons}
                note={selectionNote}
                onReasonsChange={setSelectionReasons}
                onNoteChange={setSelectionNote}
              />
            </section>
            <ReportPanel
              report={job.report}
              adjusted={job.manual_adjusted || cropDirty || reportScopeChanged}
              manualOnly={job.manual_only || !job.report}
              source={
                provenance === "pregenerated"
                  ? "pregenerated"
                  : job.capability_status === "mock" ? "mock" : "model"
              }
            />
          </main>
        )}
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
