import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { WorkspacePreferences } from "../workspaceApi";
import { PreferencesForm, preferencePresetValue, samePreferenceSettings } from "./PreferencesForm";

function preferences(overrides: Partial<WorkspacePreferences> = {}): WorkspacePreferences {
  return { revision: 4, intent: { scene: "landscape", aspect_ratio: "16:9", output_template: "social_cover", custom_ratio: null },
    guides: ["center", "safe"], ...overrides };
}

describe("photography preferences", () => {
  it("renders saved defaults with visible labels and real guide selection", () => {
    const markup = renderToStaticMarkup(<PreferencesForm preferences={preferences()} onSave={vi.fn()} onRefresh={vi.fn()} />);
    expect(markup).toContain("创作偏好");
    expect(markup).toContain("常用用途");
    expect(markup).toContain("裁剪比例与模板");
    expect(markup).toContain('value="landscape" selected=""');
    expect(markup).toContain('value="social_cover" selected=""');
    expect(markup.match(/checked=""/g)).toHaveLength(2);
    expect(markup).toContain("中心线");
    expect(markup).toContain("安全区");
    expect(markup).toContain("可以组合使用，也可以全部关闭");
    expect(markup).toContain("辅助线不会出现在下载的照片中");
    expect(markup).toContain("已有作品不受影响");
    expect(markup).toContain('type="submit" class="sc-workspace-button" disabled=""');
  });

  it("distinguishes initial loading, an unread account and a load error", () => {
    const loading = renderToStaticMarkup(<PreferencesForm loading />);
    expect(loading).toContain("正在读取偏好设置");
    expect(loading).not.toContain("<form");
    expect(loading).not.toContain("偏好已保存");
    const unread = renderToStaticMarkup(<PreferencesForm onRefresh={vi.fn()} />);
    expect(unread).toContain("读取偏好设置");
    expect(unread).not.toContain("<form");
    const failed = renderToStaticMarkup(<PreferencesForm error="偏好读取失败" onRefresh={vi.fn()} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("偏好读取失败");
    expect(failed).toContain("重新读取偏好");
  });

  it("keeps a loaded draft visible but disables its fields during refresh", () => {
    const markup = renderToStaticMarkup(<PreferencesForm preferences={preferences()} loading />);
    expect(markup).toContain("正在刷新偏好设置");
    expect(markup).toContain('value="landscape" selected=""');
    expect(markup).toContain('class="sc-preferences-fields" disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it("reveals custom ratio inputs only for a custom template", () => {
    const saved = preferences({ intent: { scene: "portrait", aspect_ratio: "custom", output_template: "custom", custom_ratio: { width: 3, height: 4 } } });
    const custom = renderToStaticMarkup(<PreferencesForm preferences={saved} />);
    expect(custom).toContain("比例宽度");
    expect(custom).toContain("比例高度");
    expect(custom).toContain('value="3"');
    expect(custom).toContain('value="4"');
    expect(custom).toContain('inputMode="numeric"');
    expect(custom).toContain('aria-describedby=');
    const fixed = renderToStaticMarkup(<PreferencesForm preferences={preferences()} />);
    expect(fixed).not.toContain('type="number"');
  });

  it("preserves an older unsupported template-ratio pairing instead of silently substituting it", () => {
    const saved = preferences({ intent: { scene: "portrait", aspect_ratio: "3:4", output_template: null, custom_ratio: null } });
    const markup = renderToStaticMarkup(<PreferencesForm preferences={saved} />);
    expect(preferencePresetValue(saved.intent)).toBe("saved");
    expect(markup).toContain('value="saved" selected=""');
    expect(markup).toContain("当前画幅 · 3:4");
    expect(saved.intent).toEqual({ scene: "portrait", aspect_ratio: "3:4", output_template: null, custom_ratio: null });
  });

  it("treats revisions and guide ordering as metadata, but detects any actual changed setting", () => {
    const base = preferences();
    expect(samePreferenceSettings(base, preferences({ revision: 5, guides: ["safe", "center"] }))).toBe(true);
    expect(samePreferenceSettings(base, preferences({ guides: [] }))).toBe(false);
    expect(samePreferenceSettings(base, preferences({ intent: { ...base.intent, scene: "social" } }))).toBe(false);
    const custom = preferences({ intent: { ...base.intent, aspect_ratio: "custom", output_template: "custom", custom_ratio: { width: 3, height: 4 } } });
    expect(samePreferenceSettings(custom, { ...custom, intent: { ...custom.intent, custom_ratio: { width: 4, height: 3 } } })).toBe(false);
    expect(base.guides).toEqual(["center", "safe"]);
  });

  it("supports saved preferences with every guide turned off", () => {
    const markup = renderToStaticMarkup(<PreferencesForm preferences={preferences({ guides: [] })} />);
    expect(markup.match(/type="checkbox"/g)).toHaveLength(4);
    expect(markup).not.toContain('checked=""');
  });
});
