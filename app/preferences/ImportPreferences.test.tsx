// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../../app"));
const settings = app.settingsSections[0]!;
afterEach(cleanup);

it("offers import retry from plugin settings before the sidebar is selected", async () => {
  const retry = vi.fn(() => ({ state: "imported", imported: [], message: "Imported successfully" }));
  renderSlot(settings, {}, {
    pluginId: "project-first-sidebar",
    rpc: {
      getImportStatus: () => ({ state: "failed", imported: [], message: "Source read failed" }),
      importPreferences: retry,
    },
  });
  await screen.findByText("Source read failed");
  expect(screen.getByRole("alert").textContent).toBe("Source read failed");
  fireEvent.click(screen.getByRole("button", { name: "Import / retry Thread-list preferences" }));
  await screen.findByText("Imported successfully");
  expect(retry).toHaveBeenCalledTimes(1);
});

it("shows transport failure and lets the user retry", async () => {
  renderSlot(settings, {}, {
    rpc: {
      getImportStatus: () => { throw new Error("Connection lost"); },
      importPreferences: () => ({ state: "absent", imported: [], message: "Thread-list is not installed" }),
    },
  });
  await screen.findByText("Connection lost");
  await waitFor(() => expect(screen.getByRole("button").hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button"));
  await screen.findByText("Thread-list is not installed");
});
