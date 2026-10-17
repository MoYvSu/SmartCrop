import { Layers3, Unplug } from "lucide-react";

import type { JobResponse } from "../types";

interface Props {
  job: JobResponse;
  onReset: () => void;
  connectionError?: string;
  onReconnect?: () => void;
  mainId?: string;
}

export function ProcessingPanel({ job, onReset, connectionError = "", onReconnect, mainId = "main-content" }: Props) {
  const ended = job.status === "expired" || job.status === "cancelled";
  return (
    <main className="processing-shell" id={mainId} tabIndex={-1} aria-live="polite">
      <section className="processing-card">
        <div className="processing-mark">{connectionError ? <Unplug aria-hidden="true" size={32} /> : <Layers3 aria-hidden="true" size={32} />}</div>
        <p className="eyebrow">你的照片已上传</p>
        <h1>{ended ? "任务已结束" : connectionError ? "连接暂时中断" : job.status === "queued" ? "你的照片正在排队" : "正在理解这张照片"}</h1>
        <p>{ended ? "任务已过期或结束，请返回上传页重新开始。" : connectionError ? "当前照片仍在页面中。重新连接只查询原任务，不会重复上传。" : job.progress_message}</p>
        {!ended && !connectionError && <div className="progress-track" aria-label="分析进行中"><span /></div>}
        {connectionError && <p className="connection-error" role="alert">{connectionError}</p>}
        <div className="processing-meta">
          {!ended && !connectionError && <span>{job.status === "queued" && job.queue_position ? `当前排在第 ${job.queue_position} 位` : "分析完成后将自动进入调整页面"}</span>}
        </div>
        {!ended && connectionError && onReconnect && <button type="button" className="primary-button reconnect-button" onClick={onReconnect}>重新连接</button>}
        <button type="button" className="text-button" onClick={onReset}>返回上传页</button>
        {!ended && <p className="processing-exit-note">返回后，已提交的任务仍可能继续处理。</p>}
      </section>
    </main>
  );
}
