import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createPregeneratedJob, DEMO_IMAGE_URL } from "../lib/demo";
import { createAnalysisIntent } from "../lib/publishing";
import { Workbench } from "./Workbench";
import type { WorkbenchProps } from "./Workbench";

function props(overrides: Partial<WorkbenchProps> = {}): WorkbenchProps {
  const job = createPregeneratedJob(createAnalysisIntent("general", "freeform", { width: 4, height: 3 }));
  return {
    job, draftCrop: job.final_crop!, sourceUrl: DEMO_IMAGE_URL, provenance: "pregenerated",
    guides: ["thirds"], selectedCandidateId: "balanced", busy: false, activity: null,
    cropDirty: false, hasPendingChanges: true, confirmationPending: true, editingLocked: false,
    jobExpired: false, manualOnly: false, aspectRatio: null, reportScopeChanged: false,
    onReset: vi.fn(), onSave: vi.fn(), onDownload: vi.fn(), onCropChange: vi.fn(),
    onSelectCandidate: vi.fn().mockReturnValue(true), onRestoreSuggestion: vi.fn(),
    onToggleGuide: vi.fn(), selectionReasons: [], selectionNote: "",
    onReasonsChange: vi.fn(), onNoteChange: vi.fn(), ...overrides,
  };
}

function buttonMarkup(markup: string, label: string): string {
  return (markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || [])
    .find((button) => button.replace(/<[^>]*>/g, "").includes(label)) || "";
}

function persistence(overrides: Partial<NonNullable<WorkbenchProps["persistence"]>> = {}) {
  return { title: "我的湖边作品", state: "draft" as const, hasDraftChanges: false,
    saveStatus: "草稿已保存", archiving: false, analysisBusy: false, analysisMessage: "",
    onArchive: vi.fn(), onAnalyze: vi.fn(), ...overrides };
}

function manualProject(overrides: Partial<WorkbenchProps> = {}) {
  const state = props({ provenance: "upload", manualOnly: true, selectedCandidateId: null,
    hasPendingChanges: false, confirmationPending: false, persistence: persistence(), ...overrides });
  state.job = { ...state.job, candidates: [], ai_crop: null, report: null,
    manual_only: true, capability_status: "not_run", selection_confirmed: true };
  return state;
}

