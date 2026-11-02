// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { displayModeSchema } from "../../shared/filter-icons.js";
import { FILTERS_CHANGED_CHANNEL, type FilterDocumentV1 } from "../../shared/filters.js";
import { TINY_PNG } from "../../checks/filter-appearance/png-fixture.js";
import { createWindowFilterStore } from "./filter-store.js";

installTestPluginRuntime();
const { ProjectFilterPanel } = await import("./ProjectFilterPanel.js");
const { ProjectFilterEditor } = await import("./ProjectFilterEditor.js");
const { FilterIcon } = await import("./FilterIcon.js");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const initial: FilterDocumentV1 = { schemaVersion: 1, revision: 1, pinnedMode: "filter", filters: [{ id: "own", name: "Полное имя", rule: { kind: "projectIds", projectIds: [] } }] };

describe("filter appearance UI", () => {
  it("shares mode/icons through realtime/reconnect while retaining independent selection and focus", async () => {
    let document = initial;
    const stores = [createWindowFilterStore(), createWindowFilterStore()];
    const slots = stores.map((store) => renderSlot({ component: ProjectFilterPanel }, { store }, { rpc: { listFilters: () => ({ status: "success", document }) } }));
    for (const slot of slots) await within(slot.container).findByRole("radio", { name: "Полное имя" });
    const first = within(slots[0]!.container); const second = within(slots[1]!.container);
    expect(first.getByRole("radio", { name: "Полное имя" }).textContent).toBe("Полное имя");
    expect(first.getByRole("radio", { name: "Все" }).querySelector('[data-icon]')).toBeNull();
    fireEvent.click(first.getByRole("radio", { name: "Полное имя" }));
    first.getByRole("radio", { name: "Полное имя" }).focus();
    document = { ...document, revision: 2, displayMode: "icon", filters: [{ ...initial.filters[0]!, icon: { kind: "png", data: TINY_PNG } }] };
    for (const slot of slots) await slot.behavior.emitRealtime(FILTERS_CHANGED_CHANNEL, { revision: 2 });
    await waitFor(() => expect(first.getByRole("radio", { name: "Полное имя" }).textContent).toBe(""));
    expect(globalThis.document.activeElement).toBe(first.getByRole("radio", { name: "Полное имя" }));
    expect(first.getByRole("radio", { name: "Полное имя" }).title).toBe("Полное имя");
    expect(first.getByRole("radio", { name: "Полное имя" }).getAttribute("aria-checked")).toBe("true");
    expect(second.getByRole("radio", { name: "Все" }).getAttribute("aria-checked")).toBe("true");
    const image = first.getByRole("radio", { name: "Полное имя" }).querySelector("img")!;
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${TINY_PNG}`);
    expect(image.style.objectFit).toBe("contain"); expect(image.width).toBe(16);
    expect(first.getByRole("radio", { name: "Все" }).querySelector('[data-clear-filter-icon]')).not.toBeNull();
    expect(first.getByRole("radio", { name: "Без проектов" }).querySelector('[data-icon="Folder"]')).not.toBeNull();
    fireEvent.keyDown(first.getByRole("radio", { name: "Полное имя" }), { key: "ArrowRight" });
    expect(globalThis.document.activeElement).toBe(first.getByRole("radio", { name: "Все" }));
    fireEvent.keyDown(first.getByRole("radio", { name: "Все" }), { key: "End" });
    expect(globalThis.document.activeElement).toBe(first.getByRole("radio", { name: "Полное имя" }));
    document = { ...document, revision: 3, displayMode: "icon-text" };
    for (const slot of slots) { await slot.behavior.setRealtimeConnectionState("reconnecting"); await slot.behavior.setRealtimeConnectionState("connected"); }
    for (const slot of slots) await waitFor(() => expect(within(slot.container).getByRole("radio", { name: "Полное имя" }).textContent).toBe("Полное имя"));
    expect(slots.flatMap((slot) => slot.inspection.rpcCalls).every((call) => call.method === "listFilters")).toBe(true);
  });
  it("changes only displayMode immediately with revision and keeps icon in the definition draft", async () => {
    let document = initial;
    const updateFilter = vi.fn(() => ({ status: "conflict", currentRevision: 3 }));
    const setDisplayMode = vi.fn((input: unknown) => {
      const parsed = displayModeSchema.parse(input && typeof input === "object" && "displayMode" in input ? input.displayMode : undefined);
      document = { ...document, revision: 2, displayMode: parsed };
      return { status: "success", document };
    });
    const slot = renderSlot({ component: ProjectFilterEditor }, { store: createWindowFilterStore() }, { rpc: { listFilters: () => ({ status: "success", document }), setDisplayMode, updateFilter } });
    fireEvent.click(await slot.findByLabelText("Иконка"));
    await waitFor(() => expect(setDisplayMode).toHaveBeenCalledWith({ expectedRevision: 1, displayMode: "icon" }));
    fireEvent.click(slot.getByRole("button", { name: "Редактировать Полное имя" }));
    fireEvent.change(slot.getByLabelText("Поиск иконок BB"), { target: { value: "star" } });
    fireEvent.click(slot.getByRole("button", { name: "Star" }));
    expect(updateFilter).not.toHaveBeenCalled();
    expect(slot.getByLabelText("Иконка").closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Отменить" }));
    expect(updateFilter).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Редактировать Полное имя" }));
    expect(slot.getByRole("button", { name: "FilterHorizontal" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Star" }));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await slot.findByRole("button", { name: "Перечитать" });
    expect(updateFilter).toHaveBeenCalledWith({ expectedRevision: 2, filterId: "own", name: "Полное имя", rule: initial.filters[0]!.rule, icon: { kind: "builtin", name: "Star" } });
    expect(slot.getByRole("button", { name: "Star" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("reports a direct-RPC corrupted PNG image error without substituting artwork", () => {
    const slot = renderSlot({ component: FilterIcon }, { icon: { kind: "png", data: TINY_PNG } });
    fireEvent.error(slot.container.querySelector("img")!);
    expect(slot.container.querySelector("img")).toBeNull();
    expect(slot.container.querySelector('[data-filter-icon-error="true"]')?.getAttribute("title")).toMatch(/PNG/);
    expect(slot.container.querySelector('[data-icon]')).toBeNull();
  });
});
