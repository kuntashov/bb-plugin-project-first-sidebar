import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";

it("starts a separate rebuild after a completed initial fill and a later live error", async () => {
  const threads = ["a", "b"].map((id) => makeThreadResponse({ id }));
  const failing = new Set<string>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list: async () => threads,
    events: { list: async ({ threadId }) => { if (failing.has(threadId)) throw Object.assign(new Error("large"), { status: 413 }); return []; } },
  } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  failing.add("b");
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: threads[1]!, sequence: 1 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" }));
  failing.add("a");
  expect(await harness.behavior.callRpc("startExecutionRebuild", null)).toMatchObject({ kind: "rebuild", state: "running" });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", tooLarge: 2 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["a"] })).toEqual({ projections: [{ threadId: "a", state: "absent" }] });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("does not report a failed rebuild as successful after a live repair without cutover", async () => {
  const thread = makeThreadResponse({ id: "t" });
  let failing = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list: async () => [thread],
    events: { list: async () => { if (failing) throw Object.assign(new Error("large"), { status: 413 }); return []; } },
  } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  failing = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", errors: 1 }));
  const beforeRepair = harness.inspection.realtimeSignals.length;
  failing = false;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 2 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", errors: 0 }));
  expect(harness.inspection.realtimeSignals.slice(beforeRepair)).toContainEqual(expect.objectContaining({ payload: { progress: true } }));
  expect(await Promise.all([harness.behavior.callRpc("getExecutionRebuildStatus", null), harness.behavior.callRpc("getExecutionRebuildStatus", null)])).toEqual([expect.objectContaining({ state: "error", errors: 0 }), expect.objectContaining({ state: "error", errors: 0 })]);
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 1 });
  expect(bb.storage.database().prepare("SELECT state, generation FROM execution_job WHERE id = 1").get()).toEqual({ state: "error", generation: 2 });
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "done" }));
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  expect(bb.storage.database().prepare("SELECT state, generation FROM execution_job WHERE id = 1").get()).toEqual({ state: "done", generation: 2 });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("joins initial fill from two windows without starting another catalogue scan", async () => {
  let release: (() => void) | undefined;
  const list = vi.fn(async () => [makeThreadResponse({ id: "t" })]);
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list, events: { list: async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; } } } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(release).toBeDefined());
  const results = await Promise.all([harness.behavior.callRpc("startExecutionRebuild", null), harness.behavior.callRpc("startExecutionRebuild", null)]);
  expect(results).toEqual([expect.objectContaining({ kind: "initial", state: "running" }), expect.objectContaining({ kind: "initial", state: "running" })]);
  expect(list).toHaveBeenCalledTimes(1);
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("joins concurrent rebuild requests and retains the working projection on a terminal rebuild error", async () => {
  let fail = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list: async () => [makeThreadResponse({ id: "t" })],
    events: { list: async ({ types }) => {
      if (fail) { await new Promise<void>((resolve) => { release = resolve; }); throw Object.assign(new Error("large"), { status: 413 }); }
      return (types?.includes("turn/input/accepted") ? [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }] : [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: "high", serviceTier: "fast" } } }]) as never;
    } },
  } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  fail = true;
  const [first, second] = await Promise.all([harness.behavior.callRpc("startExecutionRebuild", null), harness.behavior.callRpc("startExecutionRebuild", null)]);
  expect(first).toMatchObject({ kind: "rebuild", state: "running" });
  expect(second).toEqual(first);
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] });
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", errors: 1, tooLarge: 1 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("waits for a live change during rebuild and cuts over only after its newest result", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let level = "high";
  let block = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [thread], events: { list: async ({ types }) => {
      const snapshot = level;
      if (block && types?.includes("turn/input/accepted")) { block = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return (types?.includes("turn/input/accepted") ? [{ id: `a-${snapshot}`, seq: 2, type: "turn/input/accepted", data: { clientRequestId: snapshot } }] : [{ id: `q-${snapshot}`, seq: 1, type: "client/turn/requested", data: { requestId: snapshot, execution: { reasoningLevel: snapshot, serviceTier: "fast" } } }]) as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  block = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(release).toBeDefined());
  level = "low";
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread, sequence: 3 });
  expect((await harness.behavior.callRpc("getExecutionRebuildStatus", null))).toMatchObject({ state: "running" });
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "done", kind: "rebuild" }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toMatchObject({ projections: [{ reasoningLevel: "low" }] });
  expect(bb.storage.database().prepare("SELECT DISTINCT generation FROM execution_projection").all()).toEqual([{ generation: 2 }]);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("keeps the old pointer if the success transaction fails", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "t" })], events: { list: async () => [] } } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  bb.storage.database().exec("CREATE TRIGGER reject_pointer BEFORE UPDATE ON execution_meta BEGIN SELECT RAISE(ABORT, 'pointer failure'); END");
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "error" }));
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 1 });
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "absent" }] });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("retains the committed pointer when cleanup fails and completes recovery on reload", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "t" })], events: { list: async () => [] } } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  bb.storage.database().exec("CREATE TRIGGER reject_cleanup BEFORE DELETE ON execution_projection WHEN OLD.generation = 1 BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END");
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "done", kind: "rebuild" }));
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  bb.storage.database().exec("DROP TRIGGER reject_cleanup");
  service.controller.abort(); await service.done;
  const reloaded = await harness.lifecycle.reload(plugin);
  expect(await reloaded.harness.behavior.callRpc("startExecutionRebuild", null)).toMatchObject({ kind: "recovery", state: "running" });
  expect(await reloaded.harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "unverified" }] });
  reloaded.harness.sdk.stub("subscribe", () => () => {});
  const recovery = reloaded.harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await reloaded.harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "recovery", state: "done" }));
  expect(reloaded.bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  recovery.controller.abort(); await recovery.done; await reloaded.harness.lifecycle.dispose();
});

it("removes a hidden thread from both generations while a rebuild read is pending", async () => {
  const thread = makeThreadResponse({ id: "t" });
  let visible = true;
  let block = false;
  let release: (() => void) | undefined;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => visible ? [thread] : [], events: { list: async () => { if (block) { block = false; await new Promise<void>((resolve) => { release = resolve; }); } return []; } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  block = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(release).toBeDefined());
  visible = false;
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["title-changed"] } as never);
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "done", total: 0 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "loading" }] });
  expect(bb.storage.database().prepare("SELECT * FROM execution_projection WHERE thread_id = ?").all("t")).toEqual([]);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});
