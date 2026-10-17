import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { routeFromPath, useAppRoute, workspacePath, type WorkspacePage } from "./navigation";

const pages: WorkspacePage[] = ["overview", "workbench", "library", "insights", "profile"];

function captureNavigation(): ReturnType<typeof useAppRoute>["navigate"] {
  let navigate: ReturnType<typeof useAppRoute>["navigate"] | undefined;
  function Probe() {
    navigate = useAppRoute().navigate;
    return null;
  }
  renderToString(createElement(Probe));
  if (!navigate) throw new Error("Navigation probe was not rendered");
  return navigate;
}

// A small History API stand-in for Node tests. This does not simulate React's
// browser rendering or claim to cover browser Back/Forward interaction.
function fakeBrowser(pathname: string) {
  const location = { pathname };
  const setPath = (_state: unknown, _title: string, path: string) => {
    location.pathname = path;
  };
  const history = { pushState: vi.fn(setPath), replaceState: vi.fn(setPath) };
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { location, history, dispatchEvent });
  return { location, history, dispatchEvent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace route mapping", () => {
  it("keeps the public homepage separate from the workspace overview", () => {
    expect(routeFromPath("/")).toEqual({ kind: "home" });
    expect(routeFromPath("/studio")).toEqual({ kind: "workspace", page: "overview" });
    expect(routeFromPath("/studio/")).toEqual({ kind: "workspace", page: "overview" });
  });

  it.each(pages)("maps the %s page and accepts trailing slashes", (page) => {
    expect(workspacePath(page)).toBe(`/studio/${page}`);
    expect(routeFromPath(workspacePath(page))).toEqual({ kind: "workspace", page });
    expect(routeFromPath(`${workspacePath(page)}/`)).toEqual({ kind: "workspace", page });
  });

  it.each([
    "/other",
    "/studio/missing",
    "/studio/library/project-123",
    "/studio/workbench/project-123",
    "/studio/overview/nested",
    "/Studio/overview",
  ])("does not pretend the unsupported path %s is a working project", (path) => {
    expect(routeFromPath(path)).toEqual({ kind: "not-found" });
  });

  it("can render on the server without a browser window", () => {
    function Probe() {
      return createElement("span", null, useAppRoute().route.kind);
    }
    expect(renderToString(createElement(Probe))).toBe("<span>home</span>");
    expect(() => captureNavigation()("library")).not.toThrow();
  });

  it("maps login and durable project editor addresses", () => {
    expect(routeFromPath("/login/")).toEqual({ kind: "login" });
    const projectId = "a".repeat(32);
    expect(routeFromPath(`/studio/workbench/${projectId}`)).toEqual({ kind: "workspace", page: "workbench", projectId });
  });
});

describe("navigation history writes in a Node browser stand-in", () => {
  it("pushes another page and emits a notification for all subscribers", () => {
    const browser = fakeBrowser("/");
    captureNavigation()("workbench");
    expect(browser.history.pushState).toHaveBeenCalledWith(null, "", "/studio/workbench");
    expect(browser.history.replaceState).not.toHaveBeenCalled();
    expect(browser.dispatchEvent).toHaveBeenCalledOnce();
    expect(browser.dispatchEvent.mock.calls[0][0].type).toBe("smartcrop:navigation");
  });

  it("does not add duplicate entries when the target page is already open", () => {
    const browser = fakeBrowser("/studio/library");
    captureNavigation()("library");
    expect(browser.history.pushState).not.toHaveBeenCalled();
    expect(browser.history.replaceState).not.toHaveBeenCalled();
    expect(browser.dispatchEvent).not.toHaveBeenCalled();
  });

  it.each(["/studio", "/studio/", "/studio/overview/"])(
    "replaces the same-page alias %s with its canonical address",
    (path) => {
      const browser = fakeBrowser(path);
      captureNavigation()("overview");
      expect(browser.history.replaceState).toHaveBeenCalledWith(null, "", "/studio/overview");
      expect(browser.history.pushState).not.toHaveBeenCalled();
    },
  );

  it("can replace the current history entry explicitly", () => {
    const browser = fakeBrowser("/studio/library");
    captureNavigation()("profile", { replace: true });
    expect(browser.history.replaceState).toHaveBeenCalledWith(null, "", "/studio/profile");
    expect(browser.history.pushState).not.toHaveBeenCalled();
  });

  it("can navigate back to the public homepage", () => {
    const browser = fakeBrowser("/studio/profile");
    captureNavigation()("/");
    expect(browser.location.pathname).toBe("/");
    expect(browser.history.pushState).toHaveBeenCalledWith(null, "", "/");
  });

  it("does not replace another project's history entry as if both were the same workbench", () => {
    const browser = fakeBrowser(`/studio/workbench/${"a".repeat(32)}`);
    captureNavigation()({ page: "workbench", projectId: "b".repeat(32) });
    expect(browser.history.pushState).toHaveBeenCalledWith(null, "", `/studio/workbench/${"b".repeat(32)}`);
    expect(browser.history.replaceState).not.toHaveBeenCalled();
  });
});
