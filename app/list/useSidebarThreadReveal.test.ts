import { describe, expect, it } from "vitest";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  makePluginProject,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { projectSidebarSnapshot } from "../model/sidebar-projection.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import {
  INITIAL_SIDEBAR_THREAD_REVEAL_STATE,
  resolveThreadRevealExpansion,
  stepSidebarThreadReveal,
} from "./useSidebarThreadReveal.js";

function thread(id: string, overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    id,
    projectId: "proj_personal",
    sectionId: id,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  });
}

interface RevealInputs {
  selectedThreadId: string | undefined;
  threads: SidebarThread[];
  threadsReady: boolean;
  preferencesReady: boolean;
}

function startReveal(
  initial: Partial<RevealInputs> & { threads: SidebarThread[] },
) {
  let state = INITIAL_SIDEBAR_THREAD_REVEAL_STATE;
  const current: RevealInputs = {
    selectedThreadId: "first",
    threadsReady: true,
    preferencesReady: true,
    ...initial,
  };
  const reveal = (next: Partial<RevealInputs> = {}) => {
    Object.assign(current, next);
    const step = stepSidebarThreadReveal(state, {
      ...current,
      threadById: new Map(current.threads.map((item) => [item.id, item])),
    });
    state = step.state;
    return [...step.revealIds];
  };
  return { initial: reveal(), reveal };
}

