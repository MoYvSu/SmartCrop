import { Crop, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";

import { ApiError } from "./api";
import { LoginPanel } from "./components/LoginPanel";
import { ProjectEditor } from "./components/ProjectEditor";
import type { ProjectEditorHandle } from "./components/ProjectEditor";
import { SampleEditor } from "./components/SampleEditor";
import type { SampleEditorHandle } from "./components/SampleEditor";
import { UploadPanel } from "./components/UploadPanel";
import { InsightsPage, LibraryPage, OverviewPage, ProfilePage } from "./components/WorkspacePages";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { useAppRoute } from "./lib/navigation";
import type { NavigationTarget, WorkspacePage } from "./lib/navigation";
import { createAnalysisIntent } from "./lib/publishing";
import { DEMO_IMAGE_URL } from "./lib/demo";
import { clearImageAnalysisCache } from "./lib/browserImageAnalysis";
import { clearArchivedInsightsCache } from "./hooks/useArchivedInsights";
import { useWorkspacePreferences } from "./hooks/useWorkspacePreferences";
import type { AnalysisIntent } from "./types";
import { clearWorkspaceSession, createProject, deleteProject, getAuthSession, getProject, listProjects, login, logout } from "./workspaceApi";
import type { ProjectDetail, ProjectSummary, WorkspaceUser } from "./workspaceApi";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请稍后重试。";

export default function App() {
  const { route, navigate } = useAppRoute();
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const userRef = useRef<WorkspaceUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>(undefined);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const listGeneration = useRef(0);
  const projectMutation = useRef(0);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [mode, setMode] = useState<"new" | "project" | "sample">("new");
  const [sampleIntent, setSampleIntent] = useState<AnalysisIntent | null>(null);
  const [sampleGeneration, setSampleGeneration] = useState(0);
  const [importGeneration, setImportGeneration] = useState(0);
  const editor = useRef<ProjectEditorHandle>(null);
  const sampleEditor = useRef<SampleEditorHandle>(null);
  const [editorStatus, setEditorStatus] = useState("尚未导入照片");
  const setStatus = useCallback((value: string) => setEditorStatus(value), []);
  const [busy, setBusy] = useState(false);
  const importing = useRef(false);
  const pendingImport = useRef<{ file: File; intent: AnalysisIntent; useDefaults: boolean } | null>(null);
  const preferencesDirty = useRef(false);
  const [error, setError] = useState("");
  const [loadingProject, setLoadingProject] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const requestedId = route.kind === "workspace" && route.page === "workbench" ? route.projectId : undefined;
  const isWorkspace = route.kind === "workspace";
  const page = isWorkspace ? route.page : "overview";
  const routeKey = isWorkspace ? `${route.page}/${route.projectId || ""}` : route.kind;

  const expired = useCallback(() => {
    clearArchivedInsightsCache(); clearImageAnalysisCache();
    userRef.current = null;
    setUser(null);
    clearWorkspaceSession();
    setAuthError("登录已过期。请重新登录，页面内尚未保存的调整会保留等待重试。");
    listGeneration.current += 1;
    setProjects(undefined);
  }, []);
  const accountPreferences = useWorkspacePreferences(user, userRef, expired);

  useEffect(() => {
    const controller = new AbortController();
    getAuthSession(controller.signal).then(session => {
      if (controller.signal.aborted) return;
      userRef.current = session.user; setUser(session.user);
    }).catch(caught => {
      if (!controller.signal.aborted) setAuthError(`暂时无法连接登录服务：${errorMessage(caught)}`);
    }).finally(() => { if (!controller.signal.aborted) setAuthReady(true); });
    return () => controller.abort();
  }, []);

  const refreshProjects = useCallback(async () => {
    if (!userRef.current) return;
    const generation = ++listGeneration.current;
    setProjectsLoading(true); setProjectsError("");
    try {
      while (generation === listGeneration.current && userRef.current) {
        const snapshot = projectMutation.current;
        const items = await listProjects();
        if (generation !== listGeneration.current || !userRef.current) return;
        // A slow list response cannot erase a project just imported, saved or
        // deleted in this tab. Read again after concurrent local mutations.
        if (snapshot !== projectMutation.current) continue;
        setProjects(items);
        break;
      }
    } catch (caught) {
      if (generation !== listGeneration.current) return;
      setProjectsError(errorMessage(caught));
      if (caught instanceof ApiError && caught.status === 401) expired();
    } finally { if (generation === listGeneration.current) setProjectsLoading(false); }
  }, [expired]);
  useEffect(() => { if (user) void refreshProjects(); }, [user, refreshProjects]);
  const saved = useCallback((updated: ProjectDetail) => {
    if (!userRef.current) return;
    projectMutation.current += 1;
    setProject(current => current?.id === updated.id ? updated : current);
    setProjects(current => [updated, ...(current || []).filter(item => item.id !== updated.id)]);
  }, []);

  useEffect(() => {
    if (!requestedId || !user || (mode === "project" && project?.id === requestedId)) {
      setLoadingProject(false);
      return;
    }
    const controller = new AbortController();
    setLoadingProject(true); setLoadError("");
    const load = async () => {
      try {
        await editor.current?.flush();
        const loaded = await getProject(requestedId, controller.signal);
        if (controller.signal.aborted) return;
        setProject(loaded); setMode("project"); setSampleIntent(null); setEditorStatus("草稿已保存");
      } catch (caught) {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(caught));
        if (caught instanceof ApiError && caught.status === 401) expired();
      } finally { if (!controller.signal.aborted) setLoadingProject(false); }
    };
    void load();
    return () => controller.abort();
  }, [requestedId, user, mode, project?.id, reloadTick, expired]);

  useEffect(() => {
    if (!authReady) return;
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
      document.getElementById("main-content")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [routeKey, authReady, user?.id, loadingProject]);

  const prepareToLeave = async () => {
    if (mode === "sample" && sampleEditor.current?.isDirty()
      && !window.confirm("离开样例会放弃尚未确认的样例调整，是否继续？")) return false;
    if (mode === "project") await editor.current?.flush();
    return true;
  };
  const newCreation = async () => {
    if (importing.current) return;
    try {
      if (!await prepareToLeave()) return;
      setMode("new"); setProject(null); setSampleIntent(null); setError(""); setEditorStatus("尚未导入照片");
      setImportGeneration(value => value + 1);
      if (userRef.current) void accountPreferences.load(true).catch(() => undefined);
      navigate("workbench");
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const openSample = async (intent = createAnalysisIntent("general", "freeform", { width: 4, height: 3 })) => {
    try {
      if (!await prepareToLeave()) return;
      setMode("sample"); setProject(null); setSampleIntent(intent); setSampleGeneration(value => value + 1);
      setError(""); navigate("workbench");
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const importPhoto = async (file: File, intent: AnalysisIntent, useDefaults = false) => {
    if (!userRef.current) {
      pendingImport.current = { file, intent, useDefaults }; navigate("login"); return;
    }
    if (importing.current) return;
    importing.current = true; setBusy(true); setError("");
    try {
      if (!await prepareToLeave()) return;
      const defaults = await accountPreferences.load();
      const created = await createProject(file, useDefaults ? defaults.intent : intent);
      projectMutation.current += 1;
      setProject(created); setMode("project"); setSampleIntent(null); setEditorStatus("草稿已保存");
      setProjects(current => [created, ...(current || []).filter(item => item.id !== created.id)]);
      pendingImport.current = null;
      navigate({ page: "workbench", projectId: created.id });
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.status === 401) {
        pendingImport.current = { file, intent, useDefaults }; expired();
      }
    } finally { importing.current = false; setBusy(false); }
  };
  const signIn = async (username: string, password: string) => {
    if (loginBusy) return;
    setLoginBusy(true); setAuthError("");
    try {
      const session = await login(username, password);
      userRef.current = session.user; setUser(session.user);
      if (pendingImport.current) {
        const pending = pendingImport.current;
        await importPhoto(pending.file, pending.intent, pending.useDefaults);
      } else if (route.kind === "login" || route.kind === "home") navigate("overview");
    } catch (caught) { setAuthError(errorMessage(caught)); }
    finally { setLoginBusy(false); }
  };
  const signOut = async () => {
    if (logoutBusy || importing.current) return;
    if (preferencesDirty.current && !window.confirm("创作偏好尚未保存，退出会放弃这些修改。是否继续？")) return;
    setLogoutBusy(true); setError("");
    try {
      try { await editor.current?.flush(); }
      catch {
        if (!window.confirm("仍有未保存的调整。退出会放弃这些本地调整，是否继续？")) return;
      }
      await logout();
      accountPreferences.reset(); preferencesDirty.current = false;
      clearArchivedInsightsCache(); clearImageAnalysisCache();
      userRef.current = null; setUser(null); setProjects(undefined); setProject(null); setMode("new"); setSampleIntent(null);
      pendingImport.current = null; listGeneration.current += 1; setAuthError(""); navigate("/");
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLogoutBusy(false); }
  };
  const remove = async (id: string) => {
    await deleteProject(id);
    clearArchivedInsightsCache(); clearImageAnalysisCache();
    projectMutation.current += 1;
    setProjects(current => current?.filter(item => item.id !== id));
    if (project?.id === id) { setProject(null); setMode("new"); setEditorStatus("作品已删除"); }
  };
  const openProject = async (id: string) => {
    try {
      if (await prepareToLeave()) navigate({ page: "workbench", projectId: id });
    } catch (caught) { setError(errorMessage(caught)); }
  };
  const navigatePage = (target: NavigationTarget) => {
    if (target === "workbench" && mode === "project" && project) navigate({ page: "workbench", projectId: project.id });
    else navigate(target);
  };
  const follow = (event: MouseEvent<HTMLAnchorElement>, target: NavigationTarget) => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigatePage(target);
  };
  const isSampleVisible = isWorkspace && page === "workbench" && !requestedId && mode === "sample" && !!sampleIntent;
  const canView = (authReady && !!user) || isSampleVisible;
  const showShell = isWorkspace && (canView || !authReady);
  const showLogin = route.kind === "login" || (isWorkspace && authReady && !canView);
  const isProjectVisible = isWorkspace && authReady && page === "workbench" && !!user && mode === "project"
    && !!project && (!requestedId || requestedId === project.id) && !loadingProject;
  const isUploadVisible = isWorkspace && authReady && page === "workbench" && !!user && !requestedId && mode === "new";
  const loginPanel = <LoginPanel busy={loginBusy || busy} error={authError} onSubmit={(name, password) => void signIn(name, password)} onBack={() => navigate("/")} />;
  const session = mode === "sample" ? {
    imageUrl: DEMO_IMAGE_URL, label: "构图静物 · 固定使用样例", phase: "result" as const,
    provenance: "pregenerated" as const, status: "succeeded" as const, hasPendingChanges: editorStatus.includes("未确认"),
  } : undefined;
  const pageProps = {
    onNavigate: (target: WorkspacePage) => navigatePage(target),
    onNewCreation: () => void newCreation(), onOpenSample: () => void openSample(), session,
    user: user || undefined, projects, projectsLoading, projectsError, onRefreshProjects: () => void refreshProjects(),
    onOpenProject: (id: string) => void openProject(id), onDeleteProject: remove,
    preferences: accountPreferences.preferences, preferencesLoading: accountPreferences.loading,
    preferencesError: accountPreferences.error,
    onRefreshPreferences: () => { void accountPreferences.load(true).catch(() => undefined); },
    onSavePreferences: accountPreferences.save,
    onPreferencesDirtyChange: (dirty: boolean) => { preferencesDirty.current = dirty; },
  };
  const importDefaults = {
    defaults: accountPreferences.preferences, defaultsRequired: !!user,
    defaultsLoading: accountPreferences.loading, defaultsError: accountPreferences.error,
    onRetryDefaults: () => { void accountPreferences.load(true).catch(() => undefined); },
  };

  return <>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    {/* Keep the editor alive through page changes and session reauthentication. */}
    <div hidden={!showShell}>
      <WorkspaceShell page={page} status={user || isSampleVisible ? editorStatus : "请登录演示账号"}
        user={user || undefined} onLogout={() => void signOut()} logoutBusy={logoutBusy || busy} onNavigate={navigatePage}>
        {error && <div className="global-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")}>关闭</button></div>}
        <div hidden={!isProjectVisible}>
          {mode === "project" && project && <main className="workspace-main" id={isProjectVisible ? "main-content" : "project-content"} tabIndex={-1}>
            <ProjectEditor key={project.id} ref={editor} initial={project} active={isProjectVisible && !logoutBusy && !busy} authenticated={!!user}
              onSaved={saved} onStatus={setStatus} onAuthExpired={expired} onNewCreation={() => void newCreation()} />
          </main>}
        </div>
        <div hidden={!isSampleVisible}>
          {mode === "sample" && sampleIntent && <main className="workspace-main" id={isSampleVisible ? "main-content" : "sample-content"} tabIndex={-1}>
            <SampleEditor key={sampleGeneration} ref={sampleEditor} intent={sampleIntent} active={isSampleVisible}
              onStatus={setStatus} onNewCreation={() => void newCreation()} />
          </main>}
        </div>
        <div hidden={!isUploadVisible}>
          <UploadPanel key={importGeneration} variant="workspace" persistent active={isUploadVisible} mainId={isUploadVisible ? "main-content" : "import-content"}
            {...importDefaults}
            accessCode="" onAccessCodeChange={() => undefined} busy={busy}
            onSubmit={(file, intent) => importPhoto(file, intent)} onOpenPregeneratedDemo={intent => void openSample(intent)} />
        </div>
        {isWorkspace && !authReady && !isSampleVisible && <main className="workspace-main" id="main-content" tabIndex={-1}><p role="status">正在确认登录状态…</p></main>}
        {isWorkspace && canView && page === "workbench" && requestedId && !isProjectVisible && <main className="workspace-main" id="main-content" tabIndex={-1}>
          {loadError ? <><h1>作品暂时无法打开</h1><p role="alert">{loadError}</p><button className="secondary-button" onClick={() => setReloadTick(value => value + 1)}>重试</button><button className="text-button" onClick={() => navigate("library")}>返回作品列表</button></> : <p role="status">正在打开作品…</p>}
        </main>}
        {isWorkspace && canView && page === "overview" && <OverviewPage {...pageProps} />}
        {isWorkspace && canView && page === "library" && <LibraryPage {...pageProps} />}
        {isWorkspace && canView && page === "insights" && <InsightsPage {...pageProps} />}
        <div hidden={!(isWorkspace && canView && page === "profile")}>
          {authReady && user && <ProfilePage {...pageProps} profileMainId={isWorkspace && canView && page === "profile" ? "main-content" : "profile-content"} />}
        </div>
      </WorkspaceShell>
    </div>
    <div hidden={showShell} className="desktop-app">
      {!showLogin && <header className="app-header">
        <a className="brand" href="/" onClick={event => follow(event, "/")}><span className="brand-mark"><Crop aria-hidden="true" size={22} /></span><span><strong>SmartCrop</strong><small>美境智剪</small></span></a>
        <nav className="header-nav" aria-label="展示首页导航"><a className="is-active" href="/studio/overview" onClick={event => follow(event, "overview")}>进入工作室</a>
          {route.kind === "home" && <><a href="#inspiration">构图灵感</a><a href="#guide">使用指南</a></>}</nav>
        <div className="header-trust"><ShieldCheck aria-hidden="true" size={17} />作品保留至主动删除 · 演示账号共用</div>
      </header>}
      {error && !isWorkspace && <div className="global-error" role="alert">{error}</div>}
      {route.kind === "home" && <UploadPanel persistent accessCode="" onAccessCodeChange={() => undefined} busy={busy}
        {...importDefaults}
        onSubmit={(file, intent, _provenance, customized) => importPhoto(file, intent, !user && !customized)} onOpenPregeneratedDemo={intent => void openSample(intent)} />}
      {showLogin && (authReady ? loginPanel : <main id="main-content" className="workspace-main"><p role="status">正在确认登录状态…</p></main>)}
      {route.kind === "not-found" && <main className="workspace-not-found" id="main-content" tabIndex={-1}><h1>这个页面暂时无法打开</h1><p>请检查地址，或回到工作室查看已保存作品。</p><button className="primary-button" onClick={() => navigate("overview")}>返回创作概览</button></main>}
      {!isWorkspace && <footer className="app-footer"><span><strong>SmartCrop</strong> 美境智剪</span><span>用新的视角，看见照片的可能。</span><span>AI 提供灵感 · 你决定画面</span></footer>}
    </div>
  </>;
}
