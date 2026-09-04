import { Layers3 } from "lucide-react";

import type { JobResponse } from "../types";

interface Props {
  job: JobResponse;
  onReset: () => void;
}

export function ProcessingPanel({ job, onReset }: Props) {
  return (
    <main className="processing-shell" aria-live="polite">
      <section className="processing-card">
        <div className="processing-mark"><Layers3 aria-hidden="true" size={32} /></div>
        <p className="eyebrow">任务 {job.id.slice(0, 8)}</p>
        <h1>{job.status === "queued" ? "等待 GPU 空闲" : "正在理解这张照片"}</h1>
        <p>{job.progress_message}</p>
        <div className="progress-track" aria-label="分析进行中"><span /></div>
        <div className="processing-meta">
          <span>单 GPU 串行处理</span>
          <span>等待上限 120 秒</span>
        </div>
        <button type="button" className="text-button" onClick={onReset}>返回上传页</button>
      </section>
    </main>
  );
}
