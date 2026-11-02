// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSidebarThreadsState,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "../preferences/preferences-sync.js";
import { defaultPreferences } from "../../shared/preferences.js";
import { defaultFilterDocument } from "../../shared/filters.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";

const app = await loadPluginApp(() => import("../../app.js"));
const registration = app.threadLists[0];
if (!registration) throw new Error("thread-list slot not registered");

type SidebarThreadsHook =
  typeof import("@get-bb/plugin-sdk/app").experimental_useSidebarThreads;
type TestPluginRuntime = typeof globalThis & {
  __bbPluginRuntime: {
    pluginSdkApp: { experimental_useSidebarThreads: SidebarThreadsHook };
  };
};
let restoreSidebarThreadsHook: (() => void) | null = null;

function currentTestPluginSdkApp() {
  return (globalThis as TestPluginRuntime).__bbPluginRuntime.pluginSdkApp;
}

function createMutableSidebarRegistration(initialState: PluginSidebarThreadsState) {
  let sidebarState = initialState;
  let instanceIdentity: object | null = null;
  const pluginSdkApp = currentTestPluginSdkApp();
  const runtimeHook = pluginSdkApp.experimental_useSidebarThreads;
  const sourceHook: SidebarThreadsHook = (...args) => {
    runtimeHook(...args);
    return sidebarState;
  };
  pluginSdkApp.experimental_useSidebarThreads = sourceHook;
  restoreSidebarThreadsHook = () => {
    pluginSdkApp.experimental_useSidebarThreads = runtimeHook;
  };

  function MutableSidebarSlot(slotProps: PluginThreadListProps) {
    const identity = useRef<object | null>(null);
    identity.current ??= {};
    instanceIdentity = identity.current;
    return <registration.component {...slotProps} />;
  }

  return {
    Component: MutableSidebarSlot,
    replaceState(nextState: PluginSidebarThreadsState) {
      sidebarState = nextState;
    },
    getInstanceIdentity() {
      if (instanceIdentity === null) throw new Error("slot not mounted");
      return instanceIdentity;
    },
    getSourceHookIdentity() {
      return sourceHook;
    },
    getInstalledSourceHookIdentity() {
      return currentTestPluginSdkApp().experimental_useSidebarThreads;
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

afterEach(() => {
  cleanup();
  restoreSidebarThreadsHook?.();
  restoreSidebarThreadsHook = null;
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

describe("sidebar filter editor dialog wiring", () => {
  it.each([false, true])("opens the shared editor from the sidebar and closes without a mutation (compact=%s)", async (isCompactViewport) => {
    setPreferencesMirrorStorageForTest(null);
    const slot = renderSlot(registration, { ...props(), isCompactViewport }, {
      sidebarThreads: {
        status: "ready",
        projects: [],
        sections: [],
        threads: [],
      },
      rpc: {
        listPreferences: () => ({ preferences: defaultPreferences() }),
        setPreference: (input: unknown) => input,
        listFilters: () => ({
          status: "success",
          document: {
            ...defaultFilterDocument(),
            revision: 60,
            filters: [{
              id: "work",
              name: "Рабочие",
              rule: { kind: "nameGlobs", globs: ["work-*"] },
            }],
          },
        }),
      },
    });

    await screen.findByText("No threads");
    fireEvent.click(screen.getByRole("radio", { name: "Рабочие" }));
    const manage = screen.getByRole("button", {
      name: "Меню фильтров",
    });
    manage.focus();
    if (isCompactViewport) fireEvent.click(manage);
    else fireEvent.keyDown(manage, { key: "ArrowDown" });
    fireEvent.click(await screen.findByText("Настроить", { exact: true }));

    const dialog = await screen.findByRole("dialog", {
      name: "Настроить фильтры",
    });
    expect(
      within(dialog).getByRole("button", { name: "Создать фильтр" }),
    ).not.toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Создать фильтр" }),
    );
    fireEvent.change(within(dialog).getByLabelText("Имя фильтра"), {
      target: { value: "Черновик" },
    });
    fireEvent.change(within(dialog).getByLabelText("Маски проектов"), {
      target: { value: "draft-*" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Отменить" }));
    expect(within(dialog).queryByLabelText("Имя фильтра")).toBeNull();

    if (isCompactViewport) fireEvent.keyDown(dialog, { key: "Escape" });
    else fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(manage));
    expect(
      screen.getByRole("radio", { name: "Рабочие" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      slot.inspection.rpcCalls.filter((call) =>
        [
          "createFilter",
          "updateFilter",
          "deleteFilter",
          "reorderFilters",
          "setPinnedMode",
        ].includes(call.method),
      ),
    ).toEqual([]);
  });

  it("updates an open glob preview and the active sidebar from catalog snapshots without refetch or remount", async () => {
    setPreferencesMirrorStorageForTest(null);
    const revision = 70;
    const filterDocument = {
      ...defaultFilterDocument(),
      revision,
      filters: [
        {
          id: "glob",
          name: "Рабочие по имени",
          rule: { kind: "nameGlobs" as const, globs: ["work-*"] },
        },
        {
          id: "static",
          name: "Статический",
          rule: { kind: "projectIds" as const, projectIds: ["static"] },
        },
      ],
    };
    const personal = makePluginProject({
      id: "personal",
      name: "Personal",
      isPersonal: true,
    });
    const alpha = makePluginProject({ id: "alpha", name: "Work-Alpha" });
    const staticProject = makePluginProject({ id: "static", name: "Other" });
    const alphaThread = makeSidebarThread({
      id: "alpha-thread",
      projectId: alpha.id,
      title: "Alpha thread",
    });
    const staticThread = makeSidebarThread({
      id: "static-thread",
      projectId: staticProject.id,
      title: "Static thread",
    });
    const initialState: PluginSidebarThreadsState = {
      status: "ready",
      projects: [personal, alpha, staticProject],
      sections: [],
      threads: [alphaThread, staticThread],
      experimental_archived: null,
    };
    const harness = createMutableSidebarRegistration(initialState);
    const listFilters = vi.fn(() => ({
      status: "success" as const,
      document: filterDocument,
    }));
    const listProps = props();
    const slot = renderSlot({ component: harness.Component }, listProps, {
      sidebarThreads: initialState,
      rpc: {
        listPreferences: () => ({
          preferences: { ...defaultPreferences(), organizationMode: "project" as const },
        }),
        setPreference: (input: unknown) => input,
        listFilters,
      },
    });

    fireEvent.click(await within(slot.container).findByRole("radio", {
      name: "Рабочие по имени",
    }));
    await within(slot.container).findByText("Alpha thread");
    expect(within(slot.container).queryByText("Static thread")).toBeNull();
    fireEvent.keyDown(within(slot.container).getByRole("button", {
      name: "Меню фильтров",
    }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Настроить" }));
    const dialog = await screen.findByRole("dialog", { name: "Настроить фильтры" });
    fireEvent.click(within(dialog).getByRole("button", {
      name: "Редактировать Рабочие по имени",
    }));
    const preview = within(dialog).getByRole("list", {
      name: "Подходящие проекты",
    });
    expect(within(preview).getByText("Work-Alpha")).not.toBeNull();
    expect(within(preview).queryByText("Other")).toBeNull();

    const instanceIdentity = harness.getInstanceIdentity();
    const sourceHookIdentity = harness.getSourceHookIdentity();
    const readsAfterEditorOpen = listFilters.mock.calls.length;
    const assertStableMountAndDocument = () => {
      expect(harness.getInstanceIdentity()).toBe(instanceIdentity);
      expect(harness.getInstalledSourceHookIdentity()).toBe(sourceHookIdentity);
      expect(listFilters).toHaveBeenCalledTimes(readsAfterEditorOpen);
      expect(
        slot.container.querySelector('[data-filter-id="glob"]')?.getAttribute("aria-checked"),
      ).toBe("true");
      expect(filterDocument.revision).toBe(revision);
      expect(filterDocument.filters.map((filter) => filter.id)).toEqual(["glob", "static"]);
      expect(slot.inspection.rpcCalls.filter((call) => [
        "createFilter",
        "updateFilter",
        "deleteFilter",
        "reorderFilters",
        "setPinnedMode",
      ].includes(call.method))).toEqual([]);
    };

    const created = makePluginProject({ id: "created", name: "Work-Created" });
    const createdThread = makeSidebarThread({
      id: "created-thread",
      projectId: created.id,
      title: "Created thread",
    });
    harness.replaceState({
      ...initialState,
      projects: [...initialState.projects, created],
      threads: [...initialState.threads, createdThread],
    });
    slot.lifecycle.rerender(
      <harness.Component {...listProps} activeThreadId="catalog-created" />,
    );
    await within(slot.container).findByTitle("Work-Created");
    expect(within(preview).getByText("Work-Alpha")).not.toBeNull();
    expect(within(preview).getByText("Work-Created")).not.toBeNull();
    assertStableMountAndDocument();

    const renamedAlpha = { ...alpha, name: "Archive-Alpha" };
    harness.replaceState({
      ...initialState,
      projects: [personal, renamedAlpha, staticProject, created],
      threads: [...initialState.threads, createdThread],
    });
    slot.lifecycle.rerender(
      <harness.Component {...listProps} activeThreadId="catalog-renamed" />,
    );
    await waitFor(() => {
      expect(within(slot.container).queryByText("Alpha thread")).toBeNull();
      expect(within(preview).queryByText("Work-Alpha")).toBeNull();
    });
    expect(within(slot.container).getByTitle("Work-Created")).not.toBeNull();
    expect(within(preview).getByText("Work-Created")).not.toBeNull();
    assertStableMountAndDocument();

    harness.replaceState({
      ...initialState,
      projects: [personal, renamedAlpha, staticProject],
      threads: [...initialState.threads, createdThread],
    });
    slot.lifecycle.rerender(
      <harness.Component {...listProps} activeThreadId="catalog-deleted" />,
    );
    await waitFor(() => {
      expect(within(slot.container).queryByTitle("Work-Created")).toBeNull();
      expect(within(dialog).queryByText("Work-Created")).toBeNull();
    });
    expect(within(dialog).getByText("Нет подходящих проектов.")).not.toBeNull();
    expect(within(slot.container).getByText("Нет проектов по этому фильтру")).not.toBeNull();
    assertStableMountAndDocument();
  });
});
