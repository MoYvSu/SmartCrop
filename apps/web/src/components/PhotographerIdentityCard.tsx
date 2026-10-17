import { Aperture, ArrowUpRight, Crop, FolderHeart, Grid3X3, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { intentRatioLabel } from "../lib/publishing";
import type { CompositionGuide, SceneType } from "../types";
import type { ProjectSummary, WorkspacePreferences, WorkspaceUser } from "../workspaceApi";
import "./photographer-identity.css";

interface Props {
  user?: WorkspaceUser;
  projects?: ProjectSummary[];
  projectsLoading?: boolean;
  projectsError?: string;
  preferences?: WorkspacePreferences;
  preferencesLoading?: boolean;
  preferencesError?: string;
  onNavigate: (page: "library" | "insights") => void;
}

const SCENES: Record<SceneType, string> = {
  general: "通用构图", portrait: "人物摄影", landscape: "风景摄影", product: "商品展示", social: "社交分享",
};
const GUIDES: Record<CompositionGuide, string> = {
  thirds: "三分线", center: "中心线", diagonal: "对角线", safe: "安全区",
};
const number = new Intl.NumberFormat("zh-CN");

/** A summary of real account records, not an inferred personal profile. */
export function PhotographerIdentityCard({ user, projects, projectsLoading, projectsError,
  preferences, preferencesLoading, preferencesError, onNavigate }: Props) {
  const id = useId();
  const records = (projects || []).filter(project => project.source !== "pregenerated" && project.published?.source !== "pregenerated");
  const countsReady = Boolean(user && projects !== undefined && !projectsLoading && !projectsError);
  const settingsReady = Boolean(user && preferences && !preferencesLoading && !preferencesError);
  const settingsStatus = !user ? "登录后设置" : preferencesLoading ? "正在读取" : preferencesError ? "暂不可用" : "等待同步";
  const countStatus = projectsLoading ? "正在读取作品记录…" : projectsError ? "作品记录暂不可用" : projects === undefined ? "作品记录等待同步" : "";

  return <section className="sc-photographer-card" aria-labelledby={`${id}-name`}>
    <div className="sc-photographer-cover">
      <img src="/images/alpine-lake.jpg" alt="" width="1400" height="933" loading="lazy" />
      <div className="sc-photographer-cover-shade" aria-hidden="true" />
      <span className="sc-photographer-cover-frame" aria-hidden="true" />
      <span className="sc-photographer-cover-edition">LIGHT / FRAME / STORY</span>
      <span className="sc-photographer-cover-caption">灵感封面 · 山间湖泊</span>
    </div>
    <div className="sc-photographer-body">
      <div className="sc-photographer-identity-row">
        <div className="sc-photographer-avatar" aria-hidden="true"><Aperture size={34} strokeWidth={1.3} /></div>
        <span className="sc-photographer-account-tag">{user ? "共用演示空间" : "访客体验"}</span>
      </div>
      <p className="sc-workspace-eyebrow">A photographer’s notebook</p>
      <h2 id={`${id}-name`}>{user ? user.display_name || user.username : "当前为访客体验"}</h2>
      <p className="sc-photographer-handle">{user ? `用户名：${user.username}` : "登录后，把创作记录留在这里。"}</p>
      <p className="sc-photographer-motto">收藏光影，也收藏自己的视角。</p>

      {user && <>
        <dl className="sc-photographer-counts" aria-label="账号作品记录">
          <div><dt>已归档作品</dt><dd>{countsReady ? number.format(records.filter(project => project.state === "archived").length) : "—"}</dd></div>
          <div><dt>草稿项目</dt><dd>{countsReady ? number.format(records.filter(project => project.state === "draft").length) : "—"}</dd></div>
        </dl>
        {countStatus && <p className="sc-photographer-sync-note" role="status">{countStatus}</p>}
      </>}

      <section className="sc-photographer-settings" aria-labelledby={`${id}-settings`}>
        <div className="sc-photographer-section-title"><h3 id={`${id}-settings`}>创作起点</h3><span>{settingsReady ? preferences!.revision > 1 ? "已保存偏好" : "初始设置" : "默认设置"}</span></div>
        <dl>
          <div><dt><FolderHeart size={15} aria-hidden="true" />常用用途</dt><dd>{settingsReady ? SCENES[preferences!.intent.scene] : settingsStatus}</dd></div>
          <div><dt><Crop size={15} aria-hidden="true" />偏好画幅</dt><dd>{settingsReady ? intentRatioLabel(preferences!.intent) : settingsStatus}</dd></div>
          <div><dt><Grid3X3 size={15} aria-hidden="true" />构图辅助</dt><dd className="sc-photographer-guide-list">{settingsReady ? preferences!.guides.length
            ? preferences!.guides.map(guide => <span key={guide}>{GUIDES[guide]}</span>) : "不使用辅助线" : settingsStatus}</dd></div>
        </dl>
      </section>
      {user && <div className="sc-photographer-actions">
        <button type="button" onClick={() => onNavigate("library")}>查看作品<ArrowUpRight size={16} aria-hidden="true" /></button>
        <button type="button" onClick={() => onNavigate("insights")}>摄影洞察<ArrowUpRight size={16} aria-hidden="true" /></button>
      </div>}
      <div className="sc-photographer-shared-note"><ShieldCheck size={16} aria-hidden="true" /><p>{user
        ? "演示账号共用作品与偏好设置，同一账号的使用者都能查看和修改。"
        : "固定使用样例可直接体验，登录后使用共用作品库。"}</p></div>
    </div>
  </section>;
}
