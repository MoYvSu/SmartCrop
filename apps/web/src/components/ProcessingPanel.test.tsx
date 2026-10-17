import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createPregeneratedJob } from "../lib/demo";
import { createAnalysisIntent } from "../lib/publishing";
import type { JobResponse } from "../types";
import { ProcessingPanel } from "./ProcessingPanel";

function processingJob(overrides: Partial<JobResponse> = {}): JobResponse {
  return {
    ...createPregeneratedJob(createAnalysisIntent("general", "freeform", { width: 4, height: 3 })),
    id: "existing-upload-task",
    status: "running",
    progress_message: "模型正在分析构图，请稍候。",
    ...overrides,
  };
}

describe("ProcessingPanel", () => {
  it("shows the actual queue position without promising a fixed completion deadline", () => {
    const markup = renderToStaticMarkup(
      <ProcessingPanel job={processingJob({ status: "queued", queue_position: 3 })} onReset={vi.fn()} />,
    );

    expect(markup).toContain("你的照片正在排队");
    expect(markup).toContain("当前排在第 3 位");
    expect(markup).toContain('aria-label="分析进行中"');
    expect(markup).toContain("已提交的任务仍可能继续处理");
    expect(markup).not.toMatch(/120\s*秒|2\s*分钟|两分钟/);
    expect(markup).not.toContain("重新连接</button>");
  });

  it("shows the worker progress while running without inventing a duration limit", () => {
    const markup = renderToStaticMarkup(
      <ProcessingPanel job={processingJob()} onReset={vi.fn()} />,
    );

    expect(markup).toContain("正在理解这张照片");
    expect(markup).toContain("模型正在分析构图，请稍候。");
    expect(markup).toContain("分析完成后将自动进入调整页面");
    expect(markup).toContain('aria-label="分析进行中"');
    expect(markup).not.toContain("当前排在第");
    expect(markup).not.toMatch(/120\s*秒|2\s*分钟|两分钟/);
  });

  it("offers reconnection to the original task rather than a new upload when disconnected", () => {
    const onReconnect = vi.fn();
    const markup = renderToStaticMarkup(
      <ProcessingPanel
        job={processingJob()}
        onReset={vi.fn()}
        connectionError="网络连接暂时不可用"
        onReconnect={onReconnect}
      />,
    );

    expect(markup).toContain("连接暂时中断");
    expect(markup).toContain("原任务");
    expect(markup).toContain("不会重复上传");
    expect(markup).toContain('role="alert">网络连接暂时不可用');
    expect(markup).toContain("重新连接</button>");
    expect(markup).not.toContain('aria-label="分析进行中"');
    expect(markup).not.toContain('class="progress-track"');
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("重新上传");
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it.each(["expired", "cancelled"] as const)("shows %s as ended without an analysis animation or reconnect action", (status) => {
    // Even a stale connection error must not revive an already ended task.
    const markup = renderToStaticMarkup(
      <ProcessingPanel
        job={processingJob({ status, queue_position: 2 })}
        onReset={vi.fn()}
        connectionError="上一次查询未完成"
        onReconnect={vi.fn()}
      />,
    );

    expect(markup).toContain("任务已结束");
    expect(markup).toContain("任务已过期或结束，请返回上传页重新开始。");
    expect(markup).toContain("返回上传页</button>");
    expect(markup).not.toContain('aria-label="分析进行中"');
    expect(markup).not.toContain('class="progress-track"');
    expect(markup).not.toContain("重新连接</button>");
    expect(markup).not.toContain("分析完成后将自动进入调整页面");
    expect(markup).not.toContain("当前排在第");
    expect(markup).not.toContain("仍可能继续处理");
  });
});
