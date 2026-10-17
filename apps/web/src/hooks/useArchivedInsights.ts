import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError } from "../api";
import { archivedAnalysisKey, filterArchivedProjects } from "../lib/archiveInsights";
import type { ArchivedInsightEntry } from "../lib/archiveInsights";
import { analyzeImageSource } from "../lib/browserImageAnalysis";
import { IMAGE_ANALYSIS_VERSION } from "../lib/imageAnalysis";
import type { PixelAnalysis } from "../lib/imageAnalysis";
import type { ProjectSummary } from "../workspaceApi";

export interface ArchivedInsightsState {
  status: "idle" | "loading" | "ready";
  total: number; completed: number; entries: ArchivedInsightEntry[];
  retry: () => void;
}
const cache = new Map<string, PixelAnalysis>();
const controllers = new Set<AbortController>();
const listeners = new Set<() => void>();
let cacheEpoch = 0;
const getCacheEpoch = () => cacheEpoch;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function clearArchivedInsightsCache() {
  cacheEpoch += 1;
  cache.clear();
  for (const controller of controllers) controller.abort();
  for (const listener of listeners) listener();
}

interface Snapshot { key: string; entries: ArchivedInsightEntry[]; complete: boolean }
export function useArchivedInsights(projects: ProjectSummary[] | undefined, enabled: boolean): ArchivedInsightsState {
  const epoch = useSyncExternalStore(subscribe, getCacheEpoch, () => 0);
  const eligible = filterArchivedProjects(projects || []);
  const fingerprint = JSON.stringify(eligible.map(project => [archivedAnalysisKey(project), project.title, project.archived_at]));
  const [attempt, setAttempt] = useState(0);
  const key = `${enabled}:${projects !== undefined}:${attempt}:${epoch}:${fingerprint}`;
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: "", entries: [], complete: false });
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    if (!enabled || projects === undefined) return;
    const controller = new AbortController();
    const epoch = cacheEpoch;
    controllers.add(controller);
    const entries: ArchivedInsightEntry[] = eligible.map(project => ({ project, analysis: null, error: null }));
    const current = () => !controller.signal.aborted && epoch === cacheEpoch;
    const publish = (complete = false) => {
      if (current()) setSnapshot({ key, entries: entries.map(entry => ({ ...entry })), complete });
    };
    publish(entries.length === 0);
    const run = async () => {
      // Decode one photo at a time. A large archive cannot allocate many full
      // resolution images or launch an unbounded set of analysis workers.
      for (const entry of entries) {
        if (!current()) return;
        const cacheKey = `${IMAGE_ANALYSIS_VERSION}:${archivedAnalysisKey(entry.project)}`;
        try {
          const width = entry.project.published?.width || 0;
          const height = entry.project.published?.height || 0;
          if (!width || !height) throw new Error("归档尺寸缺失，暂不能分析此成片。");
          let analysis = cache.get(cacheKey);
          if (!analysis) {
            analysis = await analyzeImageSource(entry.project.published_url!, { width, height }, controller.signal);
            if (!current()) return;
            cache.set(cacheKey, analysis);
            if (cache.size > 128) cache.delete(cache.keys().next().value!);
          }
          entry.analysis = analysis;
        } catch (caught) {
          if (!current()) return;
          entry.error = caught instanceof ApiError && caught.status === 401
            ? "登录已失效，请重新登录后再读取归档图片。"
            : caught instanceof Error ? caught.message : "暂时无法读取此归档图片。";
        }
        publish();
      }
      publish(true);
    };
    void run();
    return () => { controller.abort(); controllers.delete(controller); };
    // The fingerprint includes every immutable image input and displayed title.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!enabled || projects === undefined) return { status: "idle", total: eligible.length, completed: 0, entries: [], retry };
  const entries = snapshot.key === key ? snapshot.entries : eligible.map(project => ({ project, analysis: null, error: null }));
  return {
    status: snapshot.key === key && snapshot.complete ? "ready" : "loading",
    total: entries.length, completed: entries.filter(entry => entry.analysis || entry.error).length, entries, retry,
  };
}
