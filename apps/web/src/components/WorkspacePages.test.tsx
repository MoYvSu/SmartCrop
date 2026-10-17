import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  InsightsPage,
  filterWorkspaceProjects,
  LibraryPage,
  OverviewPage,
  ProfilePage,
} from "./WorkspacePages";
import type { WorkspacePageProps, WorkspaceSession } from "./WorkspacePages";
import type { ProjectSummary } from "../workspaceApi";

function props(overrides: Partial<WorkspacePageProps> = {}): WorkspacePageProps {
  return { onNavigate: vi.fn(), onOpenSample: vi.fn(), ...overrides };
}

const session: WorkspaceSession = {
  imageUrl: "blob:current-photo",
  label: "湖边旅行照.jpg",
  phase: "result",
  provenance: "upload",
  status: "succeeded",
  hasPendingChanges: true,
};

const user = { id: "demo-user", username: "demo", display_name: "摄影演示账号" };

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: "project-1", title: "湖边散步", state: "draft", revision: 1,
    created_at: "2026-10-17T08:00:00Z", updated_at: "2026-10-17T09:00:00Z", archived_at: null,
    image_width: 1600, image_height: 1200, original_url: "/projects/project-1/original",
    preview_url: "/projects/project-1/preview", crop_url: "/projects/project-1/crop",
    published_url: null, has_draft_changes: false, ...overrides,
  };
}

// Overview and its child components are stateless. Expanding them lets us
// verify navigation callbacks without adding a browser/DOM dependency.
function buttons(node: ReactNode): Array<ReactElement<Record<string, unknown>>> {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    if (typeof child.type === "function") {
      const component = child.type as (value: Record<string, unknown>) => ReactNode;
      return buttons(component(child.props));
    }
    const descendants = buttons(child.props.children as ReactNode);
    return child.type === "button" ? [child, ...descendants] : descendants;
  });
}

function buttonWithText(node: ReactNode, text: string) {
  return buttons(node).find((button) => renderToStaticMarkup(button).includes(text));
}

