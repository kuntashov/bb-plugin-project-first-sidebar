import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";
import { createExecutionProjectionStore } from "./projection-store.js";
import { registerCatalogueFill } from "./catalogue-fill.js";

it("fills through the factory service into SQLite and RPC, with bounded active workers before archive", async () => {
  const threads = [...Array.from({ length: 6 }, (_, i) => makeThreadResponse({ id: `active${i}` })), makeThreadResponse({ id: "archive", archivedAt: 1 })];
  let running = 0, maximum = 0;
  const started: string[] = [];
  const list = vi.fn(async () => threads);
  const release = new Map<string, () => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list,
    events: { list: async ({ threadId, types }) => {
      if (types?.includes("turn/input/accepted")) {
        started.push(threadId); running++; maximum = Math.max(maximum, running);
        await new Promise<void>((resolve) => release.set(threadId, resolve));
        running--;
        return [{ id: `a-${threadId}`, seq: 3, type: "turn/input/accepted", data: { clientRequestId: `r-${threadId}` } }] as never;
      }
      return [{ id: `q-${threadId}`, seq: 2, type: "client/turn/requested", data: { requestId: `r-${threadId}`, execution: { reasoningLevel: "high", serviceTier: "fast" } } }] as never;
    } },
  } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(started).toHaveLength(4));
  expect(list).toHaveBeenCalledWith({ includeHidden: false });
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["active0"] })).toEqual({ projections: [{ threadId: "active0", state: "loading" }] });
  release.get("active1")!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["active1"] })).toEqual({ projections: [{ threadId: "active1", state: "ready", reasoningLevel: "high", serviceTier: "fast" }] }));
  expect(bb.storage.database().prepare("SELECT state FROM execution_manifest WHERE thread_id = ?").get("active1")).toEqual({ state: "done" });
  await vi.waitFor(() => expect(started).toHaveLength(5));
  for (const id of ["active0", "active2", "active3", "active4"]) release.get(id)!();
  await vi.waitFor(() => expect(started).toHaveLength(6));
  expect(started).not.toContain("archive");
  release.get("active5")!();
  await vi.waitFor(() => expect(started).toContain("archive"));
  release.get("archive")!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 7, done: 7, errors: 0 }));
  expect(maximum).toBe(4);
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["archive"] })).toEqual({ projections: [{ threadId: "archive", state: "ready", reasoningLevel: "high", serviceTier: "fast" }] });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("rolls back result and checkpoint together when the checkpoint write fails", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "t" }), makeThreadResponse({ id: "archive", archivedAt: 1 })], events: { list: async () => [] } } } });
  await plugin(bb);
  bb.storage.database().exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON execution_manifest WHEN NEW.thread_id = 't' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  bb.storage.database().exec("CREATE TRIGGER reject_job_error BEFORE UPDATE ON execution_job BEGIN SELECT RAISE(ABORT, 'failure'); END");
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" }));
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t", "archive"] })).toEqual({ projections: [{ threadId: "t", state: "error" }, { threadId: "archive", state: "absent" }] }));
  expect(bb.storage.database().prepare("SELECT state FROM execution_manifest WHERE thread_id = ?").get("t")).toEqual({ state: "pending" });
  expect(harness.inspection.realtimeSignals.some((signal) => JSON.stringify(signal).includes('"threadId":"t"'))).toBe(true);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("does not commit or publish when disposed while a history read is pending", async () => {
  let release!: () => void;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list: async () => [makeThreadResponse({ id: "t" })],
    events: { list: async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; } },
  } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(release).toBeDefined());
  service.controller.abort();
  await harness.lifecycle.dispose();
  release();
  await expect(service.done).resolves.toBeUndefined();
  expect(harness.inspection.realtimeSignals).toHaveLength(0);
});

