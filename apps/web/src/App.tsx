import { BrainCircuit, Download, FileJson, ImagePlus, RotateCcw, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ApiError, createJob, createReview, downloadArtifact, getJob, updateCrop } from "./api";
import { CandidatePanel } from "./components/CandidatePanel";
import { CropEditor } from "./components/CropEditor";
import { CropPreview } from "./components/CropPreview";
import { ProcessingPanel } from "./components/ProcessingPanel";
import { ReportPanel } from "./components/ReportPanel";
import { UploadPanel } from "./components/UploadPanel";
import { cropEquals, normalizedAspectRatio } from "./lib/crop";
import type { AnalysisIntent, CropBox, CropCandidate, JobResponse } from "./types";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired"]);
const DEFAULT_MANUAL_CROP: CropBox = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export default function App() {
  const [accessCode, setAccessCode] = useState(() => sessionStorage.getItem("smartcrop-access") || "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [job, setJob] = useState<JobResponse | null>(null);
  const [draftCrop, setDraftCrop] = useState<CropBox | null>(null);
  const [reviewJob, setReviewJob] = useState<JobResponse | null>(null);
  const [phase, setPhase] = useState<"upload" | "processing" | "result">("upload");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pollToken = useRef(0);

  useEffect(() => {
    sessionStorage.setItem("smartcrop-access", accessCode);
  }, [accessCode]);

  useEffect(() => () => {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  const reset = () => {
    pollToken.current += 1;
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    setSourceUrl("");
    setJob(null);
    setDraftCrop(null);
    setReviewJob(null);
    setError("");
    setBusy(false);
    setPhase("upload");
  };

  const analyze = async (file: File, intent: AnalysisIntent) => {
    setBusy(true);
    setError("");
    const token = ++pollToken.current;
    const localUrl = URL.createObjectURL(file);
    setSourceUrl(localUrl);
    try {
      let current = await createJob(file, intent, accessCode);
      setJob(current);
      setPhase("processing");
      while (!TERMINAL.has(current.status)) {
        await sleep(1500);
        if (token !== pollToken.current) return;
        current = await getJob(current.id, accessCode);
        setJob(current);
      }
      if (current.status === "failed") {
        setDraftCrop(DEFAULT_MANUAL_CROP);
        setPhase("result");
        return;
      }
      if (current.status !== "succeeded" || !current.final_crop) {
        throw new Error(current.error?.message || "任务未能完成，请重新上传图片");
      }
      setDraftCrop(current.final_crop);
      setPhase("result");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "提交失败，请稍后重试";
      setError(message);
      setPhase("upload");
    } finally {
      setBusy(false);
    }
  };

  const cropDirty = Boolean(
    draftCrop && (!job?.final_crop || !cropEquals(job.final_crop, draftCrop)),
  );

  const saveCrop = async (): Promise<JobResponse | null> => {
    if (!job || !draftCrop) return null;
    setBusy(true);
    setError("");
    try {
      const selected = job.candidates.find((candidate) => cropEquals(candidate.crop, draftCrop));
      const updated = await updateCrop(job.id, draftCrop, accessCode, selected?.id);
      setJob(updated);
      setDraftCrop(updated.final_crop);
      return updated;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存裁剪失败");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const reviewFinal = async () => {
    if (!job) return;
    setBusy(true);
    setError("");
    const token = ++pollToken.current;
    try {
      let current = job;
      if (cropDirty) {
        const updated = await saveCrop();
        if (!updated) return;
        current = updated;
        setBusy(true);
      }
      let review = await createReview(current.id, accessCode);
      setReviewJob(review);
      while (!TERMINAL.has(review.status)) {
        await sleep(1500);
        if (token !== pollToken.current) return;
        review = await getJob(review.id, accessCode);
        setReviewJob(review);
      }
      if (review.status !== "succeeded") throw new Error(review.error?.message || "终稿复评失败");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "终稿复评失败");
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (!job) return;
    let current = job;
    if (cropDirty) {
      const updated = await saveCrop();
      if (!updated) return;
      current = updated;
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
      if (cropDirty) {
        const updated = await saveCrop();
        if (!updated) return;
        current = updated;
      }
      const payload = {
        schema_version: "1.0",
        job_id: current.id,
        intent: current.intent,
        selected_candidate_id: current.selected_candidate_id,
        final_crop: current.final_crop,
        initial_report: current.report,
        final_review: reviewJob?.status === "succeeded" ? reviewJob.report : null,
        capability_status: current.capability_status,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `SmartCrop_${current.id.slice(0, 8)}_plan.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "方案导出失败");
    }
  };

  const selectCandidate = (candidate: CropCandidate) => {
    setDraftCrop(candidate.crop);
    setReviewJob(null);
  };

  const aspectRatio = job
    ? normalizedAspectRatio(job.intent.aspect_ratio, job.image_width, job.image_height)
    : null;

  return (
    <>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="mobile-unsupported">
        <div><SlidersHorizontal aria-hidden="true" size={30} /></div>
        <h1>请使用桌面浏览器</h1>
        <p>SmartCrop V1 暂不支持手机端。API 已保留未来扩展能力。</p>
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
                  <button type="button" className="secondary-button" disabled={!cropDirty || busy} onClick={saveCrop}>
                    <Save aria-hidden="true" size={18} />应用裁剪
                  </button>
                  <button type="button" className="secondary-button" disabled={busy} onClick={reviewFinal}>
                    <BrainCircuit aria-hidden="true" size={18} />
                    {reviewJob && !TERMINAL.has(reviewJob.status) ? "正在复评" : "复评终稿"}
                  </button>
                  <button type="button" className="secondary-button" disabled={busy || !job.artifacts.plan} onClick={downloadPlan}>
                    <FileJson aria-hidden="true" size={18} />导出方案
                  </button>
                  <button type="button" className="primary-button compact" disabled={busy} onClick={download}>
                    <Download aria-hidden="true" size={18} />下载裁剪图
                  </button>
                </div>
              </div>

              <div className={`capability-banner status-${job.capability_status}`} role="status">
                <strong>{job.capability_status === "verified" ? "真实模型已验收" : job.capability_status === "mock" ? "Mock 演示模式" : "真实模型待 GPU 验收"}</strong>
                <span>{job.capability_status === "verified" ? "多候选与终稿复评已通过当前环境验证。" : "当前可验证交互与契约，不能据此宣称 Venus 已具备稳定的方案比较能力。"}</span>
              </div>

              <CandidatePanel imageUrl={sourceUrl} candidates={job.candidates} crop={draftCrop} onSelect={selectCandidate} />

              <div className="comparison-grid">
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>原图</span><small>拖动框或四角调整，也可使用方向键</small></div>
                    {cropDirty && <span className="change-badge">未应用修改</span>}
                  </div>
                  <CropEditor imageUrl={sourceUrl} crop={draftCrop} onChange={(crop) => { setDraftCrop(crop); setReviewJob(null); }} aspectRatio={aspectRatio} />
                </article>
                <article className="image-card">
                  <div className="image-card-heading">
                    <div><span>裁剪预览</span><small>下载时使用原始分辨率</small></div>
                    <button
                      type="button"
                      className="icon-text-button"
                      onClick={() => { if (job.ai_crop) { setDraftCrop(job.ai_crop); setReviewJob(null); } }}
                      disabled={!job.ai_crop || cropEquals(job.ai_crop, draftCrop)}
                    >
                      <RotateCcw aria-hidden="true" size={16} />恢复 AI 建议
                    </button>
                  </div>
                  <div className="preview-stage"><CropPreview imageUrl={sourceUrl} crop={draftCrop} /></div>
                </article>
              </div>
            </section>
            <ReportPanel
              report={reviewJob?.status === "succeeded" ? reviewJob.report : job.report}
              adjusted={reviewJob?.status !== "succeeded" && (job.manual_adjusted || cropDirty)}
              manualOnly={job.manual_only || !job.report}
              finalReview={reviewJob?.status === "succeeded"}
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
