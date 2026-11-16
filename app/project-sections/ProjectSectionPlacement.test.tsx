// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  PluginSidebarSplitLayout,
  PluginSidebarThreadRowStatus,
  PluginSidebarThreadsState,
  PluginThreadActionEntry,
  PluginThreadActionTarget,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { experimental_makePanelController, createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server.js";
import { PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL } from "../../shared/project-section-assignment.js";
import { PROJECT_SECTIONS_CHANGED_CHANNEL } from "../../shared/project-sections.js";
import { ALL_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { makePluginProject, makeSidebarEnvironment, makeSidebarThread } from "../model/fixtures.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "../preferences/preferences-sync.js";
import { assignProjectSectionAction } from "../rows/assignProjectSectionAction.js";
import { moveThreadAction } from "../rows/moveThreadAction.js";
import type { SidebarThread } from "../model/sidebar-thread.js";

const app = await loadPluginApp(() => import("../../app.js"));
const registration = app.threadLists[0];
if (!registration) throw new Error("thread-list slot not registered");

const PERSONAL = makePluginProject({ id: "proj_personal", name: "Personal", isPersonal: true });
const APP = makePluginProject({ id: "proj_app", name: "App" });
const WEB = makePluginProject({ id: "proj_web", name: "Web" });

type SidebarThreadsHook =
  typeof import("@get-bb/plugin-sdk/app").experimental_useSidebarThreads;
type TestPluginRuntime = typeof globalThis & {
  __bbPluginRuntime: {
    pluginSdkApp: { experimental_useSidebarThreads: SidebarThreadsHook };
  };
};
let restoreSidebarHook: (() => void) | null = null;

function installSidebarHook(read: () => PluginSidebarThreadsState) {
  const runtime = (globalThis as TestPluginRuntime).__bbPluginRuntime;
  const appSdk = runtime.pluginSdkApp;
  const original = appSdk.experimental_useSidebarThreads;
  appSdk.experimental_useSidebarThreads = () => read();
  return () => {
    appSdk.experimental_useSidebarThreads = original;
  };
}

afterEach(() => {
  restoreSidebarHook?.();
  restoreSidebarHook = null;
  latestRootChoices = [];
  cleanup();
  windowFilterStore.setActiveFilterId(ALL_FILTER_ID);
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

function metadataHost() {
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({ pluginId: "project-first-sidebar" });
  const read = async (args: { threadIds: readonly string[] }) => ({
    threads: args.threadIds.map((threadId) => ({
      threadId,
      metadata: metadata.get(threadId) ?? {},
    })),
  });
  host.harness.sdk.stub("threads.updatePluginMetadata", async (args: {
    threadId: string;
    set?: Record<string, unknown>;
    remove?: string[];
  }) => {
    const next = { ...(metadata.get(args.threadId) ?? {}) };
    for (const key of args.remove ?? []) delete next[key];
    Object.assign(next, args.set ?? {});
    metadata.set(args.threadId, next);
    return next;
  });
  host.harness.sdk.stub("threads.experimental_listPluginMetadata", read);
  host.harness.sdk.stub("threads.getPluginMetadata", async (args: { threadId: string }) => (
    metadata.get(args.threadId) ?? {}
  ));
  return { host, metadata, read };
}

async function createSection(callRpc: (method: string, input: unknown) => Promise<unknown>, projectId: string, name: string, expectedRevision: number) {
  const created = await callRpc("createProjectSection", { expectedRevision, projectId, name }) as {
    status: string;
    document: { revision: number; sections: { id: string; projectId: string; name: string }[] };
  };
  if (created.status !== "success") throw new Error(`section ${name} was not created`);
  const section = created.document.sections.find((item) => item.projectId === projectId && item.name === name);
  if (!section) throw new Error(`section ${name} is missing`);
  return { id: section.id, revision: created.document.revision };
}

function threadActions(
  thread: PluginThreadActionTarget,
  context: { requestRename: (threadId: string) => void },
): PluginThreadActionEntry[] {
  const readProject = assignProjectSectionAction.useData;
  const readMove = moveThreadAction.useData;
  if (readProject === undefined || readMove === undefined) return [];
  const projectData = readProject({ threadIds: [] });
  const moveData = readMove({ threadIds: [] });
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const args = { thread, sdk, navigate, experimental_panel: experimental_makePanelController() };
  const projectItem = assignProjectSectionAction.item({ ...args, data: projectData });
  const moveItem = moveThreadAction.item({ ...args, data: moveData });
  const rows: PluginThreadActionEntry[] = [];
  const requestRename = () => context.requestRename(thread.id);
  if (projectItem?.choices && thread.id === "thr_root") {
    latestRootChoices = projectItem.choices.items.map((choice) => ({
      id: choice.id,
      label: choice.label,
      selected: choice.selected === true,
      disabled: choice.disabled === true,
    }));
  }
  if (projectItem?.choices) {
    for (const choice of projectItem.choices.items) {
      rows.push({
        key: `project-first-sidebar/project-section/${choice.id}`,
        pluginId: "project-first-sidebar",
        group: "2_organize",
        action: {
          label: choice.label,
          icon: "SectionMove",
          disabled: choice.disabled,
          run: async () => {
            await projectItem.run({ value: choice.id, requestRename });
          },
        },
      });
    }
  }
  if (moveItem?.choices) {
    for (const choice of moveItem.choices.items) {
      rows.push({
        key: `project-first-sidebar/move/${choice.id}`,
        pluginId: "project-first-sidebar",
        group: "2_organize",
        action: {
          label: `Move: ${choice.label}`,
          icon: "SectionMove",
          disabled: choice.disabled,
          run: async () => {
            await moveItem.run({ value: choice.id, requestRename });
          },
        },
      });
    }
  }
  return rows;
}

async function mount(options: {
  threads: SidebarThread[];
  projects?: ReturnType<typeof makePluginProject>[];
  sections?: { id: string; name: string; createdAt: number; updatedAt: number }[];
  prepare?: (tools: ReturnType<typeof metadataHost>) => Promise<void>;
  holdMetadata?: boolean;
  metadataError?: boolean;
  holdDocument?: boolean;
  documentError?: boolean;
  archived?: PluginSidebarThreadsState["experimental_archived"];
  sidebarDraftThreadIds?: readonly string[];
  sidebarRowStatuses?: Record<string, PluginSidebarThreadRowStatus>;
  sidebarSplitLayout?: PluginSidebarSplitLayout;
}) {
  const tools = metadataHost();
  await plugin(tools.host.bb);
  let releaseMetadata: (() => void) | null = null;
  let releaseDocument: (() => void) | null = null;
  const documentGate = options.holdDocument
    ? new Promise<void>((resolve) => {
      releaseDocument = resolve;
    })
    : null;
  if (options.holdMetadata) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tools.host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: { threadIds: readonly string[] }) => {
      await gate;
      return tools.read(args);
    });
    releaseMetadata = release;
  }
  if (options.metadataError) {
    tools.host.harness.sdk.stub("threads.experimental_listPluginMetadata", async () => {
      throw new Error("metadata down");
    });
  }
  await options.prepare?.(tools);
  setPreferencesMirrorStorageForTest(null);
  const sidebarState = { current: null as PluginSidebarThreadsState | null };
  function SidebarSource(props: PluginThreadListProps) {
    if (restoreSidebarHook === null) {
      restoreSidebarHook = installSidebarHook(() => {
        if (sidebarState.current === null) throw new Error("sidebar state is missing");
        return sidebarState.current;
      });
    }
    return <registration.component {...props} />;
  }
  const sidebar = {
    status: "ready" as const,
    projects: options.projects ?? [PERSONAL, APP, WEB],
    sections: options.sections ?? [],
    threads: options.threads,
    experimental_archived: options.archived ?? null,
  } satisfies PluginSidebarThreadsState;
  sidebarState.current = sidebar;
  const slotOptions = {
    pluginId: "project-first-sidebar",
    sidebarDraftThreadIds: options.sidebarDraftThreadIds,
    sidebarRowStatuses: options.sidebarRowStatuses,
    sidebarSplitLayout: options.sidebarSplitLayout,
    sidebarThreads: sidebar,
    sdk: {
      threads: {
        update: (async () => ({})) as never,
        unpin: (async () => ({})) as never,
      },
    },
    threadActions,
    rpc: {
      listPreferences: () => tools.host.harness.behavior.callRpc("listPreferences", null),
      setPreference: (input: unknown) => tools.host.harness.behavior.callRpc("setPreference", input),
      listFilters: () => tools.host.harness.behavior.callRpc("listFilters", null),
      createFilter: (input: unknown) => tools.host.harness.behavior.callRpc("createFilter", input),
      setPinnedMode: (input: unknown) => tools.host.harness.behavior.callRpc("setPinnedMode", input),
      listProjectSections: async () => {
        if (documentGate !== null) await documentGate;
        if (options.documentError) {
          return { status: "error", issues: [{ message: "Не удалось прочитать секции проекта" }] };
        }
        return tools.host.harness.behavior.callRpc("listProjectSections", null);
      },
      createProjectSection: (input: unknown) => tools.host.harness.behavior.callRpc("createProjectSection", input),
      renameProjectSection: (input: unknown) => tools.host.harness.behavior.callRpc("renameProjectSection", input),
      deleteProjectSection: (input: unknown) => tools.host.harness.behavior.callRpc("deleteProjectSection", input),
      assignProjectSection: (input: unknown) => tools.host.harness.behavior.callRpc("assignProjectSection", input),
      clearProjectSectionAssignment: (input: unknown) => tools.host.harness.behavior.callRpc("clearProjectSectionAssignment", input),
      readProjectSectionMetadata: (input: unknown) => tools.host.harness.behavior.callRpc("readProjectSectionMetadata", input),
    },
  };
  let slot = renderSlot({ component: SidebarSource }, props(), slotOptions);
  return {
    ...tools,
    get slot() { return slot; },
    sidebar,
    releaseMetadata: () => releaseMetadata?.(),
    releaseDocument: () => releaseDocument?.(),
    update(patch: Partial<PluginSidebarThreadsState>) {
      sidebarState.current = { ...sidebar, ...sidebarState.current, ...patch };
      slot.lifecycle.rerender(<registration.component {...props()} />);
    },
    async reload() {
      slot.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      slot = renderSlot({ component: SidebarSource }, props(), slotOptions);
      return slot;
    },
  };
}

function props(): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: () => undefined,
    searchQuery: "",
  };
}

