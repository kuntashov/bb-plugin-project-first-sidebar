// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReducer, useState } from "react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { toast } from "sonner";
import type { PluginSidebarThread, PluginSidebarThreadsState, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";
import { defaultFilterDocument, FILTERS_CHANGED_CHANNEL, filterDocumentSchema, type FilterDocumentV1 } from "../../shared/filters.js";
import { defaultPreferences, PREFERENCES_CHANGED_CHANNEL, type PreferenceValues } from "../../shared/preferences.js";
import { EXECUTION_CHANGED_CHANNEL } from "../../shared/execution-projection.js";
import { createWindowFilterStore, windowFilterStore } from "../filters/filter-store.js";
import { UNREAD_FILTER_ID, WAITING_FOR_ACTION_FILTER_ID } from "../filters/dynamic-filter-ids.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { flushPreferenceWritesForTest, resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "../preferences/preferences-sync.js";
import { requestThreadReveal } from "../reveal/ThreadReveal.js";
import { requestQuickThreadSearch } from "../search/QuickThreadSearch.js";

const app = await loadPluginApp(() => import("../../app.js"));
const ThreadList = app.threadLists[0]!.component;
const RevealOverlay = app.appOverlays.find(({ id }) => id === "thread-reveal")!.component;
const QuickSearchOverlay = app.appOverlays.find(({ id }) => id === "quick-thread-search")!.component;
const VisibilitySettings = app.settingsSections.find(({ id }) => id === "built-in-filter-visibility")!.component;
const projects = [
  makePluginProject({ id: "app", name: "App" }),
  makePluginProject({ id: "web", name: "Web" }),
  makePluginProject({ id: "personal", isPersonal: true }),
];
const active = makeSidebarThread({ id: "active", projectId: "app", title: "Active match", isUnread: true, hasPendingInteraction: true });
const archived = makeSidebarThread({ id: "archived", projectId: "app", title: "Archived match", archivedAt: 1, isUnread: true, hasPendingInteraction: true });
const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;

type SdkApp = typeof import("@get-bb/plugin-sdk/app");
type SidebarLifecycle = "active" | "archived";
const sdkRuntime: Pick<SdkApp, "experimental_useSidebarThreads" | "useBbContext"> = Reflect.get(
  Reflect.get(globalThis, "__bbPluginRuntime"), "pluginSdkApp",
);

beforeEach(() => {
  windowFilterStore.setActiveFilterId("all");
  windowFilterStore.setBuiltInVisibilityReady(false);
  setPreferencesMirrorStorageForTest(null);
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

function radio(name: string) {
  return screen.getByRole("radio", { name });
}
function row(threadId = active.id) {
  return document.querySelector<HTMLAnchorElement>(`a[data-sidebar-thread-id="${threadId}"]`);
}
function title(threadId = active.id) {
  return row(threadId)?.closest("[data-sidebar-rename-row]")?.querySelector(".bb-thread-title");
}

function mockWindowing(mountOnScroll: boolean) {
  const viewport = new DOMRect(0, 0, 300, 500);
  const offscreen = new DOMRect(0, 1_000, 300, 30);
  const observerByTarget = new Map<Element, IntersectionObserverCallback>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) { observerByTarget.set(target, this.callback); }
    unobserve(target: Element) { observerByTarget.delete(target); }
    disconnect() {
      for (const [target, callback] of observerByTarget) {
        if (callback === this.callback) observerByTarget.delete(target);
      }
    }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.closest("[data-sidebar-dynamic-filter]") ? offscreen : viewport;
  });
  scrollIntoView.mockImplementation(function (this: HTMLElement) {
    if (!mountOnScroll || !this.hasAttribute("data-sidebar-windowed-nav")) return;
    const entry: IntersectionObserverEntry = {
      target: this,
      isIntersecting: true,
      boundingClientRect: offscreen,
      intersectionRatio: 1,
      intersectionRect: offscreen,
      rootBounds: viewport,
      time: 0,
    };
    const observer = observerByTarget.get(this);
    if (observer) observer([entry], {} as IntersectionObserver);
  });
}

