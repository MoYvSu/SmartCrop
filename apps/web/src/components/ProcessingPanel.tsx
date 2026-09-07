import { CircleSlash2, Layers3, XCircle } from "lucide-react";

import type { JobResponse } from "../types";

interface Props {
  job: JobResponse;
  onReset: () => void;
  onCancel: () => void;
  cancelling: boolean;
}

export function ProcessingPanel({ job, onReset, onCancel, cancelling }: Props) {
  const cancelled = job.status === "cancelled";
  return (
    <main className="processing-shell" id="main-content" aria-live="polite">
      <section className={`processing-card ${cancelled ? "is-cancelled" : ""}`}>
        <div className="processing-mark">
          {cancelled
            ? <CircleSlash2 aria-hidden="true" size={32} />
            : <Layers3 aria-hidden="true" size={32} />}
        </div>
        <p className="eyebrow">任务 {job.id.slice(0, 8)}</p>
        <h1>
          {cancelled
            ? "任务已取消"
            : job.status === "queued"
              ? "等待分析资源"
              : "正在理解这张照片"}
        </h1>
        <p>
          {cancelled
            ? "该任务已停止排队，图片与临时文件仍会在到期后自动清理。"
            : job.progress_message}
        </p>
        {!cancelled && <div className="progress-track" aria-label="分析进行中"><span /></div>}
        <div className="processing-meta">
          <span>{cancelled ? "已终止" : "串行任务处理"}</span>
          <span>{cancelled ? "无占用" : "等待上限 120 秒"}</span>
        </div>
        {!cancelled && (
          <button
            type="button"
            className="text-button cancel-button"
            disabled={cancelling || job.status === "succeeded"}
            onClick={onCancel}
          >
            <XCircle aria-hidden="true" size={16} />
            {cancelling ? "正在取消…" : "取消任务"}
          </button>
        )}
        <button type="button" className="text-button" onClick={onReset}>
          返回上传页
        </button>
      </section>
    </main>
  );
}
