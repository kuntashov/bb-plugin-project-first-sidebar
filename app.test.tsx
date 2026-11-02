// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PluginSidebarThreadsState,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "./app/model/fixtures.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./app/preferences/preferences-sync.js";
import {
  defaultPreferences,
  type PreferenceValues,
} from "./shared/preferences.js";
import { defaultFilterDocument } from "./shared/filters.js";

const app = await loadPluginApp(() => import("./app"));
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

function createMutableSidebarRegistration(
  initialSidebarState: PluginSidebarThreadsState,
) {
  let sidebarState = initialSidebarState;
  let instanceIdentity: object | null = null;
  let runtimeHook: SidebarThreadsHook | null = null;
  const sourceOwnerIdentity = {};
  const sourceHook: SidebarThreadsHook = (...args) => {
    if (runtimeHook === null) throw new Error("sidebar hook not captured");
    runtimeHook(...args);
    return sidebarState;
  };

  function installSource() {
    const pluginSdkApp = currentTestPluginSdkApp();
    if (runtimeHook === null) {
      runtimeHook = pluginSdkApp.experimental_useSidebarThreads;
      restoreSidebarThreadsHook = () => {
        if (runtimeHook !== null) {
          pluginSdkApp.experimental_useSidebarThreads = runtimeHook;
        }
      };
      pluginSdkApp.experimental_useSidebarThreads = sourceHook;
      return;
    }
    if (pluginSdkApp.experimental_useSidebarThreads !== sourceHook) {
      throw new Error("sidebar source owner changed");
    }
  }

  function MutableSidebarSlot(props: PluginThreadListProps) {
    installSource();
    const identity = useRef<object | null>(null);
    identity.current ??= {};
    instanceIdentity = identity.current;
    return <registration.component {...props} />;
  }

  return {
    Component: MutableSidebarSlot,
    getSidebarState() {
      return sidebarState;
    },
    updateSidebarState(patch: Partial<PluginSidebarThreadsState>) {
      sidebarState = { ...sidebarState, ...patch };
    },
    getSourceOwnerIdentity() {
      return sourceOwnerIdentity;
    },
    getSourceHookIdentity() {
      return sourceHook;
    },
    getInstalledSourceHookIdentity() {
      return currentTestPluginSdkApp().experimental_useSidebarThreads;
    },
    getInstanceIdentity() {
      if (instanceIdentity === null) throw new Error("slot not mounted");
      return instanceIdentity;
    },
  };
}

const PERSONAL_PROJECT_ID = "proj_personal";

const PROJECTS = [
  makePluginProject({
    id: PERSONAL_PROJECT_ID,
    name: "Personal",
    isPersonal: true,
  }),
  makePluginProject({ id: "proj_app", name: "App" }),
  makePluginProject({ id: "proj_web", name: "Web" }),
];

const SECTIONS = [
  { id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 },
  { id: "sec_review", name: "Review", createdAt: 2, updatedAt: 2 },
];

const THREADS = [
  makeSidebarThread({
    id: "thr_pinned",
    projectId: "proj_app",
    title: "Pinned thread",
    isPinned: true,
    pinnedAt: 10,
    pinSortKey: "a",
    createdAt: 10,
    updatedAt: 10,
    latestAttentionAt: 10,
  }),
  makeSidebarThread({
    id: "thr_parent",
    projectId: "proj_app",
    title: "Parent thread",
    createdAt: 8,
    updatedAt: 8,
    latestAttentionAt: 8,
  }),
  makeSidebarThread({
    id: "thr_child",
    projectId: "proj_app",
    title: "Child thread",
    parentThreadId: "thr_parent",
    createdAt: 7,
    updatedAt: 7,
    latestAttentionAt: 7,
  }),
  makeSidebarThread({
    id: "thr_later",
    projectId: "proj_web",
    title: "Later thread",
    sectionId: "sec_later",
    createdAt: 6,
    updatedAt: 6,
    latestAttentionAt: 6,
    host: { id: "host_laptop", name: "Laptop" },
    environment: {
      id: "env_web",
      name: null,
      branchName: "main",
      path: null,
      providerId: null,
      isWorktree: false,
      workspaceDisplayKind: "other",
    },
  }),
  makeSidebarThread({
    id: "thr_personal",
    projectId: PERSONAL_PROJECT_ID,
    title: "Personal thread",
    createdAt: 5,
    updatedAt: 5,
    latestAttentionAt: 5,
  }),
];

function props(): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: vi.fn(),
    searchQuery: "",
  };
}

