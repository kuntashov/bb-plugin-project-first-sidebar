import { useEffect, useRef, useState } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { changesSearchMetadata, completeAncestors, listSearchThreads, type SearchProject, type SearchThread } from "./search-model.js";

export interface SearchData {
  active: readonly SearchThread[];
  archived: readonly SearchThread[];
  byId: ReadonlyMap<string, SearchThread>;
  projects: readonly SearchProject[];
  activeReady: boolean;
  archiveReady: boolean;
  error: string | null;
  archiveError: string | null;
}
const initial: SearchData = { active: [], archived: [], byId: new Map(), projects: [], activeReady: false, archiveReady: false, error: null, archiveError: null };

// Session-local metadata only. Input changes never refetch the collection.
export function useSearchData(includeArchived: boolean) {
  const sdk = useSdk();
  const activeRequest = useRef<AbortController | null>(null);
  const archiveRequest = useRef<AbortController | null>(null);
  const [version, setVersion] = useState(0);
  const [data, setData] = useState<SearchData>(initial);
  useEffect(() => {
    const invalidate = () => {
      activeRequest.current?.abort(); archiveRequest.current?.abort();
      setData(initial); setVersion((value) => value + 1);
    };
    const disposers = [
      sdk.subscribe({ event: "thread:changed", callback: (event) => {
        // Streaming output, read receipts and tab changes do not alter membership
        // or titles; restarting on each delta would prevent navigation entirely.
        if (changesSearchMetadata(event.changes)) invalidate();
      } }),
      sdk.subscribe({ event: "project:changed", callback: invalidate }),
      sdk.subscribe({ event: "realtime:connection", callback: (event) => { if (event.reconnected) invalidate(); } }),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [sdk]);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    activeRequest.current = controller;
    setData(initial);
    void (async () => {
      const [active, projects] = await Promise.all([
        listSearchThreads(sdk, false, signal),
        sdk.projects.list({ includePersonal: true, signal }),
      ]);
      const byId = await completeAncestors(sdk, active, signal);
      signal.throwIfAborted();
      setData({ ...initial, active, projects: projects.map((project) => ({ ...project, isPersonal: project.kind === "personal" })), byId, activeReady: true });
    })().catch((error: unknown) => {
      if (!signal.aborted) setData({ ...initial, error: error instanceof Error ? error.message : "Не удалось загрузить треды." });
    });
    return () => controller.abort();
  }, [sdk, version]);
  useEffect(() => {
    if (!includeArchived || !data.activeReady || data.archiveReady) return;
    const controller = new AbortController();
    const { signal } = controller;
    archiveRequest.current = controller;
    setData((current) => ({ ...current, archiveError: null }));
    void (async () => {
      const archived = await listSearchThreads(sdk, true, signal);
      const byId = await completeAncestors(sdk, [...data.byId.values(), ...archived], signal);
      signal.throwIfAborted();
      setData((current) => ({ ...current, archived, byId, archiveReady: true }));
    })().catch((error: unknown) => {
      if (!signal.aborted) setData((current) => ({ ...current, archiveError: error instanceof Error ? error.message : "Не удалось загрузить архив." }));
    });
    return () => controller.abort();
  }, [sdk, includeArchived, data.activeReady, data.archiveReady, version]);
  return data;
}
