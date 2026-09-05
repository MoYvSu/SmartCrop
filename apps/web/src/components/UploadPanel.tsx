import { FileImage, LockKeyhole, UploadCloud, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AnalysisIntent, AspectRatio, SceneType } from "../types";

interface Props {
  accessCode: string;
  onAccessCodeChange: (value: string) => void;
  onSubmit: (file: File, intent: AnalysisIntent) => Promise<void>;
  busy: boolean;
}

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 20 * 1024 * 1024;

export function UploadPanel({ accessCode, onAccessCodeChange, onSubmit, busy }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [scene, setScene] = useState<SceneType>("general");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("free");

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (candidate?: File) => {
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
  };

  return (
    <main className="upload-shell" id="main-content">
      <section className="intro-panel">
        <p className="eyebrow">AI aesthetic cropping</p>
        <h1>把注意力留给画面本身</h1>
        <p className="intro-copy">
          先说明用途和成片比例，再从三种构图策略中选择、微调并复评终稿。
        </p>
        <dl className="intro-facts">
          <div><dt>输出</dt><dd>三种构图策略 + 可编辑终稿 + 方案文件</dd></div>
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
          <label>成片比例
            <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
              <option value="free">自由比例</option>
              <option value="1:1">1:1 方形</option>
              <option value="4:5">4:5 竖图</option>
              <option value="3:4">3:4 竖图</option>
              <option value="16:9">16:9 横图</option>
            </select>
          </label>
        </fieldset>

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
          disabled={!file || busy}
          onClick={() => file && onSubmit(file, { scene, aspect_ratio: aspectRatio })}
        >
          <ScanIcon />
          {busy ? "正在提交" : "开始美学分析"}
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
