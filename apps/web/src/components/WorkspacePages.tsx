import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  Clock3,
  Crop,
  Download,
  FolderHeart,
  ImagePlus,
  Layers3,
  RefreshCw,
  ScanLine,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { JobStatus } from "../types";
import type { ProjectSummary, WorkspacePreferences } from "../workspaceApi";
import { useArchivedInsights } from "../hooks/useArchivedInsights";
import { buildArchiveInsights, filterArchivedProjects } from "../lib/archiveInsights";
import { InsightsDashboard } from "./InsightsDashboard";
import { PreferencesForm } from "./PreferencesForm";
import { PhotographerIdentityCard } from "./PhotographerIdentityCard";

import "./workspace-pages.css";

export type WorkspacePageId = "overview" | "workbench" | "library" | "insights" | "profile";

export interface WorkspaceSession {
  imageUrl: string;
  label: string;
  phase: "processing" | "result";
  provenance: "upload" | "pregenerated";
  status: JobStatus;
  hasPendingChanges: boolean;
}

export interface WorkspacePageProps {
  onNavigate: (page: WorkspacePageId) => void;
  onOpenSample: () => void;
  onNewCreation?: () => void;
  session?: WorkspaceSession;
  user?: { id: string; username: string; display_name: string };
  projects?: ProjectSummary[];
  projectsLoading?: boolean;
  projectsError?: string;
  onRefreshProjects?: () => void;
  onOpenProject?: (id: string) => void;
  onDeleteProject?: (id: string) => void;
  profileMainId?: string;
  preferences?: WorkspacePreferences;
  preferencesLoading?: boolean;
  preferencesError?: string;
  onRefreshPreferences?: () => void;
  onSavePreferences?: (value: WorkspacePreferences) => Promise<WorkspacePreferences>;
  onPreferencesDirtyChange?: (dirty: boolean) => void;
}

interface HeadingProps {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}

function PageHeading({ eyebrow, title, description, action }: HeadingProps) {
  return (
    <header className="sc-workspace-heading">
      <div>
        <p className="sc-workspace-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="sc-workspace-description">{description}</p>
      </div>
      {action}
    </header>
  );
}

function WorkbenchButton({ onNavigate, onNewCreation, session }: WorkspacePageProps) {
  return (
    <button type="button" className="sc-workspace-button" onClick={onNewCreation || (() => onNavigate("workbench"))}>
      <ImagePlus size={17} aria-hidden="true" />
      {session && !onNewCreation ? "返回当前创作" : "导入照片，开始创作"}
      <ArrowUpRight size={17} aria-hidden="true" />
    </button>
  );
}

function SampleButton({ onOpenSample, session }: WorkspacePageProps) {
  const processing = session?.phase === "processing";
  return (
    <button
      type="button"
      className="sc-workspace-text-button"
      onClick={onOpenSample}
      disabled={processing}
      title={processing ? "当前照片正在处理，请先返回工作台查看进度" : undefined}
    >
      <BookOpen size={17} aria-hidden="true" />查看使用样例<ArrowRight size={16} aria-hidden="true" />
    </button>
  );
}

function SampleCallout(props: WorkspacePageProps) {
  return (
    <aside className="sc-workspace-sample-callout">
      <div className="sc-workspace-sample-copy">
        <BookOpen size={22} aria-hidden="true" />
        <div>
          <h2>想先熟悉一下操作？</h2>
          <p>固定样例可体验构图与下载，不调用当前模型，也不是你的历史作品。</p>
          {props.session?.phase === "processing" && <p>当前照片正在处理，完成后可切换样例。</p>}
        </div>
      </div>
      <SampleButton {...props} />
    </aside>
  );
}

const STATUS_COPY: Record<JobStatus, string> = {
  queued: "照片正在排队，返回工作台可查看进度。",
  running: "正在生成构图参考，你可以返回查看进度。",
  succeeded: "当前结果已就绪，可以继续查看和精修。",
  failed: "本次分析未完成，仍可返回使用手动裁剪。",
  cancelled: "本次任务已结束，可以返回查看当前照片。",
  expired: "任务已过期，可以返回查看保留的预览。",
};

