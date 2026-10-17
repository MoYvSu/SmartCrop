import { ArrowLeft, BarChart3, Crop, FolderOpen, LayoutDashboard, LoaderCircle, LogOut, ShieldCheck, UserRound } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { workspacePath } from "../lib/navigation";
import type { WorkspacePage } from "../lib/navigation";
import "./workspace-shell.css";

const PAGES = [
  { id: "overview", label: "创作概览", Icon: LayoutDashboard },
  { id: "workbench", label: "构图工作台", Icon: Crop },
  { id: "library", label: "我的作品", Icon: FolderOpen },
  { id: "insights", label: "摄影洞察", Icon: BarChart3 },
  { id: "profile", label: "摄影档案", Icon: UserRound },
] as const;

interface Props {
  page: WorkspacePage;
  status: string;
  onNavigate: (page: WorkspacePage | "/") => void;
  children: ReactNode;
  user?: { id: string; username: string; display_name: string };
  onLogout?: () => void;
  logoutBusy?: boolean;
}

/** Leave modified clicks to the browser so links still support new tabs. */
function follow(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  action();
}

export function WorkspaceShell({ page, status, onNavigate, children, user, onLogout, logoutBusy = false }: Props) {
  const current = PAGES.find((item) => item.id === page)!;
  return (
    <div className="workspace-shell">
      <aside className="workspace-sidebar" aria-label="摄影工作室">
        <a className="brand workspace-brand" href={workspacePath("overview")} onClick={(event) => follow(event, () => onNavigate("overview"))}>
          <span className="brand-mark"><Crop aria-hidden="true" size={22} /></span>
          <span><strong>SmartCrop</strong><small>美境智剪 · 摄影工作室</small></span>
        </a>
        <p className="workspace-nav-caption">你的创作空间</p>
        <nav className="workspace-nav" aria-label="工作室主导航">
          {PAGES.map(({ id, label, Icon }) => (
            <a key={id} href={workspacePath(id)} aria-current={page === id ? "page" : undefined}
              className={page === id ? "is-current" : ""} onClick={(event) => follow(event, () => onNavigate(id))}>
              <Icon aria-hidden="true" size={19} /><span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="workspace-sidebar-bottom">
          <div className="workspace-session-note"><ShieldCheck aria-hidden="true" size={17} /><p>
            <strong>{user ? user.display_name || user.username : "当前为访客体验"}</strong>
            <span>{user ? `${user.username} · 演示账号共用作品库` : "固定样例可直接体验；登录后使用共用作品库"}</span>
          </p></div>
          {user && onLogout && <button type="button" className="workspace-logout" onClick={onLogout} disabled={logoutBusy} aria-busy={logoutBusy}>
            {logoutBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" size={16} /> : <LogOut aria-hidden="true" size={16} />}
            {logoutBusy ? "正在退出" : "退出登录"}
          </button>}
          <a href="/" onClick={(event) => follow(event, () => onNavigate("/"))}><ArrowLeft aria-hidden="true" size={16} />返回展示首页</a>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="workspace-topbar">
          <div className="workspace-breadcrumb"><span>摄影工作室</span><span aria-hidden="true">/</span><strong>{current.label}</strong></div>
          <p className="workspace-live-status" role="status">{status}</p>
        </header>
        <div className="workspace-route-content">{children}</div>
      </div>
    </div>
  );
}
