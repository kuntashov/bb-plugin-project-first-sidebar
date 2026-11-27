// @vitest-environment jsdom

import { useEffect, useState } from "react";
import { act, cleanup } from "@testing-library/react";
import type { DragEndEvent, DragOverEvent, DragStartEvent } from "@dnd-kit/core";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import {
  projectSectionCollapseKey,
  projectSectionLooseDropKey,
  type ProjectSectionDocumentV1,
} from "../../shared/project-sections.js";
import { NO_COLLAPSED_CHILD_ACTIVITY } from "../model/thread-activity.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import {
  CHRONOLOGICAL_CONTAINER_ID,
  type ProjectThreadItem,
  type ProjectThreadNode,
} from "../model/project-thread-groups.js";
import type { SidebarSectionId } from "../model/sidebar-section-id.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { projectSectionAssignmentStore } from "../project-sections/assignment-store.js";
import { getSidebarThreadRowDroppableId } from "../rows/sidebarThreadRowDroppable.js";
import type { SectionThreadDndState } from "./useSectionThreadDnd.js";

installTestPluginRuntime();
const { useSectionThreadDnd } = await import("./useSectionThreadDnd.js");

const PROJECT_A = "proj_a";
const PROJECT_B = "proj_b";
const EMPTY_SECTION = "sec_empty";
const FULL_SECTION = "sec_full";
const HIDDEN_SECTION = "sec_hidden";
const OTHER_SECTION = "sec_other";
const EMPTY_KEY = projectSectionCollapseKey(PROJECT_A, EMPTY_SECTION);
const FULL_KEY = projectSectionCollapseKey(PROJECT_A, FULL_SECTION);
const LOOSE_KEY = projectSectionLooseDropKey(PROJECT_A);
const OTHER_KEY = projectSectionCollapseKey(PROJECT_B, OTHER_SECTION);
const STORED_A = [EMPTY_SECTION, HIDDEN_SECTION, FULL_SECTION];
const VISIBLE_A = [EMPTY_SECTION, FULL_SECTION];
const TOP_LEVEL: readonly SidebarSectionId[] = [
  "pinned",
  `project:${PROJECT_A}`,
  `project:${PROJECT_B}`,
  "threads",
];

