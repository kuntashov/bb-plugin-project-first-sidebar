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
    (typeof e.cause?.code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(e.cause.code)) ||
    e.name === "BbRequestTimeoutError" || (typeof e.status === "number" && [408, 429, 502, 503, 504].includes(e.status));
}

/** All reads and writes for an ID go through the same revision-fenced worker. */
export function registerCatalogueFill(bb: BbPluginApi, store: ReturnType<typeof createExecutionProjectionStore>) {
  let dispatch: ((id: string, membership: boolean, force?: boolean) => void) | undefined;
  let requestScan: (() => void) | undefined;
  let load = 0;
  const early = new Set<string>();
  bb.events.on("experimental_thread.events", ({ thread }) => {
    if (dispatch) dispatch(thread.id, false, false); else early.add(thread.id);
  });
  bb.background.service("execution-catalogue", {
    async start(signal) {
      const current = ++load;
      const stale = () => signal.aborted || current !== load;
      const revisions = new Map<string, number>();
      const membership = new Set<string>();
      const fullRead = new Set<string>();
      const live = new Set<string>();
      const pending = new Set<string>();
      const running = new Set<string>();
      let snapshotChanges: Set<string> | undefined;
      let active = 0;
      let wake: (() => void) | undefined;
      const publish = (id?: string) => { if (!stale()) bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, id ? { threadId: id } : {}); };
      const changed = (id: string, check: boolean, force = true, liveChange = true) => {
        if (stale()) return;
        revisions.set(id, (revisions.get(id) ?? 0) + 1);
        if (check) { membership.add(id); snapshotChanges?.add(id); }
        if (force) fullRead.add(id);
        if (liveChange) live.add(id);
        pending.add(id);
        pump();
      };
      const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
          try { return await operation(); } catch (error) {
            if (attempt === 3 || !transient(error) || stale()) throw error;
            await delay([1000, 5000, 15000][attempt]!, signal);
            if (stale()) throw error;
          }
        }
      };
      async function work(id: string) {
        const revision = revisions.get(id) ?? 0;
        const token = store.token();
        const force = fullRead.delete(id);
        const liveChange = live.delete(id);
        const valid = () => !stale() && token === store.token() && revision === (revisions.get(id) ?? 0);
        try {
          if (membership.has(id)) {
            const rows = await retry(() => bb.sdk.threads.list({ threadIds: [id], includeHidden: false }));
            if (!valid()) return;
            const thread = rows.find((row) => row.id === id);
            if (!thread) {
              await retry(async () => { if (valid()) store.remove(id); });
              if (valid()) { membership.delete(id); publish(id); }
              return;
            }
            await retry(async () => { if (valid()) store.add(thread); });
            if (!valid()) return;
            membership.delete(id);
          }
          if (!store.contains(id)) return;
          const previous = force ? undefined : store.verified(id);
          let result = await readAcceptedProjection(bb.sdk.threads.events.list, id, previous);
          for (const ms of [1000, 5000, 15000]) {
            if (result.state !== "error" || result.reason !== "transient" || !valid()) break;
            await delay(ms, signal);
            if (!valid()) return;
            result = await readAcceptedProjection(bb.sdk.threads.events.list, id, previous);
          }
          if (!valid()) return;
          const before = store.read([id])[0];
          await retry(async () => { if (valid()) store.commit(id, result, liveChange); });
          if (!valid()) return;
          if (JSON.stringify(before) !== JSON.stringify(store.read([id])[0])) publish(id);
          else if (store.status().state === 'running') bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { progress: true });
        } catch (error) {
          if (!valid()) return;
          try { store.commit(id, { state: "error", reason: transient(error) ? "transient" : "unknown" }, liveChange); }
          catch { store.markFailed(id, liveChange); }
          publish(id);
        } finally {
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
            wake?.();
          });
        }
      }
      async function drain() {
        while (!stale() && (pending.size || active)) await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
      dispatch = changed;
      const unsubscribeThread = bb.sdk.subscribe({ event: "thread:changed", callback: (event) => {
        if (event.id && event.changes.some((change) => ["thread-created", "thread-deleted", "title-changed", "archived-changed"].includes(change))) changed(event.id, true);
        if (event.id && event.changes.some((change) => ["history-rewritten", "history-compacted"].includes(change))) changed(event.id, false);
      } });
      let scanRequested = false;
      let scanRunning = false;
      const scan = async () => {
        scanRequested = true;
        if (scanRunning) return;
        scanRunning = true;
        try {
          store.beginRecovery();
          while (scanRequested && !stale()) {
            scanRequested = false;
            const touched = new Set<string>(); snapshotChanges = touched;
            const threads = await retry(() => bb.sdk.threads.list({ includeHidden: false }));
            if (stale()) return;
            const visible = new Set(threads.map((thread) => thread.id));
            let removed: string[] = [];
            await retry(async () => {
              if (stale()) return;
              removed = store.ids().filter((id) => !visible.has(id) && !touched.has(id));
              for (const id of removed) revisions.set(id, (revisions.get(id) ?? 0) + 1);
              store.beginManifest(threads, touched);
            });
            if (stale()) return;
            snapshotChanges = undefined;
            for (const id of removed) publish(id);
            // Recheck every ID observed during the snapshot, even if it was already processed.
            for (const id of touched) changed(id, true);
            for (const archived of [false, true]) {
              for (const thread of threads) if (!touched.has(thread.id) && (thread.archivedAt !== null) === archived) changed(thread.id, false, true, false);
              await drain();
              if (stale()) return;
            }
            await retry(async () => {
              while (!stale() && (pending.size || active)) await drain();
              if (!stale() && !scanRequested) store.finish();
            });
            if (scanRequested) continue;
            publish();
            if (store.status().state === 'done') {
              try { store.cleanup(); } catch { bb.log.error("Execution index cleanup failed; it will be retried at startup"); }
            }
          }
        } catch (error) {
          snapshotChanges = undefined;
          if (!stale()) {
            try { store.fail(); } catch { /* storage is unavailable */ }
            publish();
            bb.log.error(`Execution catalogue fill failed: ${error instanceof Error ? error.name : "unknown error"}`);
          }
        } finally {
          scanRunning = false;
          if (scanRequested && !stale()) void scan();
        }
      };
      requestScan = () => { void scan(); };
      const unsubscribeConnection = bb.sdk.subscribe({ event: "realtime:connection", callback: (event) => {
        if (event.state === "connected") void scan();
      } });
      for (const id of early) changed(id, true);
      early.clear();
      const stop = () => { if (current === load) { ++load; dispatch = undefined; requestScan = undefined; } unsubscribeThread(); unsubscribeConnection(); wake?.(); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      void scan();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  return {
    startRebuild() {
      if (store.startRebuild()) { requestScan?.(); bb.realtime.publish(EXECUTION_CHANGED_CHANNEL, { progress: true }); }
      return { ...store.status(), kind: store.kind(), tooLarge: store.tooLarge() };
    },
  };
}
