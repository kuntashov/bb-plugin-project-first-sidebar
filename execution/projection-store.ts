import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAcceptedProjection, type AcceptedProjection } from "./accepted-projection.js";
import { executionProjectionSchema, type ExecutionProjection } from "../shared/execution-projection.js";

export function createExecutionProjectionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  let storageFailure = false;
  const failedIds = new Set<string>();
  bb.storage.migrate(db, [`CREATE TABLE IF NOT EXISTS execution_projection (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, reasoning_level TEXT, service_tier TEXT, accepted_id TEXT, accepted_seq INTEGER, request_id TEXT, request_seq INTEGER, PRIMARY KEY (generation, thread_id))`, `ALTER TABLE execution_projection ADD COLUMN error_reason TEXT`, `CREATE TABLE execution_job (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, state TEXT NOT NULL)`, `CREATE TABLE execution_manifest (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, archived INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (generation, thread_id))`, `ALTER TABLE execution_job ADD COLUMN failure_scope TEXT`, `UPDATE execution_job SET failure_scope = 'catalogue' WHERE state = 'error'`]);
  function refreshFinishedStatus(resolvedId: string) {
    const remainingFailures = failedIds.size - (failedIds.has(resolvedId) ? 1 : 0);
    db.prepare("UPDATE execution_job SET state = CASE WHEN ? > 0 OR EXISTS (SELECT 1 FROM execution_manifest WHERE generation = 1 AND state != 'done') OR EXISTS (SELECT 1 FROM execution_projection WHERE generation = 1 AND state = 'error') THEN 'error' ELSE 'done' END WHERE id = 1 AND state != 'running' AND failure_scope IS NULL").run(remainingFailures);
  }
  const store = {
    async reconcile(threadId: string) {
      const result = await readAcceptedProjection(bb.sdk.threads.events.list, threadId);
      store.put(threadId, result);
      return result;
    },
    markUnverified() { db.prepare("UPDATE execution_projection SET state = 'unverified' WHERE generation = 1 AND state IN ('ready', 'absent')").run(); },
    put(threadId: string, value: AcceptedProjection) {
      const ready = value.state === "ready" ? value : null;
      db.prepare(`INSERT OR REPLACE INTO execution_projection (generation, thread_id, state, reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq, error_reason) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, value.state, ready?.reasoningLevel ?? null, ready?.serviceTier ?? null, ready?.acceptedId ?? null, ready?.acceptedSeq ?? null, ready?.requestId ?? null, ready?.requestSeq ?? null, value.state === "error" ? value.reason : null);
    },
    beginManifest(threads: { id: string; archivedAt: number | null }[], changed = new Set<string>()) {
      const removed: string[] = [];
      db.transaction(() => {
        const existing = new Set((db.prepare("SELECT thread_id FROM execution_manifest UNION SELECT thread_id FROM execution_projection").all() as { thread_id: string }[]).map((row) => row.thread_id));
        for (const id of failedIds) existing.add(id);
        const visible = new Set(threads.map((thread) => thread.id));
        for (const id of existing) if (!visible.has(id) && !changed.has(id)) {
          db.prepare("DELETE FROM execution_projection WHERE thread_id = ?").run(id);
          db.prepare("DELETE FROM execution_manifest WHERE thread_id = ?").run(id);
          removed.push(id);
        }
        const insert = db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (1, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived, state = 'pending'");
        for (const thread of threads) if (!changed.has(thread.id)) insert.run(thread.id, thread.archivedAt === null ? 0 : 1);
        db.prepare("INSERT OR REPLACE INTO execution_job (id, generation, state) VALUES (1, 1, 'running')").run();
      })();
      for (const id of removed) failedIds.delete(id);
      storageFailure = false;
    },
    add(thread: { id: string; archivedAt: number | null }) {
      db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (1, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived").run(thread.id, thread.archivedAt === null ? 0 : 1);
    },
    remove(threadId: string) {
      db.transaction(() => {
        db.prepare("DELETE FROM execution_projection WHERE thread_id = ?").run(threadId);
        db.prepare("DELETE FROM execution_manifest WHERE thread_id = ?").run(threadId);
        refreshFinishedStatus(threadId);
      })();
      failedIds.delete(threadId);
    },
    contains(threadId: string) {
      return !!db.prepare("SELECT 1 FROM execution_manifest WHERE generation = 1 AND thread_id = ?").get(threadId);
    },
    ids() {
      const ids = new Set((db.prepare("SELECT thread_id FROM execution_manifest UNION SELECT thread_id FROM execution_projection").all() as { thread_id: string }[]).map((row) => row.thread_id));
      for (const id of failedIds) ids.add(id);
      return [...ids];
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
        refreshFinishedStatus(threadId);
      })();
      failedIds.delete(threadId);
    },
    markFailed(threadId: string) { failedIds.add(threadId); },
    finish() {
      db.prepare("UPDATE execution_job SET state = CASE WHEN ? > 0 OR EXISTS (SELECT 1 FROM execution_manifest WHERE generation = 1 AND state != 'done') OR EXISTS (SELECT 1 FROM execution_projection WHERE generation = 1 AND state = 'error') THEN 'error' ELSE 'done' END, failure_scope = NULL WHERE id = 1").run(failedIds.size);
      storageFailure = false;
    },
    fail() {
      storageFailure = true;
      db.prepare("INSERT INTO execution_job (id, generation, state, failure_scope) VALUES (1, 1, 'error', 'catalogue') ON CONFLICT(id) DO UPDATE SET state = 'error', failure_scope = 'catalogue'").run();
    },
    status() {
      const job = db.prepare("SELECT state, failure_scope FROM execution_job WHERE id = 1").get() as { state: 'running' | 'done' | 'error'; failure_scope: string | null } | undefined;
      const counts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending FROM execution_manifest WHERE generation = 1").get() as { total: number; done: number | null; pending: number | null };
      const errors = new Set(failedIds);
      const rows = db.prepare("SELECT thread_id FROM execution_manifest WHERE generation = 1 AND state = 'error' UNION SELECT thread_id FROM execution_projection WHERE generation = 1 AND state = 'error'").all() as { thread_id: string }[];
      for (const row of rows) errors.add(row.thread_id);
      const state = storageFailure ? 'error' : !job ? 'loading' : job.state === 'running' ? 'running' : job.failure_scope === 'catalogue' || errors.size || counts.pending ? 'error' : 'done';
      return { state, total: counts.total, done: counts.done ?? 0, errors: errors.size } as const;
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
