import { useId, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  Check, ChevronDown, Crop, Download, ImagePlus, Images,
  LoaderCircle, MessageSquareText, Move, RotateCcw, Save, ScanEye, SlidersHorizontal, Sparkles,
} from "lucide-react";

import { cropEquals } from "../lib/crop";
import { getCropMetrics } from "../lib/metrics";
import { intentRatioLabel, PUBLICATION_PRESETS } from "../lib/publishing";
import type {
  CompositionGuide, CropBox, CropCandidate, JobResponse, RunProvenance, SelectionReason,
} from "../types";
import { CandidatePanel } from "./CandidatePanel";
import { CompositionTools } from "./CompositionTools";
import { CropEditor } from "./CropEditor";
import { CropPreview } from "./CropPreview";
import { ReportPanel } from "./ReportPanel";
import { SelectionReasonPanel } from "./SelectionReasonPanel";
import { ImageAnalysisPanel } from "./ImageAnalysisPanel";
import { ShotParameters } from "./ShotParameters";
import type { PhotoExif } from "../workspaceApi";
import "./workbench.css";

export interface WorkbenchProps {
  exif?: PhotoExif;
  analysisEnabled?: boolean;
  persistence?: {
    title: string; state: "draft" | "archived"; hasDraftChanges: boolean; saveStatus: string;
    archiving: boolean; analysisBusy: boolean; analysisMessage: string;
    onArchive: () => void; onAnalyze: () => void;
  };
  job: JobResponse;
  draftCrop: CropBox;
  sourceUrl: string;
  provenance: RunProvenance;
  guides: CompositionGuide[];
  selectedCandidateId: CropCandidate["id"] | null;
  busy: boolean;
  activity: "analysis" | "save" | "download" | null;
  cropDirty: boolean;
  hasPendingChanges: boolean;
  confirmationPending: boolean;
  editingLocked: boolean;
  jobExpired: boolean;
  manualOnly: boolean;
  aspectRatio: number | null;
  reportScopeChanged: boolean;
  onReset: () => void;
  onSave: () => void;
  onDownload: () => void;
  onCropChange: (crop: CropBox) => void;
  onSelectCandidate: (candidate: CropCandidate) => boolean;
  onRestoreSuggestion: () => void;
  onToggleGuide: (guide: CompositionGuide) => void;
  selectionReasons: SelectionReason[];
  selectionNote: string;
  onReasonsChange: (reasons: SelectionReason[]) => void;
  onNoteChange: (note: string) => void;
}

const VIEWS = [
  { id: "crop", label: "裁剪", Icon: Crop },
  { id: "preview", label: "成片预览", Icon: ScanEye },
  { id: "compare", label: "对照", Icon: Images },
] as const;
const TOOLS = [
  { id: "image", label: "图像分析" },
  { id: "ai", label: "AI 参考" },
  { id: "exif", label: "拍摄参数" },
] as const;
type View = typeof VIEWS[number]["id"];
type Tool = typeof TOOLS[number]["id"];

function switchTab<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  items: readonly { id: T }[],
  index: number,
  select: (id: T) => void,
) {
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : event.key === "ArrowRight" ? (index + 1) % items.length
      : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : null;
  if (next === null) return;
  event.preventDefault();
  select(items[next].id);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}

