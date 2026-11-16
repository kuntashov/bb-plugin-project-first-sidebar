import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readAcceptedProjection, type AcceptedProjection } from "./accepted-projection.js";
import { executionProjectionSchema, type ExecutionProjection } from "../shared/execution-projection.js";

export function createExecutionProjectionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [`CREATE TABLE IF NOT EXISTS execution_projection (generation INTEGER NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, reasoning_level TEXT, service_tier TEXT, accepted_id TEXT, accepted_seq INTEGER, request_id TEXT, request_seq INTEGER, PRIMARY KEY (generation, thread_id))`]);
  const store = {
    async reconcile(threadId: string) {
      const result = await readAcceptedProjection(bb.sdk.threads.events.list, threadId);
      store.put(threadId, result);
      return result;
    },
    markUnverified() { db.prepare("UPDATE execution_projection SET state = 'unverified' WHERE generation = 1").run(); },
    put(threadId: string, value: AcceptedProjection) {
      const ready = value.state === "ready" ? value : null;
      db.prepare(`INSERT OR REPLACE INTO execution_projection (generation, thread_id, state, reasoning_level, service_tier, accepted_id, accepted_seq, request_id, request_seq) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, value.state, ready?.reasoningLevel ?? null, ready?.serviceTier ?? null, ready?.acceptedId ?? null, ready?.acceptedSeq ?? null, ready?.requestId ?? null, ready?.requestSeq ?? null);
    },
    read(threadIds: string[]): ExecutionProjection[] {
      const query = db.prepare("SELECT state, reasoning_level, service_tier FROM execution_projection WHERE generation = 1 AND thread_id = ?");
      return threadIds.map((threadId) => {
        const row = query.get(threadId) as { state: string; reasoning_level: string | null; service_tier: string | null } | undefined;
        if (!row) return { threadId, state: "loading" };
        const projection = row.state === "ready" ? { threadId, state: row.state, reasoningLevel: row.reasoning_level, serviceTier: row.service_tier } : { threadId, state: row.state };
        return executionProjectionSchema.parse(projection);
      });
    },
  };
  return store;
}
