import { ArrowUpRight, BookOpen, LockKeyhole, ShieldCheck, UploadCloud, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  createAnalysisIntent,
  isCustomRatioValid,
  PUBLICATION_PRESETS,
} from "../lib/publishing";
import type { AnalysisIntent, OutputTemplate, RunProvenance, SceneType } from "../types";
import type { WorkspacePreferences } from "../workspaceApi";
import { StudioIntro, StudioSections } from "./StudioShowcase";

interface Props {
  accessCode: string;
  onAccessCodeChange: (value: string) => void;
  onSubmit: (file: File, intent: AnalysisIntent, provenance: RunProvenance, customized?: boolean) => Promise<void>;
  onOpenPregeneratedDemo: (intent: AnalysisIntent) => void;
  busy: boolean;
  variant?: "showcase" | "workspace";
  active?: boolean;
  mainId?: string;
  persistent?: boolean;
  defaults?: WorkspacePreferences;
  defaultsRequired?: boolean;
  defaultsLoading?: boolean;
  defaultsError?: string;
  onRetryDefaults?: () => void;
}

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 20 * 1024 * 1024;
const SAMPLE_INTENT = createAnalysisIntent("general", "freeform", { width: 4, height: 3 });

type ClipboardItemLike = Pick<DataTransferItem, "getAsFile" | "kind" | "type">;