function SessionCard({ session, onNavigate, user }: WorkspacePageProps & { session: WorkspaceSession }) {
  const sample = session.provenance === "pregenerated";
  const ended = session.status === "expired" || session.status === "cancelled";
  const action = session.phase === "processing" ? "查看处理进度" : "返回工作台";
  return (
    <article className="sc-workspace-session-card">
      <div className="sc-workspace-session-image">
        <img src={session.imageUrl} alt={sample ? "当前固定样例预览" : "本次上传照片预览"} />
      </div>
      <div className="sc-workspace-session-copy">
        <p className="sc-workspace-eyebrow">{sample ? "固定使用样例" : "本次上传"}</p>
        <h3>{session.label}</h3>
        <p>{STATUS_COPY[session.status] || session.status || (session.phase === "processing" ? "正在处理这张照片。" : "返回工作台，继续本次创作。")}</p>
        <span className="sc-workspace-session-note">
          <Clock3 size={14} aria-hidden="true" />
          {sample ? "固定展示，未调用当前模型" : user ? "当前工作台会话，保存状态以项目记录为准" : "仅当前标签页，刷新后无法恢复"}
          {session.phase === "result" && session.hasPendingChanges && !ended && " · 有待确认的调整"}
        </span>
      </div>
      <button type="button" className="sc-workspace-outline-button" onClick={() => onNavigate("workbench")}>
        {action}<ArrowRight size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

const SCENES = [
  { title: "旅途与风景", description: "留住环境，也留一点想象。", image: "/images/alpine-lake.jpg", alt: "湖边木屋与远处群山", category: "LANDSCAPE" },
  { title: "分享与封面", description: "为标题和故事，找到留白。", image: "/images/ocean.jpg", alt: "傍晚海面上轻柔起伏的浪花", category: "STORY & COVER" },
  { title: "日常与好物", description: "收紧取景，让细节成为主角。", image: "/images/coffee.jpg", alt: "朋友手持咖啡相聚的俯视画面", category: "EVERYDAY" },
];

export type ProjectFilter = "all" | "draft" | "archived";

export function filterWorkspaceProjects(projects: ProjectSummary[], filter: ProjectFilter, query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return projects
    .filter((project) => (filter === "all" || project.state === filter)
      && project.title.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => (Date.parse(right.updated_at) || 0) - (Date.parse(left.updated_at) || 0));
}

function projectDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期未记录" : date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function ProjectCard({ project, onOpen, onDelete, busy = false }: {
  project: ProjectSummary;
  onOpen?: (id: string) => void;
  onDelete?: (id: string) => void;
  busy?: boolean;
}) {
  const published = project.state === "archived" && Boolean(project.published_url);
  const image = <><img src={published ? project.published_url! : project.preview_url}
    alt={`${project.title}：${published ? "已归档成片" : "原图预览"}`} loading="lazy" />
    <span className="sc-project-preview-label">{published ? "归档成片" : "原图预览"}</span></>;
  return (
    <article className="sc-project-card">
      {onOpen ? <button type="button" className="sc-project-preview" disabled={busy}
        aria-label={`打开作品：${project.title}`} onClick={() => onOpen(project.id)}>{image}</button>
        : <div className="sc-project-preview">{image}</div>}
      <div className="sc-project-copy">
        <div className="sc-project-title"><h3>{project.title}</h3><span>{project.state === "archived" ? "已归档" : "草稿"}</span></div>
        <p>原图 {project.image_width} × {project.image_height} · 当前版本 v{project.revision}</p>
        <p>更新于 {projectDate(project.updated_at)}</p>
        {project.has_draft_changes && project.state === "archived" && <p className="sc-project-draft-note">草稿有新调整，归档成片保持不变</p>}
        <div className="sc-project-actions">
          {onOpen && <button type="button" className="sc-workspace-text-button" disabled={busy}
            aria-label={`继续编辑：${project.title}`} onClick={() => onOpen(project.id)}>继续编辑<ArrowRight size={15} aria-hidden="true" /></button>}
          {published && <a className="sc-workspace-text-button" href={project.published_url!} download
            aria-label={`下载归档成片：${project.title}`}><Download size={15} aria-hidden="true" />下载归档成片</a>}
          {onDelete && <button type="button" className="sc-project-delete" disabled={busy}
            aria-label={`删除项目：${project.title}`} onClick={() => onDelete(project.id)}><Trash2 size={16} aria-hidden="true" />删除</button>}
        </div>
      </div>
    </article>
  );
}