function project(projectId: string): HTMLElement {
  const element = document.querySelector(`[data-sidebar-project-id="${projectId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`project ${projectId} is missing`);
  return element;
}

function threadRow(threadId: string): HTMLElement {
  const link = document.querySelector(`[data-sidebar-thread-id="${threadId}"]`);
  const row = link?.closest("[data-sidebar-rename-row]");
  if (!(row instanceof HTMLElement)) throw new Error(`thread ${threadId} is missing`);
  return row;
}

function idsInside(root: ParentNode): string[] {
  return [...root.querySelectorAll("[data-sidebar-thread-id]")].map((element) => element.getAttribute("data-sidebar-thread-id") ?? "");
}

function looseIds(projectId: string): string[] {
  return idsInside(project(projectId)).filter((id) => {
    const link = project(projectId).querySelector(`[data-sidebar-thread-id="${id}"]`);
    return link?.closest("[data-project-section-id]") === null;
  });
}

function signalMark(root: ParentNode): string {
  const glyph = root.querySelector("[data-thread-status-glyph]");
  if (glyph) {
    return [
      "glyph",
      glyph.getAttribute("data-thread-status-glyph"),
      glyph.getAttribute("data-row-status"),
      glyph.getAttribute("data-row-status-tone"),
      glyph.getAttribute("class"),
    ].join("|");
  }
  const map = root.querySelector("[role='img']");
  if (map === null) return "";
  const rects = [...map.querySelectorAll("rect")].map((rect) => rect.getAttribute("class") ?? "");
  return `split|${rects.join(",")}`;
}

function sectionBox(sectionId: string): HTMLElement {
  const element = document.querySelector(`[data-project-section-id="${sectionId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`section ${sectionId} is missing`);
  return element;
}

async function openMenu(row: HTMLElement) {
  fireEvent.click(within(row).getByRole("button", { name: "Thread actions" }));
  return within(row).findByRole("menu", { name: "Thread actions" });
}

function metadataReadIds(view: { slot: { inspection: { rpcCalls: { method: string; input?: unknown }[] } } }): string[][] {
  return view.slot.inspection.rpcCalls.flatMap((call) => {
    if (call.method !== "readProjectSectionMetadata") return [];
    const threadIds = (call.input as { threadIds?: string[] } | undefined)?.threadIds;
    return threadIds === undefined ? [] : [threadIds];
  });
}

function menuLabels(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"]')]
    .map((item) => item.textContent ?? "")
    .filter((label) => label !== "Customize actions");
}

describe("assignment cache and archive", () => {
  it("keeps a loaded archived root in its section and withholds the next archive page until its metadata is read", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const view = await mount({
      archived: {
        status: "ready",
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      },
      threads: [
        makeSidebarThread({
          id: "thr_archived",
          projectId: "proj_app",
          title: "Archived root",
          archivedAt: 4,
          isArchived: true,
          createdAt: 4,
          latestAttentionAt: 4,
        }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_archived", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
        await host.harness.behavior.callRpc("setPreference", {
          key: "threadLifecycles",
          value: ["active", "archived"],
        });
      },
    });
    await screen.findByText("Archived root");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_archived"]);
    expect(metadataReadIds(view)).toEqual([["thr_archived"]]);
    expect(view.slot.inspection.rpcCalls.filter((call) => (
      call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment"
    ))).toEqual([]);
    const stored = JSON.stringify(view.metadata.get("thr_archived"));

    let releasePage: () => void = () => undefined;
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    view.host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: { threadIds: readonly string[] }) => {
      await pageGate;
      return view.read(args);
    });
    view.metadata.set("thr_page", { projectId: "proj_app", projectSectionId: alphaId });
    view.update({
      threads: [
        ...view.sidebar.threads,
        makeSidebarThread({
          id: "thr_page",
          projectId: "proj_app",
          title: "Page two",
          archivedAt: 5,
          isArchived: true,
          createdAt: 5,
          latestAttentionAt: 5,
        }),
      ],
    });
    await waitFor(() => expect(metadataReadIds(view).some((ids) => ids.includes("thr_page"))).toBe(true));
    expect(screen.queryByText("Page two")).toBeNull();
    expect(looseIds("proj_app")).not.toContain("thr_page");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_archived"]);
    expect(metadataReadIds(view).flat()).not.toContain("thr_unloaded");
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(JSON.stringify(view.metadata.get("thr_archived"))).toBe(stored);

    releasePage();
    await waitFor(() => expect(idsInside(sectionBox(alphaId)).sort()).toEqual(["thr_archived", "thr_page"]));
    expect(looseIds("proj_app")).toEqual([]);
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(JSON.stringify(view.metadata.get("thr_archived"))).toBe(stored);
  });

  it("reads loaded threads in batches of at most 200 and leaves the unread archive page alone", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const loaded = Array.from({ length: 201 }, (_, index) => {
      const id = `thr_${String(index).padStart(3, "0")}`;
      return makeSidebarThread({
        id,
        projectId: "proj_app",
        title: id,
        createdAt: index + 1,
        latestAttentionAt: index + 1,
      });
    });
    const view = await mount({
      archived: {
        status: "ready",
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      },
      threads: loaded,
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_000", { projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_200", { projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId)).sort()).toEqual(["thr_000", "thr_200"]));
    const reads = metadataReadIds(view);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((ids) => ids.length > 0 && ids.length <= 200)).toBe(true);
    expect(reads.flat().sort()).toEqual(loaded.map((thread) => thread.id).sort());
    expect(reads.flat()).not.toContain("thr_unloaded");
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("finishes loaded assignment reads when a new thread and a subset signal arrive during an open batch", async () => {
    const calls: { ids: readonly string[]; release: () => void; released: boolean }[] = [];
    const loaded = Array.from({ length: 201 }, (_, index) => {
      const id = `thr_${String(index).padStart(3, "0")}`;
      return makeSidebarThread({
        id,
        projectId: "proj_app",
        title: id,
        createdAt: index + 1,
        latestAttentionAt: index + 1,
      });
    });
    const view = await mount({
      threads: loaded,
      prepare: async (tools) => {
        tools.host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: { threadIds: readonly string[] }) => {
          await new Promise<void>((resolve) => {
            calls.push({ ids: [...args.threadIds], release: resolve, released: false });
          });
          return tools.read(args);
        });
      },
    });
    await waitFor(() => expect(calls.map((call) => call.ids)).toEqual([
      loaded.slice(0, 200).map((thread) => thread.id),
    ]));

    view.update({
      threads: [
        ...loaded,
        makeSidebarThread({
          id: "thr_new",
          projectId: "proj_app",
          title: "thr_new",
          createdAt: 300,
          latestAttentionAt: 300,
        }),
      ],
    });
    await view.slot.behavior.emitRealtime(PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, {
      threadIds: ["thr_000"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await waitFor(() => {
      for (const call of calls) {
        if (call.released) continue;
        call.released = true;
        call.release();
      }
      expect(document.querySelector("[data-sidebar-thread-id='thr_000']")).not.toBeNull();
      expect(document.querySelector("[data-sidebar-thread-id='thr_001']")).not.toBeNull();
      expect(document.querySelector("[data-sidebar-thread-id='thr_200']")).not.toBeNull();
      expect(document.querySelector("[data-sidebar-thread-id='thr_new']")).not.toBeNull();
    });
    expect(calls.every((call) => call.ids.length > 0 && call.ids.length <= 200)).toBe(true);
    expect(new Set(calls.flatMap((call) => call.ids)).size).toBe(202);
    expect(calls.flatMap((call) => call.ids)).not.toContain("thr_unloaded");
    expect(document.querySelectorAll("[data-sidebar-thread-id]").length).toBe(202);
  }, 15000);

  it("keeps the successful batch when the next batch fails and does not show that batch as the loose list", async () => {
    const gate = { failLate: true, completed: 0 };
    const loaded = Array.from({ length: 201 }, (_, index) => {
      const id = `thr_${String(index).padStart(3, "0")}`;
      return makeSidebarThread({
        id,
        projectId: "proj_app",
        title: id,
        createdAt: index + 1,
        latestAttentionAt: index + 1,
      });
    });
    const view = await mount({
      threads: loaded,
      prepare: async (tools) => {
        const alpha = await createSection(tools.host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        tools.metadata.set("thr_000", { projectId: "proj_app", projectSectionId: alpha.id });
        tools.metadata.set("thr_200", { projectId: "proj_app", projectSectionId: alpha.id });
        tools.host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: { threadIds: readonly string[] }) => {
          try {
            if (gate.failLate && args.threadIds.includes("thr_200")) throw new Error("next batch down");
            return await tools.read(args);
          } finally {
            gate.completed += 1;
          }
        });
      },
    });
    await waitFor(() => expect(gate.completed).toBe(2));
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_000"]));
    expect(looseIds("proj_app")).toContain("thr_001");
    expect(looseIds("proj_app")).not.toContain("thr_200");
    expect(document.querySelector(`[data-sidebar-thread-id="thr_200"]`)).toBeNull();
    expect(document.querySelector("[data-project-thread-placement]")).toBeNull();

    gate.failLate = false;
    await view.slot.behavior.emitRealtime(PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, {
      threadIds: ["thr_200"],
    });
    await waitFor(() => expect(gate.completed).toBe(3));
    await waitFor(() => expect(idsInside(sectionBox(alphaId)).sort()).toEqual(["thr_000", "thr_200"]));

    gate.failLate = true;
    await view.slot.behavior.emitRealtime(PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, {
      threadIds: [...loaded.map((thread) => thread.id), "thr_unloaded"],
    });
    await waitFor(() => expect(gate.completed).toBe(5));
    await waitFor(() => expect(idsInside(sectionBox(alphaId)).sort()).toEqual(["thr_000", "thr_200"]));
    expect(looseIds("proj_app")).not.toContain("thr_200");
    expect(metadataReadIds(view).every((ids) => ids.length <= 200)).toBe(true);
    expect(metadataReadIds(view).flat()).not.toContain("thr_unloaded");
  }, 15000);

  it("clears a stored assignment only when the read namespace has no assignment fields", async () => {
    const view = await mount({
      threads: [makeSidebarThread({
        id: "thr_root",
        projectId: "proj_app",
        title: "Root",
        createdAt: 2,
        latestAttentionAt: 2,
      })],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    const reread = async (metadata: Record<string, unknown> | undefined) => {
      const before = metadataReadIds(view).length;
      if (metadata === undefined) view.metadata.delete("thr_root");
      else view.metadata.set("thr_root", metadata);
      await view.slot.behavior.emitRealtime(PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, {
        threadIds: ["thr_root"],
      });
      await waitFor(() => expect(metadataReadIds(view).length).toBeGreaterThan(before));
    };
    const staysInSection = async (metadata: Record<string, unknown>) => {
      await reread(metadata);
      expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]);
      expect(looseIds("proj_app")).not.toContain("thr_root");
      expect(document.querySelector("[data-project-thread-placement]")).toBeNull();
    };

    await staysInSection({ projectId: "proj_app" });
    await staysInSection({ projectSectionId: alphaId });
    await staysInSection({ projectId: "proj_app", projectSectionId: "" });
    await staysInSection({ projectId: "", projectSectionId: alphaId });
    await staysInSection({ projectId: "proj_app", projectSectionId: 4 });

    await reread({});
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_root"]));
    expect(document.querySelector("[data-project-section-id]")).not.toBeNull();

    await reread({ note: "keep", projectId: "proj_app", projectSectionId: alphaId });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    await reread({ note: "keep" });
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_root"]));

    await reread({ note: "keep", projectId: "proj_app", projectSectionId: alphaId });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    await reread(undefined);
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_root"]));

    await reread({ note: "keep", projectId: "proj_app", projectSectionId: alphaId });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    await view.host.harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1,
      projectId: "proj_app",
      sectionId: alphaId,
    });
    await view.slot.behavior.emitRealtime(PROJECT_SECTIONS_CHANGED_CHANNEL, { revision: 2 });
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_root"]));
    expect(document.querySelector("[data-project-thread-placement]")).toBeNull();
    expect(view.metadata.get("thr_root")).toEqual({
      note: "keep",
      projectId: "proj_app",
      projectSectionId: alphaId,
    });
  });

  it("shows an error instead of the loose list when the first assignment read is invalid", async () => {
    await mount({
      threads: [makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root" })],
      prepare: async ({ metadata }) => {
        metadata.set("thr_root", { projectId: "proj_app" });
      },
    });
    await waitFor(() => expect(
      document.querySelector("[data-project-thread-placement]")?.getAttribute("data-project-thread-placement"),
    ).toBe("error"));
    expect(screen.queryByText("Root")).toBeNull();
    expect(document.querySelector(`[data-sidebar-thread-id="thr_root"]`)).toBeNull();
  });

  it("drops an archived root from a deleted section in one document write without reading the rest of the archive", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const view = await mount({
      archived: {
        status: "ready",
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      },
      threads: [makeSidebarThread({
        id: "thr_archived",
        projectId: "proj_app",
        title: "Archived root",
        archivedAt: 4,
        isArchived: true,
        createdAt: 4,
        latestAttentionAt: 4,
      })],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_archived", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_unloaded", { projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_archived"]));
    const readsBefore = metadataReadIds(view).length;
    const metadataReadsBefore = view.host.harness.sdk.callsTo("threads.experimental_listPluginMetadata").length;
    const metadataWritesBefore = view.host.harness.sdk.callsTo("threads.updatePluginMetadata").length;
    const documentBefore = view.host.bb.storage.database().prepare(
      "SELECT document FROM project_section_document WHERE id = 1",
    ).get() as { document: string };
    fireEvent.pointerDown(within(sectionBox(alphaId)).getByRole("button", { name: "Alpha: действия" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить секцию" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить секцию" }));
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_archived"]));
    expect(document.querySelector("[data-project-section-id]")).toBeNull();
    const deletes = view.slot.inspection.rpcCalls.filter((call) => call.method === "deleteProjectSection");
    expect(deletes).toHaveLength(1);
    const documentAfter = view.host.bb.storage.database().prepare(
      "SELECT document FROM project_section_document WHERE id = 1",
    ).get() as { document: string };
    expect(JSON.parse(documentAfter.document)).toMatchObject({ revision: 2, sections: [], order: [] });
    expect(JSON.parse(documentBefore.document).revision).toBe(1);
    expect(view.host.harness.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(metadataWritesBefore);
    expect(view.host.harness.sdk.callsTo("threads.experimental_listPluginMetadata")).toHaveLength(metadataReadsBefore);
    expect(metadataReadIds(view)).toHaveLength(readsBefore);
    expect(metadataReadIds(view).flat()).not.toContain("thr_unloaded");
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(view.metadata.get("thr_archived")).toEqual({
      note: "keep",
      projectId: "proj_app",
      projectSectionId: alphaId,
    });
    expect(view.metadata.get("thr_unloaded")).toEqual({
      projectId: "proj_app",
      projectSectionId: alphaId,
    });
  });

  it("shows an external metadata write on reconnect or the next view load, without polling", async () => {
    const fetchNextPage = vi.fn(async () => undefined);
    const view = await mount({
      archived: {
        status: "ready",
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      },
      threads: [makeSidebarThread({
        id: "thr_root",
        projectId: "proj_app",
        title: "Root",
        createdAt: 2,
        latestAttentionAt: 2,
      })],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        const beta = await createSection(host.harness.behavior.callRpc, "proj_app", "Beta", alpha.revision);
        alphaId = alpha.id;
        betaId = beta.id;
        metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_unloaded", { projectId: "proj_app", projectSectionId: beta.id });
      },
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    const metadataReads = () => metadataReadIds(view).length;
    const sectionReads = () => view.slot.inspection.rpcCalls.filter((call) => call.method === "listProjectSections").length;
    const readsBefore = metadataReads();
    const sectionsBefore = sectionReads();
    view.metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: betaId });
    const stored = view.host.bb.storage.database().prepare(
      "SELECT document FROM project_section_document WHERE id = 1",
    ).get() as { document: string };
    const renamed = JSON.parse(stored.document) as {
      revision: number;
      sections: { id: string; name: string }[];
    };
    renamed.revision += 1;
    renamed.sections = renamed.sections.map((section) => (
      section.id === alphaId ? { ...section, name: "Renamed" } : section
    ));
    view.host.bb.storage.database().prepare(
      "UPDATE project_section_document SET document = ? WHERE id = 1",
    ).run(JSON.stringify(renamed));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]);
    expect(screen.queryByText("Renamed")).toBeNull();
    expect(metadataReads()).toBe(readsBefore);
    expect(sectionReads()).toBe(sectionsBefore);
    expect(fetchNextPage).not.toHaveBeenCalled();

    await view.slot.behavior.setRealtimeConnectionState("reconnecting");
    await view.slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(idsInside(sectionBox(betaId))).toEqual(["thr_root"]));
    expect(screen.getByText("Renamed")).not.toBeNull();
    expect(metadataReads()).toBeGreaterThan(readsBefore);
    expect(sectionReads()).toBeGreaterThan(sectionsBefore);
    expect(metadataReadIds(view).flat()).not.toContain("thr_unloaded");
    expect(fetchNextPage).not.toHaveBeenCalled();

    view.metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alphaId });
    const reloaded = await view.reload();
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    expect(reloaded.container.querySelector(`[data-sidebar-thread-id="thr_root"]`)).not.toBeNull();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("does not show a failed assignment write as a successful update", async () => {
    const view = await mount({
      threads: [makeSidebarThread({
        id: "thr_root",
        projectId: "proj_app",
        title: "Root",
        createdAt: 2,
        latestAttentionAt: 2,
      })],
      prepare: async ({ host }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        host.harness.sdk.stub("threads.updatePluginMetadata", async () => {
          throw new Error("metadata down");
        });
      },
    });
    await screen.findByText("Root");
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_root"]));
    const menu = await openMenu(threadRow("thr_root"));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Alpha" }));
    await waitFor(() => expect(
      view.host.harness.sdk.callsTo("threads.updatePluginMetadata").length,
    ).toBeGreaterThan(0));
    expect(looseIds("proj_app")).toEqual(["thr_root"]);
    expect(view.host.harness.realtimeSignals.filter((signal) => (
      signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL
    ))).toEqual([]);
    expect(idsInside(sectionBox(alphaId))).toEqual([]);
  });
});

