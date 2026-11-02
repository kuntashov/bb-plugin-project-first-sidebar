import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { ImportResult, projectFirstSidebarRpcContract } from "../../server.js";

export function ImportPreferences() {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rpc.call("getImportStatus", null).then((status) => {
      if (active) setResult(status);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [rpc]);

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      setResult(await rpc.call("importPreferences", null));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p>Import while Thread-list is enabled. After a successful import, disable Thread-list and choose Project-first sidebar in Settings → Interface → Sidebar.</p>
      <p role={error || result?.state === "failed" ? "alert" : "status"}>
        {error ?? result?.message ?? "Loading import status…"}
      </p>
      <Button disabled={busy} onClick={() => void retry()}>
        {busy ? "Please wait…" : "Import / retry Thread-list preferences"}
      </Button>
    </div>
  );
}