describe("useSidebarThreadReveal", () => {
  it("requires leaving and returning before revealing the open thread again", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first"), thread("second")],
    });
    expect(initial).toEqual(["first"]);

    expect(
      reveal({
        threads: [
          thread("first", { title: "Updated", latestAttentionAt: 2 }),
          thread("second"),
        ],
      }),
    ).toEqual([]);

    expect(reveal({ selectedThreadId: undefined })).toEqual([]);
    expect(reveal({ selectedThreadId: "first" })).toEqual(["first"]);
  });

  it("reveals only newly unread non-open threads", () => {
    const { reveal } = startReveal({
      threads: [thread("first"), thread("second"), thread("third")],
    });
    expect(
      reveal({
        threads: [
          thread("first", { latestAttentionAt: 2 }),
          thread("second", { latestAttentionAt: 2 }),
          thread("third"),
        ],
      }),
    ).toEqual(["second"]);

    expect(
      reveal({
        threads: [
          thread("first", { latestAttentionAt: 2 }),
          thread("second", { latestAttentionAt: 3 }),
          thread("third"),
        ],
      }),
    ).toEqual([]);

    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { lastReadAt: 3, latestAttentionAt: 3 }),
          thread("third"),
        ],
      }),
    ).toEqual([]);
    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { lastReadAt: 3, latestAttentionAt: 4 }),
          thread("third"),
        ],
      }),
    ).toEqual(["second"]);
  });

  it("keeps initially unread threads collapsed and ignores hidden unread threads", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(initial).toEqual(["first"]);
    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { latestAttentionAt: 2 }),
          thread("third", { latestAttentionAt: 2, isHidden: true }),
        ],
      }),
    ).toEqual([]);
  });

  it("waits for the threads to be ready before establishing the unread baseline", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first")],
      threadsReady: false,
    });
    expect(initial).toEqual([]);

    expect(
      reveal({
        threadsReady: true,
        threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
      }),
    ).toEqual(["first"]);

    expect(reveal({ threads: [thread("first"), thread("second")] })).toEqual(
      [],
    );
    expect(
      reveal({
        threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
      }),
    ).toEqual(["second"]);
  });

  it("waits for preferences and the destination thread before revealing navigation", () => {
    const { initial, reveal } = startReveal({
      threads: [],
      preferencesReady: false,
    });
    expect(initial).toEqual([]);
    expect(reveal({ preferencesReady: true })).toEqual([]);
    expect(reveal({ threads: [thread("first")] })).toEqual(["first"]);
  });

  it("ignores a real foreign unread transition while the route stays unchanged", () => {
    const projects = [
      makePluginProject({ id: "proj_visible", name: "Visible" }),
      makePluginProject({ id: "proj_foreign", name: "Foreign" }),
    ];
    const document = {
      schemaVersion: 1 as const,
      revision: 1,
      pinnedMode: "filter" as const,
      filters: [
        {
          id: "visible-only",
          name: "Visible only",
          rule: {
            kind: "projectIds" as const,
            projectIds: ["proj_visible"],
          },
        },
      ],
    };
    const visible = thread("visible", { projectId: "proj_visible" });
    const foreignParent = thread("foreign-parent", {
      projectId: "proj_foreign",
      sectionId: "sec_foreign",
      host: { id: "host_foreign", name: "Foreign host" },
    });
    const foreignChild = thread("foreign-child", {
      projectId: "proj_foreign",
      parentThreadId: "foreign-parent",
      sectionId: "sec_foreign",
      host: { id: "host_foreign", name: "Foreign host" },
    });
    const project = (threads: SidebarThread[]) =>
      projectSidebarSnapshot({
        activeFilterId: "visible-only",
        document,
        snapshot: { projects, threads },
      });
    let state = INITIAL_SIDEBAR_THREAD_REVEAL_STATE;
    const initialProjection = project([visible, foreignParent, foreignChild]);
    const initial = stepSidebarThreadReveal(state, {
      selectedThreadId: "visible",
      threads: initialProjection.visible.threads,
      threadById: new Map(
        initialProjection.visible.threads.map((item) => [item.id, item]),
      ),
      threadsReady: true,
      preferencesReady: true,
    });
    state = initial.state;
    expect([...initial.revealIds]).toEqual(["visible"]);

    const unreadForeignChild = {
      ...foreignChild,
      latestAttentionAt: 2,
      isUnread: true,
    };
    const updatedProjection = project([
      visible,
      foreignParent,
      unreadForeignChild,
    ]);
    const updated = stepSidebarThreadReveal(state, {
      selectedThreadId: "visible",
      threads: updatedProjection.visible.threads,
      threadById: new Map(
        updatedProjection.visible.threads.map((item) => [item.id, item]),
      ),
      threadsReady: true,
      preferencesReady: true,
    });

    expect([...updated.revealIds]).toEqual([]);
    expect(updated.navigationRevealId).toBeUndefined();
    expect([...updatedProjection.visible.threadIds]).toEqual(["visible"]);
    expect(updatedProjection.visible.threadIds.has("foreign-parent")).toBe(
      false,
    );
    expect(updatedProjection.visible.threadIds.has("foreign-child")).toBe(
      false,
    );
  });

  it("expands only ancestors present in the projected thread map", () => {
    const child = thread("visible-child", {
      parentThreadId: "foreign-parent",
      environment: makeSidebarEnvironment({ id: "env_visible" }),
    });

    const { threadIdsToExpand, environmentIdsToExpand } =
      resolveThreadRevealExpansion({
        thread: child,
        threadById: new Map([[child.id, child]]),
        effectivePinnedThreadIds: new Set(),
        organizationMode: "chronological",
        personalProjectId: "proj_personal",
      });

    expect([...threadIdsToExpand]).toEqual([]);
    expect([...environmentIdsToExpand]).toEqual(["env_visible"]);
  });

  it("reveals the pinned ancestors and environment of a newly unread child", () => {
    const parent = thread("parent", {
      pinnedAt: 1,
      environment: makeSidebarEnvironment({ id: "env_parent" }),
    });
    const child = thread("child", {
      parentThreadId: "parent",
      environment: makeSidebarEnvironment({ id: "env_child" }),
      latestAttentionAt: 2,
    });
    const threads = [thread("first"), parent, child];

    const { threadIdsToExpand, environmentIdsToExpand, expansion } =
      resolveThreadRevealExpansion({
        thread: child,
        threadById: new Map(threads.map((item) => [item.id, item])),
        effectivePinnedThreadIds: buildPinnedSidebarState({ threads })
          .effectivePinnedThreadIds,
        organizationMode: "chronological",
        personalProjectId: "proj_personal",
      });

    expect([...threadIdsToExpand]).toEqual(["parent"]);
    expect([...environmentIdsToExpand].sort()).toEqual([
      "env_child",
      "env_parent",
    ]);
    expect(expansion).toEqual({ sidebarSectionId: "pinned" });
  });
});