it("persists a terminal history error and reports the failed index without treating it as absent", async () => {
  const read = vi.fn(async () => { throw Object.assign(new Error("private"), { status: 413 }); });
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "t" })], events: { list: read } } } });
  await plugin(bb);
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "error", total: 1, done: 0, errors: 1 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  expect(read).toHaveBeenCalledTimes(1);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("retries SQLite busy at 1, 5 and 15 seconds, then records the affected ID and continues the archive", async () => {
  vi.useFakeTimers();
  try {
    const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "a" }), makeThreadResponse({ id: "z", archivedAt: 1 })], events: { list: async () => [] } } } });
    const store = createExecutionProjectionStore(bb);
    const commit = store.commit.bind(store);
    const times: number[] = [];
    vi.spyOn(store, "commit").mockImplementation((id, value) => {
      if (id === "a" && value.state === "absent") { times.push(Date.now()); throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }); }
      return commit(id, value);
    });
    registerCatalogueFill(bb, store);
    harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(21000);
    expect(times.map((time) => time - times[0]!)).toEqual([0, 1000, 6000, 21000]);
    expect(store.read(["a", "z"])).toEqual([{ threadId: "a", state: "error" }, { threadId: "z", state: "absent" }]);
    expect(store.status()).toEqual({ state: "error", total: 2, done: 1, errors: 1 });
    service.controller.abort(); await service.done; await harness.lifecycle.dispose();
  } finally { vi.useRealTimers(); }
});

it("publishes a job failure even when persisting that failure also fails", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => { throw new Error("unavailable"); } } } });
  await plugin(bb);
  bb.storage.database().exec("CREATE TRIGGER reject_job_insert BEFORE INSERT ON execution_job BEGIN SELECT RAISE(ABORT, 'failure'); END");
  harness.sdk.stub("subscribe", () => () => {});
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(harness.inspection.realtimeSignals).toHaveLength(1));
  expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("reconciles history edits, copied fork history and an ordinary child through RPC", async () => {
  const threads = ["source", "fork", "child"].map((id) => makeThreadResponse({ id }));
  const executions = new Map<string, { seq: number; level: string }>([["source", { seq: 8, level: "high" }], ["fork", { seq: 8, level: "high" }]]);
  const subscriptions = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { subscriptions.set(event, callback as (event: never) => void); return () => subscriptions.delete(event); },
    threads: { list: async () => threads, events: { list: async ({ threadId, types }) => {
      const value = executions.get(threadId);
      if (!value) return [];
      if (types?.includes("turn/input/accepted")) return [{ id: `a${value.seq}`, seq: value.seq, type: "turn/input/accepted", data: { clientRequestId: `r${value.seq}` } }] as never;
      return [{ id: `q${value.seq}`, seq: value.seq - 1, type: "client/turn/requested", data: { requestId: `r${value.seq}`, execution: { reasoningLevel: value.level, serviceTier: "fast" } } }] as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async (id: string) => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: [id] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read("child")).toEqual({ threadId: "child", state: "absent" }));
  expect(await read("fork")).toMatchObject({ state: "ready", reasoningLevel: "high" });
  executions.set("source", { seq: 4, level: "low" });
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: threads[0]!, sequence: 4 });
  await vi.waitFor(async () => expect(await read("source")).toMatchObject({ state: "ready", reasoningLevel: "low" }));
  expect(await read("fork")).toMatchObject({ state: "ready", reasoningLevel: "high" });
  executions.delete("source");
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: threads[0]!, sequence: 1 });
  await vi.waitFor(async () => expect(await read("source")).toEqual({ threadId: "source", state: "absent" }));
  executions.set("source", { seq: 2, level: "max" });
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: threads[0]!, sequence: 2 });
  await vi.waitFor(async () => expect(await read("source")).toMatchObject({ state: "ready", reasoningLevel: "max" }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
  expect(subscriptions.size).toBe(0);
});

