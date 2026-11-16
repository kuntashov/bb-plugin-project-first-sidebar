import { useCallback, useEffect, useMemo, useRef } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { EXECUTION_CHANGED_CHANNEL, type ExecutionProjection } from "../../shared/execution-projection.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { sidebarShowExecutionHighlightingAtom } from "../preferences/atoms.js";
import { createProjectionQueue } from "./projection-queue.js";

export const executionProjectionsAtom = atom<Record<string, ExecutionProjection>>({});
export const executionIndexErrorAtom = atom(false);

export function ExecutionProjectionSync() {
  const enabled = useAtomValue(sidebarShowExecutionHighlightingAtom);
  const setProjections = useSetAtom(executionProjectionsAtom);
  const setIndexError = useSetAtom(executionIndexErrorAtom);
  const { threads } = useSidebarData();
  const ids = useMemo(() => JSON.stringify(threads.map((thread) => thread.id).sort()), [threads]);
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const queue = useRef<ReturnType<typeof createProjectionQueue> | null>(null);
  const visible = useRef(new Set<string>());
  const statusVersion = useRef(0);
  const appliedVersion = useRef(0);
  const mounted = useRef(false);
  const refreshStatus = useCallback(() => {
    const version = ++statusVersion.current;
    void rpc.call("getExecutionIndexStatus", null).then((status) => {
      if (mounted.current && version > appliedVersion.current) { appliedVersion.current = version; setIndexError(status.state === "error" || status.errors > 0); }
    }).catch(() => {
      if (mounted.current && version > appliedVersion.current) { appliedVersion.current = version; setIndexError(true); }
    });
  }, [rpc, setIndexError]);
  const invalidate = useCallback((payload: unknown) => {
    refreshStatus();
    if (typeof payload === "object" && payload !== null && "threadId" in payload && typeof payload.threadId === "string") {
      if (visible.current.has(payload.threadId)) queue.current?.add([payload.threadId]);
    } else if (!(typeof payload === "object" && payload !== null && "progress" in payload)) queue.current?.add([...visible.current]);
  }, [refreshStatus]);
  useRealtime(EXECUTION_CHANGED_CHANNEL, invalidate);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    mounted.current = true;
    refreshStatus();
    return () => { mounted.current = false; };
  }, [refreshStatus, connection]);
  useEffect(() => {
    const threadIds: string[] = JSON.parse(ids);
    visible.current = new Set(threadIds);
    if (!enabled) { setProjections({}); return; }
    const next = createProjectionQueue(
      async (threadIds) => (await rpc.call("getExecutionProjections", { threadIds })).projections,
      (values) => setProjections((previous) => ({ ...previous, ...Object.fromEntries(values.map((value) => [value.threadId, value])) })),
    );
    queue.current = next;
    setProjections((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => visible.current.has(id))));
    next.add(threadIds);
    return () => { next.dispose(); if (queue.current === next) queue.current = null; };
  }, [enabled, ids, rpc, setProjections, connection]);
  return null;
}
