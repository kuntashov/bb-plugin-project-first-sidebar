// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { windowFilterStore } from "../filters/filter-store.js";
import { defaultFilterDocument } from "../../shared/filters.js";
import { defaultPreferences, PREFERENCES_CHANGED_CHANNEL, type PreferenceValues } from "../../shared/preferences.js";
import {
  flushPreferenceWritesForTest,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./preferences-sync.js";

const app = await loadPluginApp(() => import("../../app.js"));
const registration = app.threadLists[0]!;
const props: PluginThreadListProps = {
  activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: "",
};

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

describe("built-in filter visibility in the registered sidebar", () => {
  it("applies built-in visibility preferences to the sidebar after edits, remount and realtime", async () => {
    const settings = app.settingsSections.find((section) => section.id === "built-in-filter-visibility")!;
    expect(settings).toBeDefined();
    const sidebarHostStore = createStore();
    const settingsHostStore = createStore();
    function Component({ settingsOpen }: { settingsOpen: boolean }) {
      return <>
        <JotaiProvider store={sidebarHostStore}><registration.component {...props} /></JotaiProvider>
        {settingsOpen ? <JotaiProvider store={settingsHostStore}><settings.component /></JotaiProvider> : null}
      </>;
    }
    setPreferencesMirrorStorageForTest(null);
    const preferences = defaultPreferences();
    const listPreferences = vi.fn(() => ({ preferences }));
    const options: RenderSlotOptions = {
      rpc: {
        listPreferences,
        listFilters: () => ({ status: "success", document: defaultFilterDocument() }),
        setPreference: (input) => {
          const { key, value } = input as { key: "showProjectlessFilter"; value: boolean };
          preferences[key] = value;
          return input;
        },
      },
    };
    const first = renderSlot({ component: Component }, { settingsOpen: true }, options);
    const projectless = await screen.findByRole("radio", { name: "Без проектов" });
    const setting = (name: string) => screen.getByRole<HTMLInputElement>("checkbox", { name });
    const label = "Показывать фильтр «Без проектов»";
    await waitFor(() => expect(setting(label).disabled).toBe(false));
    expect(setting(label).checked).toBe(true);
    expect(setting("Показывать фильтр «Непрочитанные»").checked).toBe(true);
    expect(setting("Показывать фильтр «Ждут действия»").checked).toBe(true);
    fireEvent.click(projectless);
    fireEvent.click(setting(label));
    expect(screen.queryByRole("radio", { name: "Без проектов" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Все" }).getAttribute("aria-checked")).toBe("true");
    act(() => windowFilterStore.setActiveFilterId("projectless"));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    await act(async () => flushPreferenceWritesForTest());
    expect(first.rpcCalls.filter(({ method }) => method === "setPreference")).toEqual([
      { method: "setPreference", input: { key: "showProjectlessFilter", value: false } },
    ]);
    first.unmount();
    resetPreferencesSyncForTest();
    listPreferences.mockClear();

    const remounted = renderSlot({ component: Component }, { settingsOpen: false }, options);
    await waitFor(() => {
      expect(listPreferences).toHaveBeenCalledOnce();
      expect(windowFilterStore.isFilterAvailable("projectless")).toBe(false);
    });
    await remounted.lifecycle.rerender(<Component settingsOpen />);
    expect(setting(label).disabled).toBe(false);
    expect(setting(label).checked).toBe(false);
    expect(screen.queryByRole("radio", { name: "Без проектов" })).toBeNull();
    await remounted.behavior.emitRealtime(PREFERENCES_CHANGED_CHANNEL, { key: "showProjectlessFilter", value: true });
    const restored = await screen.findByRole("radio", { name: "Без проектов" });
    expect(restored.getAttribute("aria-checked")).toBe("false");
    expect(setting(label).checked).toBe(true);
    fireEvent.click(restored);
    act(() => restored.focus());
    await remounted.behavior.emitRealtime(PREFERENCES_CHANGED_CHANNEL, { key: "showProjectlessFilter", value: false });
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Все" }));
  });

  it.each([false, true])("waits for the initial visibility response before admitting the personal filter (%s)", async (visible) => {
    setPreferencesMirrorStorageForTest(null);
    let finishRead!: (value: { preferences: PreferenceValues }) => void;
    const response = new Promise<{ preferences: PreferenceValues }>((resolve) => { finishRead = resolve; });
    renderSlot(registration, props, {
      rpc: {
        listPreferences: () => response,
        listFilters: () => ({ status: "success", document: {
          ...defaultFilterDocument(), revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
          filters: [{ id: "other", name: "Work filter", rule: { kind: "projectIds", projectIds: [] } }],
        } }),
      },
    });
    const all = await screen.findByRole("radio", { name: "Все" });
    const custom = await screen.findByRole("radio", { name: "Work filter" });
    fireEvent.click(all);
    expect(screen.queryByRole("radio", { name: "Без проектов" })).toBeNull();
    act(() => windowFilterStore.setActiveFilterId("projectless"));
    expect(all.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(custom);
    expect(custom.getAttribute("aria-checked")).toBe("true");
    await act(async () => finishRead({ preferences: { ...defaultPreferences(), showProjectlessFilter: visible } }));
    act(() => windowFilterStore.setActiveFilterId("projectless"));
    if (visible) {
      expect(screen.getByRole("radio", { name: "Без проектов" }).getAttribute("aria-checked")).toBe("true");
    } else {
      expect(screen.queryByRole("radio", { name: "Без проектов" })).toBeNull();
      expect(custom.getAttribute("aria-checked")).toBe("true");
    }
  });
});
