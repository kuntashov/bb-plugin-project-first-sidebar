// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { renderSlot, loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ThreadReveal, requestThreadReveal } from "./ThreadReveal.js";
import { makePluginProject, makeSidebarEnvironment, makeSidebarThread } from "../model/fixtures.js";
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
const EMPTY_SECTION_DOCUMENT = { schemaVersion: 1 as const, revision: 0, sections: [], order: [] };

beforeEach(() => {
  setPreferencesMirrorStorageForTest(null);
  windowFilterStore.setActiveFilterId("all");
  Element.prototype.scrollIntoView = scroll;
  scroll.mockClear();
});
afterEach(() => {
  document.getElementById("split-surface")?.remove();
  vi.restoreAllMocks();
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

async function mount(
  preferences: Partial<PreferenceValues> = {},
  threads = [parent, child],
  extra: Parameters<typeof renderSlot>[2] = {},
  pinnedMode: "filter" | "always-show" = "filter",
  placement?: {
    document: { schemaVersion: 1; revision: number; sections: { id: string; projectId: string; name: string }[]; order: { projectId: string; sectionIds: string[] }[] };
    metadata: Record<string, Record<string, unknown>>;
  },
) {
  const prefs = { ...defaultPreferences(), ...preferences };
  function Component() { return <><ThreadReveal /><list.component {...props} /></>; }
  const document = { ...defaultFilterDocument(), pinnedMode, revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
    filters: [{ id: "web-only", name: "Web only", rule: { kind: "projectIds" as const, projectIds: ["web"] } }, { id: "app-only", name: "App only", rule: { kind: "projectIds" as const, projectIds: ["app"] } }] };
  const view = renderSlot({ component: Component }, {}, {
    pluginId: "project-first-sidebar",
    rpc: {
      listPreferences: () => ({ preferences: prefs }), setPreference: (input: unknown) => input,
      listFilters: () => ({ status: "success", document }),
      listProjectSections: () => ({ status: "success", document: placement?.document ?? EMPTY_SECTION_DOCUMENT }),
      readProjectSectionMetadata: (input: unknown) => ({
        status: "success" as const,
        threads: ((input as { threadIds?: string[] } | null)?.threadIds ?? []).map((threadId) => ({
          threadId,
          metadata: placement?.metadata[threadId] ?? {},
        })),
      }),
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
function row(id = "child") {
  const sidebar = document.querySelector("[data-project-first-sidebar]");
  return sidebar?.querySelector<HTMLElement>(`a[data-sidebar-thread-id="${id}"]`) ?? null;
}
function lastPreference(calls: { method: string; input?: unknown }[], key: string) {
  const writes = calls.filter((call) => call.method === "setPreference" && (call.input as { key?: string }).key === key);
  return writes.at(-1)?.input;
}

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

  it("opens the project section, worktree group and ancestors, and focuses the sidebar row", async () => {
    const linked = makeSidebarEnvironment({ id: "env_linked", name: "linked", isWorktree: true, providerId: "git-worktree" });
    const linkedParent = makeSidebarThread({ id: "parent", projectId: "app", title: "Parent", environment: linked });
    const linkedSibling = makeSidebarThread({ id: "sibling", projectId: "app", title: "Sibling", environment: linked });
    const linkedChild = makeSidebarThread({ id: "child", projectId: "app", title: "Child", parentThreadId: "parent", environment: linked });
    const outside = document.createElement("a");
    outside.id = "split-surface";
    outside.dataset.sidebarThreadId = "child";
    outside.href = "#split";
    outside.textContent = "Split child";
    document.body.append(outside);
    const { rpcCalls } = await mount({
      collapsedProjects: ["app", "web"],
      collapsedThreads: ["parent"],
      collapsedEnvironments: ["env_linked"],
      collapsedThreadSections: ["project-section:app::sec_alpha", "project-section:app::sec_beta", "project-section:web::sec_other"],
    }, [linkedParent, linkedSibling, linkedChild], {}, "filter", {
      document: {
        schemaVersion: 1,
        revision: 1,
        sections: [
          { id: "sec_alpha", projectId: "app", name: "Alpha" },
          { id: "sec_beta", projectId: "app", name: "Beta" },
        ],
        order: [{ projectId: "app", sectionIds: ["sec_alpha", "sec_beta"] }],
      },
      metadata: {
        parent: { projectId: "app", projectSectionId: "sec_alpha" },
        sibling: { projectId: "app", projectSectionId: "sec_alpha" },
        child: { projectId: "app", projectSectionId: "sec_beta" },
      },
    });
    act(() => windowFilterStore.setActiveFilterId("app-only"));
    expect(row()).toBeNull();
    await reveal();
    await waitFor(() => expect(document.activeElement).toBe(row()));
    expect(row()?.closest("[data-project-section-id]")?.getAttribute("data-project-section-id")).toBe("sec_alpha");
    expect(document.querySelector("[data-project-section-id='sec_alpha']")?.getAttribute("data-project-section-collapsed")).toBe("false");
    expect(document.querySelector("[data-project-section-id='sec_beta']")?.getAttribute("data-project-section-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse linked threads" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse Parent threads" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse App section" })).toBeTruthy();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("app-only");
    expect(scroll).toHaveBeenCalled();
    await flushPreferenceWritesForTest();
    expect(lastPreference(rpcCalls, "collapsedThreadSections")).toEqual({
      key: "collapsedThreadSections",
      value: ["project-section:app::sec_beta", "project-section:web::sec_other"],
    });
    expect(lastPreference(rpcCalls, "collapsedProjects")).toEqual({ key: "collapsedProjects", value: ["web"] });
    expect(lastPreference(rpcCalls, "collapsedEnvironments")).toEqual({ key: "collapsedEnvironments", value: [] });
    expect(lastPreference(rpcCalls, "collapsedThreads")).toEqual({ key: "collapsedThreads", value: [] });
  });

  it("switches an excluded project to All and opens that thread's project section", async () => {
    const root = makeSidebarThread({ id: "parent", projectId: "app", title: "Parent" });
    await mount({
      collapsedProjects: ["app"],
      collapsedThreadSections: ["project-section:app::sec_alpha"],
    }, [root], {}, "filter", {
      document: {
        schemaVersion: 1,
        revision: 1,
        sections: [{ id: "sec_alpha", projectId: "app", name: "Alpha" }],
        order: [{ projectId: "app", sectionIds: ["sec_alpha"] }],
      },
      metadata: { parent: { projectId: "app", projectSectionId: "sec_alpha" } },
    });
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    expect(row("parent")).toBeNull();
    await reveal("parent");
    await waitFor(() => expect(document.activeElement).toBe(row("parent")));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    expect(row("parent")?.closest("[data-project-section-id]")?.getAttribute("data-project-section-id")).toBe("sec_alpha");
  });

  it("reveals a pinned thread in Pinned and leaves its project section collapsed", async () => {
    const pinnedParent = makeSidebarThread({ id: "parent", projectId: "app", title: "Parent", pinnedAt: 1, isPinned: true });
    const pinnedChild = makeSidebarThread({ id: "child", projectId: "app", title: "Child", parentThreadId: "parent" });
    const { rpcCalls } = await mount({
      collapsedSections: ["pinned"],
      collapsedProjects: ["app"],
      collapsedThreadSections: ["project-section:app::sec_alpha"],
    }, [pinnedParent, pinnedChild], {}, "always-show", {
      document: {
        schemaVersion: 1,
        revision: 1,
        sections: [{ id: "sec_alpha", projectId: "app", name: "Alpha" }],
        order: [{ projectId: "app", sectionIds: ["sec_alpha"] }],
      },
      metadata: {
        parent: { projectId: "app", projectSectionId: "sec_alpha" },
        child: { projectId: "app", projectSectionId: "sec_beta" },
      },
    });
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    await reveal();
    await waitFor(() => expect(document.activeElement).toBe(row()));
    const pinnedGroup = screen.getByRole("button", { name: "Collapse Pinned section" }).closest("[data-sidebar-rename-row]");
    expect(pinnedGroup?.contains(row()!)).toBe(true);
    expect(row()?.closest("[data-project-section-id]")).toBeNull();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("web-only");
    await flushPreferenceWritesForTest();
    for (const call of rpcCalls.filter((item) => item.method === "setPreference")) {
      const input = call.input as { key: string; value: unknown };
      if (input.key === "collapsedThreadSections") expect(input.value).toContain("project-section:app::sec_alpha");
      if (input.key === "collapsedProjects") expect(input.value).toContain("app");
    }
  });

  it("reveals an archived thread in the section the loaded archive page already shows", async () => {
    const archived = makeSidebarThread({
      id: "archived-root", projectId: "app", title: "Archived root", archivedAt: 4, isArchived: true,
    });
    const fetchNextPage = vi.fn(async () => {});
    await mount({
      threadLifecycles: ["active", "archived"],
      collapsedProjects: ["app"],
      collapsedThreadSections: ["project-section:app::sec_alpha", "project-section:app::sec_beta"],
    }, [archived], {
      sidebarThreads: {
        projects,
        threads: [archived],
        sections: [],
        experimental_archived: {
          status: "ready", hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage,
        },
      },
    }, "filter", {
      document: {
        schemaVersion: 1,
        revision: 1,
        sections: [
          { id: "sec_alpha", projectId: "app", name: "Alpha" },
          { id: "sec_beta", projectId: "app", name: "Beta" },
        ],
        order: [{ projectId: "app", sectionIds: ["sec_alpha", "sec_beta"] }],
      },
      metadata: { "archived-root": { projectId: "app", projectSectionId: "sec_alpha" } },
    });
    await reveal("archived-root");
    await waitFor(() => expect(document.activeElement).toBe(row("archived-root")));
    expect(row("archived-root")?.closest("[data-project-section-id]")?.getAttribute("data-project-section-id")).toBe("sec_alpha");
    expect(document.querySelector("[data-project-section-id='sec_beta']")?.getAttribute("data-project-section-collapsed")).toBe("true");
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("leaves the project section collapsed when archive confirmation is cancelled", async () => {
    const archived = { ...child, isArchived: true, archivedAt: 1 };
    const { rpcCalls } = await mount({
      hiddenGroups: ["project:app"],
      collapsedProjects: ["app"],
      collapsedThreadSections: ["project-section:app::sec_alpha"],
    }, [parent, archived], {}, "filter", {
      document: {
        schemaVersion: 1,
        revision: 1,
        sections: [{ id: "sec_alpha", projectId: "app", name: "Alpha" }],
        order: [{ projectId: "app", sectionIds: ["sec_alpha"] }],
      },
      metadata: { parent: { projectId: "app", projectSectionId: "sec_alpha" } },
    });
    act(() => windowFilterStore.setActiveFilterId("web-only"));
    await reveal();
    fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await flushPreferenceWritesForTest();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("web-only");
    expect(rpcCalls.filter((call) => call.method === "setPreference")).toEqual([]);
    expect(row()).toBeNull();
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
