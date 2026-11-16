// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { renderSlot, loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ThreadReveal, requestThreadReveal } from "./ThreadReveal.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { defaultPreferences, type PreferenceValues } from "../../shared/preferences.js";
import { defaultFilterDocument } from "../../shared/filters.js";
import { windowFilterStore } from "../filters/filter-store.js";
import { flushPreferenceWritesForTest, resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "../preferences/preferences-sync.js";

const app = await loadPluginApp(() => import("../../app"));
const list = app.threadLists[0]!;
const projects = [makePluginProject({ id: "personal", isPersonal: true }), makePluginProject({ id: "app", name: "App" }), makePluginProject({ id: "web", name: "Web" })];
const parent = makeSidebarThread({ id: "parent", projectId: "app", title: "Parent", sectionId: "later" });
const child = makeSidebarThread({ id: "child", projectId: "app", title: "Child", parentThreadId: "parent" });
const props: PluginThreadListProps = { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: () => {}, searchQuery: "" };
const scroll = vi.fn();

beforeEach(() => {
  setPreferencesMirrorStorageForTest(null);
  windowFilterStore.setActiveFilterId("all");
  Element.prototype.scrollIntoView = scroll;
  scroll.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); resetPreferencesSyncForTest(); setPreferencesMirrorStorageForTest(undefined); });

async function mount(preferences: Partial<PreferenceValues> = {}, threads = [parent, child], extra: Parameters<typeof renderSlot>[2] = {}, pinnedMode: "filter" | "always-show" = "filter") {
  const prefs = { ...defaultPreferences(), ...preferences };
  function Component() { return <><ThreadReveal /><list.component {...props} /></>; }
  const document = { ...defaultFilterDocument(), pinnedMode, revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
    filters: [{ id: "web-only", name: "Web only", rule: { kind: "projectIds" as const, projectIds: ["web"] } }, { id: "app-only", name: "App only", rule: { kind: "projectIds" as const, projectIds: ["app"] } }] };
  const view = renderSlot({ component: Component }, {}, {
    pluginId: "project-first-sidebar",
    rpc: {
      listPreferences: () => ({ preferences: prefs }), setPreference: (input: unknown) => input,
      listFilters: () => ({ status: "success", document }),
    },
    sidebarThreads: { projects, threads, sections: [{ id: "later", name: "Later", createdAt: 1, updatedAt: 1 }],
      experimental_archived: { status: "ready", hasNextPage: false, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: async () => {} } },
    ...extra,
  });
  await screen.findByRole("radio", { name: "Все" });
  await waitFor(() => expect(windowFilterStore.getSnapshot().status).toBe("ready"));
  return view;
}
async function reveal(id = "child") { await act(async () => requestThreadReveal(id)); }
function row(id = "child") { return document.querySelector<HTMLElement>(`a[data-sidebar-thread-id="${id}"]`); }