it("rechecks title changes during a catalogue snapshot and rejects a stale history read", async () => {
  const t = makeThreadResponse({ id: "t" });
  let visible = true;
  let releaseRead: (() => void) | undefined;
  let releaseSnapshot: (() => void) | undefined;
  let slowRead = false, slowSnapshot = false;
  let inRead = 0, maxRead = 0;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async (args) => {
      const result = visible ? [t] : [];
      if (!args?.threadIds && slowSnapshot) await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      return result;
    }, events: { list: async ({ types }) => {
      if (types?.includes("turn/input/accepted")) {
        inRead++; maxRead = Math.max(maxRead, inRead);
        if (slowRead) { slowRead = false; await new Promise<void>((resolve) => { releaseRead = resolve; }); }
        inRead--; return [];
      }
      return [];
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "absent" }));
  slowRead = true;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 2 });
  await vi.waitFor(() => expect(releaseRead).toBeDefined());
  visible = false;
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["title-changed"] } as never);
  releaseRead!();
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "loading" }));
  expect(maxRead).toBe(1);
  slowSnapshot = true;
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(() => expect(releaseSnapshot).toBeDefined());
  visible = true;
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["title-changed"] } as never);
  releaseSnapshot!();
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "absent" }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("avoids rereading the request on append but rereads it after a rewrite with identical IDs", async () => {
  const t = makeThreadResponse({ id: "t" });
  let level = "high", requested = 0, accepted = 0;
  const callbacks = new Map<string, (event: never) => void>();
  const registrations: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { registrations.push(event); callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => { expect(registrations).toEqual(["thread:changed", "realtime:connection"]); return [t]; }, events: { list: async ({ types }) => {
      if (types?.includes("turn/input/accepted")) { accepted++; return [{ id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } }] as never; }
      requested++; return [{ id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: level, serviceTier: "fast" } } }] as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "high" }));
  const signals = harness.inspection.realtimeSignals.length;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 3 });
  await vi.waitFor(() => expect(accepted).toBe(2));
  await vi.waitFor(() => expect(requested).toBe(1));
  expect(harness.inspection.realtimeSignals.length).toBe(signals);
  level = "max";
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["history-rewritten"] } as never);
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "max" }));
  expect(requested).toBe(2);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("discards an in-flight result after a second event and serializes reads for the same ID", async () => {
  const t = makeThreadResponse({ id: "t" });
  let value = "high", gate: (() => void) | undefined, hold = false, active = 0, maximum = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: () => () => {}, threads: { list: async () => [t], events: { list: async ({ types }) => {
      if (types?.includes("turn/input/accepted")) {
        const snapshot = value; active++; maximum = Math.max(maximum, active);
        if (hold) { hold = false; await new Promise<void>((resolve) => { gate = resolve; }); }
        active--; return [{ id: snapshot, seq: snapshot === "high" ? 2 : 4, type: "turn/input/accepted", data: { clientRequestId: snapshot } }] as never;
      }
      return [{ id: "q", seq: value === "high" ? 1 : 3, type: "client/turn/requested", data: { requestId: value, execution: { reasoningLevel: value, serviceTier: "fast" } } }] as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "high" }));
  hold = true;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 3 });
  await vi.waitFor(() => expect(gate).toBeDefined());
  value = "max";
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 4 });
  gate!();
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "max" }));
  expect(maximum).toBe(1);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("fences a stale snapshot that contains a hidden thread and preserves membership on lookup failure", async () => {
  const t = makeThreadResponse({ id: "t" });
  let visible = true, failLookup = false, release: (() => void) | undefined, hold = false;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async (args) => {
      if (args?.threadIds && failLookup) throw new Error("lookup failed");
      const snapshot = visible ? [t] : [];
      if (!args?.threadIds && hold) { hold = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return snapshot;
    }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "absent" }));
  failLookup = true;
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["title-changed"] } as never);
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "error" }));
  expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ total: 1 });
  failLookup = false;
  hold = true;
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(() => expect(release).toBeDefined());
  visible = false;
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["title-changed"] } as never);
  release!();
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "loading" }));
  expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ total: 0 });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("reconciles offline additions and removals after the first connected event", async () => {
  let threads = [makeThreadResponse({ id: "old" })];
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => threads, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async (ids: string[]) => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ids }) as { projections: unknown[] }).projections;
  await vi.waitFor(async () => expect(await read(["old"])).toEqual([{ threadId: "old", state: "absent" }]));
  threads = [makeThreadResponse({ id: "new", archivedAt: 1 })];
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: false, reconnectDelayMs: null } as never);
  await vi.waitFor(async () => expect(await read(["old", "new"])).toEqual([{ threadId: "old", state: "loading" }, { threadId: "new", state: "absent" }]));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("recovers a failed catalogue snapshot after reconnect", async () => {
  let failed = true;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => { if (failed) throw new Error("unavailable"); return [makeThreadResponse({ id: "t" })]; }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" }));
  failed = false;
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 1, done: 1, errors: 0 }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("reports live history failure and recovery without ending a still-running full job", async () => {
  const a = makeThreadResponse({ id: "a" }), b = makeThreadResponse({ id: "b" });
  let fail = false, release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: () => () => {}, threads: { list: async () => [a, b], events: { list: async ({ threadId }) => {
      if (threadId === "b") await new Promise<void>((resolve) => { release = resolve; });
      if (threadId === "a" && fail) throw Object.assign(new Error("large"), { status: 413 });
      return [];
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(release).toBeDefined());
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["a"] })).toEqual({ projections: [{ threadId: "a", state: "absent" }] }));
  fail = true;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: a, sequence: 2 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "running", total: 2, done: 0, errors: 1 }));
  fail = false;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: a, sequence: 3 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "running", total: 2, done: 1, errors: 0 }));
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 2, done: 2, errors: 0 }));
  fail = true;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: a, sequence: 4 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "error", total: 2, done: 1, errors: 1 }));
  fail = false;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: a, sequence: 5 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 2, done: 2, errors: 0 }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("reports an unsuccessful membership lookup for a new ID and recovers on the next event", async () => {
  const t = makeThreadResponse({ id: "new" });
  let fail = true;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async (args) => { if (!args?.threadIds) return []; if (fail) throw new Error("unavailable"); return [t]; }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  const notify = () => callbacks.get("thread:changed")!({ entity: "thread", id: "new", changes: ["thread-created"] } as never);
  notify();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 1 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["new"] })).toEqual({ projections: [{ threadId: "new", state: "error" }] });
  fail = false; notify();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 1, done: 1, errors: 0 }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("stops promptly while the initial catalogue request is unresolved and fences its late result", async () => {
  let release: ((value: ReturnType<typeof makeThreadResponse>[]) => void) | undefined;
  let subscriptions = 0;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
    threads: { list: async () => new Promise((resolve) => { release = resolve; }), events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(() => expect(release).toBeDefined());
  service.controller.abort();
  await expect(Promise.race([service.done.then(() => "stopped"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 200))])).resolves.toBe("stopped");
  expect(subscriptions).toBe(0);
  await harness.lifecycle.dispose();
  release!([makeThreadResponse({ id: "late" })]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(harness.inspection.realtimeSignals).toHaveLength(0);
});

it("clears an unpersisted per-ID storage failure after successful reconciliation", async () => {
  const t = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [t], events: { list: async () => [] } },
  } });
  await plugin(bb);
  bb.storage.database().exec("CREATE TRIGGER reject_result BEFORE UPDATE ON execution_manifest WHEN NEW.thread_id = 't' BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 1 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  bb.storage.database().exec("DROP TRIGGER reject_result");
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 1, done: 1, errors: 0 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "absent" }] });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("removes a failed unknown lookup after a later successful full catalogue excludes it", async () => {
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async (args) => { if (args?.threadIds) throw new Error("unavailable"); return []; }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  callbacks.get("thread:changed")!({ entity: "thread", id: "unknown", changes: ["thread-created"] } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 1 }));
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 0, done: 0, errors: 0 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["unknown"] })).toEqual({ projections: [{ threadId: "unknown", state: "loading" }] });
  expect(harness.inspection.realtimeSignals.some((signal) => JSON.stringify(signal).includes('"threadId":"unknown"'))).toBe(true);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("retains a catalogue-wide failure across plugin reload until a successful full scan", async () => {
  let fail = false;
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => { if (fail) throw new Error("unavailable"); return [makeThreadResponse({ id: "t" })]; }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  fail = true;
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true, reconnectDelayMs: null } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 0 }));
  const reloaded = await harness.lifecycle.reload(plugin);
  expect(await reloaded.harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 0 });
  await reloaded.harness.lifecycle.dispose();
});