function renderList(
  preferences: Partial<PreferenceValues>,
  options: RenderSlotOptions = {},
) {
  const { rpc, ...rest } = options;
  return renderSlot(registration, props(), {
    sidebarThreads: {
      projects: PROJECTS,
      sections: SECTIONS,
      threads: THREADS,
    },
    rpc: {
      listPreferences: () => ({
        preferences: { ...defaultPreferences(), ...preferences },
      }),
      setPreference: (input: unknown) => input,
      listFilters: () => ({
        status: "success" as const,
        document: defaultFilterDocument(),
      }),
      ...rpc,
    },
    ...rest,
  });
}

function sectionHeaders(): string[] {
  return Array.from(
    document.querySelectorAll('[data-sidebar-sticky-tier="label"] [title]'),
    (element) => element.getAttribute("title") ?? "",
  );
}

function threadIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-sidebar-thread-id]"),
    (element) => element.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

afterEach(() => {
  cleanup();
  restoreSidebarThreadsHook?.();
  restoreSidebarThreadsHook = null;
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

describe("project-first-sidebar plugin", () => {
  it("shows the navigation skeleton until preferences load", () => {
    setPreferencesMirrorStorageForTest(null);
    renderSlot(registration, props(), {
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: THREADS,
      },
      rpc: {
        listPreferences: () => new Promise(() => undefined),
        listFilters: () => ({
          status: "success",
          document: defaultFilterDocument(),
        }),
      },
    });
    expect(screen.getByLabelText("Loading sidebar navigation")).not.toBeNull();
    expect(threadIds()).toEqual([]);
  });

  it("renders pinned, custom sections, and loose threads in chronological mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderList({ organizationMode: "chronological" });

    await screen.findByText("Pinned thread");
    expect(rpcCalls.map((call) => call.method)).toEqual([
      "listPreferences",
      "listFilters",
    ]);
    expect(sectionHeaders()).toEqual(["Pinned", "Later", "Review", "Threads"]);
    expect(threadIds()).toEqual([
      "thr_pinned",
      "thr_later",
      "thr_parent",
      "thr_child",
      "thr_personal",
    ]);
    expect(
      screen.getByRole("button", { name: "Collapse Parent thread threads" }),
    ).not.toBeNull();
  });

  it("groups pinned worktree roots when environment grouping is enabled", async () => {
    setPreferencesMirrorStorageForTest(null);
    const environment = {
      id: "env_review",
      name: "Reviewer worktree group",
      branchName: "review",
      path: null,
      providerId: null,
      isWorktree: true,
      workspaceDisplayKind: "managed-worktree" as const,
    };
    const pinnedWorktreeThreads = [
      makeSidebarThread({
        id: "thr_worktree_a",
        projectId: "proj_app",
        title: "Worktree root A",
        pinnedAt: 20,
        pinSortKey: "a",
        environment,
      }),
      makeSidebarThread({
        id: "thr_worktree_b",
        projectId: "proj_app",
        title: "Worktree root B",
        pinnedAt: 19,
        pinSortKey: "b",
        environment,
      }),
    ];
    renderList(
      {
        organizationMode: "chronological",
        environmentGrouping: true,
      },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: [...THREADS, ...pinnedWorktreeThreads],
        },
      },
    );

    const environmentGroup = (
      await screen.findByText("Reviewer worktree group")
    ).closest("[data-sidebar-sticky-group]");
    expect(environmentGroup).not.toBeNull();
    expect(
      within(environmentGroup as HTMLElement).getByText("Worktree root A"),
    ).not.toBeNull();
    expect(
      within(environmentGroup as HTMLElement).getByText("Worktree root B"),
    ).not.toBeNull();
  });

  it("groups threads by machine in machine mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "machine" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "Laptop", "No machine"]);
    const laptop = screen
      .getByTitle("Laptop")
      .closest("[data-sidebar-sticky-group]");
    expect(laptop).not.toBeNull();
    expect(
      within(laptop as HTMLElement).getByText("Later thread"),
    ).not.toBeNull();
    const noMachine = screen
      .getByTitle("No machine")
      .closest("[data-sidebar-sticky-group]");
    expect(
      within(noMachine as HTMLElement).getByText("Personal thread"),
    ).not.toBeNull();
  });

  it("opens the composer on the machine named by its section", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderList({ organizationMode: "machine" });

    fireEvent.click(
      await screen.findByRole("button", { name: "New thread in Laptop" }),
    );

    expect(inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: {
        projectId: PERSONAL_PROJECT_ID,
        hostId: "host_laptop",
        placement: { sectionId: null, pinned: false },
        focusPrompt: true,
      },
    });
  });

  it("shows a machine section before it has any threads", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList(
      { organizationMode: "machine" },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: THREADS,
          experimental_hosts: [
            { id: "host_laptop", name: "Laptop" },
            { id: "host_empty", name: "Studio Mac" },
          ],
        },
      },
    );

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual([
      "Pinned",
      "Laptop",
      "Studio Mac",
      "No machine",
    ]);
  });

  it("groups threads by project in project mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "project" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "App", "Web", "Threads"]);
    const appGroup = screen
      .getByTitle("App")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;
    expect(within(appGroup).getByText("Parent thread")).not.toBeNull();
    expect(within(appGroup).getByText("Child thread")).not.toBeNull();
    const webGroup = screen
      .getByTitle("Web")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;
    expect(within(webGroup).getByText("Later thread")).not.toBeNull();
    const threadsGroup = screen
      .getByTitle("Threads")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;
    expect(within(threadsGroup).getByText("Personal thread")).not.toBeNull();
  });

  it("keys its slot and preferences mirror by its own plugin id", async () => {
    window.localStorage.clear();
    expect(registration.id).toBe("project-first-sidebar");
    expect(app.threadActions.map((action) => action.id)).toContain("move");
    window.localStorage.setItem("bb.thread-list.preferences.v1", '{"organizationMode":"project"}');
    renderList({ organizationMode: "machine" }, { pluginId: "project-first-sidebar" });

    await screen.findByText("Pinned thread");
    expect(
      JSON.parse(
        window.localStorage.getItem("bb.project-first-sidebar.preferences.v1") ?? "{}",
      ).organizationMode,
    ).toBe("machine");
    expect(window.localStorage.getItem("bb.thread-list.preferences.v1")).toBe('{"organizationMode":"project"}');
    window.localStorage.clear();
  });

  it.each([true, false])(
    "renders personal rows once with standard projects: %s",
    async (includeStandardProjects) => {
      setPreferencesMirrorStorageForTest(null);
      renderList(
        { organizationMode: "project" },
        {
          sidebarThreads: {
            projects: includeStandardProjects
              ? PROJECTS
              : PROJECTS.filter((project) => project.isPersonal),
            sections: [],
            threads: THREADS.filter(
              (thread) => thread.projectId === PERSONAL_PROJECT_ID,
            ),
          },
        },
      );

      await screen.findByTitle("Threads");
      expect(threadIds()).toEqual(["thr_personal"]);
      expect(sectionHeaders()).toEqual(
        includeStandardProjects ? ["App", "Web", "Threads"] : ["Threads"],
      );
    },
  );

  it("calls onNavigate when a thread row is opened", async () => {
    setPreferencesMirrorStorageForTest(null);
    const listProps = props();
    renderSlot(registration, listProps, {
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: THREADS,
      },
      rpc: {
        listPreferences: () => ({
          preferences: {
            ...defaultPreferences(),
            organizationMode: "chronological",
          },
        }),
        listFilters: () => ({
          status: "success",
          document: defaultFilterDocument(),
        }),
      },
    });
    const link = await screen.findByRole("link", {
      name: "Open Personal thread",
    });
    link.click();
    await waitFor(() => expect(listProps.onNavigate).toHaveBeenCalledOnce());
  });

  it("keeps a custom filter selected across an external thread route change", async () => {
    setPreferencesMirrorStorageForTest(null);
    const listProps = props();
    const slot = renderSlot(registration, listProps, {
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: THREADS,
      },
      rpc: {
        listPreferences: () => ({
          preferences: {
            ...defaultPreferences(),
            organizationMode: "chronological",
          },
        }),
        listFilters: () => ({
          status: "success",
          document: {
            ...defaultFilterDocument(),
            revision: 1,
            filters: [{
              id: "work",
              name: "Рабочие",
              rule: { kind: "projectIds", projectIds: ["proj_app"] },
            }],
          },
        }),
      },
    });
    const customFilter = await within(slot.container).findByRole("radio", {
      name: "Рабочие",
    });
    fireEvent.click(customFilter);
    expect(customFilter.getAttribute("aria-checked")).toBe("true");

    slot.lifecycle.rerender(
      <registration.component
        {...listProps}
        activeThreadId="thr_personal"
        activeProjectId={PERSONAL_PROJECT_ID}
      />,
    );

    await within(slot.container).findByText("Parent thread");
    expect(within(slot.container).queryByText("Personal thread")).toBeNull();
    expect(within(slot.container).queryByText("Later thread")).toBeNull();
    expect(
      within(slot.container)
        .getByRole("radio", { name: "Рабочие" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(listProps.onNavigate).not.toHaveBeenCalled();
  });

  it("projects a static filter through project mode and both pinned policies", async () => {
    setPreferencesMirrorStorageForTest(null);
    const filterDocument = {
      ...defaultFilterDocument(),
      revision: 2,
      filters: [
        {
          id: "web-only",
          name: "Web only",
          rule: { kind: "projectIds" as const, projectIds: ["proj_web"] },
        },
      ],
    };
    const slot = renderList(
      { organizationMode: "project" },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: filterDocument }),
        },
      },
    );

    await within(slot.container).findByText("Pinned thread");
    fireEvent.click(
      within(slot.container).getByRole("radio", { name: "Web only" }),
    );
    await within(slot.container).findByText("Later thread");
    expect(sectionHeaders()).toEqual(["Web", "Threads"]);
    expect(threadIds()).toEqual(["thr_later"]);
    expect(within(slot.container).queryByText("Pinned thread")).toBeNull();

    fireEvent.click(within(slot.container).getByRole("radio", { name: "Без проектов" }));
    await within(slot.container).findByText("Personal thread");
    expect(threadIds()).toEqual(["thr_personal"]);
  });

  it.each([
    {
      mode: "project" as const,
      revision: 20,
      expectedHeaders: ["Web", "Threads"],
    },
    {
      mode: "chronological" as const,
      revision: 21,
      expectedHeaders: ["Later", "Review", "Threads"],
    },
    {
      mode: "machine" as const,
      revision: 22,
      expectedHeaders: ["Laptop"],
    },
  ])(
    "projects rows, shortcuts, and empty catalog groups in $mode mode",
    async ({ mode, revision, expectedHeaders }) => {
      setPreferencesMirrorStorageForTest(null);
      const slot = renderList(
        { organizationMode: mode },
        {
          sidebarThreads: {
            projects: PROJECTS,
            sections: SECTIONS,
            threads: THREADS,
            experimental_hosts: [
              { id: "host_laptop", name: "Laptop" },
              { id: "host_empty", name: "Studio Mac" },
            ],
          },
          rpc: {
            listFilters: () => ({
              status: "success",
              document: {
                ...defaultFilterDocument(),
                revision,
                filters: [
                  {
                    id: `web-only-${mode}`,
                    name: `Web only ${mode}`,
                    rule: {
                      kind: "projectIds" as const,
                      projectIds: ["proj_web"],
                    },
                  },
                ],
              },
            }),
          },
        },
      );

      fireEvent.click(
        await within(slot.container).findByRole("radio", {
          name: `Web only ${mode}`,
        }),
      );
      await within(slot.container).findByText("Later thread");
      expect(sectionHeaders()).toEqual(
        mode === "machine"
          ? ["Laptop", "Studio Mac"]
          : expectedHeaders,
      );
      expect(threadIds()).toEqual(["thr_later"]);
      expect(
        Array.from(
          slot.container.querySelectorAll(
            "[data-sidebar-thread-shortcut-target]",
          ),
          (element) => element.getAttribute("data-sidebar-thread-id"),
        ),
      ).toEqual(["thr_later"]);
      expect(within(slot.container).queryByText("Pinned thread")).toBeNull();
      expect(within(slot.container).queryByText("Parent thread")).toBeNull();
      expect(within(slot.container).queryByText("Personal thread")).toBeNull();
    },
  );

  it("keeps hidden machine groups projected inside More", async () => {
    setPreferencesMirrorStorageForTest(null);
    const slot = renderList(
      {
        organizationMode: "machine",
        hiddenGroups: ["machine:host_laptop"],
      },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: [
            ...THREADS.map((thread) =>
              thread.id === "thr_later"
                ? {
                    ...thread,
                    status: "idle" as const,
                    runtimeStatus: "idle" as const,
                    lastReadAt: thread.latestAttentionAt,
                    isUnread: false,
                    activity: {
                      workflows: 0,
                      backgroundAgents: 0,
                      backgroundCommands: 0,
                      planMode: 0,
                      goals: 0,
                    },
                  }
                : thread,
            ),
            makeSidebarThread({
              id: "thr_foreign_laptop",
              projectId: "proj_app",
              title: "Foreign laptop activity",
              host: { id: "host_laptop", name: "Laptop" },
              runtimeStatus: "active",
              activity: {
                workflows: 0,
                backgroundAgents: 0,
                backgroundCommands: 0,
                planMode: 1,
                goals: 0,
              },
            }),
          ],
        },
        rpc: {
          listFilters: () => ({
            status: "success",
            document: {
              ...defaultFilterDocument(),
              revision: 23,
              filters: [
                {
                  id: "web-only-more",
                  name: "Web only More",
                  rule: {
                    kind: "projectIds" as const,
                    projectIds: ["proj_web"],
                  },
                },
              ],
            },
          }),
        },
      },
    );

    fireEvent.click(
      await within(slot.container).findByRole("radio", {
        name: "Web only More",
      }),
    );
    const more = await within(slot.container).findByRole("button", {
      name: "More machines",
    });
    expect(threadIds()).toEqual([]);
    expect(more.querySelector("[data-thread-status-glyph]")).toBeNull();
    fireEvent.keyDown(more, { key: "Enter" });
    const hiddenMachine = await screen.findByRole("menuitem", {
      name: /Laptop/,
    });
    fireEvent.keyDown(hiddenMachine, { key: "ArrowRight" });
    await screen.findByText("Later thread");
    expect(threadIds()).toEqual(["thr_later"]);
    expect(within(slot.container).queryByText("Pinned thread")).toBeNull();
    expect(within(slot.container).queryByText("Personal thread")).toBeNull();
    expect(screen.queryByText("Foreign laptop activity")).toBeNull();
  });

  it("shows the full pinned subtree as the only foreign-project exception", async () => {
    setPreferencesMirrorStorageForTest(null);
    const slot = renderList(
      { organizationMode: "project" },
      {
        rpc: {
          listFilters: () => ({
            status: "success",
            document: {
              ...defaultFilterDocument(),
              revision: 24,
              pinnedMode: "always-show",
              filters: [
                {
                  id: "web-only",
                  name: "Web only",
                  rule: {
                    kind: "projectIds" as const,
                    projectIds: ["proj_web"],
                  },
                },
              ],
            },
          }),
        },
      },
    );

    await within(slot.container).findByText("Pinned thread");
    fireEvent.click(
      within(slot.container).getByRole("radio", { name: "Web only" }),
    );
    await waitFor(() =>
      expect(
        within(slot.container)
          .getByRole("radio", { name: "Web only" })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
    await within(slot.container).findByText("Later thread");
    expect(threadIds()).toEqual(["thr_pinned", "thr_later"]);
    expect(within(slot.container).queryByText("Parent thread")).toBeNull();
    expect(within(slot.container).queryByText("Personal thread")).toBeNull();
  });

  it("distinguishes a zero full-catalog match without hiding pinned exceptions", async () => {
    setPreferencesMirrorStorageForTest(null);
    const zeroMatchDocument = {
      ...defaultFilterDocument(),
      revision: 30,
      filters: [
        {
          id: "missing-project",
          name: "Missing project",
          rule: {
            kind: "projectIds" as const,
            projectIds: ["proj_missing"],
          },
        },
      ],
    };
    const emptySlot = renderList(
      { organizationMode: "project" },
      {
        rpc: {
          listFilters: () => ({
            status: "success",
            document: zeroMatchDocument,
          }),
        },
      },
    );

    fireEvent.click(
      await within(emptySlot.container).findByRole("radio", {
        name: "Missing project",
      }),
    );
    expect(
      await within(emptySlot.container).findByText(
        "Нет проектов по этому фильтру",
      ),
    ).not.toBeNull();
    emptySlot.lifecycle.unmount();

    const pinnedSlot = renderList(
      { organizationMode: "project" },
      {
        rpc: {
          listFilters: () => ({
            status: "success",
            document: {
              ...zeroMatchDocument,
              revision: 31,
              pinnedMode: "always-show",
            },
          }),
        },
      },
    );
    fireEvent.click(
      await within(pinnedSlot.container).findByRole("radio", {
        name: "Missing project",
      }),
    );
    expect(
      await within(pinnedSlot.container).findByText("Pinned thread"),
    ).not.toBeNull();
    expect(
      within(pinnedSlot.container).queryByText("Нет проектов по этому фильтру"),
    ).toBeNull();
  });

  it.each([
    {
      hasNextPage: true,
      message: "Нет подходящих тредов среди загруженных",
    },
    {
      hasNextPage: false,
      message: "Нет тредов по этому фильтру",
    },
  ])(
    "renders the filtered archive empty state when hasNextPage=$hasNextPage",
    async ({ hasNextPage, message }) => {
      setPreferencesMirrorStorageForTest(null);
      const fetchNextPage = vi.fn(async () => undefined);
      const slot = renderList(
        { organizationMode: "chronological" },
        {
          sidebarThreads: {
            projects: PROJECTS,
            sections: SECTIONS,
            threads: THREADS.filter(
              (thread) => thread.projectId !== "proj_app",
            ),
            experimental_archived: {
              status: "ready",
              hasNextPage,
              isFetchingNextPage: false,
              isFetchNextPageError: false,
              fetchNextPage,
            },
          },
          rpc: {
            listFilters: () => ({
              status: "success",
              document: {
                ...defaultFilterDocument(),
                revision: hasNextPage ? 32 : 33,
                filters: [
                  {
                    id: "app-only",
                    name: "App only",
                    rule: {
                      kind: "projectIds" as const,
                      projectIds: ["proj_app"],
                    },
                  },
                ],
              },
            }),
          },
        },
      );

      fireEvent.click(
        await within(slot.container).findByRole("radio", { name: "App only" }),
      );
      expect(await within(slot.container).findByText(message)).not.toBeNull();
      expect(fetchNextPage).not.toHaveBeenCalled();
      if (hasNextPage) {
        fireEvent.click(
          within(slot.container).getByRole("button", {
            name: "Load more archived threads",
          }),
        );
        await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());
      } else {
        expect(
          within(slot.container).queryByRole("button", {
            name: "Load more archived threads",
          }),
        ).toBeNull();
      }
    },
  );

  it.each([
    {
      initialStatus: "loading" as const,
      revision: 40,
      stockAssertion: (container: HTMLElement) =>
        expect(
          within(container).getByLabelText("Loading sidebar navigation"),
        ).not.toBeNull(),
    },
    {
      initialStatus: "error" as const,
      revision: 42,
      stockAssertion: (container: HTMLElement) =>
        expect(
          within(container).getAllByText("Threads unavailable").length,
        ).toBeGreaterThan(0),
    },
  ])(
    "gates filtered empty states across $initialStatus to ready",
    async ({ initialStatus, revision, stockAssertion }) => {
      setPreferencesMirrorStorageForTest(null);
      const filterDocument = {
        ...defaultFilterDocument(),
        revision,
        filters: [
          {
            id: `empty-${initialStatus}`,
            name: `Empty ${initialStatus}`,
            rule: {
              kind: "projectIds" as const,
              projectIds: ["proj_missing"],
            },
          },
        ],
      };
      const initialSidebarState: PluginSidebarThreadsState = {
        status: initialStatus,
        projects: [],
        sections: [],
        threads: [],
        experimental_archived: null,
      };
      const harness = createMutableSidebarRegistration(initialSidebarState);
      const sourceOwnerIdentity = harness.getSourceOwnerIdentity();
      const sourceHookIdentity = harness.getSourceHookIdentity();
      const listProps = props();
      const slot = renderSlot({ component: harness.Component }, listProps, {
        sidebarThreads: initialSidebarState,
        rpc: {
          listPreferences: () => ({
            preferences: {
              ...defaultPreferences(),
              organizationMode: "project",
            },
          }),
          listFilters: () => ({
            status: "success",
            document: filterDocument,
          }),
        },
      });
      expect(harness.getSidebarState()).toBe(initialSidebarState);
      expect(harness.getSourceOwnerIdentity()).toBe(sourceOwnerIdentity);
      expect(harness.getInstalledSourceHookIdentity()).toBe(
        sourceHookIdentity,
      );
      fireEvent.click(
        await within(slot.container).findByRole("radio", {
          name: `Empty ${initialStatus}`,
        }),
      );
      expect(
        within(slot.container).queryByText("Нет проектов по этому фильтру"),
      ).toBeNull();
      stockAssertion(slot.container);
      const instanceIdentity = harness.getInstanceIdentity();

      harness.updateSidebarState({
        status: "ready",
        projects: [],
        sections: [],
        threads: [],
      });
      slot.lifecycle.rerender(
        <harness.Component
          {...listProps}
          activeThreadId={`transition-${initialStatus}`}
        />,
      );
      expect(harness.getInstanceIdentity()).toBe(instanceIdentity);
      expect(harness.getSourceOwnerIdentity()).toBe(sourceOwnerIdentity);
      expect(harness.getInstalledSourceHookIdentity()).toBe(
        sourceHookIdentity,
      );
      expect(
        within(slot.container)
          .getByRole("radio", { name: `Empty ${initialStatus}` })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        await within(slot.container).findByText(
          "Нет проектов по этому фильтру",
        ),
      ).not.toBeNull();
      expect(
        within(slot.container).queryByLabelText("Loading sidebar navigation"),
      ).toBeNull();
      expect(
        within(slot.container).queryByText("Threads unavailable"),
      ).toBeNull();
    },
  );

  it("treats SDK-hidden rows as non-renderable for filtered empty states", async () => {
    setPreferencesMirrorStorageForTest(null);
    const slot = renderList(
      { organizationMode: "chronological" },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: [
            makeSidebarThread({
              id: "thr_hidden_match",
              projectId: "proj_app",
              title: "Hidden match",
              isHidden: true,
            }),
          ],
          experimental_archived: {
            status: "ready",
            hasNextPage: false,
            isFetchingNextPage: false,
            isFetchNextPageError: false,
            fetchNextPage: vi.fn(async () => undefined),
          },
        },
        rpc: {
          listFilters: () => ({
            status: "success",
            document: {
              ...defaultFilterDocument(),
              revision: 44,
              filters: [
                {
                  id: "hidden-match",
                  name: "Hidden match",
                  rule: {
                    kind: "projectIds" as const,
                    projectIds: ["proj_app"],
                  },
                },
              ],
            },
          }),
        },
      },
    );

    fireEvent.click(
      await within(slot.container).findByRole("radio", {
        name: "Hidden match",
      }),
    );
    expect(
      await within(slot.container).findByText("Нет тредов по этому фильтру"),
    ).not.toBeNull();
    expect(
      slot.container.querySelector(
        '[data-sidebar-thread-id="thr_hidden_match"]',
      ),
    ).toBeNull();
  });

  it.each([
    { hidden: true, revision: 45, expectZeroProject: true },
    { hidden: false, revision: 46, expectZeroProject: false },
  ])(
    "handles a pinned exception with SDK hidden=$hidden",
    async ({ hidden, revision, expectZeroProject }) => {
      setPreferencesMirrorStorageForTest(null);
      const slot = renderList(
        { organizationMode: "project" },
        {
          sidebarThreads: {
            projects: PROJECTS,
            sections: [],
            threads: [
              makeSidebarThread({
                id: `thr_pinned_${hidden ? "hidden" : "visible"}`,
                projectId: "proj_app",
                title: hidden ? "Hidden pinned" : "Visible pinned",
                pinnedAt: 1,
                isHidden: hidden,
              }),
            ],
          },
          rpc: {
            listFilters: () => ({
              status: "success",
              document: {
                ...defaultFilterDocument(),
                revision,
                pinnedMode: "always-show",
                filters: [
                  {
                    id: `missing-pinned-${hidden}`,
                    name: `Missing pinned ${hidden}`,
                    rule: {
                      kind: "projectIds" as const,
                      projectIds: ["proj_missing"],
                    },
                  },
                ],
              },
            }),
          },
        },
      );

      fireEvent.click(
        await within(slot.container).findByRole("radio", {
          name: `Missing pinned ${hidden}`,
        }),
      );
      if (expectZeroProject) {
        expect(
          await within(slot.container).findByText(
            "Нет проектов по этому фильтру",
          ),
        ).not.toBeNull();
        expect(within(slot.container).queryByText("Hidden pinned")).toBeNull();
      } else {
        expect(
          await within(slot.container).findByText("Visible pinned"),
        ).not.toBeNull();
        expect(
          within(slot.container).queryByText(
            "Нет проектов по этому фильтру",
          ),
        ).toBeNull();
      }
    },
  );

  it("does not treat a preference-hidden project group as an empty filter", async () => {
    setPreferencesMirrorStorageForTest(null);
    const slot = renderList(
      {
        organizationMode: "project",
        hiddenGroups: ["project:proj_app"],
      },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: [],
          threads: [
            makeSidebarThread({
              id: "thr_preference_hidden",
              projectId: "proj_app",
              title: "Preference hidden",
            }),
          ],
        },
        rpc: {
          listFilters: () => ({
            status: "success",
            document: {
              ...defaultFilterDocument(),
              revision: 47,
              filters: [
                {
                  id: "app-hidden-group",
                  name: "App hidden group",
                  rule: {
                    kind: "projectIds" as const,
                    projectIds: ["proj_app"],
                  },
                },
              ],
            },
          }),
        },
      },
    );

    fireEvent.click(
      await within(slot.container).findByRole("radio", {
        name: "App hidden group",
      }),
    );
    expect(
      await within(slot.container).findByRole("button", {
        name: "More projects",
      }),
    ).not.toBeNull();
    expect(
      within(slot.container).queryByText("Нет проектов по этому фильтру"),
    ).toBeNull();
  });

  it("keeps archive retry manual and reaches exhaustion after a successful retry", async () => {
    setPreferencesMirrorStorageForTest(null);
    const pendingFetches: Array<() => void> = [];
    const fetchNextPage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          pendingFetches.push(resolve);
        }),
    );
    const filterDocument = {
      ...defaultFilterDocument(),
      revision: 48,
      filters: [
        {
          id: "archive-retry",
          name: "Archive retry",
          rule: {
            kind: "projectIds" as const,
            projectIds: ["proj_app"],
          },
        },
      ],
    };
    const initialArchiveState: PluginSidebarThreadsState = {
      status: "ready",
      projects: PROJECTS,
      sections: SECTIONS,
      threads: [],
      experimental_archived: {
        status: "error",
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: true,
        fetchNextPage,
      },
    };
    const harness = createMutableSidebarRegistration(initialArchiveState);
    const sourceOwnerIdentity = harness.getSourceOwnerIdentity();
    const sourceHookIdentity = harness.getSourceHookIdentity();
    const initialArchiveController = initialArchiveState.experimental_archived;
    if (initialArchiveController === null) {
      throw new Error("initial archive controller missing");
    }
    const listProps = props();
    const slot = renderSlot({ component: harness.Component }, listProps, {
      sidebarThreads: initialArchiveState,
      rpc: {
        listPreferences: () => ({
          preferences: {
            ...defaultPreferences(),
            organizationMode: "chronological",
          },
        }),
        listFilters: () => ({
          status: "success",
          document: filterDocument,
        }),
      },
    });
    expect(harness.getSidebarState()).toBe(initialArchiveState);
    expect(harness.getSourceOwnerIdentity()).toBe(sourceOwnerIdentity);
    expect(harness.getInstalledSourceHookIdentity()).toBe(sourceHookIdentity);
    expect(harness.getSidebarState().experimental_archived).toBe(
      initialArchiveController,
    );
    fireEvent.click(
      await within(slot.container).findByRole("radio", {
        name: "Archive retry",
      }),
    );
    expect(
      await within(slot.container).findByText(
        "Нет подходящих тредов среди загруженных",
      ),
    ).not.toBeNull();
    expect(
      within(slot.container).getByText("Archived threads unavailable"),
    ).not.toBeNull();
    const retry = within(slot.container).getByRole("button", {
      name: "Load more archived threads",
    });
    expect(retry.textContent).toBe("Retry loading");
    expect(fetchNextPage).not.toHaveBeenCalled();
    const instanceIdentity = harness.getInstanceIdentity();
    const archiveSource = harness.getSidebarState().experimental_archived;
    if (archiveSource === null) throw new Error("archive source not captured");
    expect(archiveSource).toBe(initialArchiveController);

    fireEvent.click(retry);
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledOnce());
    await act(async () => {
      pendingFetches.shift()?.();
      await Promise.resolve();
    });
    harness.updateSidebarState({ experimental_archived: archiveSource });
    slot.lifecycle.rerender(
      <harness.Component {...listProps} activeThreadId="archive-retry-1" />,
    );
    expect(harness.getInstanceIdentity()).toBe(instanceIdentity);
    expect(harness.getSourceOwnerIdentity()).toBe(sourceOwnerIdentity);
    expect(harness.getInstalledSourceHookIdentity()).toBe(sourceHookIdentity);
    expect(harness.getSidebarState().experimental_archived).toBe(
      initialArchiveController,
    );
    expect(
      within(slot.container).getByText("Archived threads unavailable"),
    ).not.toBeNull();
    const secondRetry = within(slot.container).getByRole("button", {
      name: "Load more archived threads",
    });
    expect(secondRetry.textContent).toBe("Retry loading");

    fireEvent.click(secondRetry);
    await waitFor(() => expect(fetchNextPage).toHaveBeenCalledTimes(2));
    Object.assign(archiveSource, {
      status: "ready",
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetchNextPageError: false,
    });
    await act(async () => {
      pendingFetches.shift()?.();
      await Promise.resolve();
    });
    harness.updateSidebarState({ experimental_archived: archiveSource });
    slot.lifecycle.rerender(
      <harness.Component {...listProps} activeThreadId="archive-retry-2" />,
    );
    expect(harness.getInstanceIdentity()).toBe(instanceIdentity);
    expect(harness.getSourceOwnerIdentity()).toBe(sourceOwnerIdentity);
    expect(harness.getInstalledSourceHookIdentity()).toBe(sourceHookIdentity);
    expect(harness.getSidebarState().experimental_archived).toBe(
      initialArchiveController,
    );
    expect(
      await within(slot.container).findByText(
        "Нет тредов по этому фильтру",
      ),
    ).not.toBeNull();
    expect(
      within(slot.container).queryByText("Archived threads unavailable"),
    ).toBeNull();
    expect(
      within(slot.container).queryByRole("button", {
        name: "Load more archived threads",
      }),
    ).toBeNull();
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});
