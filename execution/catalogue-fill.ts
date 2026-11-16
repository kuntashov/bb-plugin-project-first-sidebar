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

function transient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; status?: unknown; name?: unknown; cause?: { code?: unknown } };
  return (typeof e.code === "string" && (e.code.startsWith("SQLITE_BUSY") || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(e.code))) ||
    (typeof e.cause?.code === "string" && (e.cause.code.startsWith("SQLITE_BUSY") || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(e.cause.code))) ||
    e.name === "BbRequestTimeoutError" || (typeof e.status === "number" && [408, 429, 502, 503, 504].includes(e.status));
}

/** All reads and writes for an ID go through the same revision-fenced worker. */
export function registerCatalogueFill(bb: BbPluginApi, store: ReturnType<typeof createExecutionProjectionStore>) {
  let dispatch: ((id: string, membership: boolean, force?: boolean) => void) | undefined;
  let requestScan: (() => void) | undefined;
  let load = 0;
  let isScanActive = () => false;
  const early = new Set<string>();
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (dispatch) dispatch(thread.id, false, false); else early.add(thread.id);
  });
  bb.background.service("execution-catalogue", {
    async start(signal) {
      const current = ++load;
      const stale = () => signal.aborted || current !== load;
      let scanRunning = false;
      isScanActive = () => !stale() && scanRunning;
      const revisions = new Map<string, number>();
      let globalRevision = 0;
      let catalogRevision = 0;
      let scanRequested = false;
      let scanLiveRequested = false;
      const membership = new Set<string>();
      const fullRead = new Set<string>();
      const live = new Set<string>();
      const pending = new Set<string>();
      const running = new Set<string>();
      let snapshotChanges: Set<string> | undefined;
      let active = 0;
      let wake: (() => void) | undefined;
      const publish = (id?: string) => { if (!stale()) bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, id ? { threadId: id } : {}); };
      const publishProgress = () => { if (!stale()) bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { progress: true }); };
      const changed = (id: string, check: boolean, force = true, liveChange = true) => {
        if (stale()) return;
        revisions.set(id, (revisions.get(id) ?? 0) + 1);
        if (check) { membership.add(id); snapshotChanges?.add(id); }
        if (force) fullRead.add(id);
        if (liveChange) live.add(id);
        pending.add(id);
        pump();
      };
      const retry = async <T>(operation: () => Promise<T>, onFailure?: () => void): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try { return await operation(); } catch (error) {
            if (attempt === 3 || !transient(error) || stale()) throw error;
            onFailure?.();
            await delay([1000, 5000, 15000][attempt]!, signal);
            if (stale()) throw error;
          }
        }
      };
      async function work(id: string) {
        const revision = revisions.get(id) ?? 0;
        const globalAtStart = globalRevision;
        const token = store.token();
        const force = fullRead.delete(id);
        const liveChange = live.delete(id);
        const valid = () => !stale() && token === store.token() && revision === (revisions.get(id) ?? 0) && globalAtStart === globalRevision;
        const recordFailure = () => {
          if (!valid()) return;
          try { store.commit(id, { state: "error", reason: "transient" }, liveChange, catalogRevision === globalRevision); }
          catch { store.markFailed(id, liveChange); }
          publish(id);
        };
        try {
          if (membership.has(id)) {
            const rows = await retry(() => bb.sdk.threads.list({ threadIds: [id], includeHidden: false }), recordFailure);
            if (!valid()) return;
            const thread = rows.find((row) => row.id === id);
            if (!thread) {
              await retry(async () => { if (valid()) store.remove(id); }, recordFailure);
              if (valid()) { membership.delete(id); publish(id); }
              return;
            }
            await retry(async () => { if (valid()) store.add(thread); }, recordFailure);
            if (!valid()) return;
            membership.delete(id);
          }
          const exists = await retry(async () => valid() && store.contains(id), recordFailure);
          if (!valid() || !exists) return;
          const previous = force ? undefined : await retry(async () => valid() ? store.verified(id) : undefined, recordFailure);
          if (!valid()) return;
          const listHistory: typeof bb.sdk.threads.events.list = (args) => {
            if (!valid()) return Promise.reject(new Error("Execution read superseded"));
            return bb.sdk.threads.events.list(args);
          };
          let result = await readAcceptedProjection(listHistory, id, previous);
          for (const ms of [1000, 5000, 15000]) {
            if (result.state !== "error" || result.reason !== "transient" || !valid()) break;
            recordFailure();
            await delay(ms, signal);
            if (!valid()) return;
            result = await readAcceptedProjection(listHistory, id, previous);
          }
          if (!valid()) return;
          const before = await retry(async () => valid() ? store.read([id])[0] : undefined, recordFailure);
          const statusBefore = await retry(async () => valid() ? store.status() : undefined, recordFailure);
          if (!valid()) return;
          const outcome = await retry(async () => {
            if (!valid()) return undefined;
            store.commit(id, result, liveChange, catalogRevision === globalRevision);
            return { after: store.read([id])[0], status: store.status() };
          }, recordFailure);
          if (!valid() || !outcome) return;
          if (JSON.stringify(before) !== JSON.stringify(outcome.after)) publish(id);
          else if (outcome.status.state === 'running' || JSON.stringify(statusBefore) !== JSON.stringify(outcome.status)) bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { progress: true });
        } catch (error) {
          if (!valid()) return;
          try { store.commit(id, { state: "error", reason: transient(error) ? "transient" : "unknown" }, liveChange, catalogRevision === globalRevision); }
          catch { store.markFailed(id, liveChange); }
          publish(id);
        } finally {
          if (globalAtStart !== globalRevision && !stale()) { fullRead.add(id); live.add(id); }
          if (force && !valid() && !stale()) fullRead.add(id);
          if (liveChange && !valid() && !stale()) live.add(id);
          if (!valid() && !stale()) pending.add(id);
        }
      }
      function pump() {
        while (!stale() && active < 4) {
          const id = [...pending].find((candidate) => !running.has(candidate));
          if (!id) break;
          pending.delete(id); running.add(id); active++;
          void work(id).finally(() => {
            running.delete(id); active--;
            if (!stale()) pump();
            if (!stale() && !scanRunning && !pending.size && !active) {
              void retry(async () => {
                if (!stale() && !scanRunning && !pending.size && !active && store.canFinishRepair()) { store.finish(); publish(); }
              }, () => publish()).catch(() => {
                // The saved error remains available for the next trigger.
                publish();
              });
            }
            wake?.();
          });
        }
      }
      async function drain() {
        while (!stale() && (pending.size || active)) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
      dispatch = changed;
      const requestLiveScan = () => {
        if (stale()) return;
        globalRevision++;
        store.invalidateAll();
        publish();
        scanLiveRequested = true;
        scanRequested = true;
        requestScan?.();
      };
      const unsubscribeThread = bb.sdk.subscribe({ event: "thread:changed", callback: (event) => {
        if (!event.id) {
          const membershipOrRewrite = event.changes.some((change) => ["thread-created", "thread-deleted", "title-changed", "archived-changed", "history-rewritten", "history-compacted"].includes(change));
          const types = event.metadata?.eventTypes;
          const relevantAppend = event.changes.includes("events-appended") && (!types?.length || types.some((type) => type === "turn/input/accepted" || type === "client/turn/requested"));
          if (membershipOrRewrite || relevantAppend) {
            requestLiveScan();
          }
          return;
        }
        if (event.id && event.changes.some((change) => ["thread-created", "thread-deleted", "title-changed", "archived-changed"].includes(change))) changed(event.id, true);
        if (event.id && event.changes.some((change) => ["history-rewritten", "history-compacted"].includes(change))) changed(event.id, false);
      } });
      const scan = async () => {
        scanRequested = true;
        if (scanRunning) return;
        scanRunning = true;
        const recordScanFailure = () => {
          if (stale()) return;
          try { store.fail(); } catch { /* storage is unavailable */ }
          publishProgress();
        };
        try {
          while (scanRequested && !stale()) {
            scanRequested = false;
            const liveScan = scanLiveRequested;
            scanLiveRequested = false;
            const scanRevision = globalRevision;
            publishProgress();
            await retry(async () => { if (!stale()) store.beginRecovery(); }, recordScanFailure);
            if (stale()) return;
            const touched = new Set<string>(); snapshotChanges = touched;
            const threads = await retry(() => bb.sdk.threads.list({ includeHidden: false }), recordScanFailure);
            if (stale()) return;
            if (scanRevision !== globalRevision) { snapshotChanges = undefined; continue; }
            const visible = new Set(threads.map((thread) => thread.id));
            let removed: string[] = [];
            const applied = await retry(async () => {
              if (stale() || scanRevision !== globalRevision) return false;
              removed = store.ids().filter((id) => !visible.has(id) && !touched.has(id));
              for (const id of removed) revisions.set(id, (revisions.get(id) ?? 0) + 1);
              store.beginManifest(threads, touched);
              return true;
            }, recordScanFailure);
            if (stale()) return;
            if (!applied || scanRevision !== globalRevision) { snapshotChanges = undefined; continue; }
            catalogRevision = scanRevision;
            snapshotChanges = undefined;
            for (const id of removed) publish(id);
            // Recheck every ID observed during the snapshot, even if it was already processed.
            for (const id of touched) changed(id, true);
            for (const archived of [false, true]) {
              for (const thread of threads) if (!touched.has(thread.id) && (thread.archivedAt !== null) === archived) changed(thread.id, false, true, liveScan);
              await drain();
              if (stale()) return;
            }
            await retry(async () => {
              while (!stale() && (pending.size || active)) await drain();
              if (!stale() && !scanRequested && store.finish()) {
                publish();
                try { store.cleanup(); } catch { bb.log.error("Execution index cleanup failed; it will be retried at startup"); }
              }
            }, recordScanFailure);
            if (scanRequested) continue;
          }
        } catch (error) {
          snapshotChanges = undefined;
          if (!stale()) {
            try { store.fail(); } catch { /* storage is unavailable */ }
            bb.log.error(`Execution catalogue fill failed: ${error instanceof Error ? error.name : "unknown error"}`);
          }
        } finally {
          scanRunning = false;
          if (scanRequested && !stale()) void scan();
          else publishProgress();
        }
      };
      requestScan = () => { void scan(); };
      const unsubscribeConnection = bb.sdk.subscribe({ event: "realtime:connection", callback: (event) => {
        if (event.state === "connected") requestLiveScan();
      } });
      for (const id of early) changed(id, true);
      early.clear();
      const stop = () => { if (current === load) { ++load; dispatch = undefined; requestScan = undefined; isScanActive = () => false; } unsubscribeThread(); unsubscribeConnection(); wake?.(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      void scan();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  return {
    status() { return { ...store.status(), kind: store.kind(), tooLarge: store.tooLarge(), active: isScanActive() }; },
    startRebuild() {
      if (!isScanActive() && store.startRebuild()) { requestScan?.(); bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { progress: true }); }
      return this.status();
    },
  };
}
