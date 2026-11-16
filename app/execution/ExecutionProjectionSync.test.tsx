// @vitest-environment jsdom
import React from "react";
import { Provider, createStore } from "jotai";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: { call: vi.fn() } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => mocks.rpc, useRealtime: () => {}, useRealtimeConnectionState: () => "connected" }));
vi.mock("../model/use-sidebar-data.js", () => ({ useSidebarData: () => ({ threads: [] }) }));
import { ExecutionProjectionSync, executionIndexErrorAtom } from "./ExecutionProjectionSync.js";

it("exposes an individual error while the catalogue job is still running", async () => {
  mocks.rpc.call.mockResolvedValue({ state: "running", total: 2, done: 0, errors: 1 });
  const store = createStore();
  const view = render(<Provider store={store}><ExecutionProjectionSync /></Provider>);
  await waitFor(() => expect(store.get(executionIndexErrorAtom)).toBe(true));
  view.unmount();
});
