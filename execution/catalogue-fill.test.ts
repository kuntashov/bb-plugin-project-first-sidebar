import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";

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
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: { list: async () => [makeThreadResponse({ id: "t" })], events: { list: async () => [] } } } });
  await plugin(bb);
  bb.storage.database().exec("CREATE TRIGGER reject_checkpoint BEFORE UPDATE ON execution_manifest BEGIN SELECT RAISE(ABORT, 'failure'); END");
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toMatchObject({ state: "error" }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "loading" }] });
  expect(bb.storage.database().prepare("SELECT state FROM execution_manifest WHERE thread_id = ?").get("t")).toEqual({ state: "pending" });
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});

it("does not commit or publish when disposed while a history read is pending", async () => {
  let release!: () => void;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { threads: {
    list: async () => [makeThreadResponse({ id: "t" })],
    events: { list: async () => { await new Promise<void>((resolve) => { release = resolve; }); return []; } },
  } } });
  await plugin(bb);
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
  const service = harness.behavior.runService("execution-catalogue");
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionIndexStatus", null)).toEqual({ state: "error", total: 1, done: 0, errors: 1 }));
  expect(await harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] })).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  expect(read).toHaveBeenCalledTimes(1);
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
});
