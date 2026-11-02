// @vitest-environment jsdom

import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { FILTERS_CHANGED_CHANNEL, type FilterReadResult } from "../../shared/filters.js";
import { createWindowFilterStore } from "./filter-store.js";

installTestPluginRuntime();
const { ProjectFilterPanel } = await import("./ProjectFilterPanel.js");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function success(revision: number, filters: Array<{ id: string; name: string }>): FilterReadResult {
  return {
    status: "success",
    document: {
      schemaVersion: 1,
      revision,
      pinnedMode: "filter",
      filters: filters.map(({ id, name }) => ({
        id,
        name,
        rule: { kind: "projectIds", projectIds: [] },
      })),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("project filter panel", () => {
  it.each([
    { oldOutcome: "response", resolveOrder: "fresh-first" },
    { oldOutcome: "error", resolveOrder: "signal-first" },
  ] as const)(
    "starts a fresh lifetime read after cleanup ($oldOutcome, $resolveOrder)",
    async ({ oldOutcome, resolveOrder }) => {
      const store = createWindowFilterStore();
      const oldRead = deferred<FilterReadResult>();
      let calls = 0;
      const first = renderSlot(
        { component: ProjectFilterPanel },
        { store },
        { rpc: { listFilters: () => {
          calls += 1;
          return oldRead.promise;
        } } },
      );
      await waitFor(() => expect(calls).toBe(1));
      first.lifecycle.unmount();
      await Promise.resolve();

      const freshRead = deferred<FilterReadResult>();
      const signalRead = deferred<FilterReadResult>();
      const reads = [freshRead.promise, signalRead.promise];
      const second = renderSlot(
        { component: ProjectFilterPanel },
        { store },
        { rpc: { listFilters: () => {
          calls += 1;
          const read = reads.shift();
          if (!read) throw new Error("unexpected read");
          return read;
        } } },
      );
      await waitFor(() => expect(calls).toBe(2));
      await second.behavior.emitRealtime(FILTERS_CHANGED_CHANNEL, { revision: 3 });
      await waitFor(() => expect(calls).toBe(3));

      if (resolveOrder === "fresh-first") {
        freshRead.resolve(success(2, [{ id: "fresh", name: "Fresh" }]));
        await freshRead.promise;
        signalRead.resolve(success(3, [{ id: "latest", name: "Latest" }]));
      } else {
        signalRead.resolve(success(3, [{ id: "latest", name: "Latest" }]));
        await signalRead.promise;
        freshRead.resolve(success(2, [{ id: "fresh", name: "Fresh" }]));
      }
      if (oldOutcome === "response") {
        oldRead.resolve(success(1, [{ id: "old", name: "Old" }]));
      } else {
        oldRead.reject(new Error("late old lifetime failure"));
      }

      await Promise.allSettled([oldRead.promise, freshRead.promise, signalRead.promise]);
      await waitFor(() => expect(
        within(second.container).getByRole("radio", { name: "Latest" }),
      ).not.toBeNull());
      expect(within(second.container).queryByRole("radio", { name: "Old" })).toBeNull();
      expect(within(second.container).queryByRole("alert")).toBeNull();
      expect(within(second.container).queryByText("Загрузка фильтров…")).toBeNull();

      second.lifecycle.unmount();
      await Promise.resolve();
      const third = renderSlot(
        { component: ProjectFilterPanel },
        { store },
        { rpc: { listFilters: () => {
          calls += 1;
          return Promise.resolve(success(4, [{ id: "current", name: "Current" }]));
        } } },
      );
      await within(third.container).findByRole("radio", { name: "Current" });
      expect(calls).toBe(4);
    },
  );

  it("keeps two synthetic app windows independent and preserves only a remounted window", async () => {
    const firstStore = createWindowFilterStore();
    const secondStore = createWindowFilterStore();
    const options = {
      rpc: { listFilters: () => success(1, [{ id: "work", name: "Рабочие" }]) },
    };
    const first = renderSlot(
      { component: ProjectFilterPanel },
      { store: firstStore },
      options,
    );
    const second = renderSlot(
      { component: ProjectFilterPanel },
      { store: secondStore },
      options,
    );
    const firstView = within(first.container);
    const secondView = within(second.container);
    const firstWork = await firstView.findByRole("radio", { name: "Рабочие" });
    await secondView.findByRole("radio", { name: "Рабочие" });
    fireEvent.click(firstWork);
    expect(firstWork.getAttribute("aria-checked")).toBe("true");
    expect(secondView.getByRole("radio", { name: "Все" }).getAttribute("aria-checked")).toBe("true");

    first.lifecycle.unmount();
    const remounted = renderSlot(
      { component: ProjectFilterPanel },
      { store: firstStore },
      options,
    );
    await waitFor(() => expect(
      within(remounted.container).getByRole("radio", { name: "Рабочие" }).getAttribute("aria-checked"),
    ).toBe("true"));

    const freshRuntime = renderSlot(
      { component: ProjectFilterPanel },
      { store: createWindowFilterStore() },
      options,
    );
    expect(within(freshRuntime.container).getByRole("radio", { name: "Все" }).getAttribute("aria-checked")).toBe("true");
  });

  it("renders ordered accessible radios and implements wrapping roving keyboard selection", async () => {
    const longName = "Очень длинное имя фильтра, которое должно переноситься";
    const slot = renderSlot(
      { component: ProjectFilterPanel },
      { store: createWindowFilterStore() },
      {
        rpc: {
          listFilters: () => success(1, [
            { id: "emoji", name: "👨‍👩‍👧‍👦" },
            { id: "long", name: longName },
          ]),
        },
      },
    );

    await waitFor(() => expect(slot.getAllByRole("radio")).toHaveLength(4));
    const radios = slot.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Все",
      "Без проектов",
      "👨‍👩‍👧‍👦",
      longName,
    ]);
    expect(slot.getByRole("radiogroup", { name: "Фильтры проектов" }).classList).toContain("flex-wrap");
    expect(radios[3]!.className).toContain("max-w-full");
    expect(radios[3]!.className).toContain("whitespace-normal");
    expect(radios[3]!.className).toContain("break-words");
    expect(radios[0]!.getAttribute("tabindex")).toBe("0");
    expect(radios[1]!.getAttribute("tabindex")).toBe("-1");

    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[1]);

    fireEvent.keyDown(radios[1]!, { key: "End" });
    expect(radios[3]!.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(radios[3]);
    fireEvent.keyDown(radios[3]!, { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[3]);

    expect(fireEvent.keyDown(radios[3]!, { key: "Tab" })).toBe(true);
    expect(radios[3]!.getAttribute("aria-checked")).toBe("true");
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("refetches for realtime and reconnect, then focuses All when the focused active filter is deleted", async () => {
    let read = 0;
    const slot = renderSlot(
      { component: ProjectFilterPanel },
      { store: createWindowFilterStore() },
      {
        rpc: {
          listFilters: () => ++read === 1
            ? success(1, [{ id: "work", name: "Рабочие" }])
            : success(read, []),
        },
      },
    );
    const work = await slot.findByRole("radio", { name: "Рабочие" });
    fireEvent.click(work);
    work.focus();

    await slot.behavior.emitRealtime(FILTERS_CHANGED_CHANNEL, { revision: 2 });
    await waitFor(() => expect(document.activeElement).toBe(slot.getByRole("radio", { name: "Все" })));
    expect(slot.getByRole("radio", { name: "Все" }).getAttribute("aria-checked")).toBe("true");
    expect(read).toBe(2);

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(read).toBe(3));
  });

  it("shows loading/read errors and only renders a functioning management trigger", async () => {
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<FilterReadResult>((_resolve, reject) => {
      rejectRead = reject;
    });
    const onManageFilters = vi.fn();
    const slot = renderSlot(
      { component: ProjectFilterPanel },
      { store: createWindowFilterStore(), onManageFilters },
      { rpc: { listFilters: () => pending } },
    );

    expect(slot.getByRole("status").textContent).toContain("Загрузка фильтров…");
    const manage = slot.getByRole("button", { name: "Меню фильтров" });
    fireEvent.keyDown(manage, { key: "ArrowDown" });
    fireEvent.keyDown(await screen.findByRole("menuitem", { name: "Настроить" }), { key: "Enter" });
    expect(onManageFilters).toHaveBeenCalledOnce();
    rejectRead(new Error("offline"));
    expect((await slot.findByRole("alert")).textContent).toContain("offline");
    slot.lifecycle.unmount();

    const withoutCallback = renderSlot(
      { component: ProjectFilterPanel },
      { store: createWindowFilterStore() },
      { rpc: { listFilters: () => success(0, []) } },
    );
    await withoutCallback.findByRole("radio", { name: "Все" });
    expect(withoutCallback.queryByRole("button", { name: "Меню фильтров" })).toBeNull();
  });
});

it("closes the keyboard menu with Escape and restores trigger focus without opening editor", async () => {
  const onManageFilters = vi.fn();
  const slot = renderSlot({ component: ProjectFilterPanel }, { store: createWindowFilterStore(), onManageFilters }, { rpc: { listFilters: () => success(0, []) } });
  const trigger = slot.getByRole("button", { name: "Меню фильтров" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Настроить" })).not.toBeNull();
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(onManageFilters).not.toHaveBeenCalled();
});

it.each([false, true])("restores menu trigger focus after pointer outside dismissal (compact=%s)", async (isCompactViewport) => {
  class PointerEventForTest extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerType = init.pointerType ?? "mouse"; }
  }
  vi.stubGlobal("PointerEvent", PointerEventForTest);
  const onManageFilters = vi.fn();
  function Panel() {
    return <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}><ProjectFilterPanel store={store} onManageFilters={onManageFilters} /></CompactViewportOverrideProvider>;
  }
  const store = createWindowFilterStore();
  const slot = renderSlot({ component: Panel }, {}, { rpc: { listFilters: () => success(0, []) } });
  const trigger = slot.getByRole("button", { name: "Меню фильтров" });
  const radio = slot.getByRole("radio", { name: "Без проектов" });
  radio.focus();
  expect(document.activeElement).toBe(radio);
  if (isCompactViewport) {
    fireEvent.pointerDown(trigger, { pointerType: "touch", button: 0 });
    fireEvent.click(trigger);
    await screen.findByText("Настроить", { exact: true });
    const backdrop = document.querySelector<HTMLElement>('[data-persistent-drawer-backdrop]');
    if (!backdrop) throw new Error("Expected actual compact drawer backdrop");
    fireEvent.pointerDown(backdrop, { pointerType: "touch", button: 0 });
    fireEvent.click(backdrop);
    await waitFor(() => expect(document.querySelector('[data-persistent-drawer-content][data-state="open"]')).toBeNull());
  } else {
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    await new Promise((resolve) => setTimeout(resolve, 0)); // Radix installs the outside-pointer listener after opening.
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(onManageFilters).not.toHaveBeenCalled();
});
