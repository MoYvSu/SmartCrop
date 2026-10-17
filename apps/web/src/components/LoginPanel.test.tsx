import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LoginPanel } from "./LoginPanel";

describe("LoginPanel", () => {
  it("supports password managers with an empty password and a clear shared-library notice", () => {
    const markup = renderToStaticMarkup(<LoginPanel busy={false} error="" onSubmit={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain('name="username"');
    expect(markup).toContain('autoComplete="username"');
    expect(markup).toContain('value="demo"');
    const passwordInput = markup.match(/<input[^>]*name="password"[^>]*>/)?.[0];
    expect(passwordInput).toContain('type="password"');
    expect(passwordInput).toContain('autoComplete="current-password"');
    expect(passwordInput).toContain('value=""');
    expect(markup).toContain('aria-label="显示密码"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("演示账号共用作品库");
    expect(markup).toContain("使用同一账号的人开放");
    expect(markup).not.toContain("忘记密码");
    expect(markup).not.toContain("注册账号");
  });

  it("shows a retriable authentication error without embedding credentials", () => {
    const markup = renderToStaticMarkup(<LoginPanel busy={false} error="用户名或密码不正确" onSubmit={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain('role="alert">用户名或密码不正确');
    expect(markup).toContain("密码请向演示维护者获取");
    expect(markup).toContain('value="demo"');
  });

  it("prevents duplicate submission and password edits while signing in", () => {
    const markup = renderToStaticMarkup(<LoginPanel busy error="" onSubmit={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain("正在登录");
    expect(markup).toContain('aria-busy="true"');
    const inputs = markup.match(/<input\b[^>]*>/g) || [];
    expect(inputs).toHaveLength(2);
    expect(inputs.every((input) => input.includes('disabled=""'))).toBe(true);
  });
});
