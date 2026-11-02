// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNeighborReorderSortable } from "./useNeighborReorderSortable.js";

afterEach(cleanup);

function dragEnd(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId }, over: { id: overId } } as DragEndEvent;
}

describe("useNeighborReorderSortable", () => {
  it("builds the request from full hidden-neighbor context", () => {
    const onReorder = vi.fn();
    const current: { value: ReturnType<typeof useNeighborReorderSortable<{ id: string }>> | null } = {
      value: null,
    };
    function Harness() {
      current.value = useNeighborReorderSortable({
        disabled: false,
        getId: (item) => item.id,
        items: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
        onReorder,
      });
      return null;
    }
    render(<Harness />);

    act(() => current.value!.handleDragEnd(dragEnd("C", "A")));

    expect(onReorder).toHaveBeenCalledWith(
      { itemId: "C", previousItemId: null, nextItemId: "A" },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    expect(current.value!.itemIds).toEqual(["C", "A", "B", "D"]);
  });

  it("does not let an old settlement clear a newer projected reorder", () => {
    const settlements: Array<() => void> = [];
    const current: { value: ReturnType<typeof useNeighborReorderSortable<{ id: string }>> | null } = {
      value: null,
    };
    function Harness({ invalidationKey }: { invalidationKey: string }) {
      current.value = useNeighborReorderSortable({
        disabled: false,
        getId: (item) => item.id,
        invalidationKey,
        items: [{ id: "A" }, { id: "B" }, { id: "C" }, { id: "D" }],
        onReorder: (_request, callbacks) => settlements.push(callbacks.onSettled),
      });
      return null;
    }
    const view = render(<Harness invalidationKey="first" />);
    act(() => current.value!.handleDragEnd(dragEnd("C", "A")));
    view.rerender(<Harness invalidationKey="second" />);
    act(() => current.value!.handleDragEnd(dragEnd("D", "A")));
    expect(current.value!.itemIds).toEqual(["D", "A", "B", "C"]);

    act(() => settlements[0]!());
    expect(current.value!.itemIds).toEqual(["D", "A", "B", "C"]);
  });
});
