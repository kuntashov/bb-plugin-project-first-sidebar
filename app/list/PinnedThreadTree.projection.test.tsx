// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProjectionKeyProvider } from "../filters/sidebar-projection-context.js";
import { makeSidebarThread } from "../model/fixtures.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";

const reorderDnd = vi.hoisted(() => ({
  args: null as null | {
    onDragStart?: (event: DragStartEvent) => void;
    onDragEnd: (event: DragEndEvent) => void;
  },
}));

vi.mock("@/components/ui/use-sidebar-reorder-dnd", () => ({
  useSidebarReorderDnd: (args: typeof reorderDnd.args) => {
    reorderDnd.args = args;
    return {
      dndContextProps: {},
      consumeClickSuppression: () => false,
      onClickCapture: () => undefined,
    };
  },
}));
vi.mock("@/components/ui/sortable-motion", () => ({
  useSidebarSortable: () => ({
    dragBindings: {},
    setNodeRef: () => undefined,
    style: {},
  }),
}));
vi.mock("./ProjectRow.js", () => ({
  PinnedEnvironmentThreadGroupRow: () => null,
  ThreadTreeNodeRow: ({ node }: { node: { thread: { id: string } } }) => (
    <div data-testid={node.thread.id} />
  ),
}));
vi.mock("./useSidebarListShown.js", () => ({
  useSidebarListShown: () => true,
}));
vi.mock("../dnd/SectionThreadDndContext.js", () => ({
  useChronologicalSectionThreadDnd: () => null,
}));

const { PinnedThreadTree } = await import("./PinnedThreadTree.js");

afterEach(() => {
  cleanup();
  reorderDnd.args = null;
});

describe("PinnedThreadTree projection invalidation", () => {
  it("uses the full pinned roots for hidden-neighbor requests", () => {
    const threads = [
      makeSidebarThread({ id: "A", pinnedAt: 4, pinSortKey: "a" }),
      makeSidebarThread({ id: "B", pinnedAt: 3, pinSortKey: "b" }),
      makeSidebarThread({ id: "C", pinnedAt: 2, pinSortKey: "c" }),
      makeSidebarThread({ id: "D", pinnedAt: 1, pinSortKey: "d" }),
    ];
    const full = buildPinnedSidebarState({ threads });
    const visible = buildPinnedSidebarState({
      threads: threads.filter((thread) => thread.id === "A" || thread.id === "C"),
    });
    const onReorderPinnedRoot = vi.fn();
    render(
      <SidebarProjectionKeyProvider value="stable">
        <PinnedThreadTree
          rootItems={visible.rootItems}
          rootNodes={visible.rootNodes}
          reorderRootNodes={full.rootNodes}
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
          onReorderPinnedRoot={onReorderPinnedRoot}
        />
      </SidebarProjectionKeyProvider>,
    );

    act(() => reorderDnd.args!.onDragStart?.({ active: { id: "A" } } as DragStartEvent));
    act(() =>
      reorderDnd.args!.onDragEnd({
        active: { id: "A" },
        over: { id: "C" },
      } as DragEndEvent),
    );

    expect(onReorderPinnedRoot).toHaveBeenCalledWith(
      { itemId: "A", previousItemId: "C", nextItemId: "D" },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
  });

  it("blocks the standalone pinned mutation after the projection changes", () => {
    const state = buildPinnedSidebarState({
      threads: [
        makeSidebarThread({ id: "A", pinnedAt: 4, pinSortKey: "a" }),
        makeSidebarThread({ id: "C", pinnedAt: 3, pinSortKey: "c" }),
      ],
    });
    const onReorderPinnedRoot = vi.fn();
    const tree = (projectionKey: string) => (
      <SidebarProjectionKeyProvider value={projectionKey}>
        <PinnedThreadTree
          rootItems={state.rootItems}
          rootNodes={state.rootNodes}
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={new Set()}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={vi.fn()}
          onReorderPinnedRoot={onReorderPinnedRoot}
        />
      </SidebarProjectionKeyProvider>
    );
    const view = render(tree("first"));

    act(() => reorderDnd.args!.onDragStart?.({ active: { id: "C" } } as DragStartEvent));
    view.rerender(tree("second"));
    act(() =>
      reorderDnd.args!.onDragEnd({
        active: { id: "C" },
        over: { id: "A" },
      } as DragEndEvent),
    );

    expect(onReorderPinnedRoot).not.toHaveBeenCalled();
  });
});