export function Workbench({
  job, draftCrop, sourceUrl, provenance, guides, selectedCandidateId, busy, activity,
  cropDirty, hasPendingChanges, confirmationPending, editingLocked, jobExpired, manualOnly,
  aspectRatio, reportScopeChanged, onReset, onSave, onDownload, onCropChange, onSelectCandidate,
  onRestoreSuggestion, onToggleGuide, selectionReasons, selectionNote, onReasonsChange, onNoteChange,
  persistence, analysisEnabled = true, exif,
}: WorkbenchProps) {
  const [view, setView] = useState<View>("crop");
  const [tool, setTool] = useState<Tool>("image");
  const id = useId();
  const locked = editingLocked || jobExpired;
  const pregenerated = provenance === "pregenerated";
  const metrics = getCropMetrics(job.image_width, job.image_height, draftCrop, job.intent);
  const template = PUBLICATION_PRESETS.find((preset) => preset.id === job.intent.output_template)?.name || "自由裁剪";
  const source = pregenerated ? "pregenerated" : job.capability_status === "mock" ? "mock" : "model";
  const adjusted = job.manual_adjusted || cropDirty || reportScopeChanged;
  const status = persistence ? persistence.saveStatus : jobExpired ? "任务已过期"
    : job.selection_confirmed && !hasPendingChanges ? "当前方案已确认"
      : hasPendingChanges && job.selection_confirmed ? "有未应用的调整" : "取景方向，由你决定";
  const sourceHeading = persistence && manualOnly ? "独立手动创作" : jobExpired ? "任务已过期" : manualOnly ? "手动裁剪可继续使用"
    : pregenerated ? "使用样例 · 固定展示" : job.capability_status === "mock" ? "Mock 演示模式" : "AI 构图参考";
  const sourceNote = persistence && manualOnly
    ? "照片已保存为独立作品草稿。可以直接精修、下载或归档，不必等待 AI。"
    : jobExpired
    ? "当前图片仅供查看，已无法保存或下载。请重新上传照片开始新的任务。"
    : manualOnly ? "本次分析没有生成可用结果。你可以调整取景框并下载，当前没有 AI 候选或画面分析。"
      : pregenerated ? "这是用于了解操作流程的固定结果，没有调用当前模型。"
        : job.capability_status === "mock" ? "当前结果用于验证交互与制品链路，属于模拟输出。"
          : "构图参考按不同偏好生成，由你选择和调整最终画面。";
  const photoStyle = { "--wb-image-ratio": job.image_width / job.image_height } as CSSProperties;
  const savingDraft = activity === "save" && !persistence?.archiving;

  const editor = (
    <div className="wb-crop-view" style={photoStyle}>
      <CropEditor
        imageUrl={sourceUrl} imageWidth={job.image_width} imageHeight={job.image_height}
        crop={draftCrop} onChange={onCropChange} aspectRatio={aspectRatio} guides={guides} disabled={locked}
      />
    </div>
  );

  return (
    <div className="workbench">
      <header className="wb-heading">
        <div className="wb-heading-copy">
          <p className="wb-context">{pregenerated ? "固定使用样例" : template} <span aria-hidden="true">/</span> {intentRatioLabel(job.intent)}</p>
          <h1>{persistence?.title || "构图工作台"}</h1>
        </div>
        <div className="wb-primary-actions">
          <button type="button" className="wb-button wb-button-quiet" disabled={busy} onClick={onReset}>
            <ImagePlus size={17} aria-hidden="true" />{persistence ? "导入另一张" : "分析另一张"}
          </button>
          <button type="button" className="wb-button" disabled={!hasPendingChanges || locked} onClick={onSave} aria-busy={savingDraft}>
            {savingDraft ? <LoaderCircle className="is-spinning" size={17} aria-hidden="true" /> : <Save size={17} aria-hidden="true" />}
            {savingDraft ? "正在保存" : persistence ? "保存草稿" : confirmationPending ? "确认当前方案" : "应用裁剪"}
          </button>
          {persistence && <button type="button" className="wb-button wb-button-primary" onClick={persistence.onArchive}
            disabled={locked || (persistence.state === "archived" && !persistence.hasDraftChanges && !hasPendingChanges)} aria-busy={persistence.archiving}>
            {persistence.archiving ? <LoaderCircle className="is-spinning" size={17} aria-hidden="true" /> : <Check size={17} aria-hidden="true" />}
            {persistence.archiving ? "正在归档" : persistence.state === "archived" ? "保存新版本" : "完成并归档"}
          </button>}
          <button type="button" className={`wb-button${persistence ? "" : " wb-button-primary"}`} disabled={locked} onClick={onDownload} aria-busy={activity === "download"}>
            {activity === "download" ? <LoaderCircle className="is-spinning" size={17} aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}
            {activity === "download" ? "正在准备下载" : "下载裁剪图"}
          </button>
        </div>
      </header>

      <div className={`wb-source-note${jobExpired ? " is-expired" : ""}`} role="status">
        <span className="wb-source-label">{sourceHeading}</span><span>{sourceNote}</span>
      </div>

      <div className="wb-workspace-grid">
        <section className="wb-canvas-column" aria-label="照片编辑区域">
          <div className="wb-canvas-toolbar">
            <div className="wb-view-tabs" role="tablist" aria-label="画布视图">
              {VIEWS.map(({ id: value, label, Icon }, index) => (
                <button type="button" role="tab" key={value} id={`${id}-view-${value}`}
                  aria-selected={view === value} aria-controls={`${id}-canvas-panel`}
                  tabIndex={view === value ? 0 : -1} onClick={() => setView(value)}
                  onKeyDown={(event) => switchTab(event, VIEWS, index, setView)}>
                  <Icon size={16} aria-hidden="true" />{label}
                </button>
              ))}
            </div>
            {cropDirty && <span className="wb-change-status">{persistence ? "有更新待保存" : "未应用修改"}</span>}
          </div>

          <div className={`wb-view-panel wb-view-${view}`} id={`${id}-canvas-panel`} role="tabpanel"
            aria-labelledby={`${id}-view-${view}`} data-view={view} tabIndex={0}>
            {view === "crop" && editor}
            {view === "preview" && <div className="wb-single-preview"><CropPreview imageUrl={sourceUrl} crop={draftCrop} /></div>}
            {view === "compare" && <div className="wb-compare-grid">
              <div><h2>原图 · 裁剪编辑</h2>{editor}</div>
              <div className="wb-compare-preview"><h2>当前成片</h2><div className="wb-single-preview"><CropPreview imageUrl={sourceUrl} crop={draftCrop} /></div></div>
            </div>}
          </div>

          <div className="wb-canvas-meta">
            <span><Move size={15} aria-hidden="true" />{view === "preview" ? "当前裁剪预览" : "拖动或使用方向键调整"}</span>
            <span>{metrics.outputWidth} × {metrics.outputHeight} px <span aria-hidden="true">·</span> 保留 {metrics.retainedPercent.toFixed(1)}%</span>
          </div>
          <div className="wb-canvas-secondary">
            <details className="wb-composition-details">
              <summary><SlidersHorizontal size={16} aria-hidden="true" />辅助线与尺寸<ChevronDown className="wb-disclosure-chevron" size={15} aria-hidden="true" /></summary>
              <CompositionTools crop={draftCrop} imageWidth={job.image_width} imageHeight={job.image_height}
                intent={job.intent} guides={guides} processingDurationMs={job.processing_duration_ms}
                pregenerated={pregenerated} onToggleGuide={onToggleGuide} />
            </details>
            <button type="button" className="wb-restore" onClick={onRestoreSuggestion}
              disabled={locked || !job.ai_crop || cropEquals(job.ai_crop, draftCrop)}>
              <RotateCcw size={15} aria-hidden="true" />{pregenerated ? "恢复固定示例" : "恢复 AI 建议"}
            </button>
          </div>
          <p className="wb-temporary-note">{persistence
            ? "草稿与归档作品保留至主动删除，可从作品库继续编辑。辅助线不写入下载成片。"
            : "按原始分辨率裁剪，辅助线不写入成片。图片与方案仅随当前临时任务保存，请及时下载。"}</p>
        </section>

        <aside className="wb-inspector" aria-label="参考与图像信息">
          <div className="wb-tool-tabs" role="tablist" aria-label="参考工具">
            {TOOLS.map(({ id: value, label }, index) => (
              <button type="button" role="tab" key={value} id={`${id}-tool-${value}`}
                aria-selected={tool === value} aria-controls={`${id}-tool-panel-${value}`}
                tabIndex={tool === value ? 0 : -1} onClick={() => setTool(value)}
                onKeyDown={(event) => switchTab(event, TOOLS, index, setTool)}>{label}</button>
            ))}
          </div>

          <section className="wb-tool-panel" role="tabpanel" id={`${id}-tool-panel-image`}
            aria-labelledby={`${id}-tool-image`} hidden={tool !== "image"} tabIndex={0}>
            <ImageAnalysisPanel sourceUrl={sourceUrl} width={job.image_width} height={job.image_height}
              crop={draftCrop} enabled={analysisEnabled && tool === "image" && !jobExpired} sample={pregenerated} />
            <dl className="wb-image-facts">
              <div><dt>原图尺寸</dt><dd>{job.image_width} × {job.image_height}</dd></div>
              <div><dt>当前裁剪</dt><dd>{metrics.outputWidth} × {metrics.outputHeight}</dd></div>
              <div><dt>目标比例</dt><dd>{intentRatioLabel(job.intent)}</dd></div>
              <div><dt>比例状态</dt><dd>{metrics.ratioCompliant ? "符合目标" : "需要调整"}</dd></div>
              <div><dt>保留面积</dt><dd>{metrics.retainedPercent.toFixed(1)}%</dd></div>
            </dl>
          </section>

          <section className="wb-tool-panel" role="tabpanel" id={`${id}-tool-panel-ai`}
            aria-labelledby={`${id}-tool-ai`} hidden={tool !== "ai"} tabIndex={0}>
            {persistence && <div className="wb-ai-request">
              <button type="button" className="wb-button" onClick={persistence.onAnalyze} disabled={locked || persistence.analysisBusy} aria-busy={persistence.analysisBusy}>
                {persistence.analysisBusy ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
                {persistence.analysisBusy ? "正在生成参考" : job.report ? "重新获取 AI 参考" : "获取 AI 构图参考"}
              </button>
              <p role="status">{persistence.analysisMessage || "按需调用，不影响草稿保存；新参考不会自动覆盖当前取景。"}</p>
            </div>}
            {!manualOnly && job.candidates.length > 0 && <CandidatePanel imageUrl={sourceUrl} candidates={job.candidates}
              selectedCandidateId={selectedCandidateId} pregenerated={pregenerated} referenceOnly={Boolean(persistence)} disabled={locked} onSelect={onSelectCandidate} />}
            {manualOnly && <div className="wb-feature-notice"><Crop size={26} aria-hidden="true" />
              <h2>{persistence ? "参考可选，创作继续" : jobExpired ? "当前任务已结束" : "继续手动精修"}</h2>
              <p>{persistence ? "尚无可用的 AI 参考。直接精修、下载和归档都不受影响。" : jobExpired ? "当前图片仅供查看。请重新上传照片继续精修。" : "本次未生成可用的 AI 参考。画布中的裁剪与预览仍可使用。"}</p></div>}
            {(job.report || (manualOnly && !jobExpired && !persistence)) && <details className="wb-report-details">
              <summary><Sparkles size={16} aria-hidden="true" />{manualOnly ? "查看当前模式说明" : "展开画面分析"}<ChevronDown className="wb-disclosure-chevron" size={15} aria-hidden="true" /></summary>
              <ReportPanel report={job.report} adjusted={adjusted} manualOnly={manualOnly} source={source} />
            </details>}
            {!manualOnly && adjusted && <p className="wb-reference-note">报告解释初始参考，当前成片已由你选择或调整。</p>}
          </section>

          <section className="wb-tool-panel" role="tabpanel" id={`${id}-tool-panel-exif`}
            aria-labelledby={`${id}-tool-exif`} hidden={tool !== "exif"} tabIndex={0}>
            <ShotParameters exif={exif} sample={pregenerated} />
          </section>

          <details className="wb-reasons-details">
            <summary><MessageSquareText size={16} aria-hidden="true" />记录选择依据<span>可选</span><ChevronDown className="wb-disclosure-chevron" size={15} aria-hidden="true" /></summary>
            <SelectionReasonPanel reasons={selectionReasons} note={selectionNote} disabled={locked} persistent={!!persistence}
              onReasonsChange={onReasonsChange} onNoteChange={onNoteChange} />
          </details>
          <div className="wb-save-status" role="status"><Check size={15} aria-hidden="true" />{status}</div>
        </aside>
      </div>
    </div>
  );
}
