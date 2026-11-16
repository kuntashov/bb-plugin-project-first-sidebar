import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAcceptedProjection } from "./accepted-projection.js";
import type { createExecutionProjectionStore } from "./projection-store.js";
import { EXECUTION_CHANGED_CHANNEL } from "../shared/execution-projection.js";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** One server service owns the initial queue. Later reconciliation uses the same storage. */
export function registerCatalogueFill(bb: BbPluginApi, store: ReturnType<typeof createExecutionProjectionStore>) {
  let load = 0;
  bb.background.service("execution-catalogue", {
    async start(signal) {
      const current = ++load;
      const stale = () => signal.aborted || current !== load;
      try {
        const threads = await bb.sdk.threads.list({ includeHidden: false });
        if (stale()) return;
        store.beginManifest(threads);
        // Finish all active units before starting the archive.
        for (const archived of [false, true]) {
          const ids = threads.filter((thread) => (thread.archivedAt !== null) === archived).map((thread) => thread.id);
          let next = 0;
          const workers = await Promise.allSettled(Array.from({ length: Math.min(4, ids.length) }, async () => {
            while (!stale() && next < ids.length) {
              const id = ids[next++]!;
              let result = await readAcceptedProjection(bb.sdk.threads.events.list, id);
              for (const ms of [1000, 5000, 15000]) {
                if (result.state !== "error" || result.reason !== "transient" || stale()) break;
                await delay(ms, signal);
                if (stale()) return;
                result = await readAcceptedProjection(bb.sdk.threads.events.list, id);
              }
              if (stale()) return;
              store.commit(id, result);
              bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { threadId: id });
            }
          }));
          const failed = workers.find((worker) => worker.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          if (stale()) return;
        }
        store.finish();
        bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, {});
      } catch (error) {
        if (!stale()) {
          try { store.fail(); bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, {}); } catch { /* Storage itself is unavailable. */ }
          bb.log.error(`Execution catalogue fill failed: ${error instanceof Error ? error.name : "unknown error"}`);
        }
      }
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
}
