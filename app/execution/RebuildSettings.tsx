import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { EXECUTION_CHANGED_CHANNEL } from "../../shared/execution-projection.js";
import type { projectFirstSidebarRpcContract } from "../../server.js";

type Status = { kind: "initial" | "rebuild" | "recovery"; state: "loading" | "running" | "done" | "error"; total: number; done: number; errors: number; tooLarge: number };

export function RebuildSettings() {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const refresh = useCallback(() => {
    const current = ++version.current;
    void rpc.call("getExecutionRebuildStatus", null).then((result) => {
      if (current === version.current) { setStatus(result); setError(false); }
    }).catch(() => { if (current === version.current) setError(true); });
  }, [rpc]);
  useRealtime(EXECUTION_CHANGED_CHANNEL, refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => { refresh(); return () => { version.current++; }; }, [refresh, connection]);
  async function start() {
    setBusy(true);
    const current = ++version.current;
    try {
      const result = await rpc.call("startExecutionRebuild", null);
      if (current === version.current) { setStatus(result); setError(false); }
    } catch { if (current === version.current) setError(true); }
    finally { setBusy(false); }
  }
  const recovering = status?.kind === "recovery" && status.state === "running";
  return <div className="flex flex-col gap-3">
    <p role={error || status?.state === "error" ? "alert" : "status"}>
      {error ? "Execution index status is unavailable." : !status ? "Loading execution index status…" : `${status.kind}: ${status.state} — ${status.done} / ${status.total} processed, ${status.errors} errors.`}
      {recovering && " Wait for recovery to finish before rebuilding."}
      {!!status?.tooLarge && ` ${status.tooLarge} histories exceed the SDK response size limit (413).`}
    </p>
    <Button disabled={busy || !status || recovering} onClick={() => void start()}>Rebuild execution index</Button>
  </div>;
}
