import { Check, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../api";
import { createAnalysisIntent, intentRatioLabel, isCustomRatioValid, PUBLICATION_PRESETS } from "../lib/publishing";
import type { AnalysisIntent, CompositionGuide, CustomRatio, OutputTemplate, SceneType } from "../types";
import type { WorkspacePreferences } from "../workspaceApi";

import "./preferences.css";

export interface PreferencesFormProps {
  preferences?: WorkspacePreferences;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onSave?: (value: WorkspacePreferences) => Promise<WorkspacePreferences>;
  onDirtyChange?: (dirty: boolean) => void;
}

const SCENES: Array<[SceneType, string]> = [
  ["general", "通用构图"], ["portrait", "人物摄影"], ["landscape", "风景摄影"],
  ["product", "商品展示"], ["social", "社交分享"],
];
const GUIDES: Array<[CompositionGuide, string, string]> = [
  ["thirds", "三分线", "将主体放在画面的三分处"],
  ["center", "中心线", "寻找对称与画面中心"],
  ["diagonal", "对角线", "观察画面中的方向与动势"],
  ["safe", "安全区", "给边缘内容留一点余量"],
];

export function preferencePresetValue(intent: AnalysisIntent): OutputTemplate | "saved" {
  const preset = PUBLICATION_PRESETS.find((item) => item.id === intent.output_template);
  return preset?.aspectRatio === intent.aspect_ratio ? preset.id : "saved";
}

export function samePreferenceSettings(left: WorkspacePreferences, right: WorkspacePreferences): boolean {
  return left.intent.scene === right.intent.scene
    && left.intent.aspect_ratio === right.intent.aspect_ratio
    && left.intent.output_template === right.intent.output_template
    && left.intent.custom_ratio?.width === right.intent.custom_ratio?.width
    && left.intent.custom_ratio?.height === right.intent.custom_ratio?.height
    && [...left.guides].sort().join(",") === [...right.guides].sort().join(",");
}

function copyPreferences(value: WorkspacePreferences): WorkspacePreferences {
  return { revision: value.revision, intent: { ...value.intent,
    custom_ratio: value.intent.custom_ratio ? { ...value.intent.custom_ratio } : null }, guides: [...value.guides] };
}

export function PreferencesForm({ preferences, loading, error, onRefresh, onSave, onDirtyChange }: PreferencesFormProps) {
  const [base, setBase] = useState(() => preferences ? copyPreferences(preferences) : undefined);
  const [draft, setDraft] = useState(() => preferences ? copyPreferences(preferences) : undefined);
  const [customRatio, setCustomRatio] = useState<CustomRatio>(() => preferences?.intent.custom_ratio || { width: 4, height: 3 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [ratioTouched, setRatioTouched] = useState(false);
  const [conflict, setConflict] = useState(false);
  const mounted = useRef(true);
  const dirtyCallback = useRef(onDirtyChange);
  const ratioWidth = useRef<HTMLInputElement>(null);
  const formId = useId();
  const dirty = Boolean(base && draft && !samePreferenceSettings(base, draft));
  const invalidRatio = draft?.intent.output_template === "custom" && !isCustomRatioValid(customRatio);

  useEffect(() => { dirtyCallback.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { dirtyCallback.current?.(dirty); }, [dirty]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; dirtyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    if (!preferences || dirty || saving) return;
    if (base && preferences.revision <= base.revision) return;
    setBase(copyPreferences(preferences));
    setDraft(copyPreferences(preferences));
    setCustomRatio(preferences.intent.custom_ratio || { width: 4, height: 3 });
    setRatioTouched(false);
    setConflict(false);
  }, [preferences, base, dirty, saving]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const edit = (value: WorkspacePreferences) => {
    setDraft(value);
    setMessage("");
    setSaveError("");
  };
  const reload = () => {
    if (saving || loading) return;
    if (dirty && !window.confirm("重新载入会放弃本页尚未保存的偏好设置，是否继续？")) return;
    if (preferences) {
      setBase(copyPreferences(preferences));
      setDraft(copyPreferences(preferences));
      setCustomRatio(preferences.intent.custom_ratio || { width: 4, height: 3 });
    }
    setSaveError(""); setMessage(""); setConflict(false); setRatioTouched(false);
    onRefresh?.();
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !onSave || saving || loading || !dirty || conflict) return;
    if (invalidRatio) { setRatioTouched(true); ratioWidth.current?.focus(); return; }
    setSaving(true); setSaveError(""); setMessage("");
    try {
      const saved = await onSave(copyPreferences(draft));
      if (!mounted.current) return;
      setBase(copyPreferences(saved)); setDraft(copyPreferences(saved));
      setCustomRatio(saved.intent.custom_ratio || customRatio);
      setConflict(false);
      setMessage("偏好已保存，下次新建作品会自动采用。已有作品保持原样。");
    } catch (failure) {
      if (!mounted.current) return;
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setSaveError("偏好已在其他页面更新。你的修改仍保留，请重新载入最新设置后再调整。");
      } else {
        setSaveError(failure instanceof ApiError ? failure.message : "偏好暂时未能保存，你的修改仍保留。请稍后再试。");
      }
    } finally { if (mounted.current) setSaving(false); }
  };

  return <section className="sc-workspace-defaults sc-preferences" aria-labelledby={`${formId}-title`} aria-busy={saving || loading || undefined}>
    <div className="sc-workspace-section-heading"><div><p className="sc-workspace-eyebrow">Your familiar starting point</p>
      <h2 id={`${formId}-title`}>创作偏好</h2></div><SlidersHorizontal size={21} aria-hidden="true" /></div>
    <p>保存常用设置，让下一张照片从熟悉的方式开始。每件作品都可以单独调整。</p>
    {loading && <p className="sc-preferences-feedback" role="status">{draft ? "正在刷新偏好设置…" : "正在读取偏好设置…"}</p>}
    {error && <div className="sc-preferences-error" role="alert"><p>{error}</p>
      {onRefresh && <button type="button" className="sc-workspace-text-button" disabled={loading || saving} onClick={reload}><RefreshCw size={16} aria-hidden="true" />重新读取偏好</button>}</div>}
    {!draft && !loading && !error && <div className="sc-preferences-feedback"><p>读取账号偏好后，就可以设置创作起点。</p>
      {onRefresh && <button type="button" className="sc-workspace-text-button" onClick={reload}>读取偏好设置<RefreshCw size={16} aria-hidden="true" /></button>}</div>}
    {draft && <form onSubmit={submit} noValidate>
      <fieldset className="sc-preferences-fields" disabled={saving || loading}>
        <legend className="visually-hidden">默认创作设置</legend>
        <label className="sc-preferences-field" htmlFor={`${formId}-scene`}><span>常用用途</span>
          <select id={`${formId}-scene`} value={draft.intent.scene} onChange={(event) => edit({ ...draft, intent: { ...draft.intent, scene: event.target.value as SceneType } })}>
            {SCENES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="sc-preferences-field" htmlFor={`${formId}-preset`}><span>裁剪比例与模板</span>
          <select id={`${formId}-preset`} value={preferencePresetValue(draft.intent)} onChange={(event) => {
            setRatioTouched(false);
            edit({ ...draft, intent: createAnalysisIntent(draft.intent.scene, event.target.value as OutputTemplate, customRatio) });
          }}>
            {preferencePresetValue(draft.intent) === "saved" && <option value="saved">当前画幅 · {intentRatioLabel(draft.intent)}</option>}
            {PUBLICATION_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}{preset.id === "freeform" || preset.id === "custom" ? "" : ` · ${preset.ratioLabel}`}</option>)}
          </select>
        </label>
        {draft.intent.output_template === "custom" && <div className="sc-preferences-custom">
          <div className="sc-preferences-ratio-fields">{(["width", "height"] as const).map((dimension) => <label className="sc-preferences-field" key={dimension}
            htmlFor={`${formId}-${dimension}`}><span>{dimension === "width" ? "比例宽度" : "比例高度"}</span>
            <input ref={dimension === "width" ? ratioWidth : undefined} id={`${formId}-${dimension}`} type="number" min="1" max="100" step="1" inputMode="numeric"
              value={Number.isNaN(customRatio[dimension]) ? "" : customRatio[dimension]} aria-describedby={`${formId}-ratio-hint${ratioTouched && invalidRatio ? ` ${formId}-ratio-error` : ""}`}
              aria-invalid={ratioTouched && invalidRatio || undefined} onBlur={() => setRatioTouched(true)} onChange={(event) => {
                const next = { ...customRatio, [dimension]: event.target.value === "" ? NaN : Number(event.target.value) };
                setCustomRatio(next); edit({ ...draft, intent: { ...draft.intent, custom_ratio: next } });
              }} />
          </label>)}</div>
          <p id={`${formId}-ratio-hint`} className="sc-preferences-hint">例如 3 : 4 或 16 : 9，宽、高填写 1–100 的整数。</p>
          {ratioTouched && invalidRatio && <p id={`${formId}-ratio-error`} className="sc-preferences-field-error" role="alert">请填写 1–100 的整数，宽高比需在 1:10 到 10:1 之间。</p>}
        </div>}
        <fieldset className="sc-preferences-guides"><legend>默认辅助线</legend>
          <div>{GUIDES.map(([value, label, hint]) => <label key={value} className="sc-preferences-guide">
            <input type="checkbox" checked={draft.guides.includes(value)} onChange={() => edit({ ...draft,
              guides: draft.guides.includes(value) ? draft.guides.filter((guide) => guide !== value) : [...draft.guides, value] })} />
            <span><strong>{label}</strong><small>{hint}</small></span>
          </label>)}</div>
          <p className="sc-preferences-hint">可以组合使用，也可以全部关闭。辅助线不会出现在下载的照片中。</p>
        </fieldset>
      </fieldset>
      <div className="sc-preferences-actions"><button type="submit" className="sc-workspace-button" disabled={!dirty || saving || loading || !onSave || conflict}>
        {saving ? <RefreshCw size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{saving ? "正在保存偏好…" : "保存创作偏好"}</button>
        {onRefresh && <button type="button" className="sc-workspace-text-button" disabled={saving || loading} onClick={reload}><RefreshCw size={16} aria-hidden="true" />重新载入</button>}
      </div>
      <div className="sc-preferences-feedback" role="status" aria-live="polite">{message ? <span><Check size={16} aria-hidden="true" />{message}</span>
        : dirty ? "有尚未保存的偏好设置。" : "新建作品自动采用已保存偏好，已有作品不受影响。"}</div>
      {saveError && <p className="sc-preferences-error" role="alert">{saveError}</p>}
    </form>}
  </section>;
}
