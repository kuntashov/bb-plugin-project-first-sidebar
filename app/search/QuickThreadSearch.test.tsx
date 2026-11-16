// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useReducer, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSlot, loadPluginApp, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginBrowserBbSdk, PluginSidebarThreadsState } from "@get-bb/plugin-sdk/app";
import { QuickThreadSearch, requestQuickThreadSearch } from "./QuickThreadSearch.js";
import { entry, uiPreferences } from "./test-fixtures.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { defaultPreferences } from "../../shared/preferences.js";
import { defaultFilterDocument } from "../../shared/filters.js";
import { windowFilterStore } from "../filters/filter-store.js";
import { resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "../preferences/preferences-sync.js";

let restoreSidebarHook: (() => void) | null = null;
const app = await loadPluginApp(() => import("../../app.js"));
const ThreadList = app.threadLists[0].component;
const project = { id: "app", name: "App", kind: "standard" as const, gitRemoteUrl: null, sources: [], createdAt: 1, updatedAt: 1 };
const archived = entry({ id: "archive", title: "Исследование: публикации архив", archivedAt: 1 });
const current = entry({ id: "current", title: "Исследование: публикации", updatedAt: 5 });
const sibling = entry({ id: "sibling", title: "Исследование:публикации", updatedAt: 4 });

function closingAnimation() {
  // The test animation names contain only ASCII letters; jsdom omits CSS.escape.
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (name: string) => name });
  const original = globalThis.getComputedStyle;
  vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = original.call(window, element, pseudo);
    if (element.getAttribute("role") === "dialog") {
      Object.defineProperty(style, "animationName", { configurable: true, get: () => element.getAttribute("data-state") === "closed" ? "exit" : "enter" });
      Object.defineProperty(style, "animationDuration", { configurable: true, get: () => "1s" });
    }
    return style;
  });
  return (dialog: HTMLElement) => {
    const event = new Event("animationend", { bubbles: true });
    Object.defineProperty(event, "animationName", { value: "exit" });
    fireEvent(dialog, event);
  };
}

