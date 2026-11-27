import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAcceptedProjection, type AcceptedProjection } from "./accepted-projection.js";
import { executionProjectionSchema, type ExecutionProjection } from "../shared/execution-projection.js";

export const EXECUTION_STORAGE_MIGRATIONS = [
  `CREATE TABLE execution_projection (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, reasoning_level TEXT, service_tier TEXT, accepted_id TEXT, accepted_seq INTEGER, request_id TEXT, request_seq INTEGER, error_reason TEXT, PRIMARY KEY (generation, thread_id))`,
  `CREATE TABLE execution_job (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, state TEXT NOT NULL, failure_scope TEXT, kind TEXT NOT NULL DEFAULT 'initial', epoch INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE execution_manifest (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, archived INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (generation, thread_id))`,
  `CREATE TABLE execution_meta (id INTEGER PRIMARY KEY CHECK (id = 1), active_generation INTEGER NOT NULL, initial_completed INTEGER NOT NULL DEFAULT 0)`,
  `INSERT INTO execution_meta (id, active_generation) VALUES (1, 1)`,
];

export function createExecutionProjectionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  let storageFailure = false;
  // Only this store changes jobs; keep the fence independent of fallible SQLite reads.
  let fence = 0;
  let building = false;
  let globallyUnverified = false;
  const reverified = new Set<string>();
  const failedIds = new Set<string>();
  const workingFailures = new Set<string>();
  bb.storage.migrate(db, EXECUTION_STORAGE_MIGRATIONS);
  const active = () => (db.prepare("SELECT active_generation FROM execution_meta WHERE id = 1").get() as { active_generation: number }).active_generation;
  const job = () => db.prepare("SELECT generation, state, kind, epoch FROM execution_job WHERE id = 1").get() as { generation: number; state: string; kind: string; epoch: number } | undefined;
  const target = () => job()?.generation ?? active();
  const store = {
    prepareStartup() {
      let nextBuilding = false;
      db.transaction(() => {
        const current = job();
        if (!current) db.prepare("INSERT INTO execution_job (id, generation, state, kind) VALUES (1, ?, 'running', 'initial')").run(active());
        else if (current.state === 'done') db.prepare("UPDATE execution_job SET generation = ?, state = 'running', kind = 'recovery', failure_scope = NULL WHERE id = 1").run(active());
        else if (current.state === 'running') db.prepare("UPDATE execution_manifest SET state = 'pending' WHERE generation = ? AND state = 'running'").run(current.generation);
        db.prepare("UPDATE execution_job SET epoch = epoch + 1 WHERE id = 1").run();
        nextBuilding = job()?.kind === 'rebuild' && target() !== active();
      })();
      building = nextBuilding;
      fence++;
      try {
        db.transaction(() => {
          db.prepare("DELETE FROM execution_projection WHERE generation NOT IN (?, ?)").run(active(), target());
          db.prepare("DELETE FROM execution_manifest WHERE generation NOT IN (?, ?)").run(active(), target());
        })();
      } catch { bb.log.error("Execution index cleanup failed; it will be retried after reconciliation"); }
    },
    startRebuild() {
      let nextBuilding = building;
      const started = db.transaction(() => {
        const current = job();
        if (!current || current.state === 'running') return false;
        const initialCompleted = (db.prepare("SELECT initial_completed FROM execution_meta WHERE id = 1").get() as { initial_completed: number }).initial_completed;
        if ((current.kind === 'rebuild' || (current.kind === 'initial' && !initialCompleted)) && current.state === 'error') {
          db.prepare("UPDATE execution_job SET state = 'running', failure_scope = NULL WHERE id = 1").run();
        } else {
          const generation = active() + 1;
          db.prepare("DELETE FROM execution_projection WHERE generation = ?").run(generation);
          db.prepare("DELETE FROM execution_manifest WHERE generation = ?").run(generation);
          db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) SELECT ?, thread_id, archived, 'pending' FROM execution_manifest WHERE generation = ?").run(generation, active());
          db.prepare("UPDATE execution_job SET generation = ?, kind = 'rebuild', state = 'running', failure_scope = NULL WHERE id = 1").run(generation);
        }
        db.prepare("UPDATE execution_job SET epoch = epoch + 1 WHERE id = 1").run();
        nextBuilding = job()?.kind === 'rebuild' && target() !== active();
        return true;
      })();
      if (started) { storageFailure = false; building = nextBuilding; fence++; }
      return started;
    },
    beginRecovery() {
      const generation = active();
      const changed = db.prepare("UPDATE execution_job SET generation = ?, kind = 'recovery', state = 'running', failure_scope = NULL, epoch = epoch + 1 WHERE id = 1 AND (state = 'done' OR (state = 'error' AND failure_scope = 'catalogue' AND generation = ? AND (SELECT initial_completed FROM execution_meta WHERE id = 1) = 1))").run(generation, generation).changes;
      if (changed) { building = false; fence++; }
    },
    token() { return fence; },
    kind() { return (job()?.kind ?? 'initial') as 'initial' | 'rebuild' | 'recovery'; },
    canFinishRepair() {
      return !!db.prepare("SELECT 1 FROM execution_job WHERE id = 1 AND kind IN ('initial', 'recovery') AND state = 'error' AND failure_scope IS NULL").get();
    },
    tooLarge() {
      return (db.prepare("SELECT COUNT(*) AS count FROM execution_projection WHERE generation = ? AND state = 'error' AND error_reason = 'too_large'").get(target()) as { count: number }).count;
    },
    cleanup() {
      db.transaction(() => {
        db.prepare("DELETE FROM execution_projection WHERE generation != ?").run(active());
        db.prepare("DELETE FROM execution_manifest WHERE generation != ?").run(active());
      })();
    },
    async reconcile(threadId: string) {
      const result = await readAcceptedProjection(bb.sdk.threads.events.list, threadId);
      store.put(threadId, result);
      return result;
    },
    invalidateAll() { globallyUnverified = true; reverified.clear(); },
    markUnverified() { db.prepare("UPDATE execution_projection SET state = 'unverified' WHERE generation = ? AND state IN ('ready', 'absent')").run(active()); },
    put(threadId: string, value: AcceptedProjection, generation = active()) {
      const ready = value.state === "ready" ? value : null;
      db.prepare(`INSERT OR REPLACE INTO execution_projection (generation, thread_id, state, reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq, error_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(generation, threadId, value.state, ready?.reasoningLevel ?? null, ready?.serviceTier ?? null, ready?.acceptedId ?? null, ready?.acceptedSeq ?? null, ready?.requestId ?? null, ready?.requestSeq ?? null, value.state === "error" ? value.reason : null);
    },
    beginManifest(threads: { id: string; archivedAt: number | null }[], changed = new Set<string>()) {
      const removed: string[] = [];
      db.transaction(() => {
        const existing = new Set((db.prepare("SELECT thread_id FROM execution_manifest UNION SELECT thread_id FROM execution_projection").all() as { thread_id: string }[]).map((row) => row.thread_id));
        for (const id of failedIds) existing.add(id);
        const visible = new Set(threads.map((thread) => thread.id));
        for (const id of existing) if (!visible.has(id) && !changed.has(id)) {
          db.prepare("DELETE FROM execution_projection WHERE generation IN (?, ?) AND thread_id = ?").run(active(), target(), id);
          db.prepare("DELETE FROM execution_manifest WHERE generation IN (?, ?) AND thread_id = ?").run(active(), target(), id);
          removed.push(id);
        }
        const insert = db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (?, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived");
        for (const thread of threads) if (!changed.has(thread.id)) insert.run(target(), thread.id, thread.archivedAt === null ? 0 : 1);
        if (!job()) db.prepare("INSERT INTO execution_job (id, generation, state, kind) VALUES (1, ?, 'running', 'initial')").run(active());
        else if (job()?.state !== 'running') db.prepare("UPDATE execution_job SET state = 'running', failure_scope = NULL WHERE id = 1").run();
      })();
      for (const id of removed) { failedIds.delete(id); workingFailures.delete(id); reverified.delete(id); }
      storageFailure = false;
    },
    add(thread: { id: string; archivedAt: number | null }) {
      db.prepare("INSERT INTO execution_manifest (generation, thread_id, archived, state) VALUES (?, ?, ?, 'pending') ON CONFLICT(generation, thread_id) DO UPDATE SET archived = excluded.archived").run(target(), thread.id, thread.archivedAt === null ? 0 : 1);
    },
    remove(threadId: string) {
      db.transaction(() => {
        db.prepare("DELETE FROM execution_projection WHERE generation IN (?, ?) AND thread_id = ?").run(active(), target(), threadId);
        db.prepare("DELETE FROM execution_manifest WHERE generation IN (?, ?) AND thread_id = ?").run(active(), target(), threadId);
      })();
      failedIds.delete(threadId);
      workingFailures.delete(threadId);
      reverified.delete(threadId);
    },
    contains(threadId: string) {
      return !!db.prepare("SELECT 1 FROM execution_manifest WHERE generation = ? AND thread_id = ?").get(target(), threadId);
    },
    ids() {
      const ids = new Set((db.prepare("SELECT thread_id FROM execution_manifest UNION SELECT thread_id FROM execution_projection").all() as { thread_id: string }[]).map((row) => row.thread_id));
      for (const id of failedIds) ids.add(id);
      return [...ids];
    },
    verified(threadId: string): Extract<AcceptedProjection, { state: "ready" }> | undefined {
      if (failedIds.has(threadId) || (globallyUnverified && !reverified.has(threadId))) return undefined;
      const row = db.prepare("SELECT reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq FROM execution_projection WHERE generation = ? AND thread_id = ? AND state = 'ready'").get(active(), threadId) as { reasoning_level: string | null; service_tier: string | null; accepted_id: string; accepted_seq: number; request_id: string; request_seq: number } | undefined;
      return row && { state: "ready", reasoningLevel: row.reasoning_level, serviceTier: row.service_tier, acceptedId: row.accepted_id, acceptedSeq: row.accepted_seq, requestId: row.request_id, requestSeq: row.request_seq };
    },
    commit(threadId: string, value: AcceptedProjection, live = true, verifyGlobal = true) {
      let workingUpdated = false;
      db.transaction(() => {
        const generation = target();
        const rebuild = job()?.kind === "rebuild" && generation !== active();
        if (!rebuild || value.state !== "error" || live) { store.put(threadId, value, active()); workingUpdated = true; }
        if (rebuild) store.put(threadId, value, generation);
        db.prepare("UPDATE execution_manifest SET state = ? WHERE generation = ? AND thread_id = ?").run(value.state === 'error' ? 'error' : 'done', generation, threadId);
      })();
      failedIds.delete(threadId);
      workingFailures.delete(threadId);
      if (verifyGlobal && workingUpdated) reverified.add(threadId);
    },
    markFailed(threadId: string, live = true) { failedIds.add(threadId); if (live || !building) workingFailures.add(threadId); },
    finish() {
      let cutover = false;
      let completed = false;
      db.transaction(() => {
        const generation = target();
        db.prepare("UPDATE execution_job SET state = CASE WHEN ? > 0 OR EXISTS (SELECT 1 FROM execution_manifest WHERE generation = ? AND state != 'done') OR EXISTS (SELECT 1 FROM execution_projection WHERE generation = ? AND state NOT IN ('ready', 'absent')) OR EXISTS (SELECT 1 FROM execution_manifest m LEFT JOIN execution_projection p ON p.generation = m.generation AND p.thread_id = m.thread_id WHERE m.generation = ? AND p.thread_id IS NULL) THEN 'error' ELSE 'done' END, failure_scope = NULL WHERE id = 1").run(failedIds.size, generation, generation, generation);
        const current = job();
        completed = current?.state === 'done';
        if (completed && current?.kind === 'initial') db.prepare("UPDATE execution_meta SET initial_completed = 1 WHERE id = 1").run();
        if (completed && current?.kind === 'rebuild') { db.prepare("UPDATE execution_meta SET active_generation = ? WHERE id = 1").run(generation); cutover = true; }
      })();
      if (cutover) building = false;
      storageFailure = false;
      return completed;
    },
    fail() {
      storageFailure = true;
      db.prepare("INSERT INTO execution_job (id, generation, state, failure_scope) VALUES (1, ?, 'error', 'catalogue') ON CONFLICT(id) DO UPDATE SET state = 'error', failure_scope = 'catalogue'").run(active());
    },
    status() {
      const job = db.prepare("SELECT state, failure_scope FROM execution_job WHERE id = 1").get() as { state: 'running' | 'done' | 'error'; failure_scope: string | null } | undefined;
      const counts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done, SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending FROM execution_manifest WHERE generation = ?").get(target()) as { total: number; done: number | null; pending: number | null };
      const errors = new Set(failedIds);
      const rows = db.prepare("SELECT thread_id FROM execution_manifest WHERE generation = ? AND state = 'error' UNION SELECT thread_id FROM execution_projection WHERE generation = ? AND state = 'error'").all(target(), target()) as { thread_id: string }[];
      for (const row of rows) errors.add(row.thread_id);
      const state = storageFailure ? 'error' : !job ? 'loading' : job.state === 'running' ? 'running' : job.state === 'error' || job.failure_scope === 'catalogue' || errors.size || counts.pending ? 'error' : 'done';
      return { state, total: counts.total, done: counts.done ?? 0, errors: errors.size } as const;
    },
    read(threadIds: string[]): ExecutionProjection[] {
      const query = db.prepare("SELECT state, reasoning_level, service_tier FROM execution_projection WHERE generation = ? AND thread_id = ?");
      return threadIds.map((threadId) => {
        if (workingFailures.has(threadId)) return { threadId, state: "error" };
        const row = query.get(active(), threadId) as { state: string; reasoning_level: string | null; service_tier: string | null } | undefined;
        if (!row) return { threadId, state: "loading" };
        if (globallyUnverified && !reverified.has(threadId) && (row.state === "ready" || row.state === "absent")) return { threadId, state: "unverified" };
        const projection = row.state === "ready" ? { threadId, state: row.state, reasoningLevel: row.reasoning_level, serviceTier: row.service_tier } : { threadId, state: row.state };
        return executionProjectionSchema.parse(projection);
      });
    },
  };
  return store;
}