interface MountOptions {
  preferences?: Partial<PreferenceValues>;
  filterDocument?: Partial<FilterDocumentV1>;
  listFiltersError?: boolean;
  threads?: readonly PluginSidebarThread[];
  activeStatus?: PluginSidebarThreadsState["status"];
  windowed?: boolean;
  quickSearch?: boolean;
  settings?: boolean;
  pendingPreferences?: Promise<void>;
  threadActions?: RenderSlotOptions["threadActions"];
  sdk?: RenderSlotOptions["sdk"];
}

async function mount({
  preferences,
  filterDocument,
  listFiltersError = false,
  threads = [active, archived],
  activeStatus = "ready",
  windowed = false,
  quickSearch = false,
  settings = false,
  pendingPreferences,
  threadActions,
  sdk,
}: MountOptions = {}) {
  const lifecycles: readonly SidebarLifecycle[] = ["active"];
  const fetchNextPage = vi.fn(async () => {});
  const subscriptions = new Set<string>();
  const archive = { status: "ready" as const, hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage };
  const sidebarHook = sdkRuntime.experimental_useSidebarThreads;
  let snapshots: ReadonlyMap<string, PluginSidebarThreadsState>;
  const setSnapshots = () => {
    const activeThreads = threads.filter((thread) => !thread.isArchived);
    const archivedThreads = threads.filter((thread) => thread.isArchived);
    snapshots = new Map<string, PluginSidebarThreadsState>([
      ["active", { status: activeStatus, projects, threads: activeThreads, sections: [], experimental_archived: null }],
      ["archived", { status: "ready", projects, threads: archivedThreads, sections: [], experimental_archived: archive }],
      ["active,archived", { status: "ready", projects, threads, sections: [], experimental_archived: archive }],
    ]);
  };
  setSnapshots();
  // The SDK test runtime does not apply lifecycle arguments or drive live sidebar changes.
  vi.spyOn(sdkRuntime, "experimental_useSidebarThreads").mockImplementation((options) => {
    sidebarHook(options);
    const key = [...(options?.experimental_lifecycles ?? lifecycles)].sort().join(",");
    subscriptions.add(key);
    return snapshots.get(key)!;
  });
  let refresh = () => {};
  let setSidebarVisible = (_visible: boolean) => {};
  let openThread: PluginSidebarThread | undefined;
  const navigateFromLink = vi.fn();
  const sidebarHostStore = createStore();
  const overlayHostStore = createStore();
  const settingsHostStore = createStore();
  const bbContext = sdkRuntime.useBbContext;
  vi.spyOn(sdkRuntime, "useBbContext").mockImplementation(() => ({
    ...bbContext(),
    threadId: openThread?.id ?? null,
    projectId: openThread?.projectId ?? null,
  }));
  function Component() {
    const [, rerender] = useReducer((count) => count + 1, 0);
    const [sidebarVisible, setVisible] = useState(true);
    refresh = rerender;
    setSidebarVisible = setVisible;
    const props: PluginThreadListProps = {
      activeProjectId: openThread?.projectId ?? null,
      activeThreadId: openThread?.id ?? null,
      isCompactViewport: false,
      searchQuery: "",
      onNavigate: () => {},
    };
    return (
      <>
        <JotaiProvider store={overlayHostStore}>
          <RevealOverlay />
          {quickSearch && <QuickSearchOverlay />}
        </JotaiProvider>
        <div data-sidebar={windowed ? "content" : undefined} ref={(element) => {
          if (windowed && element) Object.defineProperty(element, "clientHeight", { configurable: true, value: 500 });
        }} onClick={(event) => {
          if (!(event.target instanceof Element)) return;
          const link = event.target.closest<HTMLAnchorElement>("a[data-sidebar-thread-id]");
          const target = threads.find((thread) => thread.href === link?.getAttribute("href"));
          if (!target || event.defaultPrevented) return;
          event.preventDefault();
          navigateFromLink(target.href);
          openThread = target;
          rerender();
        }}>
          {sidebarVisible && <JotaiProvider store={sidebarHostStore}><ThreadList {...props} /></JotaiProvider>}
        </div>
        {settings && <JotaiProvider store={settingsHostStore}><VisibilitySettings /></JotaiProvider>}
        <button type="button">{openThread?.displayTitle ?? "Chat"}</button>
      </>
    );
  }
  let document = {
    ...defaultFilterDocument(),
    ...filterDocument,
    revision: (windowFilterStore.getSnapshot().document?.revision ?? 0) + 1,
  };
  let reasoningLevel = "high";
  const view = renderSlot({ component: Component }, {}, {
    pluginId: "project-first-sidebar",
    rpc: {
      listFilters: () => {
        if (listFiltersError) throw new Error("listFilters unavailable");
        return { status: "success", document };
      },
      listPreferences: async () => {
        await pendingPreferences;
        return { preferences: { ...defaultPreferences(), ...preferences } };
      },
      setPreference: (input: unknown) => input,
      getExecutionIndexStatus: () => ({ state: "done", total: 1, done: 1, errors: 0 }),
      getExecutionProjections: (input: unknown) => ({
        projections: (input as { threadIds: string[] }).threadIds.map((threadId) => ({
          threadId, state: "ready", reasoningLevel, serviceTier: "fast",
        })),
      }),
    },
    threadActions,
    sdk: quickSearch ? {
      subscribe: () => () => {},
      threads: { list: async () => [] },
      projects: { list: async () => [] },
      ...sdk,
    } : sdk,
  });
  await waitFor(() => {
    const snapshot = windowFilterStore.getSnapshot();
    expect(snapshot.status).toBe(listFiltersError ? "error" : "ready");
    if (!listFiltersError) expect(snapshot.document?.revision).toBe(document.revision);
    if (!pendingPreferences) expect(snapshot.builtInVisibilityReady).toBe(true);
  });
  return {
    view,
    subscriptions,
    navigateFromLink,
    fetchNextPage,
    setSidebarVisible: (visible: boolean) => act(() => setSidebarVisible(visible)),
    setActiveSnapshot: (nextThreads: readonly PluginSidebarThread[], status = activeStatus) => act(() => {
      threads = nextThreads;
      activeStatus = status;
      setSnapshots();
      refresh();
    }),
    setReasoningLevel: (level: string) => { reasoningLevel = level; },
    refreshFilters: async (next: Partial<FilterDocumentV1>, fail = false) => {
      listFiltersError = fail;
      document = { ...document, ...next, revision: document.revision + 1 };
      await view.behavior.emitRealtime(FILTERS_CHANGED_CHANNEL, { revision: document.revision });
      await waitFor(() => {
        const snapshot = windowFilterStore.getSnapshot();
        expect(snapshot.status).toBe(fail ? "error" : "ready");
        if (!fail) expect(snapshot.document?.revision).toBe(document.revision);
      });
    },
    getExecutionRequests: () => view.inspection.rpcCalls.filter((call) => call.method === "getExecutionProjections"),
    getPreferenceWrites: () => view.inspection.rpcCalls.filter((call) => call.method === "setPreference"),
  };
}