function ProjectFeedback(props: WorkspacePageProps) {
  return <>
    {props.projectsError && <div className="sc-project-load-error" role="alert"><p>{props.projectsError}</p>
      {props.onRefreshProjects && <button type="button" className="sc-workspace-text-button" disabled={props.projectsLoading} onClick={props.onRefreshProjects}>
        <RefreshCw size={16} aria-hidden="true" />重新读取作品</button>}
    </div>}
    {props.projectsLoading && <p className="sc-project-loading" role="status">{props.projects?.length ? "正在刷新作品库…" : "正在读取作品…"}</p>}
    {!props.projectsLoading && !props.projectsError && props.projects === undefined && <div className="sc-workspace-session-empty">
      <FolderHeart size={24} aria-hidden="true" /><div><h3>作品库尚未读取</h3><p>读取完成后显示当前账号的真实项目。</p></div>
      {props.onRefreshProjects && <button type="button" className="sc-workspace-text-button" onClick={props.onRefreshProjects}>读取作品库</button>}
    </div>}
  </>;
}

function RecentProjects(props: WorkspacePageProps) {
  const projects = filterWorkspaceProjects(props.projects || [], "all", "").slice(0, 6);
  const ready = props.projects !== undefined;
  return <section className="sc-workspace-section" aria-labelledby="sc-recent-projects-heading">
    <div className="sc-workspace-section-heading"><h2 id="sc-recent-projects-heading">最近项目</h2>
      <button type="button" className="sc-workspace-text-button" onClick={() => props.onNavigate("library")}>查看全部作品<ArrowRight size={16} aria-hidden="true" /></button></div>
    <ProjectFeedback {...props} />
    {projects.length > 0 && <div className="sc-project-grid">{projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={props.onOpenProject} />)}</div>}
    {ready && !props.projectsLoading && !props.projectsError && projects.length === 0 && <div className="sc-workspace-session-empty">
      <ImagePlus size={25} aria-hidden="true" /><div><h3>还没有保存的作品</h3><p>导入自己的照片建立第一个项目；固定使用样例不会进入作品库。</p></div><WorkbenchButton {...props} />
    </div>}
  </section>;
}

