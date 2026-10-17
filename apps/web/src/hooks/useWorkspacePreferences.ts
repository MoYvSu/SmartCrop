import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ApiError } from "../api";
import { getPreferences, savePreferences } from "../workspaceApi";
import type { WorkspacePreferences, WorkspaceUser } from "../workspaceApi";

/** Keep account defaults separate from the snapshot stored with each photograph. */
export function useWorkspacePreferences(
  user: WorkspaceUser | null,
  actor: RefObject<WorkspaceUser | null>,
  onAuthExpired: () => void,
) {
  const [preferences, setPreferences] = useState<WorkspacePreferences>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<WorkspacePreferences | undefined>(undefined);
  const generation = useRef(0);
  const sessionEpoch = useRef(0);
  const pending = useRef<{ owner: string; promise: Promise<WorkspacePreferences> } | null>(null);
  const readController = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    sessionEpoch.current += 1;
    generation.current += 1;
    readController.current?.abort();
    pending.current = null;
    current.current = undefined;
    setPreferences(undefined); setLoading(false); setError("");
  }, []);

  const load = useCallback((refresh = false): Promise<WorkspacePreferences> => {
    const owner = actor.current?.id;
    if (!owner) return Promise.reject(new Error("请先登录后读取创作偏好。"));
    if (pending.current?.owner === owner && !refresh) return pending.current.promise;
    if (current.current && !refresh) return Promise.resolve(current.current);
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const token = ++generation.current;
    setLoading(true); setError("");
    const promise = getPreferences(controller.signal).then(value => {
      if (token !== generation.current || actor.current?.id !== owner) throw new DOMException("读取已取消", "AbortError");
      if (current.current && value.revision < current.current.revision) return current.current;
      current.current = value; setPreferences(value);
      return value;
    }).catch(caught => {
      if (token === generation.current && actor.current?.id === owner && !controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "偏好暂时无法读取，请重试。");
        if (caught instanceof ApiError && caught.status === 401) onAuthExpired();
      }
      throw caught;
    }).finally(() => {
      if (token === generation.current) { pending.current = null; setLoading(false); }
    });
    pending.current = { owner, promise };
    return promise;
  }, [actor, onAuthExpired]);

  const save = useCallback(async (value: WorkspacePreferences): Promise<WorkspacePreferences> => {
    const owner = actor.current?.id;
    const epoch = sessionEpoch.current;
    if (!owner) throw new Error("请重新登录后保存创作偏好。");
    // A GET already in flight must not replace this newly saved version.
    generation.current += 1; readController.current?.abort(); pending.current = null;
    setLoading(false);
    try {
      const updated = await savePreferences(value);
      if (actor.current?.id !== owner || sessionEpoch.current !== epoch) throw new Error("登录状态已变化，请重新读取偏好。");
      if (!current.current || updated.revision >= current.current.revision) {
        current.current = updated; setPreferences(updated);
      }
      setError("");
      return updated;
    } catch (caught) {
      if (actor.current?.id === owner && sessionEpoch.current === epoch && caught instanceof ApiError && caught.status === 401) onAuthExpired();
      throw caught;
    }
  }, [actor, onAuthExpired]);

  useEffect(() => {
    if (user) void load().catch(() => undefined);
    else reset();
  }, [user, load, reset]);
  useEffect(() => () => { generation.current += 1; readController.current?.abort(); }, []);

  return { preferences, loading, error, load, save, reset };
}