describe("dynamic sidebar filters", () => {
  it.each(["Все непрочитанные", "Ждут действия"])("requests active highlights in Only archived and still runs row actions in %s", async (name) => {
    const markRead = vi.fn();
    const restore = vi.fn();
    const harness = await mount({
      preferences: { threadLifecycles: ["archived"], showExecutionHighlighting: true, rowActions: ["bb--core/read"] },
      threadActions: (thread) => [
        {
          key: "bb--core/read",
          pluginId: "bb--core",
          group: "lifecycle",
          action: { label: "Mark read", icon: "Check", run: async () => { markRead(thread.id); } },
        },
        {
          key: "bb--core/archive",
          pluginId: "bb--core",
          group: "lifecycle",
          action: { label: "Restore from archive", icon: "Archive", run: async () => { restore(thread.id); } },
        },
      ],
    });
    expect(row(archived.id)).not.toBeNull();
    expect(row(active.id)).toBeNull();
    fireEvent.click(radio(name));
    await waitFor(() => expect(title()?.classList.contains("text-red-700")).toBe(true));
    expect(row(archived.id)).toBeNull();
    expect(harness.subscriptions.has("active")).toBe(true);
    const count = harness.getExecutionRequests().length;
    expect(harness.getExecutionRequests().at(-1)?.input).toEqual({ threadIds: [active.id] });
    harness.setReasoningLevel("low");
    await harness.view.behavior.emitRealtime(EXECUTION_CHANGED_CHANNEL, { threadId: active.id });
    await waitFor(() => expect(title()?.classList.contains("text-purple-700")).toBe(true));
    expect(harness.getExecutionRequests().slice(count).map((request) => request.input)).toEqual([
      { threadIds: [active.id] },
    ]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark read" })); });
    expect(markRead).toHaveBeenCalledExactlyOnceWith(active.id);
    fireEvent.click(radio("Все"));
    expect(row(archived.id)).not.toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restore from archive" })); });
    expect(restore).toHaveBeenCalledExactlyOnceWith(archived.id);
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
    expect(harness.fetchNextPage).not.toHaveBeenCalled();
  });

  it("waits for a ready snapshot and reveals inside a dynamic filter with a failed filter document", async () => {
    mockWindowing(true);
    const harness = await mount({ windowed: true, activeStatus: "loading", listFiltersError: true, preferences: { threadLifecycles: ["archived"] } });
    fireEvent.click(radio("Все непрочитанные"));
    expect(screen.getByRole("status", { name: "Загрузка тредов" })).toBeTruthy();
    await act(async () => requestThreadReveal(active.id));
    expect(scrollIntoView).not.toHaveBeenCalled();
    harness.setActiveSnapshot([active, archived], "ready");
    const placeholder = document.querySelector(`[data-sidebar-windowed-nav="${active.id}:${active.projectId}"]`);
    expect(placeholder).not.toBeNull();
    expect(row()).toBeNull();
    await waitFor(() => {
      expect(row()).not.toBeNull();
      expect(document.activeElement).toBe(row());
    });
    expect(scrollIntoView.mock.contexts[0]).toBe(placeholder);
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(row());
    expect(row()?.hasAttribute("data-project-first-reveal-highlight")).toBe(true);
    expect(radio("Все непрочитанные").getAttribute("aria-checked")).toBe("true");
    expect(harness.view.inspection.sdkCalls).toEqual([]);
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
  });

  it("falls back to All after the target stops matching while the placeholder is waiting to mount", async () => {
    mockWindowing(false);
    const harness = await mount({ windowed: true, threads: [active] });
    fireEvent.click(radio("Ждут действия"));
    const placeholder = document.querySelector(`[data-sidebar-windowed-nav="${active.id}:${active.projectId}"]`);
    expect(placeholder).not.toBeNull();
    await act(async () => requestThreadReveal(active.id));
    await waitFor(() => expect(scrollIntoView.mock.contexts).toContain(placeholder));
    expect(row()).toBeNull();
    harness.setActiveSnapshot([{ ...active, hasPendingInteraction: false }]);
    await waitFor(() => {
      expect(radio("Все").getAttribute("aria-checked")).toBe("true");
      expect(row()).not.toBeNull();
      expect(document.activeElement).toBe(row());
    });
    expect(row()?.hasAttribute("data-project-first-reveal-highlight")).toBe(true);
    expect(harness.view.inspection.sdkCalls).toEqual([]);
  });

  it("reports an active snapshot error separately from an empty result and keeps the selected filter", async () => {
    const onError = vi.spyOn(toast, "error");
    const harness = await mount({ activeStatus: "error", preferences: { threadLifecycles: ["archived"] } });
    fireEvent.click(radio("Ждут действия"));
    expect(screen.getByRole("alert").textContent).toBe("Не удалось загрузить активные треды");
    expect(screen.queryByText("Нет тредов, ожидающих действия")).toBeNull();
    await act(async () => requestThreadReveal(active.id));
    expect(onError).toHaveBeenCalledExactlyOnceWith("Не удалось загрузить активные треды.");
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    expect(harness.view.inspection.sdkCalls).toEqual([]);
  });

  it("waits for normal visibility consent before leaving a dynamic filter", async () => {
    const harness = await mount({
      preferences: { hiddenGroups: ["project:app"] },
      threads: [{ ...active, isUnread: false }],
    });
    fireEvent.click(radio("Все непрочитанные"));
    await act(async () => requestThreadReveal(active.id));
    expect((await screen.findByRole("dialog")).textContent).toContain("Группа скрыта");
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
    expect(harness.view.inspection.sdkCalls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(radio("Все непрочитанные").getAttribute("aria-checked")).toBe("true");
    await act(async () => requestThreadReveal(active.id));
    fireEvent.click(await screen.findByRole("button", { name: "Показать в дереве" }));
    await waitFor(() => expect(document.activeElement).toBe(row()));
    expect(radio("Все").getAttribute("aria-checked")).toBe("true");
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toContainEqual({ method: "setPreference", input: { key: "hiddenGroups", value: [] } });
  });

  it("reports a positioning timeout while the target still matches", async () => {
    mockWindowing(false);
    const onError = vi.spyOn(toast, "error");
    const harness = await mount({ windowed: true, threads: [active] });
    fireEvent.click(radio("Все непрочитанные"));
    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    await act(async () => requestThreadReveal(active.id));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    vi.useRealTimers();
    expect(onError).toHaveBeenCalledExactlyOnceWith("Не удалось найти элемент в текущем дереве.");
    expect(radio("Все непрочитанные").getAttribute("aria-checked")).toBe("true");
    expect(row()).toBeNull();
    expect(harness.view.inspection.sdkCalls).toEqual([]);
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
  });

  it("cancels pending reveal on a newer filter selection even when the user comes back", async () => {
    mockWindowing(false);
    const onError = vi.spyOn(toast, "error");
    const harness = await mount({ windowed: true, threads: [active] });
    fireEvent.click(radio("Ждут действия"));
    await act(async () => requestThreadReveal(active.id));
    expect(scrollIntoView).toHaveBeenCalled();
    fireEvent.click(radio("Без проектов"));
    fireEvent.click(radio("Ждут действия"));
    harness.setActiveSnapshot([{ ...active, hasPendingInteraction: false }]);
    expect(screen.getByText("Нет тредов, ожидающих действия")).toBeTruthy();
    await flushPreferenceWritesForTest();
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    expect(onError).not.toHaveBeenCalled();
    expect(harness.getPreferenceWrites()).toEqual([]);
  });

  it("updates unread membership, keeps the thread open and consumes automatic reveal navigation and unread events", async () => {
    const parent = makeSidebarThread({ id: "parent", projectId: "app", isUnread: false });
    const child = { ...active, parentThreadId: parent.id };
    const another = makeSidebarThread({ id: "another", projectId: "app", title: "Another", isUnread: false });
    const harness = await mount({
      preferences: { collapsedProjects: ["app"], collapsedThreads: [parent.id] },
      threads: [parent, child, another],
    });
    fireEvent.click(radio("Все непрочитанные"));
    expect(row()).not.toBeNull();
    expect(row(parent.id)).toBeNull();
    fireEvent.click(row()!);
    expect(harness.navigateFromLink).toHaveBeenCalledExactlyOnceWith(child.href);
    const chat = screen.getByRole("button", { name: active.displayTitle });
    chat.focus();
    harness.setActiveSnapshot([parent, { ...child, isUnread: false }, { ...another, isUnread: true }]);
    expect(row()).toBeNull();
    expect(row(another.id)).not.toBeNull();
    expect(document.activeElement).toBe(chat);
    expect(screen.getByRole("button", { name: active.displayTitle })).toBe(chat);
    fireEvent.click(radio("Все"));
    expect(row(another.id)).toBeNull();
    expect(row()).toBeNull();
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
  });

  it.each(["filter", "always-show"] as const)("shows a read pending pin once and ignores an ordinary read pin with %s", async (pinnedMode) => {
    const pending = { ...active, projectId: "web", isUnread: false, isPinned: true, pinnedAt: 1 };
    const read = makeSidebarThread({ id: "read-pin", projectId: "web", isUnread: false, pinnedAt: 1 });
    const harness = await mount({
      preferences: { hiddenGroups: ["project:web"], collapsedProjects: ["web"] },
      filterDocument: { pinnedMode },
      threads: [pending, read],
    });
    fireEvent.click(radio("Все непрочитанные"));
    expect(screen.getByText("Нет непрочитанных тредов")).toBeTruthy();
    expect(row(read.id)).toBeNull();
    fireEvent.click(radio("Ждут действия"));
    expect(screen.getByRole("heading", { name: "Web" })).toBeTruthy();
    expect(document.querySelectorAll(`a[data-sidebar-thread-id="${active.id}"]`)).toHaveLength(1);
    expect(row(read.id)).toBeNull();
    harness.setActiveSnapshot([{ ...pending, hasPendingInteraction: false }, read]);
    expect(screen.getByText("Нет тредов, ожидающих действия")).toBeTruthy();
    expect(row()).toBeNull();
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
    expect(harness.view.inspection.sdkCalls).toEqual([]);
  });

  it.each(["project", "machine", "chronological"] as const)("renders the same flat effective projects in %s mode", async (organizationMode) => {
    const parent = makeSidebarThread({ id: "hidden-parent", projectId: "app", isHidden: true, isUnread: true });
    const child = { ...active, projectId: "web", parentThreadId: parent.id };
    const web = makeSidebarThread({ id: "web", projectId: "web", isUnread: true });
    const mine = makeSidebarThread({ id: "mine", projectId: "personal", isUnread: true });
    const harness = await mount({
      threads: [parent, child, web, mine, archived],
      preferences: { organizationMode, hiddenGroups: ["project:web"], collapsedProjects: ["app"] },
    });
    fireEvent.click(radio("Все непрочитанные"));
    const list = document.querySelector("[data-sidebar-dynamic-filter]")!;
    expect(Array.from(list.querySelectorAll("h2, a[data-sidebar-thread-id]"), (item) =>
      item.getAttribute("data-sidebar-thread-id") ?? item.textContent,
    )).toEqual(["App", child.id, "Web", web.id, "Без проектов", mine.id]);
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites()).toEqual([]);
  });

  it.each(["text", "icon", "icon-text"] as const)("distinguishes an unchanged V1 filter with the same name and key in %s mode", async (displayMode) => {
    const custom = { id: "unread", name: "Все непрочитанные", rule: { kind: "projectIds" as const, projectIds: ["web"] } };
    const unrelated = makeSidebarThread({ id: "unrelated", projectId: "web", isUnread: false });
    const savedFilterDocument = filterDocumentSchema.parse({ ...defaultFilterDocument(), filters: [custom], displayMode });
    const harness = await mount({ filterDocument: savedFilterDocument, threads: [active, unrelated] });
    const names = ["Все", "Без проектов", "Все непрочитанные", "Ждут действия", "Все непрочитанные (пользовательский фильтр)"];
    expect(screen.getAllByRole("radio").map((button) => button.getAttribute("aria-label"))).toEqual(names);
    const unread = radio(names[2]!);
    const pending = radio(names[3]!);
    const customButton = radio(names[4]!);
    expect(unread.querySelector('[data-icon="Mail"]') !== null).toBe(displayMode !== "text");
    expect(pending.querySelector('[data-icon="MessageQuestion"]') !== null).toBe(displayMode !== "text");
    expect(customButton.textContent).toBe(displayMode === "icon" ? "" : names[4]);
    radio("Без проектов").focus();
    fireEvent.keyDown(radio("Без проектов"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(unread);
    expect(unread.tabIndex).toBe(0);
    expect(row()).not.toBeNull();
    fireEvent.keyDown(unread, { key: "End" });
    expect(document.activeElement).toBe(customButton);
    expect(row()).toBeNull();
    expect(windowFilterStore.getSnapshot().document?.filters[0]).toEqual(custom);
    fireEvent.keyDown(customButton, { key: "Home" });
    expect(document.activeElement).toBe(radio("Все"));
    fireEvent.click(pending);
    harness.setSidebarVisible(false);
    harness.setSidebarVisible(true);
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    expect(createWindowFilterStore().getSnapshot().activeFilterId).toBe("all");
  });

  it("handles remote visibility of all three built-ins while retaining the personal group", async () => {
    const mine = makeSidebarThread({ id: "personal", projectId: "personal", isUnread: true, hasPendingInteraction: true });
    const harness = await mount({ threads: [mine] });
    const buttons = [
      ["Без проектов", "showProjectlessFilter"],
      ["Все непрочитанные", "showUnreadFilter"],
      ["Ждут действия", "showWaitingForActionFilter"],
    ] as const;
    for (const [name, key] of buttons) {
      const button = radio(name);
      fireEvent.click(button);
      button.focus();
      await harness.view.behavior.emitRealtime(PREFERENCES_CHANGED_CHANNEL, { key, value: false });
      expect(screen.queryByRole("radio", { name })).toBeNull();
      expect(radio("Все").getAttribute("aria-checked")).toBe("true");
      expect(document.activeElement).toBe(radio("Все"));
      if (key !== "showProjectlessFilter") {
        await harness.view.behavior.emitRealtime(PREFERENCES_CHANGED_CHANNEL, { key, value: true });
        expect(radio(name).getAttribute("aria-checked")).toBe("false");
      }
    }
    fireEvent.click(radio("Ждут действия"));
    expect(screen.getByRole("heading", { name: "Без проектов" })).toBeTruthy();
    expect(row(mine.id)).not.toBeNull();
    await harness.view.behavior.emitRealtime(PREFERENCES_CHANGED_CHANNEL, { key: "showProjectlessFilter", value: true });
    expect(radio("Без проектов")).toBeTruthy();
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the built-ins gated until saved visibility is applied, then shares settings across slot stores", async () => {
    let finishPreferences!: () => void;
    const pendingPreferences = new Promise<void>((resolve) => { finishPreferences = resolve; });
    const harness = await mount({
      pendingPreferences,
      settings: true,
      preferences: { showProjectlessFilter: false, showUnreadFilter: false, showWaitingForActionFilter: false },
    });
    const labels = ["Без проектов", "Все непрочитанные", "Ждут действия"];
    expect(screen.getAllByRole("radio").map((button) => button.textContent)).toEqual(["Все"]);
    act(() => windowFilterStore.setActiveFilterId(UNREAD_FILTER_ID));
    expect(windowFilterStore.getSnapshot().activeFilterId).toBe("all");
    const availableDuringLoad: boolean[][] = [];
    const stop = windowFilterStore.subscribe(() => {
      availableDuringLoad.push((["projectless", UNREAD_FILTER_ID, WAITING_FOR_ACTION_FILTER_ID] as const).map((id) =>
        windowFilterStore.isFilterAvailable(id),
      ));
    });
    try {
      await act(async () => finishPreferences());
      await waitFor(() => expect(windowFilterStore.getSnapshot().builtInVisibilityReady).toBe(true));
    } finally {
      stop();
    }
    expect(availableDuringLoad.length).toBeGreaterThan(0);
    expect(availableDuringLoad.every((values) => values.every((visible) => !visible))).toBe(true);
    for (const name of labels) expect(screen.queryByRole("radio", { name })).toBeNull();

    const controls = [
      ["Без проектов", "showProjectlessFilter"],
      ["Непрочитанные", "showUnreadFilter"],
      ["Ждут действия", "showWaitingForActionFilter"],
    ] as const;
    for (const [index, [label]] of controls.entries()) {
      const checkbox = screen.getByRole<HTMLInputElement>("checkbox", { name: `Показывать фильтр «${label}»` });
      expect(checkbox.checked).toBe(false);
      expect(checkbox.disabled).toBe(false);
      fireEvent.click(checkbox);
      expect(radio(labels[index]!).getAttribute("aria-checked")).toBe("false");
    }
    await flushPreferenceWritesForTest();
    expect(harness.getPreferenceWrites().map(({ input }) => input)).toEqual(
      controls.map(([, key]) => ({ key, value: true })),
    );
  });

  it("preserves dynamic selection across document updates and leaves dynamic options out of quick search", async () => {
    const custom = { id: "waiting-for-action", name: "Ждут действия", rule: { kind: "projectIds" as const, projectIds: ["web"] } };
    const harness = await mount({ quickSearch: true, filterDocument: { filters: [custom] } });
    fireEvent.click(radio("Ждут действия"));
    await harness.refreshFilters({ displayMode: "icon" });
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    await act(async () => requestQuickThreadSearch());
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "Все", "Без проектов", custom.name,
    ]);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await harness.refreshFilters({}, true);
    expect(radio("Ждут действия").getAttribute("aria-checked")).toBe("true");
    expect(row()).not.toBeNull();
  });
});
