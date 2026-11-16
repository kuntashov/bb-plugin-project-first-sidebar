import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";
import { createExecutionProjectionStore } from "./projection-store.js";
import { registerCatalogueFill } from "./catalogue-fill.js";

it.each(["thread-deleted", "title-changed"])("reconciles an ID-less %s against the full catalogue", async (change) => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let visible = true;
  const list = vi.fn(async () => visible ? [thread] : []);
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done", total: 1 }));
  visible = false;
  callbacks.get("thread:changed")!({ entity: "thread", changes: [change] } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done", total: 0 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "loading" }] });
  expect(list).toHaveBeenLastCalledWith({ includeHidden: false });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it.each([
  { changes: ["history-rewritten"] },
  { changes: ["events-appended"], metadata: { eventTypes: ["turn/input/accepted"] } },
  { changes: ["events-appended"] },
])("rechecks the full pair after an ID-less relevant change %# even when identity is unchanged", async (event) => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let level = "high";
  const history = vi.fn(async ({ types }: { types?: readonly string[] }) => types?.includes("turn/input/accepted")
    ? [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }]
    : [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: level, serviceTier: "fast" } } }]);
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [thread], events: { list: history as never } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = () => harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] });
  await vi.waitFor(async () => expect(await read()).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] }));
  level = "low";
  callbacks.get("thread:changed")!({ entity: "thread", ...event } as never);
  await vi.waitFor(async () => expect(await read()).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "low" }] }));
  expect(history.mock.calls.filter(([args]) => args.types?.includes("client/turn/requested"))).toHaveLength(2);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("ignores ID-less changes that cannot affect catalogue or execution history", async () => {
  const callbacks = new Map<string, (event: never) => void>();
  const list = vi.fn(async () => [makeThreadResponse({ id: "t" })]);
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["status-changed", "pin-state-changed"] } as never);
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["events-appended"], metadata: { eventTypes: ["item/agentMessage/delta"] } } as never);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(list).toHaveBeenCalledTimes(1);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("keeps previous colours unverified when the catalogue cannot be reconciled", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let failing = false, historyFail = false;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => { if (failing) throw Object.assign(new Error("large"), { status: 413 }); return [thread]; }, events: { list: async ({ types }) => { if (historyFail) throw Object.assign(new Error("large"), { status: 413 }); return (types?.includes("turn/input/accepted") ? [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }] : [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: "high", serviceTier: "fast" } } }]) as never; } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = () => harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] });
  await vi.waitFor(async () => expect(await read()).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] }));
  failing = true;
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["history-rewritten"] } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" }));
  expect(await read()).toEqual({ projections: [{ threadId: "t", state: "unverified" }] });
  failing = false;
  historyFail = true;
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ active: false }));
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", active: false }));
  expect(await read()).toEqual({ projections: [{ threadId: "t", state: "unverified" }] });
  historyFail = false;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(async () => expect(await read()).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("discards a stale catalogue snapshot and waits for a fresh one before rebuild cutover", async () => {
  const oldThread = makeThreadResponse({ id: "old" });
  const newThread = makeThreadResponse({ id: "new" });
  const callbacks = new Map<string, (event: never) => void>();
  let phase = "initial";
  let releaseOld: (() => void) | undefined;
  let releaseNew: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => {
      if (phase === "old") { await new Promise<void>((resolve) => { releaseOld = resolve; }); return [oldThread]; }
      if (phase === "new") { await new Promise<void>((resolve) => { releaseNew = resolve; }); return [newThread]; }
      return [oldThread];
    }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  phase = "old";
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(releaseOld).toBeDefined());
  phase = "new";
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["thread-deleted"] } as never);
  releaseOld!();
  await vi.waitFor(() => expect(releaseNew).toBeDefined());
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 1 });
  releaseNew!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "done", kind: "rebuild" }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["old", "new"] })).toEqual({ projections: [{ threadId: "old", state: "loading" }, { threadId: "new", state: "absent" }] });
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("does not apply an obsolete snapshot after a global event during SQLite backoff", async () => {
  vi.useFakeTimers();
  try {
    const oldThread = makeThreadResponse({ id: "old" });
    const newThread = makeThreadResponse({ id: "new" });
    const callbacks = new Map<string, (event: never) => void>();
    let visible = [oldThread];
    const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
      subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
      threads: { list: async () => visible, events: { list: async () => [] } },
    } });
    const store = createExecutionProjectionStore(bb);
    store.prepareStartup(); registerCatalogueFill(bb, store);
    const service = harness.behavior.runService("execution-catalogue");
    await vi.advanceTimersByTimeAsync(0);
    const beginManifest = store.beginManifest.bind(store);
    let busy = true;
    const applied: string[][] = [];
    vi.spyOn(store, "beginManifest").mockImplementation((threads, changed) => {
      if (busy) { busy = false; throw Object.assign(new Error("locked"), { code: "SQLITE_BUSY" }); }
      applied.push(threads.map((thread) => thread.id));
      beginManifest(threads, changed);
    });
    callbacks.get("realtime:connection")!({ state: "connected", reconnected: true } as never);
    await vi.advanceTimersByTimeAsync(0);
    visible = [newThread];
    callbacks.get("thread:changed")!({ entity: "thread", changes: ["thread-deleted"] } as never);
    await vi.advanceTimersByTimeAsync(1000);
    expect(applied).toEqual([["new"]]);
    expect(store.read(["old", "new"])).toEqual([{ threadId: "old", state: "loading" }, { threadId: "new", state: "absent" }]);
    service.controller.abort(); await service.done; await harness.lifecycle.dispose();
  } finally { vi.useRealTimers(); }
});