describe("visible root placement", () => {
  it("offers the effective project's sections only on a visible root", async () => {
    const linked = makeSidebarEnvironment({ id: "env_linked", isWorktree: true, name: "linked" });
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root", environment: linked, createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_peer", projectId: "proj_app", title: "Peer", environment: linked, createdAt: 3, latestAttentionAt: 3 }),
        makeSidebarThread({ id: "thr_child", projectId: "proj_app", title: "Child", parentThreadId: "thr_root", createdAt: 1, latestAttentionAt: 1 }),
      ],
      prepare: async ({ host }) => {
        await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        await createSection(host.harness.behavior.callRpc, "proj_app", "Beta", 1);
      },
    });
    await screen.findByText("Root");
    const rootMenu = await openMenu(threadRow("thr_root"));
    expect(menuLabels(rootMenu)).toEqual(["Alpha", "Beta", "Без секции"]);
    expect(rootMenu.querySelector('[role="menuitem"][disabled]')?.textContent).toBe("Без секции");
    expect(latestRootChoices).toEqual([
      { id: expect.any(String), label: "Alpha", selected: false, disabled: false },
      { id: expect.any(String), label: "Beta", selected: false, disabled: false },
      { id: "__project_section_loose__", label: "Без секции", selected: true, disabled: true },
    ]);
    const calls = view.slot.inspection.rpcCalls.filter((call) => call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment");
    fireEvent.click(within(rootMenu).getByRole("menuitem", { name: "Без секции" }));
    expect(view.slot.inspection.rpcCalls.filter((call) => call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment")).toEqual(calls);

    const childMenu = await openMenu(threadRow("thr_child"));
    expect(menuLabels(childMenu)).not.toContain("Секция проекта");
    expect(menuLabels(childMenu)).not.toContain("Без секции");
    fireEvent.click(within(project("proj_app")).getByRole("button", { name: "Environment actions" }));
    const environmentMenu = (await screen.findAllByRole("menu")).find((menu) => menu.getAttribute("aria-label") !== "Thread actions");
    expect(environmentMenu?.textContent ?? "").not.toContain("Секция проекта");
    expect(environmentMenu?.textContent ?? "").not.toContain("Без секции");
  });

  it("shows an assigned root once and replaces or clears only the assignment fields", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root", createdAt: 3, latestAttentionAt: 3 }),
        makeSidebarThread({ id: "thr_child", projectId: "proj_app", title: "Child", parentThreadId: "thr_root", createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_other", projectId: "proj_app", title: "Other", createdAt: 1, latestAttentionAt: 1 }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        const beta = await createSection(host.harness.behavior.callRpc, "proj_app", "Beta", alpha.revision);
        alphaId = alpha.id;
        betaId = beta.id;
        metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_child", { projectId: "proj_app", projectSectionId: beta.id });
        metadata.set("thr_other", { projectId: "proj_web", projectSectionId: beta.id });
      },
    });
    await screen.findByText("Root");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root", "thr_child"]);
    expect(looseIds("proj_app")).toEqual(["thr_other"]);
    const menu = await openMenu(threadRow("thr_root"));
    expect(within(menu).getByRole("menuitem", { name: "Alpha" })).toHaveProperty("disabled", true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Beta" }));
    await waitFor(() => expect(idsInside(sectionBox(betaId))).toEqual(["thr_root", "thr_child"]));
    expect(view.metadata.get("thr_root")).toMatchObject({ note: "keep", projectId: "proj_app", projectSectionId: betaId });
    expect(view.metadata.get("thr_child")).toMatchObject({ projectSectionId: betaId });
    const cleared = await openMenu(threadRow("thr_root"));
    fireEvent.click(within(cleared).getByRole("menuitem", { name: "Без секции" }));
    await waitFor(() => expect(looseIds("proj_app")).toContain("thr_root"));
    expect(view.metadata.get("thr_root")).toEqual({ note: "keep" });
    expect(view.slot.inspection.sdkCalls.filter((call) => call.method === "threads.update")).toEqual([]);
    expect(view.slot.inspection.sdkCalls.filter((call) => call.method === "threads.updatePluginMetadata")).toEqual([]);
  });

  it("keeps a deleted definition's record and survives a missing project or thread", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root", createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_web", projectId: "proj_web", title: "Web thread", createdAt: 1, latestAttentionAt: 1 }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_gone", { projectId: "proj_app", projectSectionId: alpha.id });
        await host.harness.behavior.callRpc("deleteProjectSection", {
          expectedRevision: alpha.revision,
          projectId: "proj_app",
          sectionId: alpha.id,
        });
      },
    });
    await screen.findByText("Root");
    expect(document.querySelector("[data-project-section-id]")).toBeNull();
    expect(looseIds("proj_app")).toEqual(["thr_root"]);
    expect(view.metadata.get("thr_root")).toMatchObject({ note: "keep", projectSectionId: expect.any(String) });
    expect(() => view.update({
      projects: view.sidebar.projects.filter((item) => item.id !== "proj_app"),
      threads: view.sidebar.threads.filter((thread) => thread.id !== "thr_root"),
    })).not.toThrow();
    await screen.findByText("Web thread");
  });

  it("does not present an unread section document as an empty thread list", async () => {
    const loading = await mount({ threads: [], holdDocument: true });
    await waitFor(() => expect(
      project("proj_app").querySelector("[data-project-thread-placement]")?.getAttribute("data-project-thread-placement"),
    ).toBe("loading"));
    expect(within(project("proj_app")).queryByText("No threads")).toBeNull();
    loading.releaseDocument();
    await waitFor(() => expect(within(project("proj_app")).getByText("No threads")).not.toBeNull());
    expect(project("proj_app").querySelector("[data-project-thread-placement]")).toBeNull();
    loading.slot.unmount();

    const failed = await mount({ threads: [], documentError: true });
    await waitFor(() => expect(
      project("proj_app").querySelector("[data-project-thread-placement]")?.getAttribute("data-project-thread-placement"),
    ).toBe("error"));
    expect(within(project("proj_app")).queryByText("No threads")).toBeNull();
    failed.slot.unmount();
  });

  it("does not present unread metadata as the loose list", async () => {
    const loading = await mount({
      holdMetadata: true,
      threads: [makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root" })],
    });
    await waitFor(() => expect(document.querySelector("[data-project-thread-placement]")?.getAttribute("data-project-thread-placement")).toBe("loading"));
    expect(screen.queryByText("Root")).toBeNull();
    loading.releaseMetadata();
    await screen.findByText("Root");
    expect(looseIds("proj_app")).toEqual(["thr_root"]);
    loading.slot.unmount();

    const failed = await mount({
      metadataError: true,
      threads: [makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root" })],
    });
    await waitFor(() => expect(document.querySelector("[data-project-thread-placement]")?.getAttribute("data-project-thread-placement")).toBe("error"));
    expect(screen.queryByText("Root")).toBeNull();
    failed.slot.unmount();
  });

  it("suppresses an assignment while the thread is nested and restores it without writing", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_parent", projectId: "proj_app", title: "Parent", createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root", createdAt: 1, latestAttentionAt: 1 }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_root", { projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await screen.findByText("Root");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]);
    const writes = () => view.slot.inspection.rpcCalls.filter((call) => (
      call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment"
    ));
    const before = writes().length;
    const stored = JSON.stringify(view.metadata.get("thr_root"));
    view.update({
      threads: view.sidebar.threads.map((thread) => (
        thread.id === "thr_root" ? { ...thread, parentThreadId: "thr_parent" } : thread
      )),
    });
    await waitFor(() => expect(sectionBox(alphaId).querySelector("[data-sidebar-thread-id]")).toBeNull());
    const expand = within(project("proj_app")).queryByRole("button", { name: "Expand Parent threads" });
    if (expand) fireEvent.click(expand);
    await waitFor(() => expect(looseIds("proj_app")).toEqual(["thr_parent", "thr_root"]));
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);
    view.update({
      threads: view.sidebar.threads.map((thread) => (
        thread.id === "thr_root" ? { ...thread, parentThreadId: null } : thread
      )),
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);
  });

  it("keeps the assignment record when visibility, archive, or the effective project changes", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_root", projectId: "proj_app", title: "Root", createdAt: 1, latestAttentionAt: 1 }),
        makeSidebarThread({ id: "thr_hidden_parent", projectId: "proj_web", title: "Hidden parent", isHidden: true, createdAt: 2, latestAttentionAt: 2 }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_root", { note: "keep", projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await screen.findByText("Root");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]);
    const writes = () => view.slot.inspection.rpcCalls.filter((call) => (
      call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment"
    ));
    const before = writes().length;
    const stored = JSON.stringify(view.metadata.get("thr_root"));
    const replace = (patch: Partial<SidebarThread>) => {
      view.update({
        threads: view.sidebar.threads.map((thread) => (
          thread.id === "thr_root" ? { ...thread, ...patch } : thread
        )),
      });
    };

    replace({ isHidden: true });
    await waitFor(() => expect(screen.queryByText("Root")).toBeNull());
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);

    replace({ isHidden: false });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));

    replace({ archivedAt: 9, isArchived: true });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);

    replace({ projectId: "proj_web" });
    await waitFor(() => expect(sectionBox(alphaId).querySelector("[data-sidebar-thread-id]")).toBeNull());
    expect(looseIds("proj_web")).toEqual(["thr_root"]);
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);

    replace({ projectId: "proj_app", parentThreadId: "thr_hidden_parent" });
    await waitFor(() => expect(looseIds("proj_web")).toEqual(["thr_root"]));
    expect(sectionBox(alphaId).querySelector("[data-sidebar-thread-id]")).toBeNull();
    expect(screen.queryByText("Hidden parent")).toBeNull();
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);

    replace({});
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_root"]));
    expect(writes()).toHaveLength(before);
    expect(JSON.stringify(view.metadata.get("thr_root"))).toBe(stored);
  });

  it("groups a linked worktree inside one section and leaves a single checkout on its own row", async () => {
    const linked = makeSidebarEnvironment({ id: "env_linked", isWorktree: true, name: "linked" });
    const solo = makeSidebarEnvironment({ id: "env_solo", isWorktree: true, name: "solo" });
    const checkout = makeSidebarEnvironment({ id: "env_checkout", isWorktree: false, name: "checkout" });
    let beta = "";
    await mount({
      threads: [
        makeSidebarThread({ id: "thr_a", projectId: "proj_app", title: "A", environment: linked, createdAt: 1, latestAttentionAt: 1 }),
        makeSidebarThread({ id: "thr_b", projectId: "proj_app", title: "B", environment: linked, createdAt: 4, latestAttentionAt: 4 }),
        makeSidebarThread({ id: "thr_child", projectId: "proj_app", title: "Child", parentThreadId: "thr_a", createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_c", projectId: "proj_app", title: "C", environment: linked, createdAt: 3, latestAttentionAt: 3 }),
        makeSidebarThread({ id: "thr_solo", projectId: "proj_app", title: "Solo", environment: solo, createdAt: 5, latestAttentionAt: 5 }),
        makeSidebarThread({ id: "thr_own", projectId: "proj_app", title: "Own", environment: checkout, createdAt: 6, latestAttentionAt: 6 }),
        makeSidebarThread({ id: "thr_own_b", projectId: "proj_app", title: "Own B", environment: checkout, createdAt: 7, latestAttentionAt: 7 }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        const next = await createSection(host.harness.behavior.callRpc, "proj_app", "Beta", alpha.revision);
        alphaId = alpha.id;
        beta = next.id;
        metadata.set("thr_a", { projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_b", { projectId: "proj_app", projectSectionId: alpha.id });
        metadata.set("thr_child", { projectId: "proj_app", projectSectionId: next.id });
        metadata.set("thr_c", { projectId: "proj_app", projectSectionId: next.id });
      },
    });
    await screen.findByText("A");
    expect(idsInside(sectionBox(alphaId))).toEqual(["thr_b", "thr_a", "thr_child"]);
    expect(within(sectionBox(alphaId)).getAllByRole("button", { name: "Environment actions" })).toHaveLength(1);
    expect(idsInside(sectionBox(beta))).toEqual(["thr_c"]);
    expect(within(sectionBox(beta)).queryByRole("button", { name: "Environment actions" })).toBeNull();
    expect(looseIds("proj_app")).toEqual(["thr_own_b", "thr_own", "thr_solo"]);
    expect(within(project("proj_app")).getAllByRole("button", { name: "Environment actions" })).toHaveLength(1);
  });

  it("keeps a pinned subtree in Pinned and shows it when the project filter hides the project", async () => {
    const view = await mount({
      threads: [makeSidebarThread({
        id: "thr_pin",
        projectId: "proj_app",
        title: "Pinned root",
        isPinned: true,
        pinnedAt: 5,
        pinSortKey: "a",
        createdAt: 5,
        latestAttentionAt: 5,
      })],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_pin", { projectId: "proj_app", projectSectionId: alpha.id });
        const filters = await host.harness.behavior.callRpc("listFilters", null) as { document: { revision: number } };
        await host.harness.behavior.callRpc("setPinnedMode", { expectedRevision: filters.document.revision, pinnedMode: "always-show" });
        await host.harness.behavior.callRpc("createFilter", {
          expectedRevision: filters.document.revision + 1,
          name: "Only Web",
          rule: { kind: "projectIds", projectIds: ["proj_web"] },
        });
      },
    });
    await screen.findByText("Pinned root");
    expect(sectionBox(alphaId).querySelector("[data-sidebar-thread-id]")).toBeNull();
    const stored = JSON.stringify(view.metadata.get("thr_pin"));
    view.update({
      threads: view.sidebar.threads.map((thread) => (
        thread.id === "thr_pin" ? { ...thread, isPinned: false, pinnedAt: null } : thread
      )),
    });
    await waitFor(() => expect(idsInside(sectionBox(alphaId))).toEqual(["thr_pin"]));
    expect(JSON.stringify(view.metadata.get("thr_pin"))).toBe(stored);
    view.update({
      threads: view.sidebar.threads.map((thread) => (
        thread.id === "thr_pin" ? { ...thread, isPinned: true, pinnedAt: 5 } : thread
      )),
    });
    await screen.findByText("Pinned root");
    fireEvent.click(screen.getByRole("radio", { name: "Only Web" }));
    await waitFor(() => expect(screen.queryByText("Alpha")).toBeNull());
    expect(screen.getByText("Pinned root")).not.toBeNull();
  });

  it.each([
    {
      name: "busy",
      thread: { runtimeStatus: "active" as const, lastReadAt: 5, latestAttentionAt: 1 },
    },
    {
      name: "unread",
      thread: { lastReadAt: 0, latestAttentionAt: 4 },
    },
    {
      name: "draft",
      thread: { lastReadAt: 5, latestAttentionAt: 1 },
      draftThreadIds: ["thr_signal"],
    },
    {
      name: "split",
      thread: { lastReadAt: 5, latestAttentionAt: 1 },
      splitLayout: {
        panes: [
          {
            paneId: "pane-signal",
            rect: { x: 0, y: 0, width: 1, height: 1 },
            threadId: "thr_signal",
            isFocused: true,
          },
        ],
      } satisfies PluginSidebarSplitLayout,
    },
    {
      name: "plugin status",
      thread: { lastReadAt: 5, latestAttentionAt: 1 },
      rowStatuses: {
        thr_signal: {
          icon: "AiContentGenerator01",
          label: "Plugin improving draft",
          tone: "running",
        },
      } satisfies Record<string, PluginSidebarThreadRowStatus>,
    },
  ])("rolls a $name descendant up like a collapsed standard section", async (scenario) => {
    const child = makeSidebarThread({
      id: "thr_signal",
      projectId: "proj_app",
      title: "Signal",
      createdAt: 2,
      ...scenario.thread,
    });
    await mount({
      threads: [child],
      sidebarDraftThreadIds: scenario.draftThreadIds,
      sidebarRowStatuses: scenario.rowStatuses,
      sidebarSplitLayout: scenario.splitLayout,
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set(child.id, { projectId: "proj_app", projectSectionId: alpha.id });
      },
    });
    await screen.findByText("Signal");
    fireEvent.click(within(sectionBox(alphaId)).getByRole("button", { name: "Свернуть Alpha" }));
    await waitFor(() => expect(within(sectionBox(alphaId)).queryByText("Signal")).toBeNull());
    const { SidebarSectionRow } = await import("../list/SidebarSectionRow.js");
    const standard = renderSlot({ component: SidebarSectionRow }, {
      name: "Alpha",
      label: "Alpha",
      depth: 1,
      activity: getCollapsedChildActivity([child]),
      collapsedThreads: [child],
      isCollapsed: true,
      onToggleCollapsed: () => undefined,
    }, {
      sidebarDraftThreadIds: scenario.draftThreadIds,
      sidebarRowStatuses: scenario.rowStatuses,
      sidebarSplitLayout: scenario.splitLayout,
    });
    const expected = signalMark(standard.container);
    expect(expected).not.toBe("");
    expect(signalMark(sectionBox(alphaId))).toBe(expected);
  });

  it("opens a hidden project's section with the project section menu", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({
          id: "thr_hidden",
          projectId: "proj_app",
          title: "Hidden thread",
          createdAt: 2,
          latestAttentionAt: 2,
        }),
        makeSidebarThread({
          id: "thr_web",
          projectId: "proj_web",
          title: "Web thread",
          createdAt: 1,
          latestAttentionAt: 1,
        }),
      ],
      prepare: async ({ host, metadata }) => {
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", 0);
        alphaId = alpha.id;
        metadata.set("thr_hidden", { projectId: "proj_app", projectSectionId: alpha.id });
        await host.harness.behavior.callRpc("setPreference", {
          key: "hiddenGroups",
          value: ["project:proj_app"],
        });
      },
    });
    await screen.findByText("Web thread");
    expect(document.querySelector("[data-sidebar-project-id='proj_app']")).toBeNull();
    expect(document.querySelector("[data-project-section-id]")).toBeNull();
    fireEvent.keyDown(await screen.findByRole("button", { name: "More projects" }), { key: "Enter" });
    const hiddenProject = await screen.findByRole("menuitem", { name: "App" });
    fireEvent.keyDown(hiddenProject, { key: "ArrowRight" });
    const section = await screen.findByText("Alpha").then((label) => label.closest("[data-project-section-id]"));
    expect(section?.getAttribute("data-project-section-id")).toBe(alphaId);
    if (!(section instanceof HTMLElement)) throw new Error("hidden project section is missing");
    fireEvent.pointerDown(within(section).getByRole("button", { name: "Alpha: действия" }), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "Переименовать" })).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Удалить секцию" })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Переименовать" }));
    const rename = await screen.findByRole("textbox", { name: "Имя секции" });
    fireEvent.change(rename, { target: { value: "Beta" } });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect(view.slot.inspection.rpcCalls).toContainEqual(expect.objectContaining({
      method: "renameProjectSection",
    })));
    expect(view.slot.inspection.sdkCalls.filter((call) => call.method === "threadSections.update")).toEqual([]);
    expect(document.querySelector("[data-sidebar-project-id='proj_app']")).toBeNull();
  });

  it("keeps filters, hidden projects, loose-project mode, and thread sort", async () => {
    const view = await mount({
      threads: [
        makeSidebarThread({ id: "thr_loose", projectId: "proj_app", title: "Aaa", createdAt: 1, latestAttentionAt: 1 }),
        makeSidebarThread({ id: "thr_zeta", projectId: "proj_app", title: "Zed", createdAt: 2, latestAttentionAt: 2 }),
        makeSidebarThread({ id: "thr_web", projectId: "proj_web", title: "Web thread", createdAt: 3, latestAttentionAt: 3 }),
      ],
      prepare: async ({ host, metadata }) => {
        await host.harness.behavior.callRpc("setPreference", { key: "chronologicalSort", value: "alpha" });
        await host.harness.behavior.callRpc("setPreference", { key: "hiddenGroups", value: [] });
        const zeta = await createSection(host.harness.behavior.callRpc, "proj_app", "Zeta", 0);
        const alpha = await createSection(host.harness.behavior.callRpc, "proj_app", "Alpha", zeta.revision);
        metadata.set("thr_zeta", { projectId: "proj_app", projectSectionId: alpha.id });
        const filters = await host.harness.behavior.callRpc("listFilters", null) as { document: { revision: number } };
        await host.harness.behavior.callRpc("createFilter", {
          expectedRevision: filters.document.revision,
          name: "Only Web",
          rule: { kind: "projectIds", projectIds: ["proj_web"] },
        });
      },
    });
    await screen.findByText("Zed");
    const text = project("proj_app").textContent ?? "";
    expect(text.indexOf("Zeta")).toBeLessThan(text.indexOf("Alpha"));
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Zed"));
    expect(text.indexOf("Zed")).toBeLessThan(text.indexOf("Aaa"));
    const alphaBox = [...document.querySelectorAll("[data-project-section-id]")].find((element) => element.textContent?.includes("Alpha"));
    expect(alphaBox?.textContent).toContain("Zed");
    expect(alphaBox?.textContent).not.toContain("Aaa");
    fireEvent.click(screen.getByRole("radio", { name: "Only Web" }));
    await waitFor(() => expect(screen.queryByText("Aaa")).toBeNull());
    expect(screen.getByText("Web thread")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Все" }));
    await screen.findByText("Aaa");
    fireEvent.click(screen.getByRole("radio", { name: "Без проектов" }));
    await waitFor(() => expect(document.querySelector("[data-project-section-id]")).toBeNull());
    expect(screen.queryByText("Aaa")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Все" }));
    await screen.findByText("Aaa");
    await view.host.harness.behavior.callRpc("setPreference", { key: "hiddenGroups", value: ["project:proj_app"] });
    view.slot.behavior.emitRealtime("project-first-sidebar.preferences", { key: "hiddenGroups", value: ["project:proj_app"] });
    await waitFor(() => expect(document.querySelector("[data-sidebar-project-id='proj_app']")).toBeNull());
  });

  it("still shows and can change standard sections in chronological mode", async () => {
    const view = await mount({
      sections: [{ id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 }],
      threads: [makeSidebarThread({
        id: "thr_later",
        projectId: "proj_app",
        title: "Later thread",
        sectionId: "sec_later",
      })],
      prepare: async ({ host }) => {
        await host.harness.behavior.callRpc("setPreference", { key: "organizationMode", value: "chronological" });
        await host.harness.behavior.callRpc("setPreference", {
          key: "manualSectionOrder",
          value: ["pinned", "section:sec_later", "threads"],
        });
      },
    });
    await screen.findByText("Later thread");
    expect(screen.getByText("Later")).not.toBeNull();
    expect(document.querySelector("[data-project-section-id]")).toBeNull();
    const menu = await openMenu(threadRow("thr_later"));
    expect(menuLabels(menu)).not.toContain("Без секции");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Move: Threads" }));
    await waitFor(() => expect(view.slot.inspection.sdkCalls).toContainEqual({
      method: "threads.update",
      args: [{ threadId: "thr_later", sectionId: null }],
    }));
    expect(view.sidebar.threads[0]?.sectionId).toBe("sec_later");
    expect(view.slot.inspection.rpcCalls.filter((call) => call.method === "assignProjectSection")).toEqual([]);
  });
});

let alphaId = "";
let betaId = "";
let latestRootChoices: { id: string; label: string; selected: boolean; disabled: boolean }[] = [];
