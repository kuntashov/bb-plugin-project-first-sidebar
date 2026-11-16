// @vitest-environment jsdom
import React from "react";
import { Provider, createStore } from "jotai";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: { call: vi.fn() }, handler: null as null | ((payload: unknown) => void), data: { threads: [{ id: "t" }, { id: "other" }] } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => mocks.rpc, useRealtime: (_channel: string, handler: (payload: unknown) => void) => { mocks.handler = handler; }, useRealtimeConnectionState: () => "connected" }));
vi.mock("../model/use-sidebar-data.js", () => ({ useSidebarData: () => mocks.data }));
import { ExecutionProjectionSync, executionIndexErrorAtom, executionProjectionsAtom } from "./ExecutionProjectionSync.js";
import { sidebarShowExecutionHighlightingAtom } from "../preferences/atoms.js";

it("exposes an individual error while the catalogue job is still running", async () => {
  mocks.rpc.call.mockResolvedValue({ state: "running", total: 2, done: 0, errors: 1 });
  const store = createStore();
  const view = render(<Provider store={store}><ExecutionProjectionSync /></Provider>);
  await waitFor(() => expect(store.get(executionIndexErrorAtom)).toBe(true));
  view.unmount();
});

it("updates an already open window for a failed ID while retaining another result", async () => {
  let failed = false;
  mocks.rpc.call.mockImplementation(async (method: string, input: { threadIds?: string[] } | null) => {
    if (method === "getExecutionIndexStatus") return { state: failed ? "error" : "running", total: 2, done: 1, errors: 0 };
    return { projections: input!.threadIds!.map((threadId) => ({ threadId, state: threadId === "t" && failed ? "error" : "absent" })) };
  });
  const store = createStore();
  store.set(sidebarShowExecutionHighlightingAtom, true);
  const view = render(<Provider store={store}><ExecutionProjectionSync /></Provider>);
  await waitFor(() => expect(store.get(executionProjectionsAtom).other?.state).toBe("absent"));
  failed = true;
  act(() => mocks.handler?.({ threadId: "t" }));
  await waitFor(() => expect(store.get(executionProjectionsAtom).t?.state).toBe("error"));
  expect(store.get(executionProjectionsAtom).other?.state).toBe("absent");
  expect(store.get(executionIndexErrorAtom)).toBe(true);
  view.unmount();
});