export function OverviewPage(props: WorkspacePageProps) {
  const showCounts = props.projects !== undefined && !props.projectsLoading && !props.projectsError;
  return (
    <main className="sc-workspace-page sc-workspace-overview" id="main-content" tabIndex={-1}>
      <PageHeading eyebrow="Your creative space" title="创作概览" description={props.user ? `${props.user.display_name || props.user.username}，从最近一次创作继续。` : "为一张照片停留，给下一次创作留一点灵感。"} action={props.user ? <WorkbenchButton {...props} /> : undefined} />
      {props.user && <>
        <p className="sc-shared-account-note">{props.user.username} · 演示账号共用作品库，其他使用同一账号的人也能查看和修改这些作品。</p>
        <dl className="sc-project-counts">
          <div><dt>已归档作品</dt><dd>{showCounts ? props.projects!.filter((project) => project.state === "archived").length : "—"}</dd></div>
          <div><dt>草稿项目</dt><dd>{showCounts ? props.projects!.filter((project) => project.state === "draft").length : "—"}</dd></div>
          <div><dt>待更新归档</dt><dd>{showCounts ? props.projects!.filter((project) => project.state === "archived" && project.has_draft_changes).length : "—"}</dd></div>
        </dl>
        <p className="sc-workspace-fine-print">按当前读取的项目计数。同一项目的多次修改不重复增加作品数。</p>
        <RecentProjects {...props} />
      </>}
      {!props.user && <section className="sc-workspace-hero" aria-labelledby="sc-workspace-hero-title">
        <div className="sc-workspace-hero-copy">
          <span className="sc-workspace-hero-index" aria-hidden="true">FRAME / A NEW PERSPECTIVE</span>
          <h2 id="sc-workspace-hero-title">从一个新视角，<br />重新看见照片。</h2>
          <p>选择画幅，调整留白。<br />让工具提供参考，把最后的决定留给自己。</p>
          <div className="sc-workspace-hero-actions">
            <WorkbenchButton {...props} />
            <SampleButton {...props} />
          </div>
          <span className="sc-workspace-hero-footnote">JPEG / PNG / WebP · 从你自己的照片开始</span>
        </div>
        <figure className="sc-workspace-hero-image">
          <img src="/images/alpine-lake.jpg" alt="山间湖泊、木屋与远山，作为摄影灵感参考" width="1400" height="933" />
          <div className="sc-workspace-hero-frame" aria-hidden="true"><span /><span /></div>
          <figcaption><ScanLine size={15} aria-hidden="true" />摄影灵感 · 展示素材，非分析结果</figcaption>
        </figure>
      </section>}

      {props.session && <section className="sc-workspace-section" aria-labelledby="sc-workspace-current-heading">
        <div className="sc-workspace-section-heading"><h2 id="sc-workspace-current-heading">继续本次创作</h2><span>当前浏览器会话</span></div>
        <SessionCard {...props} session={props.session} />
      </section>}

      <section className="sc-workspace-section" aria-labelledby="sc-workspace-scenes-heading">
        <div className="sc-workspace-section-heading">
          <div><p className="sc-workspace-eyebrow">Find your frame</p><h2 id="sc-workspace-scenes-heading">为下一次发布，找一点灵感</h2></div>
          <span>到工作台为照片选择用途与比例</span>
        </div>
        <div className="sc-workspace-scenes">
          {SCENES.map((scene) => (
            <button type="button" className="sc-workspace-scene" key={scene.category} onClick={() => props.onNavigate("workbench")}>
              <div className="sc-workspace-scene-image"><img src={scene.image} alt={scene.alt} width="720" height="480" loading="lazy" /><span>{scene.category}</span></div>
              <div className="sc-workspace-scene-copy"><div><h3>{scene.title}</h3><p>{scene.description}</p></div><ArrowUpRight size={20} aria-hidden="true" /></div>
              <span className="sc-workspace-scene-action">前往构图工作台<ArrowRight size={14} aria-hidden="true" /></span>
            </button>
          ))}
        </div>
        <p className="sc-workspace-fine-print">场景图片仅作灵感参考；不会作为你的照片上传，也不会自动运行分析。</p>
      </section>

      <section className="sc-workspace-principles" aria-label="创作方式">
        <div><Crop size={22} aria-hidden="true" /><h2>画面，由你精修</h2><p>调整取景框和辅助线，找到舒服的视觉关系。</p></div>
        <div><Layers3 size={22} aria-hidden="true" /><h2>参考，按需查看</h2><p>在不同构图方向之间选择，不把建议当作唯一答案。</p></div>
        <div><Check size={22} aria-hidden="true" /><h2>选择，留给自己</h2><p>确认当前方案，下载你决定的那一帧。</p></div>
      </section>
    </main>
  );
}

