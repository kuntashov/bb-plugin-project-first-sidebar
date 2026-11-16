import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAcceptedProjection, type AcceptedProjection } from "./accepted-projection.js";
import { executionProjectionSchema, type ExecutionProjection } from "../shared/execution-projection.js";

export function createExecutionProjectionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  let storageFailure = false;
  const failedIds = new Set<string>();
  bb.storage.migrate(db, [`CREATE TABLE IF NOT EXISTS execution_projection (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, reasoning_level TEXT, service_tier TEXT, accepted_id TEXT, accepted_seq INTEGER, request_id TEXT, request_seq INTEGER, PRIMARY KEY (generation, thread_id))`, `ALTER TABLE execution_projection ADD COLUMN error_reason TEXT`, `CREATE TABLE execution_job (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, state TEXT NOT NULL)`, `CREATE TABLE execution_manifest (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, archived INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (generation, thread_id))`]);
  const store = {
    async reconcile(threadId: string) {
      const result = await readAcceptedProjection(bb.sdk.threads.events.list, threadId);
      store.put(threadId, result);
      return result;
    },
    markUnverified() { db.prepare("UPDATE execution_projection SET state = 'unverified' WHERE generation = 1").run(); },
    put(threadId: string, value: AcceptedProjection) {
      const ready = value.state === "ready" ? value : null;
      db.prepare(`INSERT OR REPLACE INTO execution_projection (generation, thread_id, state, reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq, error_reason) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, value.state, ready?.reasoningLevel ?? null, ready?.serviceTier ?? null, ready?.acceptedId ?? null, ready?.acceptedSeq ?? null, ready?.requestId ?? null, ready?.requestSeq ?? null, value.state === "error" ? value.reason : null);
    },
    beginManifest(threads: { id: string; archivedAt: number | null }[], changed = new Set<string>()) {
      const removed: string[] = [];
      db.transaction(() => {
        const existing = db.prepare("SELECT DISTINCT thread_id FROM execution_manifest").all() as { thread_id: string }[];
        const visible = new Set(threads.map((thread) => thread.id));
        for (const row of existing) if (!visible.has(row.thread_id) && !changed.has(row.thread_id)) {
          db.prepare("DELETE FROM execution_projection WHERE thread_id = ?").run(row.thread_id);
          db.prepare("DELETE FROM execution_manifest WHERE thread_id = ?").run(row.thread_id);
          removed.push(row.thread_id);
        }
        const insert = db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (1, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived, state = 'pending'");
        for (const thread of threads) if (!changed.has(thread.id)) insert.run(thread.id, thread.archivedAt === null ? 0 : 1);
        db.prepare("INSERT OR REPLACE INTO execution_job (id, generation, state) VALUES (1, 1, 'running')").run();
      })();
      for (const id of removed) failedIds.delete(id);
    },
    add(thread: { id: string; archivedAt: number | null }) {
      db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (1, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived").run(thread.id, thread.archivedAt === null ? 0 : 1);
    },
    remove(threadId: string) {
      db.transaction(() => {
        db.prepare("DELETE FROM execution_projection WHERE thread_id = ?").run(threadId);
        db.prepare("DELETE FROM execution_manifest WHERE thread_id = ?").run(threadId);
      })();
      failedIds.delete(threadId);
    },
    contains(threadId: string) {
      return !!db.prepare("SELECT 1 FROM execution_manifest WHERE generation = 1 AND thread_id = ?").get(threadId);
    },
    ids() {
      return (db.prepare("SELECT DISTINCT thread_id FROM execution_manifest").all() as { thread_id: string }[]).map((row) => row.thread_id);
    },
    verified(threadId: string): Extract<AcceptedProjection, { state: "ready" }> | undefined {
      if (failedIds.has(threadId)) return undefined;
      const row = db.prepare("SELECT reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq FROM execution_projection WHERE generation = 1 AND thread_id = ? AND state = 'ready'").get(threadId) as { reasoning_level: string | null; service_tier: string | null; accepted_id: string; accepted_seq: number; request_id: string; request_seq: number } | undefined;
      return row && { state: "ready", reasoningLevel: row.reasoning_level, serviceTier: row.service_tier, acceptedId: row.accepted_id, acceptedSeq: row.accepted_seq, requestId: row.request_id, requestSeq: row.request_seq };
    },
    commit(threadId: string, value: AcceptedProjection) {
      db.transaction(() => {
        store.put(threadId, value);
        db.prepare("UPDATE execution_manifest SET state = ? WHERE generation = 1 AND thread_id = ?").run(value.state === 'error' ? 'error' : 'done', threadId);
      })();
      failedIds.delete(threadId);
    },
    markFailed(threadId: string) { failedIds.add(threadId); },
    finish() {
      db.prepare("UPDATE execution_job SET state = CASE WHEN EXISTS (SELECT 1 FROM execution_manifest WHERE generation = 1 AND state != 'done') THEN 'error' ELSE 'done' END WHERE id = 1").run();
    },
    fail() {
      storageFailure = true;
      db.prepare("INSERT INTO execution_job (id, generation, state) VALUES (1, 1, 'error') ON CONFLICT(id) DO UPDATE SET state = 'error'").run();
    },
    status() {
      const job = db.prepare("SELECT state FROM execution_job WHERE id = 1").get() as { state: 'running' | 'done' | 'error' } | undefined;
      const counts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN state = 'error' THEN 1 ELSE 0 END) AS errors FROM execution_manifest WHERE generation = 1").get() as { total: number; done: number | null; errors: number | null };
      return { state: storageFailure ? 'error' : job?.state ?? 'loading', total: counts.total, done: counts.done ?? 0, errors: counts.errors ?? 0 } as const;
    },
    read(threadIds: string[]): ExecutionProjection[] {
      const query = db.prepare("SELECT state, reasoning_level, service_tier FROM execution_projection WHERE generation = 1 AND thread_id = ?");
      return threadIds.map((threadId) => {
        if (failedIds.has(threadId)) return { threadId, state: "error" };
        const row = query.get(threadId) as { state: string; reasoning_level: string | null; service_tier: string | null } | undefined;
        if (!row) return { threadId, state: "loading" };
        const projection = row.state === "ready" ? { threadId, state: row.state, reasoningLevel: row.reasoning_level, serviceTier: row.service_tier } : { threadId, state: row.state };
        return executionProjectionSchema.parse(projection);
      });
    },
  };
  return store;
}
