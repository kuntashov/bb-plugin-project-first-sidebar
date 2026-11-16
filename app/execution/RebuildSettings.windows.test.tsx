// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ handlers: new Set<() => void>(), status: { kind: "rebuild", state: "error", total: 1, done: 0, errors: 1, tooLarge: 1 } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => rpc,
  useRealtime: (_channel: string, handler: () => void) => { mock.handlers.add(handler); },
  useRealtimeConnectionState: () => "connected",
}));
const rpc = { call: async () => ({ ...mock.status }) };
import { RebuildSettings } from "./RebuildSettings.js";
afterEach(() => { cleanup(); mock.handlers.clear(); });

it("refreshes status in two windows on a status-only invalidation", async () => {
  const first = render(<RebuildSettings />);
  const second = render(<RebuildSettings />);
  await waitFor(() => expect(screen.getAllByText(/1 errors/)).toHaveLength(2));
  mock.status = { kind: "rebuild", state: "error", total: 1, done: 1, errors: 0, tooLarge: 0 };
  act(() => { for (const handler of mock.handlers) handler(); });
  await waitFor(() => {
    expect(within(first.container).getByText(/error.*1 \/ 1.*0 errors/)).toBeTruthy();
    expect(within(second.container).getByText(/error.*1 \/ 1.*0 errors/)).toBeTruthy();
  });
});
