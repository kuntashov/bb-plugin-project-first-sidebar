// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ handlers: new Set<() => void>(), status: { kind: "rebuild", state: "error", total: 1, done: 0, errors: 1, tooLarge: 1, active: false } }));
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
  await waitFor(() => expect(screen.getAllByText(/thread errors: 1/)).toHaveLength(2));
  mock.status = { kind: "rebuild", state: "error", total: 1, done: 1, errors: 0, tooLarge: 0, active: false };
  act(() => { for (const handler of mock.handlers) handler(); });
  await waitFor(() => {
    expect(within(first.container).getByText(/error.*1 \/ 1.*thread errors: 0/)).toBeTruthy();
    expect(within(second.container).getByText(/error.*1 \/ 1.*thread errors: 0/)).toBeTruthy();
  });
});

it("keeps recovery error visible and disables rebuilding in both windows until retry ends", async () => {
  mock.status = { kind: "recovery", state: "error", total: 1, done: 1, errors: 0, tooLarge: 0, active: true };
  const first = render(<RebuildSettings />);
  const second = render(<RebuildSettings />);
  await waitFor(() => expect(screen.getAllByText(/recovery: error/)).toHaveLength(2));
  for (const window of [first, second]) {
    expect(within(window.container).getByRole("button", { name: "Rebuild execution index" }).hasAttribute("disabled")).toBe(true);
    expect(within(window.container).getByText(/Wait for recovery/)).toBeTruthy();
  }
  mock.status = { ...mock.status, state: "done", active: false };
  act(() => { for (const handler of mock.handlers) handler(); });
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Rebuild execution index" }).every((button) => !button.hasAttribute("disabled"))).toBe(true));
});

it("disables both open windows when synchronization starts before the job kind can change", async () => {
  mock.status = { kind: "initial", state: "done", total: 1, done: 1, errors: 0, tooLarge: 0, active: false };
  const first = render(<RebuildSettings />);
  const second = render(<RebuildSettings />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "Rebuild execution index" }).every((button) => !button.hasAttribute("disabled"))).toBe(true));
  mock.status = { ...mock.status, state: "error", active: true };
  act(() => { for (const handler of mock.handlers) handler(); });
  await waitFor(() => {
    for (const window of [first, second]) {
      expect(within(window.container).getByRole("button", { name: "Rebuild execution index" }).hasAttribute("disabled")).toBe(true);
      expect(within(window.container).getByText(/Index synchronization is in progress/)).toBeTruthy();
    }
  });
});
