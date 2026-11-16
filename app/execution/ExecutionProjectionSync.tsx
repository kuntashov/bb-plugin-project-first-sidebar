import { useCallback, useEffect, useMemo, useState } from "react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { EXECUTION_CHANGED_CHANNEL, type ExecutionProjection } from "../../shared/execution-projection.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { sidebarShowExecutionHighlightingAtom } from "../preferences/atoms.js";

export const executionProjectionsAtom = atom<Record<string, ExecutionProjection>>({});
export const executionIndexErrorAtom = atom(false);

export function ExecutionProjectionSync() {
  const enabled = useAtomValue(sidebarShowExecutionHighlightingAtom);
  const setProjections = useSetAtom(executionProjectionsAtom);
  const setIndexError = useSetAtom(executionIndexErrorAtom);
  const { threads } = useSidebarData();
  const ids = useMemo(() => JSON.stringify(threads.map((thread) => thread.id).sort()), [threads]);
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const [revision, setRevision] = useState(0);
  const invalidate = useCallback(() => setRevision((value) => value + 1), []);
  useRealtime(EXECUTION_CHANGED_CHANNEL, invalidate);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    let active = true;
    void rpc.call("getExecutionIndexStatus", null).then((status) => { if (active) setIndexError(status.state === "error"); }).catch(() => { if (active) setIndexError(true); });
    return () => { active = false; };
  }, [rpc, revision, connection, setIndexError]);
  useEffect(() => {
    let active = true;
    if (!enabled) { setProjections({}); return; }
    const threadIds: string[] = JSON.parse(ids);
    void (async () => {
      try {
        const batches = [];
        for (let i = 0; i < threadIds.length; i += 500) batches.push(await rpc.call("getExecutionProjections", { threadIds: threadIds.slice(i, i + 500) }));
        if (active) setProjections(Object.fromEntries(batches.flatMap((batch) => batch.projections).map((projection) => [projection.threadId, projection])));
      } catch {
        if (active) setProjections(Object.fromEntries(threadIds.map((threadId) => [threadId, { threadId, state: "error" as const }])));
      }
    })();
    return () => { active = false; };
  }, [enabled, ids, rpc, setProjections, revision, connection]);
  return null;
}
