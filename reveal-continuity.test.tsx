// @vitest-environment jsdom

import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { PluginSidebarThreadsState, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import server, { projectFirstSidebarRpcContract } from "./server.js";
import { makePluginProject, makeSidebarThread, makeSidebarEnvironment } from "./app/model/fixtures.js";
import { flushPreferenceWritesForTest, resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "./app/preferences/preferences-sync.js";
import { defaultPreferences, type PreferenceValues } from "./shared/preferences.js";
import type { FilterDisplayMode } from "./shared/filter-icons.js";
import { defaultFilterDocument, FILTER_DOCUMENT_KV_KEY, FILTERS_CHANGED_CHANNEL } from "./shared/filters.js";
import { windowFilterStore } from "./app/filters/filter-store.js";

const app = await loadPluginApp(() => import("./app"));
const registration = app.threadLists[0];
if (!registration) throw new Error("thread-list slot not registered");

type SidebarThreadsHook = typeof import("@get-bb/plugin-sdk/app").experimental_useSidebarThreads;
type BbContextHook = typeof import("@get-bb/plugin-sdk/app").useBbContext;
type TestPluginRuntime = typeof globalThis & {
  __bbPluginRuntime: { pluginSdkApp: {
    experimental_useSidebarThreads: SidebarThreadsHook;
    useBbContext: BbContextHook;
  } };
};
let restoreHostInputs: (() => void) | null = null;

function createMutableSidebarRegistration(
  initialSidebarState: PluginSidebarThreadsState,
  initialContext: ReturnType<BbContextHook>,
) {
  let sidebarState = initialSidebarState;
  let context = initialContext;
  let installed = false;
  function Component(props: PluginThreadListProps) {
    if (!installed) {
      const runtime = (globalThis as TestPluginRuntime).__bbPluginRuntime.pluginSdkApp;
      const sidebarHook = runtime.experimental_useSidebarThreads;
      const contextHook = runtime.useBbContext;
      runtime.experimental_useSidebarThreads = (...args) => {
        sidebarHook(...args);
        return sidebarState;
      };
      runtime.useBbContext = () => {
        contextHook();
        return context;
      };
      restoreHostInputs = () => {
        runtime.experimental_useSidebarThreads = sidebarHook;
        runtime.useBbContext = contextHook;
      };
      installed = true;
    }
    return <registration.component {...props} />;
  }
  return {
    Component,
    getSidebarState: () => sidebarState,
    updateSidebarState(patch: Partial<PluginSidebarThreadsState>) {
      sidebarState = { ...sidebarState, ...patch };
    },
    updateContext(next: ReturnType<BbContextHook>) { context = next; },
  };
}

function props(): PluginThreadListProps {
  return { activeThreadId: null, activeProjectId: null, isCompactViewport: false,
    onNavigate: vi.fn(), searchQuery: "" };
}
const PERSONAL_PROJECT_ID = "proj_personal";
const PROJECTS = [
  makePluginProject({ id: PERSONAL_PROJECT_ID, name: "Personal", isPersonal: true }),
  makePluginProject({ id: "proj_app", name: "App" }),
  makePluginProject({ id: "proj_web", name: "Web" }),
];
const SECTIONS = [{ id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 }];

describe("filter admission and the real sidebar reveal hook", () => {
  let backend: ReturnType<typeof createFakePluginHost> | null = null;

  afterEach(async () => {
    cleanup();
    restoreHostInputs?.();
    restoreHostInputs = null;
    resetPreferencesSyncForTest();
    setPreferencesMirrorStorageForTest(undefined);
    await backend?.harness.lifecycle.dispose();
    backend = null;
  });

  async function mountRevealScenario(initiallyUnread = false) {
    setPreferencesMirrorStorageForTest(null);
    windowFilterStore.setActiveFilterId("all");
    const host = createFakePluginHost({ pluginId: "project-first-sidebar" });
    backend = host;
    await server(host.bb);
    const preferences: PreferenceValues = {
      ...defaultPreferences(),
      organizationMode: "project",
      collapsedProjects: ["proj_app", "proj_web"],
      collapsedThreads: ["thr_parent"],
      collapsedEnvironments: ["env_app"],
      collapsedMachines: ["host_app"],
      collapsedSections: ["pinned"],
      collapsedThreadSections: ["section:untouched"],
    };
    for (const [key, value] of Object.entries(preferences)) {
      await host.harness.behavior.callRpc("setPreference", { key, value });
    }
    const revision = windowFilterStore.getSnapshot().document?.revision ?? 0;
    await host.bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, {
      ...defaultFilterDocument(), revision,
    });
    await host.harness.behavior.callRpc("createFilter", {
      expectedRevision: revision,
      name: "Web static",
      rule: { kind: "projectIds", projectIds: ["proj_web"] },
    });
    await host.harness.behavior.callRpc("createFilter", {
      expectedRevision: revision + 1,
      name: "Web glob",
      rule: { kind: "nameGlobs", globs: ["W?b*"] },
    });
    const environment = makeSidebarEnvironment({ id: "env_app" });
    const readThread = { lastReadAt: 1, latestAttentionAt: 1 };
    const source = createMutableSidebarRegistration({
      status: "ready",
      projects: PROJECTS,
      sections: SECTIONS,
      experimental_archived: null,
      threads: [
        makeSidebarThread({
          ...readThread, id: "thr_personal", projectId: PERSONAL_PROJECT_ID,
        }),
        makeSidebarThread({
          ...readThread, id: "thr_parent", projectId: "proj_app", environment,
        }),
        makeSidebarThread({
          ...readThread, id: "thr_child", projectId: "proj_app", environment,
          parentThreadId: "thr_parent", latestAttentionAt: initiallyUnread ? 2 : 1,
        }),
      ],
    }, { projectId: PERSONAL_PROJECT_ID, threadId: "thr_personal" });
    const listProps = props();
    const slot = renderSlot({ component: source.Component }, listProps, {
      pluginId: "project-first-sidebar",
      rpc: {
        listPreferences: () => host.harness.behavior.callRpc("listPreferences", null),
        setPreference: (input) => host.harness.behavior.callRpc("setPreference", input),
        listFilters: () => host.harness.behavior.callRpc("listFilters", null),
      },
    });
    const readPreferences = async () => projectFirstSidebarRpcContract.listPreferences.output.parse(
      await host.harness.behavior.callRpc("listPreferences", null),
    ).preferences;
    const flush = async () => {
      await act(async () => { await flushPreferenceWritesForTest(); });
    };
    const collapseWrites = () => slot.inspection.rpcCalls.filter((call) =>
      call.method === "setPreference",
    );
    await within(slot.container).findByRole("radio", { name: "Web glob" });
    await flush();
    expect(await readPreferences()).toEqual(preferences);
    expect(collapseWrites()).toEqual([]);
    return {
      preferences, readPreferences, flush, collapseWrites,
      async setDisplayMode(displayMode: FilterDisplayMode) {
        const snapshotBefore = JSON.stringify(source.getSidebarState());
        const current = projectFirstSidebarRpcContract.listFilters.output.parse(await host.harness.behavior.callRpc("listFilters", null));
        if (current.status !== "success") throw new Error("expected current filter document");
        const changed = await host.harness.behavior.callRpc("setDisplayMode", { expectedRevision: current.document.revision, displayMode });
        expect(changed).toMatchObject({ status: "success" });
        await slot.behavior.emitRealtime(FILTERS_CHANGED_CHANNEL, { revision: current.document.revision + 1 });
        await waitFor(() => expect(windowFilterStore.getSnapshot().document?.displayMode ?? "text").toBe(displayMode));
        await flush();
        expect(JSON.stringify(source.getSidebarState())).toBe(snapshotBefore);
      },
      async select(name: string) {
        fireEvent.click(within(slot.container).getByRole("radio", { name }));
        await flush();
      },
      async setUnread() {
        source.updateSidebarState({
          threads: source.getSidebarState().threads.map((thread) =>
            thread.id === "thr_child"
              ? { ...thread, latestAttentionAt: 2, isUnread: true }
              : thread,
          ),
        });
        slot.lifecycle.rerender(<source.Component {...listProps} />);
        await flush();
      },
      async navigate(threadId: string) {
        source.updateContext({ projectId: "proj_app", threadId });
        slot.lifecycle.rerender(<source.Component {...listProps} />);
        await flush();
      },
    };
  }

  it.each(["Без проектов", "Web static", "Web glob"])(
    "keeps every collapse preference and emits zero writes across all → %s → all",
    async (filter) => {
      const scenario = await mountRevealScenario(true);
      await scenario.select(filter);
      await scenario.select("Все");
      expect(scenario.collapseWrites()).toEqual([]);
      expect(await scenario.readPreferences()).toEqual(scenario.preferences);
    },
  );

  it("keeps full unread snapshot and every collapse preference across appearance and admission changes", async () => {
    const scenario = await mountRevealScenario(true);
    for (const mode of ["icon", "icon-text", "text"] as const) {
      await scenario.select("Web static");
      await scenario.setDisplayMode(mode);
      await scenario.select("Все");
      expect(scenario.collapseWrites()).toEqual([]);
      expect(await scenario.readPreferences()).toEqual(scenario.preferences);
    }
  });

  it("consumes a hidden unread transition without revealing it on later admission", async () => {
    const scenario = await mountRevealScenario();
    await scenario.select("Web static");
    await scenario.setUnread();
    expect(scenario.collapseWrites()).toEqual([]);
    await scenario.select("Все");
    expect(scenario.collapseWrites()).toEqual([]);
    expect(await scenario.readPreferences()).toEqual(scenario.preferences);
  });

  it("consumes a hidden route transition without deferring expansion until admission", async () => {
    const scenario = await mountRevealScenario();
    await scenario.select("Web glob");
    await scenario.navigate("thr_child");
    expect(scenario.collapseWrites()).toEqual([]);
    await scenario.select("Все");
    expect(scenario.collapseWrites()).toEqual([]);
    expect(await scenario.readPreferences()).toEqual(scenario.preferences);
  });

  it.each(["unread", "route"])(
    "still persists the stock expansion for a real visible %s transition",
    async (event) => {
      const scenario = await mountRevealScenario();
      if (event === "unread") await scenario.setUnread();
      else await scenario.navigate("thr_child");
      await waitFor(async () => expect(await scenario.readPreferences()).toEqual({
        ...scenario.preferences,
        collapsedProjects: ["proj_web"],
        collapsedThreads: [],
        collapsedEnvironments: [],
      }));
      expect(scenario.collapseWrites().length).toBeGreaterThan(0);
    },
  );
});