it("reconciles a global signal arriving immediately after rebuild cutover", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let calls = 0, block = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => { calls++; if (block && calls >= 3) await new Promise<void>((resolve) => { release = resolve; }); return [thread]; }, events: { list: async () => [] } },
  } });
  const store = createExecutionProjectionStore(bb);
  store.prepareStartup();
  const catalogue = registerCatalogueFill(bb, store);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(store.status().state).toBe("done"));
  const finish = store.finish.bind(store);
  vi.spyOn(store, "finish").mockImplementation(() => {
    const result = finish();
    if (block && result) queueMicrotask(() => callbacks.get("thread:changed")!({ entity: "thread", changes: ["history-rewritten"] } as never));
    return result;
  });
  block = true;
  catalogue.startRebuild();
  await vi.waitFor(() => expect(release).toBeDefined());
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  expect(store.read(["t"])).toEqual([{ threadId: "t", state: "unverified" }]);
  expect(catalogue.status()).toMatchObject({ kind: "recovery", state: "running", active: true });
  block = false;
  release!();
  await vi.waitFor(() => expect(catalogue.status()).toMatchObject({ kind: "recovery", state: "done", active: false }));
  expect(store.read(["t"])).toEqual([{ threadId: "t", state: "absent" }]);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("fences a rebuild history read when an ID-less rewrite changes the same thread", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let level = "high", block = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [thread], events: { list: async ({ types }) => {
      const snapshot = level;
      if (block && types?.includes("client/turn/requested")) { block = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return (types?.includes("turn/input/accepted") ? [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }] : [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: snapshot, serviceTier: "fast" } } }]) as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  block = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(release).toBeDefined());
  level = "low";
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["history-rewritten"] } as never);
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "done", kind: "rebuild" }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "low" }] });
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 2 });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("removes an unverified working colour if an ID-less rewrite cannot be read during rebuild", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let block = false, failing = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [thread], events: { list: async ({ types }) => {
      if (failing) throw Object.assign(new Error("large"), { status: 413 });
      if (block && types?.includes("turn/input/accepted")) { block = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return (types?.includes("turn/input/accepted") ? [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }] : [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: "high", serviceTier: "fast" } } }]) as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  block = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(release).toBeDefined());
  failing = true;
  callbacks.get("thread:changed")!({ entity: "thread", changes: ["history-rewritten"] } as never);
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ state: "error", kind: "rebuild" }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 1 });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});
