import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectSummary, WorkspacePreferences } from "../workspaceApi";
import { PhotographerIdentityCard } from "./PhotographerIdentityCard";

const user = { id: "demo", username: "demo", display_name: "演示摄影师" };
const preferences: WorkspacePreferences = { revision: 2,
  intent: { scene: "landscape", aspect_ratio: "custom", output_template: "custom", custom_ratio: { width: 3, height: 2 } },
  guides: ["center", "safe"],
};
const works = [{ id: "a", state: "archived" }, { id: "b", state: "archived" }, { id: "c", state: "draft" },
  { id: "sample", state: "archived", source: "pregenerated" }] as ProjectSummary[];

describe("photographer identity card", () => {
  it("shows a labelled inspiration cover, real account counts and saved creation settings", () => {
    const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} projects={works} preferences={preferences} onNavigate={vi.fn()} />);
    expect(html).toContain("灵感封面 · 山间湖泊");
    expect(html).toContain("演示摄影师");
    expect(html).toContain("共用演示空间");
    expect(html).toContain('<dt>已归档作品</dt><dd>2</dd>');
    expect(html).toContain('<dt>草稿项目</dt><dd>1</dd>');
    expect(html).toContain("风景摄影"); expect(html).toContain("3:2"); expect(html).toContain("<span>中心线</span>"); expect(html).toContain("<span>安全区</span>");
    expect(html).toContain("已保存偏好");
    expect(html).not.toContain("等级"); expect(html).not.toContain("获赞");
  });
  it.each([{ projects: undefined }, { projects: [], projectsLoading: true }, { projects: [], projectsError: "offline" }])(
    "does not fabricate zero counts for unavailable account records: %j", state => {
      const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} {...state} onNavigate={vi.fn()} />);
      expect(html.match(/<dd>—<\/dd>/g)).toHaveLength(2); expect(html).not.toContain("<dd>0</dd>");
    });
  it("shows genuine empty counts and intentional all-off guides", () => {
    const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} projects={[]} preferences={{ ...preferences, guides: [] }} onNavigate={vi.fn()} />);
    expect(html.match(/<dd>0<\/dd>/g)).toHaveLength(2); expect(html).toContain("不使用辅助线");
  });
  it("does not describe the first-read product defaults as actively saved preferences", () => {
    const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} preferences={{ ...preferences, revision: 1 }} onNavigate={vi.fn()} />);
    expect(html).toContain("初始设置"); expect(html).not.toContain("已保存偏好");
  });
  it.each([{ preferencesLoading: true, message: "正在读取" }, { preferencesError: "offline", message: "暂不可用" }])(
    "does not present unavailable preference data as current settings: %j", ({ message, ...state }) => {
      const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} preferences={preferences} {...state} onNavigate={vi.fn()} />);
      expect(html).toContain(message); expect(html).not.toContain("已保存偏好"); expect(html).not.toContain("风景摄影");
    });
  it("does not reveal authenticated records passed to a visitor card", () => {
    const html = renderToStaticMarkup(<PhotographerIdentityCard projects={works} preferences={preferences} onNavigate={vi.fn()} />);
    expect(html).toContain("当前为访客体验"); expect(html).not.toContain("账号作品记录");
    expect(html).not.toContain("风景摄影"); expect(html).not.toContain("3:2");
  });
  it("offers library and insights actions without nonfunctional account controls", () => {
    const onNavigate = vi.fn();
    // Interactive behaviour is verified in the browser; SSR names both real destinations.
    const html = renderToStaticMarkup(<PhotographerIdentityCard user={user} onNavigate={onNavigate} />);
    expect(html).toContain("查看作品"); expect(html).toContain("摄影洞察");
    expect(html).not.toContain("编辑头像"); expect(html).not.toContain("认证摄影师");
  });
});