describe("workspace pages reflect the features actually connected", () => {
  it("offers creation and fixed samples without inventing a recent project", () => {
    const callbacks = props();
    const view = OverviewPage(callbacks);
    const markup = renderToStaticMarkup(view);

    expect(markup).toContain("创作概览");
    expect(markup).toContain("摄影灵感 · 展示素材，非分析结果");
    expect(markup).not.toContain("继续本次创作");
    expect(markup).not.toContain("已归档作品");
    (buttonWithText(view, "导入照片，开始创作")?.props.onClick as () => void)();
    expect(callbacks.onNavigate).toHaveBeenCalledWith("workbench");
    (buttonWithText(view, "查看使用样例")?.props.onClick as () => void)();
    expect(callbacks.onOpenSample).toHaveBeenCalledOnce();
  });

  it("uses the new creation callback instead of returning to an existing result", () => {
    const callbacks = props({ session, onNewCreation: vi.fn() });
    const view = OverviewPage(callbacks);

    (buttonWithText(view, "导入照片，开始创作")?.props.onClick as () => void)();

    expect(callbacks.onNewCreation).toHaveBeenCalledOnce();
    expect(callbacks.onNavigate).not.toHaveBeenCalled();
    (buttonWithText(view, "返回工作台")?.props.onClick as () => void)();
    expect(callbacks.onNavigate).toHaveBeenCalledWith("workbench");
  });

  it("keeps a visitor session separate from the authenticated persistent library", () => {
    const markup = renderToStaticMarkup(<LibraryPage {...props({ session })} />);

    expect(markup).toContain("登录后使用共用作品库");
    expect(markup).toContain("本次临时创作");
    expect(markup).toContain("湖边旅行照.jpg");
    expect(markup).toContain("当前结果已就绪");
    expect(markup).toContain("仅当前标签页，刷新后无法恢复");
    expect(markup).toContain("一小时规则清理");
    expect(markup).not.toContain("草稿已保存");
    expect(markup).not.toContain("下载归档成片");
  });

  it("identifies a pregenerated session as a fixed sample rather than an upload", () => {
    const sample: WorkspaceSession = { ...session, provenance: "pregenerated" };
    const markup = renderToStaticMarkup(<LibraryPage {...props({ session: sample })} />);

    expect(markup).toContain("固定使用样例");
    expect(markup).toContain("固定展示，未调用当前模型");
    expect(markup).not.toContain('>本次上传<');
    expect(markup).not.toContain("草稿已保存");
  });

  it("explains archive-based pixel insights without fabricating visitor measurements or preferences", () => {
    const markup = renderToStaticMarkup(<InsightsPage {...props()} />);

    expect(markup).toContain("来自演示账号共用作品库，每件作品采用最新归档成片");
    expect(markup).toContain("登录并归档照片后");
    expect(markup).toContain("亮度、色相、主色、画幅与发布用途统计");
    expect(markup).not.toMatch(/\d+(?:\.\d+)?%/);
    expect(markup).not.toContain("<canvas");
    expect(markup).toContain("从作品里，发现下一次创作的灵感");
  });

  it("keeps unavailable archive records distinct from a genuine empty archive", () => {
    const loading = renderToStaticMarkup(<InsightsPage {...props({ user, projectsLoading: true })} />);
    expect(loading).toContain("正在读取作品");
    expect(loading).not.toContain("还没有已归档作品");
    expect(loading).not.toContain("作品平均亮度");

    const failed = renderToStaticMarkup(<InsightsPage {...props({ user, projects: [], projectsError: "归档记录读取失败" })} />);
    expect(failed).toContain("归档记录读取失败");
    expect(failed).not.toContain("还没有已归档作品");
    expect(failed).not.toContain("作品平均亮度");

    const empty = renderToStaticMarkup(<InsightsPage {...props({ user, projects: [project()] })} />);
    expect(empty).toContain("还没有已归档作品");
    expect(empty).not.toContain("湖边散步");
    expect(empty).toContain("在工作台完成并归档照片后");
  });

  it("starts a real archived snapshot as pending instead of fabricating a histogram", () => {
    const crop = { x: 0, y: 0, width: 0.8, height: 0.5 };
    const draft = { crop, selected_candidate_id: null, selection_reasons: [], selection_note: null, selection_explicit: false };
    const archived = project({ state: "archived", published_url: "/fixed/archive?version=3", has_draft_changes: true,
      published: { ...draft, version: 3, created_at: "2026-10-17T08:00:00Z", width: 1280, height: 600, draft,
        intent: { scene: "general", aspect_ratio: "free", output_template: "freeform", custom_ratio: null } } });
    const markup = renderToStaticMarkup(<InsightsPage {...props({ user, projects: [archived], onOpenProject: vi.fn() })} />);

    expect(markup).toContain("归档版本 v3 · 1280 × 600");
    expect(markup).toContain("已处理 0 / 1 张");
    expect(markup).toContain("等待分析");
    expect(markup).toContain("40%");
    expect(markup).toContain("有新草稿，未计入本次统计");
    expect(markup).toContain('aria-label="摄影洞察归档时间范围"');
    expect(markup).toContain("最近 30 天");
    expect(markup).toContain("最近 90 天");
    expect(markup).not.toContain("作品平均亮度");
    expect(markup).not.toContain("还没有已归档作品");
  });

  it("invites visitors to sign in before saving creative preferences", () => {
    const markup = renderToStaticMarkup(<ProfilePage {...props()} />);

    expect(markup).toContain("当前为访客体验");
    expect(markup).toContain("登录后可保存常用用途、裁剪比例和辅助线");
    expect(markup).toContain("为下一次创作，留下偏好");
    expect(markup).not.toMatch(/<(?:input|select|textarea|form)\b/);
    expect(markup).not.toContain("保存，下次创作使用");
  });

  it("does not offer to replace an in-flight task with a sample", () => {
    const view = OverviewPage(props({ session: { ...session, phase: "processing", status: "running" } }));
    const sampleButton = buttonWithText(view, "查看使用样例");

    expect(sampleButton?.props.disabled).toBe(true);
    expect(renderToStaticMarkup(view)).toContain("查看处理进度");
  });

  it.each(["expired", "cancelled"] as const)("does not offer pending adjustments for an ended %s task", (status) => {
    const markup = renderToStaticMarkup(<LibraryPage {...props({ session: { ...session, status } })} />);
    expect(markup).not.toContain("有待确认的调整");
    expect(markup).toContain(status === "expired" ? "任务已过期" : "本次任务已结束");
  });

  it("shows actual project counts and only the six most recently updated projects", () => {
    const projects = Array.from({ length: 7 }, (_, index) => project({
      id: `project-${index}`, title: `照片${index}`, updated_at: `2026-10-${10 + index}T09:00:00Z`,
      state: index < 2 ? "archived" : "draft", published_url: index < 2 ? `/published-${index}` : null,
      has_draft_changes: index === 1,
    }));
    const callbacks = props({ user, projects, onOpenProject: vi.fn() });
    const view = OverviewPage(callbacks);
    const markup = renderToStaticMarkup(view);

    expect(markup).toContain("摄影演示账号，从最近一次创作继续。");
    expect(markup).toContain("其他使用同一账号的人也能查看和修改这些作品");
    expect(markup).toContain("<dt>已归档作品</dt><dd>2</dd>");
    expect(markup).toContain("<dt>草稿项目</dt><dd>5</dd>");
    expect(markup).toContain("<dt>待更新归档</dt><dd>1</dd>");
    expect(markup.match(/class="sc-project-card"/g)).toHaveLength(6);
    expect(markup).not.toContain("打开作品：照片0");
    expect(markup.indexOf("打开作品：照片6")).toBeLessThan(markup.indexOf("打开作品：照片5"));
    expect(markup).not.toContain("尚未接入");
    const openButton = buttons(view).find((button) => button.props["aria-label"] === "打开作品：照片6");
    (openButton?.props.onClick as () => void)();
    expect(callbacks.onOpenProject).toHaveBeenCalledWith("project-6");
    (buttonWithText(view, "查看全部作品")?.props.onClick as () => void)();
    expect(callbacks.onNavigate).toHaveBeenCalledWith("library");
  });

  it("distinguishes the original preview and immutable published download from an edited draft", () => {
    const projects = [project(), project({ id: "archived", title: "山间傍晚", state: "archived", revision: 4,
      preview_url: "/archive-original-preview", crop_url: "/archive-new-draft", published_url: "/archive-published", has_draft_changes: true })];
    const markup = renderToStaticMarkup(<LibraryPage {...props({ user, projects, onOpenProject: vi.fn(), onDeleteProject: vi.fn() })} />);

    expect(markup).toContain('alt="湖边散步：原图预览"');
    expect(markup).toContain('src="/projects/project-1/preview"');
    expect(markup).toContain('alt="山间傍晚：已归档成片"');
    expect(markup).toContain('href="/archive-published" download=""');
    expect(markup).not.toContain("/archive-new-draft");
    expect(markup).not.toContain("/archive-original-preview");
    expect(markup).toContain("草稿有新调整，归档成片保持不变");
    expect(markup).toContain("原图 1600 × 1200 · 当前版本 v4");
    expect(markup).toContain('aria-label="删除项目：山间傍晚"');
    expect(markup).toContain('aria-label="继续编辑：山间傍晚"');
    expect(markup).toContain('aria-label="项目状态筛选"');
    expect(markup).toContain("搜索标题");
    expect(markup).not.toContain("作品保存尚未接入");
  });

  it("does not expose account projects in a visitor view", () => {
    const projects = [project({ title: "账号中的照片标题" })];
    for (const Component of [OverviewPage, LibraryPage]) {
      const markup = renderToStaticMarkup(<Component {...props({ projects })} />);
      expect(markup).not.toContain("账号中的照片标题");
      expect(markup).not.toContain("sc-project-card");
    }
  });

  it("keeps loading, not-yet-loaded, failed and genuinely empty libraries distinct", () => {
    const loading = renderToStaticMarkup(<LibraryPage {...props({ user, projectsLoading: true })} />);
    expect(loading).toContain('role="status">正在读取作品…');
    expect(loading).not.toContain("还没有保存的作品");
    expect(loading).not.toContain("作品库尚未读取");

    const unread = renderToStaticMarkup(<LibraryPage {...props({ user, onRefreshProjects: vi.fn() })} />);
    expect(unread).toContain("作品库尚未读取");
    expect(unread).toContain("读取作品库");
    expect(unread).not.toContain("还没有保存的作品");

    const failed = renderToStaticMarkup(<LibraryPage {...props({ user, projects: [], projectsError: "作品读取失败", onRefreshProjects: vi.fn() })} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("作品读取失败");
    expect(failed).toContain("重新读取作品");
    expect(failed).not.toContain("还没有保存的作品");

    const empty = renderToStaticMarkup(<LibraryPage {...props({ user, projects: [] })} />);
    expect(empty).toContain("还没有保存的作品");
    expect(empty).not.toContain("作品库尚未读取");
  });

  it("does not invent zero counts before the account project list is available", () => {
    const markup = renderToStaticMarkup(<OverviewPage {...props({ user, projectsLoading: true })} />);
    expect(markup.match(/<dd>—<\/dd>/g)).toHaveLength(3);
    expect(markup).not.toContain("<dd>0</dd>");
  });

  it.each([
    { projectsLoading: true },
    { projectsError: "作品读取失败" },
  ])("does not present an unavailable empty snapshot as verified zero counts: %j", (state) => {
    const markup = renderToStaticMarkup(<OverviewPage {...props({ user, projects: [], ...state })} />);
    expect(markup.match(/<dd>—<\/dd>/g)).toHaveLength(3);
    expect(markup).not.toContain("<dd>0</dd>");
  });

  it("does not show a redundant missing-session block for an authenticated project library", () => {
    const markup = renderToStaticMarkup(<LibraryPage {...props({ user, projects: [project()] })} />);
    expect(markup).toContain("湖边散步");
    expect(markup).not.toContain("还没有正在进行的创作");
    expect(markup).not.toContain('aria-labelledby="sc-workspace-library-session"');
    expect(markup).not.toContain("本次临时创作");

    const withSample = renderToStaticMarkup(<LibraryPage {...props({ user, projects: [], session: { ...session, provenance: "pregenerated" } })} />);
    expect(withSample).toContain("当前工作台");
    expect(withSample).toContain("固定使用样例");
  });

  it("identifies the shared account and keeps unavailable preferences distinct from saved defaults", () => {
    const markup = renderToStaticMarkup(<ProfilePage {...props({ user })} />);
    expect(markup).toContain("摄影演示账号");
    expect(markup).toContain("用户名：demo");
    expect(markup).toContain("演示账号共用作品与偏好设置");
    expect(markup).toContain("同一账号的使用者都能查看和修改");
    expect(markup).toContain("读取账号偏好后，就可以设置创作起点");
    expect(markup).not.toContain("当前为访客体验");
    expect(markup).not.toMatch(/<(?:input|select|textarea|form)\b/);
  });

  it("connects the signed-in photography profile to the actual saved preference form", () => {
    const preferences = { revision: 2, intent: { scene: "portrait", aspect_ratio: "1:1", output_template: "avatar", custom_ratio: null }, guides: ["diagonal"] } as const;
    const markup = renderToStaticMarkup(<ProfilePage {...props({ user, preferences: { ...preferences, guides: [...preferences.guides] }, onSavePreferences: vi.fn() })} />);
    expect(markup).toContain("创作偏好");
    expect(markup).toContain('value="portrait" selected=""');
    expect(markup).toContain('value="avatar" selected=""');
    expect(markup).toContain("保存创作偏好");
    expect(markup).not.toContain("尚未接入");
    expect(markup).not.toContain("不是你的已保存偏好");
    expect(markup).not.toContain("默认接受，不等于主动偏爱");
  });
});

describe("filterWorkspaceProjects", () => {
  it("combines status and trimmed case-insensitive title search in updated order", () => {
    const projects = [
      project({ id: "old", title: "Forest morning", updated_at: "2026-10-15T09:00:00Z" }),
      project({ id: "archive", title: "FOREST evening", state: "archived", updated_at: "2026-10-17T09:00:00Z" }),
      project({ id: "new", title: "Forest lake", updated_at: "2026-10-16T09:00:00Z" }),
      project({ id: "other", title: "海边", updated_at: "2026-10-18T09:00:00Z" }),
    ];
    expect(filterWorkspaceProjects(projects, "all", "  FOREST  ").map((item) => item.id)).toEqual(["archive", "new", "old"]);
    expect(filterWorkspaceProjects(projects, "draft", " forest ").map((item) => item.id)).toEqual(["new", "old"]);
    expect(filterWorkspaceProjects(projects, "archived", "forest").map((item) => item.id)).toEqual(["archive"]);
    expect(filterWorkspaceProjects(projects, "all", "不存在")).toEqual([]);
    expect(projects.map((item) => item.id)).toEqual(["old", "archive", "new", "other"]);
  });
});