function createThread(overrides: SidebarThreadOverrides): SidebarThread {
  return makeSidebarThread({
    id: "thread",
    projectId: PROJECT_A,
    title: "Thread",
    titleFallback: "Thread",
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

function threadNode(
  thread: SidebarThread,
  children: ProjectThreadItem[] = [],
): ProjectThreadNode {
  return {
    thread,
    children,
    depth: 0,
    stats: { childCount: children.length, childActivity: NO_COLLAPSED_CHILD_ACTIVITY },
  };
}

function threadItem(
  thread: SidebarThread,
  children: ProjectThreadItem[] = [],
): ProjectThreadItem {
  return { kind: "thread", node: threadNode(thread, children) };
}

function projectItems(
  projectId: string,
  name: string,
  items: readonly ProjectThreadItem[],
): ProjectThreadItem {
  return {
    kind: "section",
    group: {
      id: projectId,
      key: `project:${projectId}`,
      name,
      items: [...items],
      threadCount: items.length,
      activity: NO_COLLAPSED_CHILD_ACTIVITY,
    },
  };
}

function sectionItems(
  projectId: string,
  sections: readonly { id: string; name: string; items: ProjectThreadItem[] }[],
  looseItems: ProjectThreadItem[],
): ProjectThreadItem[] {
  return [
    ...sections.map((section) => ({
      kind: "section" as const,
      group: {
        id: section.id,
        key: projectSectionCollapseKey(projectId, section.id),
        name: section.name,
        items: section.items,
        threadCount: section.items.length,
        activity: NO_COLLAPSED_CHILD_ACTIVITY,
      },
    })),
    {
      kind: "section",
      group: {
        id: `loose:${projectId}`,
        key: projectSectionLooseDropKey(projectId),
        name: "",
        items: looseItems,
        threadCount: looseItems.length,
        activity: NO_COLLAPSED_CHILD_ACTIVITY,
      },
    },
  ];
}

function sectionDocument(sectionIds: readonly string[]): ProjectSectionDocumentV1 {
  return {
    schemaVersion: 1,
    revision: 2,
    sections: [
      { id: EMPTY_SECTION, projectId: PROJECT_A, name: "Empty" },
      { id: HIDDEN_SECTION, projectId: PROJECT_A, name: "Hidden" },
      { id: FULL_SECTION, projectId: PROJECT_A, name: "Full" },
      { id: OTHER_SECTION, projectId: PROJECT_B, name: "Other" },
    ],
    order: [
      { projectId: PROJECT_A, sectionIds: [...sectionIds] },
      { projectId: PROJECT_B, sectionIds: [OTHER_SECTION] },
    ],
  };
}

interface ProjectSectionGesture {
  orderKey: string;
  revision: number;
  shownSectionByThreadId: ReadonlyMap<string, string | null>;
  storedSectionIdsByProject: ReadonlyMap<string, readonly string[]>;
  visibleSectionIdsByProject: ReadonlyMap<string, readonly string[]>;
}

function gesture(
  shown: readonly (readonly [string, string | null])[],
  orderKey = "order:1",
): ProjectSectionGesture {
  return {
    orderKey,
    revision: 1,
    shownSectionByThreadId: new Map(shown),
    storedSectionIdsByProject: new Map([
      [PROJECT_A, STORED_A],
      [PROJECT_B, [OTHER_SECTION]],
    ]),
    visibleSectionIdsByProject: new Map([
      [PROJECT_A, VISIBLE_A],
      [PROJECT_B, [OTHER_SECTION]],
    ]),
  };
}

function dragStart(id: string): DragStartEvent {
  return { active: { id } } as DragStartEvent;
}

function dragOver(activeId: string, overId: string): DragOverEvent {
  return { active: { id: activeId }, over: { id: overId } } as DragOverEvent;
}

function dragEnd(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId }, over: { id: overId } } as DragEndEvent;
}

async function flushTasks(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function assignmentCalls(calls: readonly { method: string; input: unknown }[]) {
  return calls.filter((call) => (
    call.method === "assignProjectSection" || call.method === "clearProjectSectionAssignment"
  ));
}

function metadataReads(calls: readonly { method: string; input: unknown }[]) {
  return calls.filter((call) => call.method === "readProjectSectionMetadata");
}

interface HarnessProps {
  gesture: ProjectSectionGesture;
  pinnedThreads?: readonly SidebarThread[];
  projectionKey?: string;
  rootItems: readonly ProjectThreadItem[];
  topLevelSectionOrder?: readonly SidebarSectionId[];
  watchedThreadIds: readonly string[];
}

function renderProjectSectionDrag(
  props: HarnessProps,
  rpc: Record<string, (input: unknown) => unknown> = {},
) {
  const result: { current: SectionThreadDndState | null } = { current: null };
  const onTopLevelSectionOrderChange = vi.fn();
  function WatchRoots({ threadIds }: { threadIds: readonly string[] }) {
    const client = useRpc<typeof projectFirstSidebarRpcContract>();
    const [owner] = useState(() => Symbol());
    useEffect(() => {
      const release = projectSectionAssignmentStore.acquire(client);
      projectSectionAssignmentStore.watch(owner, threadIds);
      return () => {
        projectSectionAssignmentStore.unwatch(owner);
        release();
      };
    }, [client, owner, threadIds]);
    return null;
  }
  function Harness({
    gesture: projectSectionGesture,
    pinnedThreads = [],
    projectionKey = "projection:initial",
    rootItems,
    topLevelSectionOrder = TOP_LEVEL,
    watchedThreadIds,
  }: HarnessProps) {
    result.current = useSectionThreadDnd({
      containerId: CHRONOLOGICAL_CONTAINER_ID,
      enabled: true,
      groups: true,
      onReorderPinnedThread: vi.fn(),
      onTopLevelSectionOrderChange,
      pinnedReorderPending: false,
      pinnedRootItems: [],
      pinnedRootNodes: [],
      pinnedThreads,
      projectionKey,
      projectSectionGesture,
      rootItems,
      topLevelSectionOrder,
    });
    return <WatchRoots threadIds={watchedThreadIds} />;
  }
  const slot = renderSlot(
    { component: Harness },
    { ...props, watchedThreadIds: props.watchedThreadIds },
    {
      rpc: {
        readProjectSectionMetadata: (input: unknown) => {
          const threadIds = (input as { threadIds: string[] }).threadIds;
          return {
            status: "success",
            threads: threadIds.map((threadId) => ({ threadId, metadata: {} })),
          };
        },
        assignProjectSection: async () => ({ status: "success" }),
        clearProjectSectionAssignment: async () => ({ status: "success" }),
        reorderProjectSections: async () => ({
          status: "success",
          document: sectionDocument([FULL_SECTION, HIDDEN_SECTION, EMPTY_SECTION]),
        }),
        listProjectSections: async () => ({
          status: "success",
          document: sectionDocument(STORED_A),
        }),
        ...rpc,
      },
      sdk: {
        threads: {
          update: vi.fn(async () => undefined as never),
          pin: vi.fn(async () => undefined as never),
          unpin: vi.fn(async () => undefined as never),
        },
      },
    },
  );
  return {
    inspection: slot.inspection,
    onTopLevelSectionOrderChange,
    props: () => result.current!.dndContextProps,
    rerender: (next: HarnessProps) => slot.rerender(<Harness {...next} />),
    result,
    unmount: () => slot.unmount(),
  };
}

afterEach(async () => {
  cleanup();
  await flushTasks();
});

describe("project section drag", () => {
  it("assigns a visible root to an empty section and clears it into the loose list", async () => {
    const loose = createThread({ id: "loose-root" });
    const housed = createThread({ id: "housed-root" });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [
          { id: EMPTY_SECTION, name: "Empty", items: [] },
          { id: FULL_SECTION, name: "Full", items: [threadItem(housed)] },
        ],
        [threadItem(loose)],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([
        ["loose-root", null],
        ["housed-root", FULL_SECTION],
      ]),
      rootItems,
      watchedThreadIds: ["loose-root", "housed-root"],
    });
    await flushTasks();

    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    act(() => view.props().onDragOver?.(dragOver("loose-root", EMPTY_KEY)));
    expect(view.result.current?.dragOverParentKey).toBe(EMPTY_KEY);
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", EMPTY_KEY)));
    await flushTasks();

    expect(assignmentCalls(view.inspection.rpcCalls)).toEqual([
      {
        method: "assignProjectSection",
        input: {
          threadId: "loose-root",
          projectId: PROJECT_A,
          projectSectionId: EMPTY_SECTION,
        },
      },
    ]);
    expect(view.inspection.sdkCalls).toEqual([]);
    expect(view.result.current?.projectSectionPreview?.assignments.get("loose-root")).toBe(EMPTY_SECTION);

    view.rerender({
      gesture: gesture([
        ["loose-root", EMPTY_SECTION],
        ["housed-root", FULL_SECTION],
      ]),
      rootItems,
      watchedThreadIds: ["loose-root", "housed-root"],
    });
    expect(view.result.current?.projectSectionPreview).toBeNull();

    const beforeClear = assignmentCalls(view.inspection.rpcCalls).length;
    act(() => view.props().onDragStart?.(dragStart("housed-root")));
    act(() => view.props().onDragEnd?.(dragEnd("housed-root", LOOSE_KEY)));
    await flushTasks();
    expect(assignmentCalls(view.inspection.rpcCalls).slice(beforeClear)).toEqual([
      { method: "clearProjectSectionAssignment", input: { threadId: "housed-root" } },
    ]);
    expect(view.inspection.sdkCalls).toEqual([]);
    view.unmount();
  });

  it("sends no write when a root already shown loose, including a sleeping record, is dropped on the loose list", async () => {
    const loose = createThread({ id: "sleeping-root" });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [threadItem(loose)],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([["sleeping-root", null]]),
      rootItems,
      watchedThreadIds: ["sleeping-root"],
    });
    await flushTasks();
    const before = view.inspection.rpcCalls.length;
    act(() => view.props().onDragStart?.(dragStart("sleeping-root")));
    act(() => view.props().onDragEnd?.(dragEnd("sleeping-root", LOOSE_KEY)));
    await flushTasks();
    expect(view.inspection.rpcCalls.slice(before)).toEqual([]);
    expect(view.inspection.sdkCalls).toEqual([]);
    view.unmount();
  });

  it("assigns each visible worktree root and leaves descendants nested", async () => {
    const environment = makeSidebarEnvironment({ id: "env_group", isWorktree: true });
    const child = createThread({
      id: "child",
      parentThreadId: "root-a",
      environment,
    });
    const rootA = createThread({ id: "root-a", environment });
    const rootB = createThread({ id: "root-b", environment });
    const group: ProjectThreadItem = {
      kind: "environment",
      group: {
        environmentId: "env_group",
        environmentProviderId: null,
        nodes: [threadNode(rootA, [threadItem(child)]), threadNode(rootB)],
        stats: { childCount: 3, childActivity: NO_COLLAPSED_CHILD_ACTIVITY },
      },
    };
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [group],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([
        ["root-a", null],
        ["root-b", null],
      ]),
      rootItems,
      watchedThreadIds: ["root-a", "root-b"],
    });
    await flushTasks();
    act(() => view.props().onDragStart?.(dragStart("environment:root-a")));
    act(() => view.props().onDragEnd?.(dragEnd("environment:root-a", EMPTY_KEY)));
    await flushTasks();

    expect(assignmentCalls(view.inspection.rpcCalls)).toEqual([
      {
        method: "assignProjectSection",
        input: { threadId: "root-a", projectId: PROJECT_A, projectSectionId: EMPTY_SECTION },
      },
      {
        method: "assignProjectSection",
        input: { threadId: "root-b", projectId: PROJECT_A, projectSectionId: EMPTY_SECTION },
      },
    ]);
    expect(view.inspection.sdkCalls).toEqual([]);
    view.unmount();
  });

  it("rejects a descendant drop onto a section or the loose list without unnesting", async () => {
    const child = createThread({ id: "child", parentThreadId: "housed-root" });
    const housed = createThread({ id: "housed-root" });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [
          { id: EMPTY_SECTION, name: "Empty", items: [] },
          { id: FULL_SECTION, name: "Full", items: [threadItem(housed, [threadItem(child)])] },
        ],
        [],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([["housed-root", FULL_SECTION]]),
      rootItems,
      watchedThreadIds: ["housed-root"],
    });
    await flushTasks();
    for (const target of [EMPTY_KEY, LOOSE_KEY]) {
      act(() => view.props().onDragStart?.(dragStart("child")));
      act(() => view.props().onDragOver?.(dragOver("child", target)));
      expect(view.result.current?.dragOverParentKey).toBeNull();
      expect(view.result.current?.unchangedParentKey).toBeNull();
      act(() => view.props().onDragEnd?.(dragEnd("child", target)));
    }
    await flushTasks();
    expect(assignmentCalls(view.inspection.rpcCalls)).toEqual([]);
    expect(view.inspection.sdkCalls).toEqual([]);
    view.unmount();
  });

  it("rejects a drop into another project's section before any write", async () => {
    const loose = createThread({ id: "loose-root", projectId: PROJECT_B });
    const other = createThread({ id: "other-root", projectId: PROJECT_B });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [threadItem(loose)],
      )),
      projectItems(PROJECT_B, "B", sectionItems(
        PROJECT_B,
        [{ id: OTHER_SECTION, name: "Other", items: [threadItem(other)] }],
        [],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([
        ["loose-root", null],
        ["other-root", OTHER_SECTION],
      ]),
      rootItems,
      watchedThreadIds: ["loose-root", "other-root"],
    });
    await flushTasks();
    const before = view.inspection.rpcCalls.length;
    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    act(() => view.props().onDragOver?.(dragOver("loose-root", OTHER_KEY)));
    expect(view.result.current?.dragOverParentKey).toBeNull();
    expect(view.result.current?.unchangedParentKey).toBeNull();
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", OTHER_KEY)));
    await flushTasks();
    expect(view.inspection.rpcCalls.slice(before)).toEqual([]);
    expect(view.inspection.sdkCalls).toEqual([]);
    view.unmount();
  });

  it("reorders visible headers as a full permutation and keeps ids outside the visible set", async () => {
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(PROJECT_A, [
        { id: EMPTY_SECTION, name: "Empty", items: [] },
        { id: FULL_SECTION, name: "Full", items: [] },
      ], [])),
      projectItems(PROJECT_B, "B", sectionItems(
        PROJECT_B,
        [{ id: OTHER_SECTION, name: "Other", items: [] }],
        [],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([]),
      rootItems,
      watchedThreadIds: [],
    });
    await flushTasks();
    act(() => view.props().onDragStart?.(dragStart(EMPTY_KEY)));
    act(() => view.props().onDragEnd?.(dragEnd(EMPTY_KEY, FULL_KEY)));
    await flushTasks();

    expect(view.inspection.rpcCalls.filter((call) => call.method === "reorderProjectSections")).toEqual([
      {
        method: "reorderProjectSections",
        input: {
          expectedRevision: 1,
          projectId: PROJECT_A,
          sectionIds: [FULL_SECTION, HIDDEN_SECTION, EMPTY_SECTION],
        },
      },
    ]);
    expect(view.onTopLevelSectionOrderChange).not.toHaveBeenCalled();
    expect(view.result.current?.projectSectionPreview).toBeNull();

    const before = view.inspection.rpcCalls.length;
    act(() => view.props().onDragStart?.(dragStart(EMPTY_KEY)));
    act(() => view.props().onDragEnd?.(dragEnd(EMPTY_KEY, OTHER_KEY)));
    act(() => view.props().onDragStart?.(dragStart(EMPTY_KEY)));
    act(() => view.props().onDragEnd?.(dragEnd(EMPTY_KEY, "pinned")));
    await flushTasks();
    expect(view.inspection.rpcCalls.slice(before)).toEqual([]);
    expect(view.onTopLevelSectionOrderChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("rolls the assignment preview back after rereading the roots when a write fails", async () => {
    let release: (value: { status: "error"; code: "storage"; issues: [] }) => void = () => undefined;
    const gate = new Promise<{ status: "error"; code: "storage"; issues: [] }>((resolve) => {
      release = resolve;
    });
    const loose = createThread({ id: "loose-root" });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [threadItem(loose)],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([["loose-root", null]]),
      rootItems,
      watchedThreadIds: ["loose-root"],
    }, {
      assignProjectSection: () => gate,
    });
    await flushTasks();
    const readsBefore = metadataReads(view.inspection.rpcCalls).length;
    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", EMPTY_KEY)));
    expect(view.result.current?.projectSectionPreview?.assignments.get("loose-root")).toBe(EMPTY_SECTION);
    expect(view.result.current?.projectSectionError).toBeNull();

    release({ status: "error", code: "storage", issues: [] });
    await flushTasks();
    await flushTasks();

    expect(view.result.current?.projectSectionPreview).toBeNull();
    expect(view.result.current?.projectSectionError).toEqual({
      projectId: PROJECT_A,
      message: "Не удалось изменить секцию проекта",
    });
    expect(metadataReads(view.inspection.rpcCalls).length).toBeGreaterThan(readsBefore);
    expect(metadataReads(view.inspection.rpcCalls).at(-1)?.input).toEqual({
      threadIds: ["loose-root"],
    });
    expect(view.inspection.rpcCalls.filter((call) => call.method === "clearProjectSectionAssignment")).toEqual([]);
    view.unmount();
  });

  it("keeps a successful group write when another root in the same drop fails", async () => {
    const environment = makeSidebarEnvironment({ id: "env_group", isWorktree: true });
    const rootA = createThread({ id: "root-a", environment });
    const rootB = createThread({ id: "root-b", environment });
    const group: ProjectThreadItem = {
      kind: "environment",
      group: {
        environmentId: "env_group",
        environmentProviderId: null,
        nodes: [threadNode(rootA), threadNode(rootB)],
        stats: { childCount: 2, childActivity: NO_COLLAPSED_CHILD_ACTIVITY },
      },
    };
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [group],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([
        ["root-a", null],
        ["root-b", null],
      ]),
      rootItems,
      watchedThreadIds: ["root-a", "root-b"],
    }, {
      assignProjectSection: async (input: unknown) => (
        (input as { threadId: string }).threadId === "root-b"
          ? { status: "error", code: "storage", issues: [] }
          : { status: "success" }
      ),
    });
    await flushTasks();
    act(() => view.props().onDragStart?.(dragStart("environment:root-a")));
    act(() => view.props().onDragEnd?.(dragEnd("environment:root-a", EMPTY_KEY)));
    await flushTasks();
    await flushTasks();

    expect(assignmentCalls(view.inspection.rpcCalls)).toEqual([
      {
        method: "assignProjectSection",
        input: { threadId: "root-a", projectId: PROJECT_A, projectSectionId: EMPTY_SECTION },
      },
      {
        method: "assignProjectSection",
        input: { threadId: "root-b", projectId: PROJECT_A, projectSectionId: EMPTY_SECTION },
      },
    ]);
    expect(view.inspection.rpcCalls.filter((call) => call.method === "clearProjectSectionAssignment")).toEqual([]);
    expect(view.result.current?.projectSectionPreview).toBeNull();
    expect(view.result.current?.projectSectionError?.message).toBe("Не удалось изменить секцию проекта");
    expect(metadataReads(view.inspection.rpcCalls).at(-1)?.input).toEqual({
      threadIds: ["root-a", "root-b"],
    });
    view.unmount();
  });

  it("clears an order preview after a conflict and rereads the section document", async () => {
    let release: (value: { status: "conflict"; currentRevision: number }) => void = () => undefined;
    const gate = new Promise<{ status: "conflict"; currentRevision: number }>((resolve) => {
      release = resolve;
    });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(PROJECT_A, [
        { id: EMPTY_SECTION, name: "Empty", items: [] },
        { id: FULL_SECTION, name: "Full", items: [] },
      ], [])),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([]),
      rootItems,
      watchedThreadIds: [],
    }, {
      reorderProjectSections: () => gate,
    });
    await flushTasks();
    act(() => view.props().onDragStart?.(dragStart(EMPTY_KEY)));
    act(() => view.props().onDragEnd?.(dragEnd(EMPTY_KEY, FULL_KEY)));
    expect(view.result.current?.projectSectionPreview?.order).toEqual({
      projectId: PROJECT_A,
      sectionIds: [FULL_SECTION, HIDDEN_SECTION, EMPTY_SECTION],
    });

    release({ status: "conflict", currentRevision: 4 });
    await flushTasks();
    await flushTasks();

    expect(view.result.current?.projectSectionPreview).toBeNull();
    expect(view.result.current?.projectSectionError).toEqual({
      projectId: PROJECT_A,
      message: "Не удалось изменить порядок секций проекта",
    });
    expect(view.inspection.rpcCalls.filter((call) => call.method === "listProjectSections")).toEqual([
      { method: "listProjectSections", input: null },
    ]);
    expect(view.onTopLevelSectionOrderChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("cancels the gesture before a write when the filter, snapshot, visible order, or section order changes", async () => {
    const loose = createThread({ id: "loose-root" });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [threadItem(loose)],
      )),
    ];
    const initial = {
      gesture: gesture([["loose-root", null]]),
      rootItems,
      watchedThreadIds: ["loose-root"],
    };
    const view = renderProjectSectionDrag(initial);
    await flushTasks();
    const before = view.inspection.rpcCalls.length;

    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    view.rerender({ ...initial, projectionKey: "projection:filter" });
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", EMPTY_KEY)));

    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    view.rerender({
      ...initial,
      topLevelSectionOrder: ["pinned", `project:${PROJECT_B}`, `project:${PROJECT_A}`, "threads"],
    });
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", EMPTY_KEY)));

    act(() => view.props().onDragStart?.(dragStart(EMPTY_KEY)));
    view.rerender({ ...initial, gesture: gesture([["loose-root", null]], "order:2") });
    act(() => view.props().onDragEnd?.(dragEnd(EMPTY_KEY, FULL_KEY)));
    await flushTasks();

    expect(view.inspection.rpcCalls.slice(before)).toEqual([]);
    expect(view.inspection.sdkCalls).toEqual([]);
    expect(view.onTopLevelSectionOrderChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("pins, unpins, and nests without writing a project-section assignment or sectionId", async () => {
    const loose = createThread({ id: "loose-root" });
    const peer = createThread({ id: "peer-root" });
    const pinned = createThread({ id: "pinned-root", pinnedAt: 5 });
    const rootItems = [
      projectItems(PROJECT_A, "A", sectionItems(
        PROJECT_A,
        [{ id: EMPTY_SECTION, name: "Empty", items: [] }],
        [threadItem(loose), threadItem(peer)],
      )),
    ];
    const view = renderProjectSectionDrag({
      gesture: gesture([
        ["loose-root", null],
        ["peer-root", null],
        ["pinned-root", null],
      ]),
      pinnedThreads: [pinned],
      rootItems,
      watchedThreadIds: ["loose-root", "peer-root", "pinned-root"],
    });
    await flushTasks();
    const before = view.inspection.rpcCalls.length;

    act(() => view.props().onDragStart?.(dragStart("loose-root")));
    act(() => view.props().onDragEnd?.(dragEnd("loose-root", "pinned")));
    await flushTasks();

    act(() => view.props().onDragStart?.(dragStart("pinned-root")));
    act(() => view.props().onDragEnd?.(dragEnd("pinned-root", EMPTY_KEY)));
    await flushTasks();

    act(() => view.props().onDragStart?.(dragStart("peer-root")));
    act(() => view.props().onDragEnd?.(dragEnd("peer-root", getSidebarThreadRowDroppableId("loose-root"))));
    await flushTasks();

    expect(view.inspection.rpcCalls.slice(before)).toEqual([]);
    expect(view.inspection.sdkCalls).toEqual([
      { method: "threads.pin", args: [{ threadId: "loose-root" }] },
      { method: "threads.unpin", args: [{ threadId: "pinned-root" }] },
      {
        method: "threads.update",
        args: [{ threadId: "peer-root", parentThreadId: "loose-root" }],
      },
    ]);
    for (const call of view.inspection.sdkCalls) {
      const args = call.args as readonly { sectionId?: string | null }[];
      expect(args.every((update) => update.sectionId === undefined || !String(update.sectionId).startsWith("sec_"))).toBe(true);
    }
    view.unmount();
  });
});