describe("explicit reveal through the mounted sidebar", () => {
  it("switches excluded projects to All, expands the root section and focuses the same open thread repeatedly", async () => {
    await mount({ collapsedProjects: ["app", "web"], collapsedThreads: ["parent"], collapsedThreadSections: ["app::later"] });
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    expect(row()).toBeNull();
    await reveal();
    await waitFor(() => expect(document.activeElement).toBe(row()));
    expect(row()?.hasAttribute("data-project-first-reveal-highlight")).toBe(true);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    const collapse = screen.getByRole("button", { name: "Collapse Parent threads" });
    fireEvent.click(collapse);
    expect(row()).toBeNull();
    await reveal();
    await waitFor(() => expect(row()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row()));
  });

  it("keeps an admitting filter and unrelated branches collapsed", async () => {
    const { rpcCalls } = await mount({ collapsedProjects: ["web"] });
    act(() => windowFilterStore.setActiveFilterId("app-only"));
    await reveal("parent");
    await waitFor(() => expect(document.activeElement).toBe(row("parent")));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("app-only");
    await flushPreferenceWritesForTest();
    expect(rpcCalls.filter((call) => call.method === "setPreference").some((call) => JSON.stringify(call.input).includes('"web"'))).toBe(false);
  });

  it("keeps the selected filter when a pinned subtree is admitted independently", async () => {
    await mount({}, [{ ...parent, pinnedAt: 1, isPinned: true }, child], {}, "always-show");
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    await reveal();
    await waitFor(() => expect(document.activeElement).toBe(row()));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("web-only");
  });

  it.each(["Отмена", "Escape"])("cancels combined archive/group changes without writes or changing the filter: %s", async (action) => {
    const archived = { ...child, isArchived: true, archivedAt: 1 };
    const { rpcCalls, inspection } = await mount({ hiddenGroups: ["project:app"] }, [parent, archived]);
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    await reveal();
    const dialog = await screen.findByRole("dialog");
    const cancel = screen.getByRole("button", { name: "Отмена" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(dialog.textContent).toContain("останется архивированным");
    expect(dialog.textContent).toContain("Группа скрыта");
    if (action === "Escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await flushPreferenceWritesForTest();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("web-only");
    expect(rpcCalls.filter((call) => call.method === "setPreference")).toEqual([]);
    expect(inspection.sdkCalls).toEqual([]);
  });

  it("does not expand a hidden group automatically before the confirmation", async () => {
    const { rpcCalls } = await mount({ hiddenGroups: ["project:app"], collapsedProjects: ["app"] }, [parent, child],
      { context: { threadId: "child", projectId: "app" } });
    await reveal();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await flushPreferenceWritesForTest();
    expect(rpcCalls.filter((call) => call.method === "setPreference")).toEqual([]);
  });

  it("does not treat consent as authorization for a newly hidden group", async () => {
    const error = vi.spyOn(toast, "error");
    const archived = { ...child, isArchived: true, archivedAt: 1 };
    const { rpcCalls } = await mount({}, [parent, archived]);
    await reveal();
    await screen.findByRole("dialog");
    await act(async () => {
      // Another window changes visibility while this dialog is open.
      const viewSignal = { key: "hiddenGroups", value: ["project:app"] };
      const { applyRemotePreferenceSignal } = await import("../preferences/preferences-sync.js");
      applyRemotePreferenceSignal(viewSignal);
    });
    fireEvent.click(screen.getByRole("button", { name: "Показать в дереве" }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Видимость треда изменилась")));
    await flushPreferenceWritesForTest();
    expect(rpcCalls.filter((call) => call.method === "setPreference")).toEqual([]);
    expect(row()).toBeNull();
  });

  it("shows the archived thread after consent, restores only its group and preserves its lifecycle", async () => {
    const archived = { ...child, isArchived: true, archivedAt: 1 };
    const { rpcCalls, inspection } = await mount({ hiddenGroups: ["project:app", "project:web"] }, [parent, archived]);
    await reveal();
    fireEvent.click(await screen.findByRole("button", { name: "Показать в дереве" }));
    await waitFor(() => expect(document.activeElement).toBe(row()));
    await flushPreferenceWritesForTest();
    expect(rpcCalls).toContainEqual({ method: "setPreference", input: { key: "threadLifecycles", value: ["active", "archived"] } });
    expect(rpcCalls).toContainEqual({ method: "setPreference", input: { key: "hiddenGroups", value: ["project:web"] } });
    expect(inspection.sdkCalls).toEqual([]);
    expect(archived.isArchived).toBe(true);
  });

  it("goes to the project without changing archive or hidden thread status", async () => {
    const hidden = { ...child, isHidden: true, isArchived: true, archivedAt: 1 };
    const { rpcCalls, inspection } = await mount({ hiddenGroups: ["project:app"] }, [parent, hidden]);
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    await reveal();
    fireEvent.click(await screen.findByRole("button", { name: "Перейти к проекту" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Collapse App section"));
    await flushPreferenceWritesForTest();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    expect(rpcCalls.filter((call) => call.method === "setPreference").map((call) => call.input)).not.toContainEqual(expect.objectContaining({ key: "threadLifecycles" }));
    expect(inspection.sdkCalls).toEqual([]);
  });

  it("finds the personal destination even if all its threads are hidden", async () => {
    const hidden = makeSidebarThread({ id: "personal-hidden", projectId: "personal", isHidden: true });
    await mount({}, [hidden]);
    await reveal(hidden.id);
    fireEvent.click(await screen.findByRole("button", { name: "Перейти к «Без проектов»" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Без проектов"));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("projectless");
  });

  it("reads an unloaded archived thread to identify its project and can cancel without fetching archive pages", async () => {
    const get = vi.fn(async () => makeThreadResponse({ id: "unloaded", projectId: "app", archivedAt: 1 }));
    const fetchNextPage = vi.fn(async () => {});
    await mount({}, [parent], { sdk: { threads: { get } }, sidebarThreads: { projects, threads: [parent],
      experimental_archived: { status: "ready", hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage } } });
    await reveal("unloaded");
    expect((await screen.findByRole("dialog")).textContent).toContain("Проект: App");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(get).toHaveBeenCalledOnce();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("aborts pending positioning and clears highlighting when unmounted", async () => {
    const view = await mount();
    await reveal();
    await waitFor(() => expect(row()?.hasAttribute("data-project-first-reveal-highlight")).toBe(true));
    const element = row();
    view.unmount();
    expect(element?.hasAttribute("data-project-first-reveal-highlight")).toBe(false);
    await reveal();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
