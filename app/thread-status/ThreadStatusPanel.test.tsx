// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { afterEach, expect, it, vi } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import type { LifecycleRow } from "./sidebar-rpc.js";

installTestPluginRuntime();
const { ThreadStatusPanel, ThreadStatusProvider } = await import("./ThreadStatusPanel.js");
afterEach(cleanup);

const token = "5df5afce-a9e3-4563-a3e7-37ecca6094dc";
function mount(available = true) {
  const threads = ["visible", "outside"].map(id => makeSidebarThread({ id, title: id }));
  const visible = threads.slice(0, 1);
  const rows = new Map<string, LifecycleRow>();
  const mutations = vi.fn();
  const callRpc: PluginBrowserBbSdk["plugins"]["callRpc"] = async ({ pluginId, method, input, outputSchema }) => {
    expect(pluginId).toBe("bb-sidebar");
    if (!available) throw new Error("Plugin unavailable");
    if (method === "listLifecycle") return outputSchema.parse({ rows: Array.from(rows.values()) });
    if (method === "getSidebarSettings") return outputSchema.parse({ inactiveThreadsEnabled: true, inactiveAfterHours: 6, snoozePresets: "Later=2h" });
    mutations(method, input);
    const id = "visible";
    const row: LifecycleRow = { threadId: id, parkedAt: null, snoozedAt: null, snoozedUntil: null, settledAt: null };
    const reclaim = { closedTerminals: 1, keptTerminals: 2, stoppedRuntime: true };
    switch (method) {
      case "park":
        rows.set(id, { ...row, parkedAt: Date.now() });
        return outputSchema.parse({ ok: true, reclaim });
      case "snooze":
        rows.set(id, { ...row, snoozedAt: Date.now(), snoozedUntil: Number((input as { snoozedUntil: number }).snoozedUntil) });
        return outputSchema.parse({ ok: true, reclaim });
      case "settle":
        rows.set(id, { ...row, settledAt: Date.now(), settledOverride: "settled" });
        return outputSchema.parse({ ok: true, reclaim, undoToken: token });
      case "resume": case "unsnooze": case "unsettle":
        rows.delete(id);
        return outputSchema.parse({ ok: true });
      case "previewSettledCleanup":
        return outputSchema.parse({ token, threads: [{ threadId: id, title: "Visible thread", terminalCount: 1, ports: [4000] }], skipped: [] });
      case "cleanSettled":
        return outputSchema.parse({ closedTerminals: 1, signalledPorts: [{ threadId: id, port: 4000 }],
          remainingPorts: [{ threadId: id, port: 4000 }], skipped: [], failed: [{ threadId: id, resource: "port", message: "Still busy" }] });
      default: throw new Error(method);
    }
  };
  function Harness() {
    return <ThreadStatusProvider threads={threads}><ThreadStatusPanel threads={visible} /></ThreadStatusProvider>;
  }
  renderSlot({ component: Harness }, {}, { sdk: { plugins: { callRpc } } });
  fireEvent.click(screen.getByRole("button", { name: "Статус треда" }));
  return mutations;
}

async function openInactive() {
  await screen.findByRole("option", { name: "Inactive (1)" });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Inactive" } });
  expect(screen.getByRole("link", { name: "visible" }).getAttribute("href")).toContain("/threads/visible");
  expect(screen.queryByText("outside")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Статус треда «visible»" }));
  return within(await screen.findByRole("dialog"));
}

it("shares park, snooze and settle changes, shows reclamation and passes the settle undo token", async () => {
  const mutations = mount();
  const dialog = await openInactive();
  const click = async (name: string) => {
    const button = await dialog.findByRole("button", { name });
    await waitFor(() => expect(button.matches(":disabled")).toBe(false));
    fireEvent.click(button);
  };
  await click("Park");
  expect(await dialog.findByText(/Закрыто терминалов: 1, сохранено: 2/)).toBeTruthy();
  await click("Resume");
  await click("Snooze");
  await click("Later");
  await click("Unsnooze");
  await click("Settle");
  await click("Unsettle");
  await waitFor(() => expect(mutations).toHaveBeenLastCalledWith("unsettle", { threadId: "visible", undoToken: token }));
  expect(mutations.mock.calls.map(([method]) => method)).toEqual(["park", "resume", "snooze", "unsnooze", "settle", "unsettle"]);
  const until = mutations.mock.calls[2][1].snoozedUntil;
  expect(Math.abs(until - Date.now() - 2 * 3_600_000)).toBeLessThan(10_000);
});

it("previews only the filtered Settled list and reports partial cleanup after explicit confirmation", async () => {
  const mutations = mount();
  const dialog = await openInactive();
  fireEvent.click(dialog.getByRole("button", { name: "Settle" }));
  await dialog.findByRole("button", { name: "Unsettle" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Settled" } });
  fireEvent.click(screen.getByRole("button", { name: "Clean · 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Clean · предпросмотр" }));
  await screen.findByText(/Visible thread · терминалов: 1 · порты: 4000/);
  expect(mutations).toHaveBeenLastCalledWith("previewSettledCleanup", { threadIds: ["visible"] });
  expect(mutations).not.toHaveBeenCalledWith("cleanSettled", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить Clean" }));
  await screen.findByText("Продолжают слушать: visible / 4000");
  expect(screen.getByText(/Still busy/)).toBeTruthy();
  expect(mutations).toHaveBeenLastCalledWith("cleanSettled", { token });
  expect(screen.queryByRole("button", { name: "Подтвердить Clean" })).toBeNull();
});

it("keeps the status panel available and explains a missing shared lifecycle service", async () => {
  mount(false);
  expect(await screen.findByText(/нужен включённый BB Sidebar/)).toBeTruthy();
  expect(screen.getByRole("option", { name: "Working (0)" })).toBeTruthy();
});