beforeEach(() => {
  setPreferencesMirrorStorageForTest(null);
  windowFilterStore.setActiveFilterId("all");
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); restoreSidebarHook?.(); restoreSidebarHook = null; resetPreferencesSyncForTest(); setPreferencesMirrorStorageForTest(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(options: RenderSlotOptions = {}, initiallyShowSidebar = true) {
  let renderParent = () => {};
  let showSidebar = () => {};
  function Component() { const [, force] = useReducer((value) => value + 1, 0); renderParent = force; const [visible, setVisible] = useState(initiallyShowSidebar); showSidebar = () => setVisible(true); return <><QuickThreadSearch />{visible ? <ThreadList activeThreadId={null} activeProjectId={null} isCompactViewport={false} onNavigate={() => {}} searchQuery="" /> : null}</>; }
  const list = vi.fn(async (args: Parameters<PluginBrowserBbSdk["threads"]["list"]>[0] = {}) => args.offset ? [] : args.archived ? [archived] : [current, sibling]);
  const get = vi.fn(async ({ threadId }: Parameters<PluginBrowserBbSdk["threads"]["get"]>[0]) => makeThreadResponse({ ...(threadId === archived.id ? archived : threadId === sibling.id ? sibling : current), id: threadId }));
  const view = renderSlot({ component: Component }, {}, {
    pluginId: "project-first-sidebar",
    sidebarThreads: { status: "ready", projects: [makePluginProject({ id: "app", name: "App" })],
      sections: [], threads: [makeSidebarThread({ id: "current", projectId: "app", title: current.title, updatedAt: 5 })] },
    rpc: { listPreferences: () => ({ preferences: defaultPreferences() }), setPreference: (input: unknown) => input,
      listFilters: () => ({ status: "success", document: { ...defaultFilterDocument(), revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
        filters: [{ id: "app-only", name: "Рабочие", rule: { kind: "projectIds", projectIds: ["app"] } }] } }) },
    sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: { list, get } },
    ...options,
  });
  await waitFor(() => expect(windowFilterStore.getSnapshot().status).toBe("ready"));
  act(() => requestQuickThreadSearch());
  await screen.findByRole("combobox", { name: "Выбрать фильтр" });
  return { view, list, get, refreshSidebar: () => renderParent(), showSidebar: () => showSidebar() };
}
async function chooseFilter() {
  const input = screen.getByRole("combobox", { name: "Выбрать фильтр" });
  fireEvent.change(input, { target: { value: "Раб" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true"));
  return screen.getByRole("combobox", { name: "Найти тред" });
}

describe("keyboard quick navigation", () => {
  it("shows filters first and finds threads absent from the loaded sidebar with literal spaces and background highlights", async () => {
    const { list } = await mount();
    expect(screen.getByRole("option", { name: "Рабочие" })).toBeTruthy();
    const input = await chooseFilter();
    expect(document.activeElement).toBe(input);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "исс/ пуб" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    const option = screen.getByRole("option");
    expect([...option.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Исс", " пуб"]);
    expect(list.mock.calls.every(([args]) => !args?.archived)).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
  });
  it("keeps filter rows compact and supports selecting a filter in the other layout", async () => {
    await mount();
    const row = screen.getByRole("option", { name: "Рабочие" });
    expect(Number.parseInt(row.style.minHeight)).toBeLessThanOrEqual(32);
    const input = screen.getByRole("combobox", { name: "Выбрать фильтр" });
    fireEvent.change(input, { target: { value: "hf,jxbt" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option").textContent).toBe("Рабочие");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("combobox", { name: "Найти тред" });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(Number.parseInt(screen.getAllByRole("option")[0].style.height)).toBeLessThanOrEqual(44);
  });
  it("filters and highlights effective project separately from title, preserving the chosen filter", async () => {
    const target = entry({ id: "child", projectId: "other", parentThreadId: "parent", title: "Настройка сравнения" });
    const parent = entry({ id: "parent", projectId: "app", title: "Родитель" });
    const foreign = entry({ id: "foreign", projectId: "other", title: "Настройка сравнения" });
    const projects = [{ ...project, name: "Admin" }, { ...project, id: "other", name: "Home" }];
    await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => projects }, threads: {
      list: async ({ offset } = {}) => offset ? [] : [target, parent, foreign],
    } } });
    const input = await chooseFilter();
    fireEvent.change(input, { target: { value: "фвь:на/сра" } });
    const row = screen.getByRole("option");
    expect(row.textContent).toBe("Настройка сравненияAdmin");
    expect([...row.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["На", "сра", "Adm"]);
    fireEvent.change(input, { target: { value: "home:на" } });
    expect(screen.queryByRole("option")).toBeNull();
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
  });
  it("keeps compact virtual rows selectable beyond the first screen and after narrowing", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => entry({ id: `row-${index}`, title: `Server ${index}`, updatedAt: 100 - index }));
    await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
      list: async ({ offset } = {}) => offset ? [] : rows,
    } } });
    const input = await chooseFilter();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const last = screen.getByRole("option", { selected: true });
    expect(last.getAttribute("title")).toBe("Server 59");
    expect(last.getAttribute("aria-posinset")).toBe("60");
    expect(screen.getAllByRole("option").length).toBeLessThan(16);
    expect(input.getAttribute("aria-activedescendant")).toBe(last.id);
    fireEvent.change(input, { target: { value: "фзз:ыукмук/ 1" } });
    await waitFor(() => expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe("Server 1"));
    expect(screen.getAllByRole("option")).toHaveLength(11);
  });
  it("toggles the complete archive with Alt+A, preserves the phrase and resets on a new dialog", async () => {
    const { list } = await mount();
    const input = await chooseFilter();
    fireEvent.change(input, { target: { value: "исс/ пуб" } });
    fireEvent.keyDown(input, { code: "KeyA", key: "ф", altKey: true });
    await screen.findByRole("option", { name: /публикации архив/ });
    expect(screen.getByRole("button", { name: "Включать архивные" }).getAttribute("aria-pressed")).toBe("true");
    expect(input.getAttribute("value")).toBe("исс/ пуб");
    expect(list.mock.calls.some(([args]) => args?.archived && args?.offset === 1)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Включать архивные" }));
    expect(screen.queryByRole("option", { name: /публикации архив/ })).toBeNull();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => requestQuickThreadSearch());
    await screen.findByRole("combobox", { name: "Выбрать фильтр" });
    await chooseFilter();
    expect(screen.getByRole("button", { name: "Включать архивные" }).getAttribute("aria-pressed")).toBe("false");
  });
  it("opens the first result with Enter, applies the filter, expands and focuses the sidebar row", async () => {
    const { view } = await mount();
    const input = await chooseFilter();
    fireEvent.change(input, { target: { value: "исс/ пуб" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "current" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-sidebar-thread-id")).toBe("current"));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("app-only");
  });
  it("ignores a late archive response after the toggle is disabled", async () => {
    let resolveArchive!: (rows: ReturnType<typeof entry>[]) => void;
    const archivePage = new Promise<ReturnType<typeof entry>[]>((resolve) => { resolveArchive = resolve; });
    const list = vi.fn(async (args: Parameters<PluginBrowserBbSdk["threads"]["list"]>[0] = {}) => {
      if (args.offset) return [];
      return args.archived ? archivePage : [current];
    });
    await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: { list } } });
    const input = await chooseFilter();
    fireEvent.keyDown(input, { code: "KeyA", altKey: true });
    await waitFor(() => expect(list.mock.calls.some(([args]) => args?.archived)).toBe(true));
    fireEvent.keyDown(input, { code: "KeyA", altKey: true });
    await act(async () => resolveArchive([archived]));
    expect(screen.queryByRole("option", { name: /публикации архив/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Включать архивные" }).getAttribute("aria-pressed")).toBe("false");
  });
  it("cancels an in-flight Enter without late navigation or filter changes", async () => {
    let resolveTarget!: (row: ReturnType<typeof makeThreadResponse>) => void;
    const pending = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => { resolveTarget = resolve; });
    const { view } = await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
      list: async ({ offset } = {}) => offset ? [] : [current], get: () => pending,
    } } });
    const input = await chooseFilter();
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Открытие треда…");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => resolveTarget(makeThreadResponse(current)));
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
  });
  it("reveals a selected hidden target without changing a hidden ancestor", async () => {
    const hiddenParent = entry({ id: "parent", visibility: "hidden" });
    const target = entry({ ...current, visibility: "hidden", parentThreadId: "parent" });
    const update = vi.fn(async () => makeThreadResponse({ ...target, visibility: "visible" }));
    const { view } = await mount({
      sidebarThreads: { status: "ready", projects: [makePluginProject({ id: "app", name: "App" })], sections: [],
        threads: [makeSidebarThread({ id: "parent", projectId: "app", isHidden: true }), makeSidebarThread({ id: "current", projectId: "app", title: current.title, parentThreadId: "parent" })] },
      sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
        list: async ({ offset } = {}) => offset ? [] : [target, hiddenParent],
        get: async ({ threadId }) => makeThreadResponse(threadId === "parent" ? hiddenParent : target), update,
      } },
    });
    const input = await chooseFilter();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-sidebar-thread-id")).toBe("current"));
    expect(update).toHaveBeenCalledExactlyOnceWith({ threadId: "current", visibility: "visible" });
    expect(document.querySelector('a[data-sidebar-thread-id="parent"]')).toBeNull();
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "current" });
  });
  it("expands the visible child's section rather than its hidden parent's section", async () => {
    const parent = entry({ id: "parent", visibility: "hidden", sectionId: "s1", updatedAt: 1 });
    const target = { ...current, parentThreadId: "parent", sectionId: "s2" };
    await mount({
      sidebarThreads: { status: "ready", projects: [makePluginProject({ id: "app", name: "App" })],
        sections: [{ id: "s1", name: "First", createdAt: 1, updatedAt: 1 }, { id: "s2", name: "Second", createdAt: 1, updatedAt: 1 }],
        threads: [makeSidebarThread({ id: "parent", projectId: "app", isHidden: true, sectionId: "s1" }), makeSidebarThread({ id: "current", projectId: "app", title: current.title, parentThreadId: "parent", sectionId: "s2" })] },
      rpc: {
        listPreferences: () => ({ preferences: { ...defaultPreferences(), organizationMode: "chronological", collapsedThreadSections: ["chronological::s1", "chronological::s2"], hiddenGroups: ["section:s2"] } }),
        setPreference: (input: unknown) => input,
        listFilters: () => ({ status: "success", document: { ...defaultFilterDocument(), revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
          filters: [{ id: "app-only", name: "Рабочие", rule: { kind: "projectIds", projectIds: ["app"] } }] } }),
      },
      sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
        list: async ({ offset } = {}) => offset ? [] : [target, parent],
        get: async ({ threadId }) => makeThreadResponse(threadId === "parent" ? parent : target),
      } },
    });
    const input = await chooseFilter();
    fireEvent.change(input, { target: { value: "исс/ пуб" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-sidebar-thread-id")).toBe("current"));
    expect(document.querySelector('a[data-sidebar-thread-id="parent"]')).toBeNull();
  });
  it("loads hidden archived ancestry from later sidebar pages before positioning an active child", async () => {
    const parent = entry({ id: "parent", projectId: "app", archivedAt: 1, visibility: "hidden" });
    const target = { ...current, projectId: "other", parentThreadId: "parent" };
    const childRow = makeSidebarThread({ id: "current", projectId: "other", title: current.title, parentThreadId: "parent" });
    const parentRow = makeSidebarThread({ id: "parent", projectId: "app", archivedAt: 1, isArchived: true, isHidden: true });
    let refresh = () => {};
    const fetchNextPage = vi.fn(async () => {
      state = { ...state, threads: [childRow, parentRow], experimental_archived: { ...archive, hasNextPage: false } };
      refresh();
    });
    const archive = { status: "ready" as const, hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage };
    let state: PluginSidebarThreadsState = { status: "ready", projects: [makePluginProject({ id: "app", name: "App" }), makePluginProject({ id: "other", name: "Other" })],
      sections: [], threads: [childRow], experimental_archived: archive };
    type SidebarHook = typeof import("@get-bb/plugin-sdk/app").experimental_useSidebarThreads;
    const runtime: { experimental_useSidebarThreads: SidebarHook } = Reflect.get(Reflect.get(globalThis, "__bbPluginRuntime"), "pluginSdkApp");
    const originalHook = runtime.experimental_useSidebarThreads;
    runtime.experimental_useSidebarThreads = (...args) => { originalHook(...args); return state; };
    restoreSidebarHook = () => { runtime.experimental_useSidebarThreads = originalHook; };
    const list = vi.fn(async ({ archived, offset }: Parameters<PluginBrowserBbSdk["threads"]["list"]>[0] = {}) => offset ? [] : archived ? [parent] : [target]);
    const { refreshSidebar } = await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project, { ...project, id: "other", name: "Other" }] }, threads: {
      list, get: async ({ threadId }) => makeThreadResponse(threadId === "parent" ? parent : target),
    } } });
    refresh = refreshSidebar;
    const input = await chooseFilter();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-sidebar-thread-id")).toBe("current"));
    expect(fetchNextPage).toHaveBeenCalledOnce();
    expect(list.mock.calls.every(([args]) => !args?.archived)).toBe(true);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("app-only");
    expect(document.querySelector('a[data-sidebar-thread-id="parent"]')).toBeNull();
  });
  it("refreshes complete metadata on relevant realtime changes, not every streaming delta", async () => {
    let change: (changes: "thread-created"[] | "events-appended"[]) => void = () => {};
    let rows = [current];
    const list = vi.fn(async ({ offset }: Parameters<PluginBrowserBbSdk["threads"]["list"]>[0] = {}) => offset ? [] : rows);
    const subscribe = (args: Parameters<PluginBrowserBbSdk["subscribe"]>[0]) => {
      if (args.event === "thread:changed") change = (changes) => args.callback({ entity: "thread", type: "changed", changes });
      return () => {};
    };
    await mount({ sdk: { subscribe, projects: { list: async () => [project] }, threads: { list } } });
    await chooseFilter();
    const calls = list.mock.calls.length;
    act(() => change(["events-appended"]));
    expect(list.mock.calls).toHaveLength(calls);
    rows = [current, entry({ id: "added", title: "Новый результат" })];
    act(() => change(["thread-created"]));
    await screen.findByRole("option", { name: /Новый результат/ });
    expect(list.mock.calls.length).toBeGreaterThan(calls);
  });
  it("preserves the actual selected id across archive insertion, removal and re-addition", async () => {
    const newer = { ...archived, updatedAt: 100 };
    await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
      list: async ({ archived, offset } = {}) => offset ? [] : archived ? [newer] : [current],
    } } });
    const input = await chooseFilter();
    expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe(current.title);
    fireEvent.keyDown(input, { code: "KeyA", altKey: true });
    await screen.findByRole("option", { name: /публикации архив/ });
    expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe(current.title);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe(newer.title);
    fireEvent.keyDown(input, { code: "KeyA", altKey: true });
    expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe(current.title);
    fireEvent.keyDown(input, { code: "KeyA", altKey: true });
    await screen.findByRole("option", { name: /публикации архив/ });
    expect(screen.getByRole("option", { selected: true }).getAttribute("title")).toBe(current.title);
  });
  it("cancels Enter synchronously while the closing animation retains its children", async () => {
    const finish = closingAnimation();
    let resolveTarget!: (row: ReturnType<typeof makeThreadResponse>) => void;
    const pending = new Promise<ReturnType<typeof makeThreadResponse>>((resolve) => { resolveTarget = resolve; });
    const { view } = await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: {
      list: async ({ offset } = {}) => offset ? [] : [current], get: () => pending,
    } } });
    const input = await chooseFilter(); const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Открытие треда…");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog.getAttribute("data-state")).toBe("closed");
    await act(async () => resolveTarget(makeThreadResponse(current)));
    expect(dialog.isConnected).toBe(true);
    finish(dialog);
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
  });
  it("invalidates accepted preparation when filters refresh during the closing animation", async () => {
    const finish = closingAnimation();
    const { view } = await mount();
    const input = await chooseFilter(); const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dialog.getAttribute("data-state")).toBe("closed"));
    act(() => windowFilterStore.invalidate());
    await act(async () => {});
    finish(dialog);
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(view.inspection.navigateCalls).toEqual([]);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
  });
  it("rejects another provider before writes even when a generic sidebar trigger is present", async () => {
    const { view } = await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] },
      system: { uiPreferences: { list: async () => uiPreferences("other/list") } },
      threads: { list: async ({ offset } = {}) => offset ? [] : [current] },
    } }, false);
    const trigger = document.createElement("button"); trigger.dataset.sidebar = "trigger"; trigger.setAttribute("aria-expanded", "false");
    const click = vi.fn(); trigger.onclick = click; document.body.append(trigger);
    const input = await chooseFilter(); fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Project-first sidebar");
    expect(click).not.toHaveBeenCalled(); expect(view.inspection.navigateCalls).toEqual([]);
    expect(view.inspection.rpcCalls.filter((call) => call.method === "setPreference")).toEqual([]);
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    trigger.remove();
  });
  it("opens a closed drawer only after an explicit Project-first provider selection is verified", async () => {
    const { view, showSidebar } = await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] },
      system: { uiPreferences: { list: async () => uiPreferences("project-first-sidebar/project-first-sidebar") } },
      threads: { list: async ({ offset } = {}) => offset ? [] : [current], get: async () => makeThreadResponse(current) },
    } }, false);
    const trigger = document.createElement("button"); trigger.dataset.sidebar = "trigger"; trigger.setAttribute("aria-expanded", "false");
    trigger.onclick = () => { trigger.setAttribute("aria-expanded", "true"); showSidebar(); }; document.body.append(trigger);
    const input = await chooseFilter(); fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-sidebar-thread-id")).toBe("current"));
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "current" });
    trigger.remove();
  });
  it("returns to filter choice with Backspace and keeps keyboard input focus", async () => {
    await mount(); const input = await chooseFilter();
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.getByRole("combobox", { name: "Выбрать фильтр" })).toBe(document.activeElement);
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: "Рабочие" })).toBeTruthy();
  });
  it("keeps the result list windowed and keyboard selection mounted", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => entry({ id: `thread-${i}`, title: `Thread ${i}`, updatedAt: 1000 - i }));
    await mount({ sdk: { subscribe: () => () => {}, projects: { list: async () => [project] }, threads: { list: async ({ offset } = {}) => many.slice(offset, (offset ?? 0) + 200) } } });
    const input = await chooseFilter();
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(11);
    for (let i = 0; i < 20; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    const id = input.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(id)?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(input);
  });
});
