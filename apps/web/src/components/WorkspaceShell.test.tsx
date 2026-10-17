import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceShell } from "./WorkspaceShell";

describe("WorkspaceShell", () => {
  it("provides five real page links and one accessible current location", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell page="workbench" status="当前调整尚未确认" onNavigate={vi.fn()}><main>编辑区</main></WorkspaceShell>,
    );
    for (const page of ["overview", "workbench", "library", "insights", "profile"]) {
      expect(markup).toContain(`href="/studio/${page}"`);
    }
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="工作室主导航"');
    expect(markup).toContain('role="status">当前调整尚未确认');
    expect(markup).toContain("返回展示首页");
  });

  it("keeps visitors separate from the authenticated shared library", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell page="profile" status="尚未导入照片" onNavigate={vi.fn()}>档案</WorkspaceShell>,
    );
    expect(markup).toContain("当前为访客体验");
    expect(markup).toContain("登录后使用共用作品库");
    expect(markup).not.toContain("退出登录");
    expect(markup).not.toContain("仅自己可见");
  });

  it("shows the real account and logout instead of a visitor or unavailable-account claim", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceShell page="library" status="作品已读取" onNavigate={vi.fn()}
        user={{ id: "demo-user", username: "demo", display_name: "摄影演示账号" }} onLogout={vi.fn()} logoutBusy>作品</WorkspaceShell>,
    );
    expect(markup).toContain("摄影演示账号");
    expect(markup).toContain("demo · 演示账号共用作品库");
    expect(markup).toContain("正在退出");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("当前为访客体验");
    expect(markup).not.toContain("尚未启用");
  });
});
