import { BookOpen, FileImage, LoaderCircle, LockKeyhole, Play, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadAuthorizedDemoFile } from "../lib/demo";
import {
  createAnalysisIntent,
  isCustomRatioValid,
  PUBLICATION_PRESETS,
} from "../lib/publishing";
import type { AnalysisIntent, OutputTemplate, RunProvenance, SceneType } from "../types";

interface Props {
  accessCode: string;
  onAccessCodeChange: (value: string) => void;
  onSubmit: (file: File, intent: AnalysisIntent, provenance: RunProvenance) => Promise<void>;
  onOpenPregeneratedDemo: (intent: AnalysisIntent) => void;
  busy: boolean;
}

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 20 * 1024 * 1024;

export function UploadPanel({
  accessCode,
  onAccessCodeChange,
  onSubmit,
  onOpenPregeneratedDemo,
  busy,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [scene, setScene] = useState<SceneType>("general");
  const [outputTemplate, setOutputTemplate] = useState<OutputTemplate>("freeform");
  const [customRatioWidth, setCustomRatioWidth] = useState(4);
  const [customRatioHeight, setCustomRatioHeight] = useState(3);
  const [sampleLoaded, setSampleLoaded] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (candidate?: File, fromDemo = false) => {
    if (!candidate) return;
    if (!ACCEPTED.has(candidate.type)) {
      setError("请选择 JPEG、PNG 或 WebP 图片");
      return;
    }
    if (candidate.size > MAX_BYTES) {
      setError("图片不能超过 20 MB");
      return;
    }
    setError("");
    setFile(candidate);
    setSampleLoaded(fromDemo);
  };

  const customRatioValid = outputTemplate !== "custom" || isCustomRatioValid({
    width: customRatioWidth,
    height: customRatioHeight,
  });
  const intent = createAnalysisIntent(
    scene,
    outputTemplate,
    { width: customRatioWidth, height: customRatioHeight },
  );

  const loadRealtimeSample = async () => {
    setSampleLoading(true);
    setError("");
    try {
      choose(await loadAuthorizedDemoFile(), true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "演示样例加载失败");
    } finally {
      setSampleLoading(false);
    }
  };

  return (
    <main className="upload-shell" id="main-content">
      <section className="intro-panel">
        <p className="eyebrow">AI aesthetic cropping</p>
        <h1>把注意力留给画面本身</h1>
        <p className="intro-copy">
          先说明用途和成片比例，再从三种构图偏好中选择方向并完成精修。
        </p>
        <dl className="intro-facts">
          <div><dt>输出</dt><dd>三种构图偏好 + 可编辑成片 + 方案文件</dd></div>
          <div><dt>隐私</dt><dd>任务文件将在 1 小时后清理</dd></div>
          <div><dt>格式</dt><dd>JPEG、PNG、WebP，最大 20 MB</dd></div>
        </dl>
      </section>

      <section className="upload-card" aria-labelledby="upload-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">新建任务</p>
            <h2 id="upload-title">选择图片</h2>
          </div>
          <FileImage aria-hidden="true" size={24} />
        </div>

        <section className="demo-entry" aria-labelledby="demo-entry-heading">
          <div>
            <strong id="demo-entry-heading">答辩演示入口</strong>
            <span>仓库自制合成样例，明确区分实时处理与预生成导览。</span>
          </div>
          <div className="demo-entry-actions">
            <button
              type="button"
              className="demo-button"
              disabled={busy || sampleLoading}
              onClick={loadRealtimeSample}
            >
              {sampleLoading
                ? <LoaderCircle className="spin" aria-hidden="true" size={16} />
                : <Play aria-hidden="true" size={16} />}
              载入实时样例
            </button>
            <button
              type="button"
              className="demo-button"
              disabled={busy || !customRatioValid}
              onClick={() => onOpenPregeneratedDemo(intent)}
            >
              <BookOpen aria-hidden="true" size={16} />预生成导览
            </button>
          </div>
        </section>

        <button
          type="button"
          className={`drop-zone ${dragging ? "is-dragging" : ""} ${previewUrl ? "has-preview" : ""}`}
          aria-describedby={error ? "upload-error" : undefined}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(event.dataTransfer.files[0]);
          }}
        >
          {previewUrl ? (
            <img className="upload-preview" src={previewUrl} alt={`已选择图片预览：${file?.name || "图片"}`} />
          ) : (
            <UploadCloud aria-hidden="true" size={30} />
          )}
          <strong>{file ? "已选择图片" : "拖入图片，或点击浏览"}</strong>
          <span>{file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : "只处理单张图片"}</span>
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => choose(event.target.files?.[0])}
        />

        {file && (
          <button
            type="button"
            className="clear-file"
            onClick={() => {
              setFile(null);
              setSampleLoaded(false);
              if (inputRef.current) inputRef.current.value = "";
            }}
          >
            <X aria-hidden="true" size={16} />清除当前图片
          </button>
        )}

        <fieldset className="intent-fieldset">
          <legend>成片意图</legend>
          <label>使用场景
            <select value={scene} onChange={(event) => setScene(event.target.value as SceneType)}>
              <option value="general">通用构图</option>
              <option value="portrait">人像</option>
              <option value="landscape">风光</option>
              <option value="product">产品</option>
              <option value="social">社交媒体</option>
            </select>
          </label>
          <label>发布模板
            <select
              value={outputTemplate}
              onChange={(event) => setOutputTemplate(event.target.value as OutputTemplate)}
            >
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

        {outputTemplate === "custom" && (
          <fieldset className="custom-ratio-fieldset">
            <legend>自定义宽高比</legend>
            <label htmlFor="custom-ratio-width">宽
              <input
                id="custom-ratio-width"
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                value={customRatioWidth}
                onChange={(event) => setCustomRatioWidth(Number(event.target.value))}
              />
            </label>
            <span aria-hidden="true">:</span>
            <label htmlFor="custom-ratio-height">高
              <input
                id="custom-ratio-height"
                type="number"
                inputMode="numeric"
                min="1"
                max="100"
                step="1"
                value={customRatioHeight}
                onChange={(event) => setCustomRatioHeight(Number(event.target.value))}
              />
            </label>
            {!customRatioValid && (
              <p className="field-error" role="alert">
                宽和高需为 1 至 100 的整数，比例在 1:10 至 10:1 之间
              </p>
            )}
          </fieldset>
        )}

        <label className="access-field">
          <span><LockKeyhole aria-hidden="true" size={16} />演示访问码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={accessCode}
            onChange={(event) => onAccessCodeChange(event.target.value)}
            placeholder="服务器未启用时可留空"
          />
        </label>

        {error && <p className="field-error" id="upload-error" role="alert">{error}</p>}
        <button
          type="button"
          className="primary-button"
          disabled={!file || busy || !customRatioValid}
          onClick={() => file && onSubmit(
            file,
            intent,
            sampleLoaded ? "authorized_realtime" : "upload",
          )}
        >
          <ScanIcon />
          {busy ? "正在提交" : sampleLoaded ? "实时分析演示样例" : "开始美学分析"}
        </button>
      </section>
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