describe("Workbench", () => {
  it("starts with one crop canvas and keeps optional tools out of the primary view", () => {
    const markup = renderToStaticMarkup(<Workbench {...props()} />);
    expect(markup).not.toContain("<main");
    expect(markup).toContain('data-view="crop"');
    expect(markup.match(/alt="待裁剪原图"/g)).toHaveLength(1);
    expect(markup).not.toContain('class="wb-compare-grid"');
    expect(markup).not.toContain('class="wb-single-preview"');
    expect(markup).toContain('<details class="wb-report-details">');
    expect(markup).toContain('<details class="wb-reasons-details">');
    expect(markup).toContain('aria-label="画布视图"');
    expect(markup).toContain('aria-label="参考工具"');
  });

  it("uses the current draft selection rather than the saved job selection", () => {
    const state = props({ selectedCandidateId: "subject" });
    expect(state.job.selected_candidate_id).toBe("balanced");
    const markup = renderToStaticMarkup(<Workbench {...state} />);
    expect(markup).toContain('aria-label="当前方案：主体优先"');
    expect(markup).not.toContain('aria-label="当前方案：平衡构图"');
  });

  it("offers local pixel analysis without inventing metadata for the fixed sample", () => {
    const markup = renderToStaticMarkup(<Workbench {...props()} />);
    expect(markup).not.toContain("图像分析尚未接入");
    expect(markup).toContain("当前裁剪");
    expect(markup).toContain("原图");
    expect(markup).toContain("样例未提供拍摄参数");
    expect(markup).not.toContain("拍摄参数尚未接入");
    expect(markup).toContain("没有调用当前模型");
    expect(markup).toContain("当前临时任务");
    expect(markup).not.toContain("完成并归档");
    expect(markup).not.toContain("草稿已保存");
    expect(markup).not.toContain("美学分数：");
  });

  it("shows saved camera parameters in a persistent manual project without AI", () => {
    const markup = renderToStaticMarkup(<Workbench {...manualProject({ exif: {
      camera_make: "Canon", camera_model: "Canon EOS R6", focal_length_mm: 50,
      aperture: 2.8, exposure_seconds: 1 / 125, iso: 100,
    } })} />);
    expect(markup).toContain("Canon EOS R6");
    expect(markup).toContain("50 mm");
    expect(markup).toContain("1/125 秒");
    expect(markup).toContain("f/2.8");
    expect(markup).toContain("未记录");
    expect(markup).not.toContain("Canon Canon");
  });

  it("locks editing, saving and downloading when a task expires while retaining read-only views", () => {
    const markup = renderToStaticMarkup(<Workbench {...props({ jobExpired: true })} />);
    expect(markup).toContain("已无法保存或下载");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('tabindex="-1"');
    expect(buttonMarkup(markup, "确认当前方案")).toContain('disabled=""');
    expect(buttonMarkup(markup, "下载裁剪图")).toContain('disabled=""');
    expect(buttonMarkup(markup, "恢复固定示例")).toContain('disabled=""');
    expect(buttonMarkup(markup, "成片预览")).not.toContain('disabled=""');
    expect(markup).toContain('<fieldset class="selection-reason-panel" disabled=""');
  });

  it("preserves save and download progress with editing locked", () => {
    for (const [activity, label] of [["save", "正在保存"], ["download", "正在准备下载"]] as const) {
      const markup = renderToStaticMarkup(<Workbench {...props({ activity, busy: true, editingLocked: true })} />);
      const button = buttonMarkup(markup, label);
      expect(button).toContain('aria-busy="true"');
      expect(button).toContain('disabled=""');
      expect(buttonMarkup(markup, "分析另一张")).toContain('disabled=""');
    }
  });

  it("offers manual recovery without inventing AI candidates and respects its expiry", () => {
    const state = props({ manualOnly: true });
    state.job = { ...state.job, report: null, ai_crop: null, candidates: [], status: "failed" };
    const available = renderToStaticMarkup(<Workbench {...state} />);
    expect(available).toContain("继续手动精修");
    expect(available).not.toContain('aria-label="当前方案：');
    expect(buttonMarkup(available, "下载裁剪图")).not.toContain('disabled=""');
    const expired = renderToStaticMarkup(<Workbench {...state} jobExpired />);
    expect(expired).toContain("当前任务已结束");
    expect(expired).not.toContain("画布中的裁剪与预览仍可使用");
    expect(expired).not.toContain("模型分析失败，请稍后重试；也可继续使用手动裁剪。");
  });

  it("allows a persistent manual project to edit, download and archive without AI or a task expiry", () => {
    const markup = renderToStaticMarkup(<Workbench {...manualProject()} />);
    expect(markup).toContain("独立手动创作");
    expect(markup).toContain("不必等待 AI");
    expect(markup).toContain("草稿与归档作品保留至主动删除");
    expect(markup).toContain("草稿已保存");
    expect(markup).toContain("参考可选，创作继续");
    expect(markup).not.toContain('aria-label="当前方案：');
    expect(markup).not.toMatch(/1\s*小时|一小时|临时任务|任务已过期|本次分析没有生成/);
    expect(markup).not.toContain("确认当前方案");
    expect(buttonMarkup(markup, "保存草稿")).toContain('disabled=""');
    expect(buttonMarkup(markup, "完成并归档")).not.toContain('disabled=""');
    expect(buttonMarkup(markup, "下载裁剪图")).not.toContain('disabled=""');
    expect(buttonMarkup(markup, "获取 AI 构图参考")).not.toContain('disabled=""');
    expect(markup).toContain('aria-disabled="false"');
  });

  it("presents pending autosave status rather than a temporary unconfirmed plan", () => {
    const state = manualProject({ cropDirty: true, hasPendingChanges: true,
      persistence: persistence({ saveStatus: "有更新待保存" }) });
    const markup = renderToStaticMarkup(<Workbench {...state} />);
    expect(markup).toContain('class="wb-change-status">有更新待保存');
    expect(markup).toContain('class="wb-save-status" role="status"');
    expect(markup).not.toContain("未应用修改");
    expect(markup).not.toContain("取景方向，由你决定");
    expect(buttonMarkup(markup, "保存草稿")).not.toContain('disabled=""');
    expect(buttonMarkup(markup, "完成并归档")).not.toContain('disabled=""');
  });

  it("keeps local editing and archive available while optional AI is running", () => {
    const state = manualProject({ persistence: persistence({ analysisBusy: true,
      analysisMessage: "AI 参考正在生成，你可以继续精修。新结果不会覆盖当前草稿。" }) });
    const markup = renderToStaticMarkup(<Workbench {...state} />);
    expect(buttonMarkup(markup, "正在生成参考")).toContain('disabled=""');
    expect(buttonMarkup(markup, "正在生成参考")).toContain('aria-busy="true"');
    expect(buttonMarkup(markup, "完成并归档")).not.toContain('disabled=""');
    expect(buttonMarkup(markup, "下载裁剪图")).not.toContain('disabled=""');
    expect(markup).toContain('aria-disabled="false"');
    expect(markup).toContain("新结果不会覆盖当前草稿");
    expect(markup).not.toContain("当前临时任务");
  });

  it("shows archive progress only on the archive action while locking writes and download", () => {
    const state = manualProject({ busy: true, activity: "save", editingLocked: true,
      persistence: persistence({ archiving: true }) });
    const markup = renderToStaticMarkup(<Workbench {...state} />);
    expect(buttonMarkup(markup, "正在归档")).toContain('aria-busy="true"');
    expect(buttonMarkup(markup, "正在归档")).toContain('disabled=""');
    expect(buttonMarkup(markup, "保存草稿")).toContain('aria-busy="false"');
    expect(buttonMarkup(markup, "保存草稿")).toContain('disabled=""');
    expect(markup).not.toContain("正在保存");
    expect(buttonMarkup(markup, "下载裁剪图")).toContain('disabled=""');
    expect(markup).toContain('aria-disabled="true"');
  });

  it("enables a new archive version only when the archived project has changes", () => {
    const unchanged = renderToStaticMarkup(<Workbench {...manualProject({
      persistence: persistence({ state: "archived" }),
    })} />);
    expect(buttonMarkup(unchanged, "保存新版本")).toContain('disabled=""');
    const changed = renderToStaticMarkup(<Workbench {...manualProject({
      persistence: persistence({ state: "archived", hasDraftChanges: true }),
    })} />);
    expect(buttonMarkup(changed, "保存新版本")).not.toContain('disabled=""');
    expect(changed).not.toContain("完成并归档");
  });

  it("presents persistent AI results as adoptable references rather than the current manual crop", () => {
    const markup = renderToStaticMarkup(<Workbench {...props({ provenance: "upload", selectedCandidateId: null,
      persistence: persistence() })} />);
    expect(markup).toContain('aria-label="构图参考：平衡构图"');
    expect(markup).toContain('aria-label="采用构图参考：平衡构图"');
    expect(markup).not.toContain('aria-label="当前方案：');
    expect(markup).toContain("主动采用才会改变取景");
  });
});
