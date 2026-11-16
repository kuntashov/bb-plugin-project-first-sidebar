import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin, { createExecutionProjectionStore } from "../server.js";

it("serves indexed execution states in a validated batch without reading history", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar" });
  await plugin(bb);
  const store = createExecutionProjectionStore(bb);
  store.put("t1", { state: "ready", reasoningLevel: "high", serviceTier: "fast", acceptedId: "a", acceptedSeq: 3, requestId: "r", requestSeq: 2 });
  store.put("t2", { state: "absent" });
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t1", "t2", "missing"] })).toEqual({ projections: [
    { threadId: "t1", state: "ready", reasoningLevel: "high", serviceTier: "fast" },
    { threadId: "t2", state: "absent" }, { threadId: "missing", state: "loading" },
  ] });
  await expect(harness.behavior.callRpc("getExecutionProjections", { threadIds: [""] })).rejects.toThrow();
});

it("projects the last accepted pair through the SDK and persists only its normalized values", async () => {
  const events = [
    { id: "accepted", seq: 5, type: "turn/input/accepted", data: { clientRequestId: "r1" } },
    { id: "request", seq: 2, type: "client/turn/requested", data: { requestId: "r1", execution: { reasoningLevel: "xhigh", serviceTier: "fast" }, input: "private message" } },
    { id: "queued", seq: 7, type: "client/turn/requested", data: { requestId: "r2", execution: { reasoningLevel: "low", serviceTier: "priority" } } },
  ];
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { events: { list: async (args) => events.filter((event) => args.types?.includes(event.type as never) && (!args.beforeSeq || event.seq < Number(args.beforeSeq))).sort((a, b) => b.seq - a.seq).slice(0, Number(args.limit)) as never } } } });
  await plugin(bb);
  await createExecutionProjectionStore(bb).reconcile("t");
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "ready", reasoningLevel: "xhigh", serviceTier: "fast" }] });
  const stored = bb.storage.database().prepare("SELECT * FROM execution_projection").all();
  expect(JSON.stringify(stored)).not.toContain("private message");
});

it("retains only a safe error category for recovery and exposes a generic error to the client", async () => {
  const secret = "sensitive example";
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { events: { list: async () => { throw Object.assign(new Error(secret), { status: 413 }); } } } } });
  await plugin(bb);
  const result = await createExecutionProjectionStore(bb).reconcile("t");
  expect(result).toEqual({ state: "error", reason: "too_large" });
  const stored = bb.storage.database().prepare("SELECT * FROM execution_projection WHERE thread_id = ?").get("t");
  expect(stored).toMatchObject({ state: "error", error_reason: "too_large" });
  expect(JSON.stringify(stored)).not.toContain(secret);
  const response = await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] });
  expect(response).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  expect(JSON.stringify(response)).not.toContain(secret);
});
