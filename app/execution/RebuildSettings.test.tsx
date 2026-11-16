// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../app"));
afterEach(cleanup);

it("shows recovery and disables the rebuild action until recovery finishes", async () => {
  const start = vi.fn();
  const settings = app.settingsSections.find((section) => section.id === "execution-index")!;
  renderSlot(settings, {}, { rpc: { getExecutionRebuildStatus: () => ({ kind: "recovery", state: "running", total: 4, done: 2, errors: 0, tooLarge: 0, active: true }), startExecutionRebuild: start } });
  await screen.findByText(/Wait for recovery/);
  expect(screen.getByRole("button", { name: "Rebuild execution index" }).hasAttribute("disabled")).toBe(true);
  expect(start).not.toHaveBeenCalled();
});

it("starts or joins a rebuild and shows its progress", async () => {
  const start = vi.fn(() => ({ kind: "rebuild", state: "running", total: 4, done: 1, errors: 0, tooLarge: 0, active: true }));
  const settings = app.settingsSections.find((section) => section.id === "execution-index")!;
  renderSlot(settings, {}, { rpc: { getExecutionRebuildStatus: () => ({ kind: "initial", state: "done", total: 4, done: 4, errors: 0, tooLarge: 0, active: false }), startExecutionRebuild: start } });
  await screen.findByText(/4 \/ 4/);
  fireEvent.click(screen.getByRole("button", { name: "Rebuild execution index" }));
  await screen.findByText(/1 \/ 4/);
  expect(start).toHaveBeenCalledTimes(1);
});