export function firstPastedImage(
  items: ArrayLike<ClipboardItemLike> | null | undefined,
): File | null {
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

export function UploadPanel({
  accessCode,
  onAccessCodeChange,
  onSubmit,
  onOpenPregeneratedDemo,
  busy,
  variant = "showcase",
  active = true,
  mainId = "main-content",
  persistent = false,
  defaults,
  defaultsRequired = false,
  defaultsLoading = false,
  defaultsError = "",
  onRetryDefaults,
}: Props) {
  const componentId = useId();
  const elementId = (name: string) => `${componentId}-${name}`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragging, setDragging] = useState(false);
  const [intent, setIntent] = useState<AnalysisIntent>(defaults?.intent ?? SAMPLE_INTENT);
  const [customRatio, setCustomRatio] = useState(defaults?.intent.custom_ratio ?? { width: 4, height: 3 });
  const [customized, setCustomized] = useState(false);
  const scene = intent.scene;
  const outputTemplate = intent.output_template ?? (intent.aspect_ratio === "free" ? "freeform" : "retained");
  const customRatioWidth = customRatio.width;
  const customRatioHeight = customRatio.height;
  const defaultsReady = !defaultsRequired || Boolean(defaults && !defaultsLoading && !defaultsError);
  useEffect(() => {
    if (!defaults || customized) return;
    setIntent(defaults.intent);
    setCustomRatio(defaults.intent.custom_ratio ?? { width: 4, height: 3 });
  }, [defaults, customized]);
  const chooseTemplate = (template: OutputTemplate) => {
    setCustomized(true);
    setIntent(createAnalysisIntent(scene, template, customRatio));
  };
  const changeCustomRatio = (dimension: "width" | "height", value: number) => {
    setCustomized(true);
    const next = { ...customRatio, [dimension]: value };
    setCustomRatio(next);
    setIntent({ ...intent, custom_ratio: next });
  };

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = useCallback((candidate?: File, source: "picker" | "paste" = "picker") => {
    if (!candidate) return;
    if (!ACCEPTED.has(candidate.type)) {
      setAnnouncement("");
      setError("请选择 JPEG、PNG 或 WebP 图片");
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setAnnouncement("");
      setError("图片不能超过 20 MB");
      return;
    }
    setError("");
    setFile(candidate);
    setAnnouncement(source === "paste" ? `已粘贴图片：${candidate.name || "剪贴板图片"}` : "");
  }, []);

  const customRatioValid = outputTemplate !== "custom" || isCustomRatioValid({
    width: customRatioWidth,
    height: customRatioHeight,
  });

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (busy || !active) return;
      const pasted = firstPastedImage(event.clipboardData?.items);
      if (!pasted) return;
      event.preventDefault();
      choose(pasted, "paste");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [active, busy, choose]);

  return (
    <main className={`upload-shell${variant === "workspace" ? " workspace-import" : ""}`} id={mainId} tabIndex={-1}>
      {variant === "showcase" ? (
        <div className="home-kicker"><span className="eyebrow">你的灵感，从这里开始</span><span className="studio-edition">SMARTCROP / CREATIVE STUDIO</span></div>
      ) : (
        <div className="workspace-import-heading"><p className="eyebrow">Your creative workspace</p><h1>构图工作台</h1><p>{persistent ? "导入即建立独立作品草稿，可以直接精修；AI 构图参考按需获取。" : "选一张照片，从新的取景开始。本阶段沿用临时分析任务，尚未启用自动归档。"}</p></div>
      )}
      <div className="creation-grid">
      {variant === "showcase" ? <StudioIntro /> : (
        <section className="workspace-import-stage" aria-label="创作画布说明">
          <div><strong>把注意力，留给画面。</strong><span>等待导入照片</span></div>
          <figure><img src="/images/alpine-lake.jpg" alt="用于介绍工作台的山间湖泊照片，并非当前编辑项目" width="1400" height="933" /><figcaption>留下风景，也留下你的视角。<span>摄影示意 · 非 AI 推理结果</span></figcaption></figure>
          <p>{persistent ? "照片与编辑草稿独立保存，刷新或重新登录后仍可继续。最终构图由你决定，不必先运行模型。" : "分析后即可拖动取景框、切换构图方向，再下载成片。当前页面的调整仅在本次打开期间保留。"}</p>
        </section>
      )}
      <section className="upload-card" id={variant === "showcase" ? "upload-workbench" : elementId("upload-workbench")} aria-labelledby={elementId("upload-title")}>
        <div className="section-heading">
          <div className="upload-title-group">
            <span className="upload-step" aria-hidden="true">01</span>
            <div><p className="eyebrow">开始创作</p><h2 id={elementId("upload-title")}>选择你的照片</h2></div>
          </div>
          <button
            type="button"
            className="sample-link"
            disabled={busy}
            onClick={() => onOpenPregeneratedDemo(SAMPLE_INTENT)}
          >
            <BookOpen aria-hidden="true" size={16} />查看使用样例
          </button>
        </div>

        <button
          type="button"
          className={`drop-zone ${dragging ? "is-dragging" : ""} ${previewUrl ? "has-preview" : ""}`}
          aria-describedby={error ? elementId("upload-error") : undefined}
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (busy) return;
            choose(event.dataTransfer.files[0]);
          }}
        >
          {previewUrl ? (
            <img className="upload-preview" src={previewUrl} alt={`已选择图片预览：${file?.name || "图片"}`} />
          ) : (
            <span className="upload-icon"><UploadCloud aria-hidden="true" size={26} /></span>
          )}
          <strong>{file ? "已选择图片" : "拖入或粘贴图片，也可点击浏览"}</strong>
          <span>
            {file
              ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`
              : "支持拖拽文件、Ctrl / ⌘ + V 粘贴"}
          </span>
          {!file && <small className="upload-formats">JPG / PNG / WEBP · 最大 20 MB</small>}
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          aria-label="选择待裁剪照片"
          tabIndex={-1}
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {error && <p className="field-error upload-file-error" id={elementId("upload-error")} role="alert">{error}</p>}

        {file && (
          <button
            type="button"
            className="clear-file"
            disabled={busy}
            onClick={() => {
              setFile(null);
              setError("");
              setAnnouncement("");
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            <X aria-hidden="true" size={16} />清除当前图片
          </button>
        )}

        <fieldset className="intent-fieldset" disabled={busy}>
          <legend className="card-step-label"><span aria-hidden="true">02</span>告诉我们你的创作意图</legend>
          <label><span id={elementId("scene-label")}>使用场景</span>
            <select aria-labelledby={elementId("scene-label")} value={scene} onChange={(event) => { setCustomized(true); setIntent({ ...intent, scene: event.target.value as SceneType }); }}>
              <option value="general">通用构图</option>
              <option value="portrait">人像</option>
              <option value="landscape">风光</option>
              <option value="product">产品</option>
              <option value="social">社交媒体</option>
            </select>
          </label>
          <label><span id={elementId("output-template-label")}>发布模板</span>
            <select
              aria-labelledby={elementId("output-template-label")}
              value={outputTemplate}
              onChange={(event) => chooseTemplate(event.target.value as OutputTemplate)}
            >
              {outputTemplate === "retained" && <option value="retained">当前画幅 · {intent.aspect_ratio}</option>}
              {PUBLICATION_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} · {preset.ratioLabel}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <p className="template-description">
          {PUBLICATION_PRESETS.find((preset) => preset.id === outputTemplate)?.description}
        </p>
        {defaultsRequired && <div className="template-description" aria-live="polite">
          {defaultsLoading ? <p role="status">正在读取创作偏好…</p> : defaultsError ? <>
            <p role="alert">创作偏好暂时无法读取。请重试后导入照片。</p>
            <button type="button" className="text-button" onClick={onRetryDefaults}>重试读取偏好</button>
          </> : defaults && <p>{customized ? "已调整本次设置，不会更改摄影档案。" : "已采用摄影档案中的创作偏好，可为这张照片调整。"}</p>}
        </div>}

        {outputTemplate === "custom" && (
          <fieldset className="custom-ratio-fieldset" disabled={busy}>
            <legend>自定义宽高比</legend>
            <label htmlFor={elementId("custom-ratio-width")}>宽
              <input
                id={elementId("custom-ratio-width")}
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                value={customRatioWidth}
                onChange={(event) => changeCustomRatio("width", Number(event.target.value))}
              />
            </label>
            <span aria-hidden="true">:</span>
            <label htmlFor={elementId("custom-ratio-height")}>高
              <input
                id={elementId("custom-ratio-height")}
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                value={customRatioHeight}
                onChange={(event) => changeCustomRatio("height", Number(event.target.value))}
              />
            </label>
            {!customRatioValid && (
              <p className="field-error" role="alert">
                宽和高需为 1 至 100 的整数，比例在 1:10 至 10:1 之间
              </p>
            )}
          </fieldset>
        )}

        {!persistent && <label className="access-field">
          <span><LockKeyhole aria-hidden="true" size={16} />演示访问码</span>
          <input
            type="password"
            disabled={busy}
            autoComplete="current-password"
            value={accessCode}
            onChange={(event) => onAccessCodeChange(event.target.value)}
            placeholder="服务器未启用时可留空"
          />
        </label>}

        <button
          type="button"
          className="primary-button"
          disabled={!file || busy || !customRatioValid || !defaultsReady}
          onClick={() => file && onSubmit(
            file,
            intent,
            "upload",
            customized,
          )}
        >
          <ScanIcon />
          {busy ? "正在导入" : persistent ? "导入并开始创作" : "开始美学分析"}
          <ArrowUpRight aria-hidden="true" size={18} />
        </button>
        <p className="upload-privacy"><ShieldCheck aria-hidden="true" size={14} />{persistent ? "登录后存入共用演示账号，保留至主动删除；不进入训练集" : "1 小时后清理，不进入训练集"}</p>
      </section>
      </div>
      {variant === "showcase" && <StudioSections
        persistent={persistent}
        selectedTemplate={outputTemplate === "retained" ? "custom" : outputTemplate}
        disabled={busy}
        onChooseTemplate={(template, nextScene) => {
          setCustomized(true);
          setIntent(createAnalysisIntent(nextScene, template, customRatio));
        }}
      />}
    </main>
  );
}

function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
