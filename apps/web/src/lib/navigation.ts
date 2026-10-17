import { useCallback, useSyncExternalStore } from "react";

export type WorkspacePage = "overview" | "workbench" | "library" | "insights" | "profile";

export type AppRoute =
  | { kind: "home" }
  | { kind: "login" }
  | { kind: "workspace"; page: WorkspacePage; projectId?: string }
  | { kind: "not-found" };
export type NavigationTarget = "/" | "login" | WorkspacePage | { page: "workbench"; projectId: string };

const workspacePaths: Record<WorkspacePage, string> = {
  overview: "/studio/overview",
  workbench: "/studio/workbench",
  library: "/studio/library",
  insights: "/studio/insights",
  profile: "/studio/profile",
};

const navigationEvent = "smartcrop:navigation";

export function workspacePath(page: WorkspacePage): string {
  return workspacePaths[page];
}

export function routeFromPath(pathname: string): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/") return { kind: "home" };
  if (normalized === "/login") return { kind: "login" };
  if (normalized === "/studio") return { kind: "workspace", page: "overview" };

  for (const page of Object.keys(workspacePaths) as WorkspacePage[]) {
    if (normalized === workspacePaths[page]) return { kind: "workspace", page };
  }
  const project = normalized.match(/^\/studio\/workbench\/([a-f0-9]{32})$/);
  if (project) return { kind: "workspace", page: "workbench", projectId: project[1] };

  return { kind: "not-found" };
}

function getPathname(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  // pushState does not emit popstate. This extra event keeps every hook
  // instance in sync without patching the browser's history methods.
  window.addEventListener("popstate", onChange);
  window.addEventListener(navigationEvent, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(navigationEvent, onChange);
  };
}

export function useAppRoute(): {
  route: AppRoute;
  navigate: (target: NavigationTarget, options?: { replace?: boolean }) => void;
} {
  // Only pathname is observed, so an ordinary #anchor does not change pages.
  const pathname = useSyncExternalStore(subscribe, getPathname, () => "/");
  const navigate = useCallback((target: NavigationTarget, options?: { replace?: boolean }) => {
    if (typeof window === "undefined") return;
    const path = typeof target === "object"
      ? `${workspacePath(target.page)}/${encodeURIComponent(target.projectId)}`
      : target === "/" ? "/" : target === "login" ? "/login" : workspacePath(target);
    const currentPath = window.location.pathname;
    if (currentPath === path) return;

    const currentRoute = routeFromPath(currentPath);
    const nextRoute = routeFromPath(path);
    const samePage = JSON.stringify(currentRoute) === JSON.stringify(nextRoute);

    // Normalize aliases/trailing slashes in place, rather than recording
    // another visit to the same page in the Back button's history.
    if (options?.replace || samePage) {
      window.history.replaceState(null, "", path);
    } else {
      window.history.pushState(null, "", path);
    }
    window.dispatchEvent(new Event(navigationEvent));
  }, []);

  return { route: routeFromPath(pathname), navigate };
}
