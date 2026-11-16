import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import plugin from "../server.js";

it("removes the old working colour when reconnect finds unreadable offline history during rebuild", async () => {
  const thread = makeThreadResponse({ id: "t" });
  const callbacks = new Map<string, (event: never) => void>();
  let level = "high", block = false, failing = false;
  let release: (() => void) | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: {
    subscribe: ({ event, callback }) => { callbacks.set(event, callback as (event: never) => void); return () => callbacks.delete(event); },
    threads: { list: async () => [thread], events: { list: async ({ types }) => {
      if (failing) throw Object.assign(new Error("large"), { status: 413 });
      const snapshot = level;
      if (block && types?.includes("turn/input/accepted")) { block = false; await new Promise<void>((resolve) => { release = resolve; }); }
      return (types?.includes("turn/input/accepted") ? [{ id: `a-${snapshot}`, seq: 2, type: "turn/input/accepted", data: { clientRequestId: snapshot } }] : [{ id: `q-${snapshot}`, seq: 1, type: "client/turn/requested", data: { requestId: snapshot, execution: { reasoningLevel: snapshot, serviceTier: "fast" } } }]) as never;
    } } },
  } });
  await plugin(bb);
  const service = harness.behavior.runService("execution-catalogue");
  const read = () => harness.behavior.callRpc("getExecutionProjections", { threadIds: ["t"] });
  await vi.waitFor(async () => expect(await read()).toMatchObject({ projections: [{ state: "ready", reasoningLevel: "high" }] }));
  block = true;
  await harness.behavior.callRpc("startExecutionRebuild", null);
  await vi.waitFor(() => expect(release).toBeDefined());
  callbacks.get("realtime:connection")!({ state: "reconnecting", reconnected: false } as never);
  level = "low";
  failing = true;
  callbacks.get("realtime:connection")!({ state: "connected", reconnected: true } as never);
  expect(await read()).toEqual({ projections: [{ threadId: "t", state: "unverified" }] });
  release!();
  await vi.waitFor(async () => expect(await harness.behavior.callRpc("getExecutionRebuildStatus", null)).toMatchObject({ kind: "rebuild", state: "error", active: false, tooLarge: 1 }));
  expect(await read()).toEqual({ projections: [{ threadId: "t", state: "error" }] });
  expect(bb.storage.database().prepare("SELECT active_generation FROM execution_meta").get()).toEqual({ active_generation: 1 });
  const lateConnection = callbacks.get("realtime:connection")!;
  service.controller.abort(); await service.done; await harness.lifecycle.dispose();
  const signalCount = harness.inspection.realtimeSignals.length;
  lateConnection({ state: "connected", reconnected: true } as never);
  expect(harness.inspection.realtimeSignals).toHaveLength(signalCount);
});
