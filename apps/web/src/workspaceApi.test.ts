import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { archiveProject, clearWorkspaceSession, createProject, getAuthSession, getPreferences, listProjects, login, logout, projectToJob, savePreferences, saveProject } from "./workspaceApi";
import type { ProjectDetail } from "./workspaceApi";

const draft = { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, selected_candidate_id: null, selection_reasons: [], selection_note: null, selection_explicit: false };
const intent = { scene: "general" as const, aspect_ratio: "free" as const, output_template: "freeform" as const, custom_ratio: null };
const auth = { user: { id: "demo-id", username: "demo", display_name: "演示摄影师" }, csrf_token: "csrf-test-only" };
afterEach(() => { clearWorkspaceSession(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable workspace API", () => {
  it("reads account defaults privately and sends a versioned authenticated preference update", async () => {
    const preferences = { revision: 4, intent, guides: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(auth))
      .mockResolvedValueOnce(Response.json(preferences)).mockResolvedValueOnce(Response.json({ ...preferences, revision: 5 }));
    vi.stubGlobal("fetch", fetchMock);
    await login("demo", "test");
    expect(await getPreferences()).toEqual(preferences);
    expect(await savePreferences(preferences)).toMatchObject({ revision: 5, guides: [] });
    expect(fetchMock.mock.calls[1][0]).toBe("/v1/preferences");
    const init = fetchMock.mock.calls[2][1];
    expect(init.method).toBe("PUT");
    expect(init.cache).toBe("no-store");
    expect(init.headers.get("X-SmartCrop-CSRF")).toBe(auth.csrf_token);
    expect(JSON.parse(init.body)).toEqual(preferences);
  });
  it("keeps cookies server managed, attaches CSRF to writes and clears it on logout", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(auth))
      .mockResolvedValueOnce(Response.json({ id: "project" })).mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ id: "project" }));
    vi.stubGlobal("fetch", fetchMock);
    await login("demo", "not-a-real-password");
    await saveProject("project", 3, draft);
    await logout();
    await archiveProject("project", 4);
    const saveInit = fetchMock.mock.calls[1][1];
    expect(saveInit.credentials).toBe("same-origin");
    expect(saveInit.cache).toBe("no-store");
    expect(saveInit.headers.get("X-SmartCrop-CSRF")).toBe(auth.csrf_token);
    expect(JSON.parse(saveInit.body)).toMatchObject({ revision: 3, ...draft });
    expect(fetchMock.mock.calls[3][1].headers.has("X-SmartCrop-CSRF")).toBe(false);
  });

  it("does not adopt a cancelled session response after a new login", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { controller.abort(); return { user: null, csrf_token: null }; } })
      .mockResolvedValueOnce(Response.json(auth)).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAuthSession(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await login("demo", "test");
    await saveProject("project", 1, draft);
    expect(fetchMock.mock.calls[2][1].headers.get("X-SmartCrop-CSRF")).toBe(auth.csrf_token);
  });

  it("follows every page instead of making older works unreachable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ id: "new" }], next_offset: 200 }))
      .mockResolvedValueOnce(Response.json({ items: [{ id: "old" }], next_offset: null }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await listProjects()).map(item => item.id)).toEqual(["new", "old"]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/v1/projects?limit=200&offset=0", "/v1/projects?limit=200&offset=200"]);
  });

  it("rejects cyclic pagination rather than repeatedly fetching", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ items: [], next_offset: 0 })));
    await expect(listProjects()).rejects.toThrow("分页异常");
  });

  it("imports a project immediately without creating an inference job", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "project" }));
    vi.stubGlobal("fetch", fetchMock);
    await createProject(new File(["image"], "photo.png", { type: "image/png" }), intent);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/projects");
    expect(fetchMock.mock.calls[0][1].body.get("file").name).toBe("photo.png");
    expect(fetchMock.mock.calls[0][1].body.get("aspect_ratio")).toBe("free");
  });

  it("retains conflict status and server explanation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "作品已有新修改" }, { status: 409 })));
    const error = await saveProject("project", 1, draft).catch(caught => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, message: "作品已有新修改" });
  });

  it("resynchronizes a rotated CSRF token without replaying a failed write", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ detail: "请求校验失败" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json(auth)).mockResolvedValueOnce(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await expect(saveProject("project", 1, draft)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/v1/projects/project", "/v1/auth/session"]);
    await saveProject("project", 1, draft);
    expect(fetchMock.mock.calls[2][1].headers.get("X-SmartCrop-CSRF")).toBe(auth.csrf_token);
  });

  it("allows local logout when the server session has already expired", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "请先登录" }, { status: 401 })));
    await expect(logout()).resolves.toBeUndefined();
  });

  it("uses only durable project assets in the workbench adapter, even without AI", () => {
    const project = { id: "p", created_at: "2026-10-17", intent, image_width: 1200, image_height: 800,
      draft, reference: null, preview_url: "/v1/projects/p/assets/preview", crop_url: "/v1/projects/p/assets/crop" } as unknown as ProjectDetail;
    const adapted = projectToJob(project);
    expect(adapted.artifacts.preview).toBe(project.preview_url);
    expect(adapted.artifacts.crop).toBe(project.crop_url);
    expect(adapted.capability_status).toBe("not_run");
    expect(adapted.manual_only).toBe(true);
    expect(adapted.report).toBe(null);
    expect(JSON.stringify(adapted.artifacts)).not.toContain("/v1/jobs/");
  });
});