export function LibraryPage(props: WorkspacePageProps) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const projects = props.projects || [];
  const visible = filterWorkspaceProjects(projects, filter, query);
  const remove = async (id: string) => {
    if (deleting || !props.onDeleteProject) return;
    const project = projects.find((item) => item.id === id);
    if (!project || !window.confirm(`删除“${project.title}”？这将删除此项目的草稿、所有版本和图片。同一演示账号的所有使用者都会受到影响，此操作无法撤销。`)) return;
    setDeleting(id);
    setDeleteError("");
    try { await props.onDeleteProject(id); }
    catch { setDeleteError("删除未完成，项目仍保留在列表中。请重试或刷新作品库。"); }
    finally { setDeleting(null); }
  };
  return (
    <main className="sc-workspace-page" id="main-content" tabIndex={-1}>
      <PageHeading eyebrow="Your collection" title="我的作品" description="为值得留下的画面，留一个清楚的位置。" action={<WorkbenchButton {...props} />} />
      {props.user ? <>
        <p className="sc-shared-account-note">演示账号共用作品库。草稿与归档成片分开保存，固定使用样例不会成为真实作品。</p>
        <div className="sc-library-controls">
          <div className="sc-library-filters" role="group" aria-label="项目状态筛选">
            {([["all", "全部项目"], ["archived", "已归档"], ["draft", "草稿"]] as const).map(([value, label]) => <button key={value} type="button"
              aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <label className="sc-library-search"><span>搜索标题</span><span><Search size={17} aria-hidden="true" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作品标题" /></span></label>
          {props.onRefreshProjects && <button type="button" className="sc-workspace-text-button" onClick={props.onRefreshProjects} disabled={props.projectsLoading}>
            <RefreshCw size={16} aria-hidden="true" />刷新作品</button>}
        </div>
        <ProjectFeedback {...props} />
        {deleteError && <p className="sc-project-load-error" role="alert">{deleteError}</p>}
        {deleting && <p role="status" className="sc-project-loading">正在删除项目及其图片，请稍候…</p>}
        {visible.length > 0 && <div className="sc-project-grid">{visible.map((project) => <ProjectCard key={project.id} project={project}
          onOpen={props.onOpenProject} onDelete={props.onDeleteProject ? remove : undefined} busy={Boolean(deleting) || props.projectsLoading} />)}</div>}
        {props.projects !== undefined && !props.projectsLoading && !props.projectsError && visible.length === 0 && <div className="sc-workspace-session-empty">
          <FolderHeart size={26} aria-hidden="true" /><div><h3>{projects.length ? "没有匹配的作品" : "还没有保存的作品"}</h3>
            <p>{projects.length ? "换一个标题或状态，找找其他项目。" : "导入照片后开始创作，草稿和归档记录会显示在这里。"}</p></div>
          {projects.length ? <button type="button" className="sc-workspace-text-button" onClick={() => { setFilter("all"); setQuery(""); }}>清空筛选</button> : <WorkbenchButton {...props} />}
        </div>}
      </> : <section className="sc-workspace-library-empty" aria-labelledby="sc-workspace-library-title">
        <div className="sc-workspace-album-illustration" aria-hidden="true"><span /><span /><div><FolderHeart size={43} strokeWidth={1.3} /><i /></div></div>
        <div className="sc-workspace-library-copy">
          <p className="sc-workspace-eyebrow">A place for your photographs</p>
          <h2 id="sc-workspace-library-title">登录后使用共用作品库</h2>
          <p>固定样例可直接体验构图、精修和下载。登录演示账号后才能保存和恢复真实项目；使用同一账号的人会共用这些作品。</p>
          <div className="sc-workspace-library-outline">
            <span><Crop size={17} aria-hidden="true" />照片与最终取景</span>
            <span><BookOpen size={17} aria-hidden="true" />创作说明与选择</span>
            <span><Clock3 size={17} aria-hidden="true" />可继续的作品记录</span>
          </div>
          <p className="sc-workspace-fine-print">固定使用样例不属于真实作品，不能存为账号项目。</p>
        </div>
      </section>}
      {(!props.user || props.session) && <section className="sc-workspace-section" aria-labelledby="sc-workspace-library-session">
        <div className="sc-workspace-section-heading"><h2 id="sc-workspace-library-session">{props.user ? "当前工作台" : "本次临时创作"}</h2><span>与作品归档分开</span></div>
        {props.session ? <SessionCard {...props} session={props.session} /> : <div className="sc-workspace-session-empty"><ImagePlus size={24} aria-hidden="true" /><div><h3>还没有正在进行的创作</h3><p>导入照片后，你可以从这里返回本次工作台。</p></div><button type="button" className="sc-workspace-text-button" onClick={() => props.onNavigate("workbench")}>前往工作台<ArrowRight size={16} aria-hidden="true" /></button></div>}
        <p className="sc-workspace-fine-print">{props.user ? "当前工作台会话与作品记录分别呈现。需要再次打开时，请从已保存的项目进入。" : "上传任务文件仍按一小时规则清理。切换页面不会将它延长为长期作品，刷新后无法恢复本次创作。"}</p>
      </section>}
      <SampleCallout {...props} />
    </main>
  );
}

export function InsightsPage(props: WorkspacePageProps) {
  const [range, setRange] = useState<"all" | "30" | "90">("all");
  const projects = useMemo(() => filterArchivedProjects(props.projects || [], range), [props.projects, range]);
  const enabled = Boolean(props.user) && props.projects !== undefined && !props.projectsLoading && !props.projectsError;
  const state = useArchivedInsights(projects, enabled);
  const stats = useMemo(() => buildArchiveInsights(state.entries), [state.entries]);
  return (
    <main className="sc-workspace-page" id="main-content" tabIndex={-1}>
      <PageHeading eyebrow="Understand your photographs" title="摄影洞察" description="读懂画面的线索，也理解自己做出的选择。" action={<WorkbenchButton {...props} />} />
      <p className="sc-insight-source-note">来自演示账号共用作品库，每件作品采用最新归档成片。</p>
      {props.user ? <>
        <div className="sc-insight-range-bar"><div className="sc-insight-range-controls" role="group" aria-label="摄影洞察归档时间范围">
          <span>归档时间</span>{([["all", "全部作品"], ["30", "最近 30 天"], ["90", "最近 90 天"]] as const).map(([value, label]) =>
            <button type="button" key={value} aria-pressed={range === value} onClick={() => setRange(value)}>{label}</button>)}
        </div>{props.onRefreshProjects && <button type="button" className="sc-workspace-text-button" disabled={props.projectsLoading} onClick={props.onRefreshProjects}>
          <RefreshCw size={16} aria-hidden="true" />刷新归档记录</button>}</div>
        <ProjectFeedback {...props} />
        {enabled && <InsightsDashboard state={state} stats={stats} onOpenProject={props.onOpenProject} onNavigateLibrary={() => props.onNavigate("library")} onRetry={state.retry} />}
      </> : <section className="sc-workspace-insights-intro"><div className="sc-workspace-insights-mark" aria-hidden="true"><ScanLine size={32} strokeWidth={1.4} /></div>
        <div><h2>留下作品，发现自己的画面语言。</h2><p>登录并归档照片后，可查看亮度、色相、主色、画幅与发布用途统计。</p></div></section>}
      <section className="sc-workspace-insight-note" aria-labelledby="sc-workspace-insights-source">
        <div><p className="sc-workspace-eyebrow">A collection of perspectives</p><h2 id="sc-workspace-insights-source">从作品里，发现下一次创作的灵感。</h2><p>看看常用的色彩与画幅，再回到喜欢的作品继续打磨。</p></div>
        <button type="button" className="sc-workspace-outline-button" onClick={() => props.onNavigate("library")}>查看作品库<ArrowRight size={16} aria-hidden="true" /></button>
      </section>
      <SampleCallout {...props} />
    </main>
  );
}

export function ProfilePage(props: WorkspacePageProps) {
  return (
    <main className="sc-workspace-page" id={props.profileMainId || "main-content"} tabIndex={-1}>
      <PageHeading eyebrow="Make the space yours" title="摄影档案" description="创作的习惯，可以由你自己定义。" />
      <div className="sc-workspace-profile-grid">
        <PhotographerIdentityCard user={props.user} projects={props.projects} projectsLoading={props.projectsLoading} projectsError={props.projectsError}
          preferences={props.preferences} preferencesLoading={props.preferencesLoading} preferencesError={props.preferencesError} onNavigate={props.onNavigate} />
        {props.user ? <PreferencesForm preferences={props.preferences} loading={props.preferencesLoading} error={props.preferencesError}
          onRefresh={props.onRefreshPreferences} onSave={props.onSavePreferences} onDirtyChange={props.onPreferencesDirtyChange} />
          : <section className="sc-workspace-defaults" aria-labelledby="sc-workspace-defaults-title">
            <div className="sc-workspace-section-heading"><div><p className="sc-workspace-eyebrow">A starting point</p><h2 id="sc-workspace-defaults-title">为下一次创作，留下偏好</h2></div></div>
            <p>登录后可保存常用用途、裁剪比例和辅助线。刷新或重新登录，熟悉的设置仍会等你回来。</p>
            <dl className="sc-workspace-default-list"><div><dt>常用用途</dt><dd>按你的创作需要选择</dd></div><div><dt>裁剪比例</dt><dd>自由、固定与自定义画幅</dd></div><div><dt>构图辅助</dt><dd>组合使用，或全部关闭</dd></div></dl>
            <button type="button" className="sc-workspace-outline-button" onClick={() => props.onNavigate("workbench")}>前往工作台<ArrowRight size={16} aria-hidden="true" /></button>
          </section>}
      </div>
      <section className="sc-workspace-profile-notes" aria-labelledby="sc-workspace-profile-notes-title">
        <div><p className="sc-workspace-eyebrow">Make room for your next idea</p><h2 id="sc-workspace-profile-notes-title">熟悉的起点，新的可能。</h2></div>
        <div><h3>从顺手的设置开始</h3><p>把常用画幅和辅助线存下来，下次导入照片，少一步设置，多一点专注。</p></div>
        <div><h3>每张照片，自有表达</h3><p>偏好只是起点。进入工作台后，仍可以为这张照片选择最合适的构图。</p></div>
      </section>
      <SampleCallout {...props} />
    </main>
  );
}