it("recovers an initially failed history from a later live event", async () => {
  const t = makeThreadResponse({ id: "t" });
  let fail = true;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: () => () => {},
    threads: { list: async () => [t], events: { list: async () => { if (fail) throw Object.assign(new Error("large"), { status: 413 }); return []; } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "error", total: 1, done: 0, errors: 1 }));
  fail = false;
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 2 });
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "done", total: 1, done: 1, errors: 0 }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("reconciles a global history-rewritten notification after rollback and removal of accepted", async () => {
  const t = makeThreadResponse({ id: "t" });
  let execution: { seq: number; level: string } | null = { seq: 8, level: "max" };
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [t], events: { list: async ({ types }) => {
      const value = execution;
      if (!value) return [];
      if (types?.includes("turn/input/accepted")) return [{ id: `a${value.seq}`, seq: value.seq, type: "turn/input/accepted", data: { clientRequestId: `r${value.seq}` } }] as never;
      return [{ id: `q${value.seq}`, seq: value.seq - 1, type: "client/turn/requested", data: { requestId: `r${value.seq}`, execution: { reasoningLevel: value.level, serviceTier: "fast" } } }] as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "max" }));
  const rewrite = () => callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["history-rewritten"] } as never);
  execution = { seq: 3, level: "high" }; rewrite();
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "high" }));
  execution = null; rewrite();
  await vi.waitFor(async () => expect(await read()).toEqual({ threadId: "t", state: "absent" }));
  execution = { seq: 10, level: "low" };
  callbacks.get("thread:changed")!({ entity: "thread", id: "t", changes: ["events-appended"] } as never);
  await harness.behavior.emitThreadEvent("experimental_thread.events", { thread: t, sequence: 10 });
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "low" }));
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("keeps the projection when a detail-only compact removes unrelated output", async () => {
  const t = makeThreadResponse({ id: "t" });
  const subscriptions: Array<{ event: string; threadId?: string; callback: (value: never) => void }> = [];
  const subscribe = vi.fn((input: unknown) => {
    const subscription = input as { event: string; threadId?: string; callback: (value: never) => void };
    subscriptions.push(subscription);
    return () => { subscriptions.splice(subscriptions.indexOf(subscription), 1); };
  });
  let events = [
    { id: "q", seq: 1, type: "client/turn/requested", data: { requestId: "r", execution: { reasoningLevel: "high", serviceTier: "fast" } } },
    { id: "a", seq: 2, type: "turn/input/accepted", data: { clientRequestId: "r" } },
    { id: "output", seq: 3, type: "item/commandExecution/outputDelta", data: {} },
  ];
  const history = vi.fn(async ({ types }: { types?: readonly string[] }) => events.filter((event) => types?.includes(event.type)));
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { subscribe, threads: { list: async () => [t], events: { list: history as never } } } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = async () => (await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] }) as { projections: unknown[] }).projections[0];
  await vi.waitFor(async () => expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "high", serviceTier: "fast" }));
  expect(subscriptions.filter((entry) => entry.event === "thread:changed")).toHaveLength(1);
  // Match BB 0.48.1 routing: compact-only notifications go to detail targets.
  events = events.filter((event) => event.id !== "output");
  for (const entry of subscriptions.filter((entry) => entry.event === "thread:changed" && entry.threadId === t.id)) {
    entry.callback({ entity: "thread", id: t.id, changes: ["history-compacted"] } as never);
  }
  expect(history).toHaveBeenCalledTimes(2);
  expect(await read()).toMatchObject({ state: "ready", reasoningLevel: "high", serviceTier: "fast" });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("retains the error of an unknown ID across reload until catalogue reconciliation", async () => {
  const callbacks = new Map<string, (event: never) => void>();
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async (args) => { if (args?.threadIds) throw new Error("unavailable"); return []; }, events: { list: async () => [] } },
  } });
  await plugin(bb);
  harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "done" }));
  callbacks.get("thread:changed")!({ entity: "thread", id: "unknown", changes: ["thread-created"] } as never);
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 1 }));
  const reloaded = await harness.lifecycle.reload(plugin);
  expect(await reloaded.harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error", errors: 1 });
  expect(await reloaded.harness.behavior.callRpc("getExecutionProjections", { threadIds: ["unknown"] })).toEqual({ projections: [{ threadId: "unknown", state: "error" }] });
  await reloaded.harness.lifecycle.dispose();
});
