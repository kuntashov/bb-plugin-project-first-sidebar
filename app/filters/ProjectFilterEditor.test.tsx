// @vitest-environment jsdom

import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcCallArgs } from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import {
  defaultFilterDocument,
  type FilterDocumentV1,
  type FilterMutationResult,
  type ProjectFilterDefinition,
} from "../../shared/filters.js";
import { createWindowFilterStore } from "./filter-store.js";

installTestPluginRuntime();
const { ProjectFilterEditor } = await import("./ProjectFilterEditor.js");

afterEach(cleanup);

const projects = [
  { id: "work", name: "WORK-API", isPersonal: false, href: "/work", settingsHref: "/work/settings" },
  { id: "client", name: "Client-😀", isPersonal: false, href: "/client", settingsHref: "/client/settings" },
  { id: "personal", name: "Personal", isPersonal: true, href: "/personal", settingsHref: "/personal/settings" },
] as const;

function document(
  revision: number,
  filters: ProjectFilterDefinition[],
  pinnedMode: FilterDocumentV1["pinnedMode"] = "filter",
): FilterDocumentV1 {
  return { schemaVersion: 1, revision, pinnedMode, filters };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type FilterRpcContract = typeof projectFirstSidebarRpcContract;
type RpcInput<Method extends keyof FilterRpcContract> =
  PluginRpcCallArgs<FilterRpcContract[Method]>[0];
type TypedRenderSlotOptions = Omit<
  RenderSlotOptions<FilterRpcContract>,
  "rpc"
> & {
  rpc?: Partial<PluginRpcTestHandlers<FilterRpcContract>>;
};

function missingRpc(method: keyof FilterRpcContract) {
  return (_input: unknown): never => {
    throw new Error(`Unexpected RPC call: ${method}`);
  };
}

const missingRpcHandlers: PluginRpcTestHandlers<FilterRpcContract> = {
  getImportStatus: missingRpc("getImportStatus"),
  importPreferences: missingRpc("importPreferences"),
  listPreferences: missingRpc("listPreferences"),
  setPreference: missingRpc("setPreference"),
  resetPreference: missingRpc("resetPreference"),
  listFilters: missingRpc("listFilters"),
  createFilter: missingRpc("createFilter"),
  updateFilter: missingRpc("updateFilter"),
  deleteFilter: missingRpc("deleteFilter"),
  reorderFilters: missingRpc("reorderFilters"),
  setPinnedMode: missingRpc("setPinnedMode"),
  setDisplayMode: missingRpc("setDisplayMode"),
};

function renderTypedSlot<Props extends object>(
  registration: { component: ComponentType<Props> },
  props: Props,
  options: TypedRenderSlotOptions,
) {
  return renderSlot<Props, FilterRpcContract>(
    registration,
    props,
    {
      ...options,
      rpc: { ...missingRpcHandlers, ...options.rpc },
    },
  );
}

function requireInput(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("Expected an input element");
  }
  return element;
}

describe("project filter editor", () => {
  it("registers the same editor component in app settings", async () => {
    const app = await loadPluginApp(() => import("../../app.js"));
    const registration = app.settingsSections.find(
      (section) => section.id === "project-first-sidebar-filters",
    );
    expect(registration).toMatchObject({ title: "Фильтры проектов" });
    expect(registration?.component).toBe(ProjectFilterEditor);
  });

  it("cancels without writing and creates one definition without changing the active filter", async () => {
    const store = createWindowFilterStore();
    const createFilter = vi.fn((input: RpcInput<"createFilter">) => ({
      status: "success" as const,
      document: {
        ...defaultFilterDocument(),
        revision: 1,
        filters: [{ id: "emoji", name: input.name, rule: input.rule }],
      },
    }));
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: defaultFilterDocument() }),
          createFilter,
        },
      },
    );
    await slot.findByRole("button", { name: "Создать фильтр" });

    fireEvent.click(slot.getByRole("button", { name: "Создать фильтр" }));
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "👨‍👩‍👧‍👦" } });
    fireEvent.change(slot.getByLabelText("Маски проектов"), { target: { value: "work-*" } });
    fireEvent.click(slot.getByRole("button", { name: "Отменить" }));
    expect(createFilter).not.toHaveBeenCalled();

    fireEvent.click(slot.getByRole("button", { name: "Создать фильтр" }));
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "👨‍👩‍👧‍👦" } });
    fireEvent.change(slot.getByLabelText("Маски проектов"), { target: { value: "work-*" } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));

    await waitFor(() => expect(createFilter).toHaveBeenCalledOnce());
    expect(createFilter).toHaveBeenCalledWith({
      expectedRevision: 0,
      icon: { kind: "builtin", name: "FilterHorizontal" },
      name: "👨‍👩‍👧‍👦",
      rule: { kind: "nameGlobs", globs: ["work-*"] },
    });
    expect(store.getSnapshot().activeFilterId).toBe("all");
  });

  it("edits static membership with search, preserves unavailable IDs, and previews the changing ordinary catalog", async () => {
    const initial = document(4, [{
      id: "static",
      name: "Статика",
      rule: { kind: "projectIds", projectIds: ["missing", "work"] },
    }]);
    const updateFilter = vi.fn((input: {
      expectedRevision: number;
      filterId: string;
      name: string;
      rule: ProjectFilterDefinition["rule"];
    }) => ({
      status: "success" as const,
      document: document(5, [{ id: input.filterId, name: input.name, rule: input.rule }]),
    }));
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects },
      { rpc: { listFilters: () => ({ status: "success", document: initial }), updateFilter } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Статика" }));

    const selected = slot.getByRole("group", { name: "Выбранные проекты" });
    expect(within(selected).getByText("Недоступный проект: missing")).not.toBeNull();
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("WORK-API")).not.toBeNull();
    expect(slot.queryByText("Personal")).toBeNull();

    fireEvent.change(slot.getByLabelText("Поиск проектов"), { target: { value: "client" } });
    expect(within(selected).queryByText("WORK-API")).toBeNull();
    fireEvent.click(within(selected).getByText("Client-😀"));
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("Client-😀")).not.toBeNull();

    slot.lifecycle.rerender(
      <ProjectFilterEditor
        store={store}
        projects={[
          { ...projects[0], name: "WORK-RENAMED" },
          projects[2],
        ]}
      />,
    );
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("WORK-RENAMED")).not.toBeNull();
    expect(slot.queryByText("Client-😀")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await waitFor(() => expect(updateFilter).toHaveBeenCalledOnce());
    expect(updateFilter).toHaveBeenCalledWith({
      expectedRevision: 4,
      icon: { kind: "builtin", name: "FilterHorizontal" },
      filterId: "static",
      name: "Статика",
      rule: { kind: "projectIds", projectIds: ["missing", "work", "client"] },
    });
  });

  it("uses the shared glob semantics and blocks duplicate names before RPC", async () => {
    const initial = document(2, [
      { id: "first", name: "Рабочие", rule: { kind: "nameGlobs", globs: ["work-*"] } },
      { id: "second", name: "Клиенты", rule: { kind: "projectIds", projectIds: [] } },
    ]);
    const updateFilter = vi.fn();
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects },
      { rpc: { listFilters: () => ({ status: "success", document: initial }), updateFilter } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Клиенты" }));
    fireEvent.click(slot.getByLabelText("Маски имён"));
    fireEvent.change(slot.getByLabelText("Маски проектов"), { target: { value: "client-?" } });
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("Client-😀")).not.toBeNull();
    slot.lifecycle.rerender(
      <ProjectFilterEditor
        store={store}
        projects={[...projects, {
          id: "client-b",
          name: "Client-B",
          isPersonal: false,
          href: "/client-b",
          settingsHref: "/client-b/settings",
        }]}
      />,
    );
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("Client-B")).not.toBeNull();
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: " РАБОЧИЕ " } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    expect((await slot.findByRole("alert")).textContent).toContain("уже существует");
    expect(updateFilter).not.toHaveBeenCalled();
  });

  it("preserves a stale draft until explicit reread and never retries the mutation", async () => {
    const initial = document(7, [{
      id: "work-filter",
      name: "Рабочие",
      rule: { kind: "nameGlobs", globs: ["work-*"] },
    }]);
    const incoming = document(8, [{
      id: "work-filter",
      name: "Серверное имя",
      rule: { kind: "nameGlobs", globs: ["server-*"] },
    }]);
    let reads = 0;
    const updateFilter = vi.fn((_input: unknown) => ({ status: "conflict" as const, currentRevision: 8 }));
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store: createWindowFilterStore(), projects },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: ++reads === 1 ? initial : incoming }),
          updateFilter,
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Рабочие" }));
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "Черновик" } });
    expect(slot.getByRole("button", { name: "Удалить Рабочие" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByRole("button", { name: "Переместить Рабочие вверх" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByLabelText("Не фильтровать").closest("fieldset")?.hasAttribute("disabled")).toBe(true);

    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await slot.findByRole("button", { name: "Перечитать" });
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
    expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Черновик");
    expect(updateFilter).toHaveBeenCalledOnce();
    expect(updateFilter.mock.calls[0]![0]).toMatchObject({ expectedRevision: 7, name: "Черновик" });

    fireEvent.click(slot.getByRole("button", { name: "Перечитать" }));
    expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Серверное имя");
    expect((slot.getByLabelText("Маски проектов") as HTMLTextAreaElement).value).toBe("server-*");
    expect(updateFilter).toHaveBeenCalledOnce();
  });

  it("performs reorder and pinned policy immediately, but deletes only after confirmation", async () => {
    let current = document(1, [
      { id: "first", name: "Первый", rule: { kind: "projectIds", projectIds: [] } },
      { id: "second", name: "Второй", rule: { kind: "projectIds", projectIds: [] } },
    ]);
    const reorderFilters = vi.fn((input: { expectedRevision: number; filterIds: string[] }) => {
      current = document(2, input.filterIds.map((id) => current.filters.find((filter) => filter.id === id)!));
      return { status: "success" as const, document: current };
    });
    const setPinnedMode = vi.fn((input: { expectedRevision: number; pinnedMode: "filter" | "always-show" }) => {
      current = document(3, current.filters, input.pinnedMode);
      return { status: "success" as const, document: current };
    });
    const deleteFilter = vi.fn((input: { expectedRevision: number; filterId: string }) => {
      current = document(4, current.filters.filter((filter) => filter.id !== input.filterId), current.pinnedMode);
      return { status: "success" as const, document: current };
    });
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: current }),
          reorderFilters,
          setPinnedMode,
          deleteFilter,
        },
      },
    );
    await slot.findByRole("button", { name: "Переместить Второй вверх" });
    store.setActiveFilterId("first");

    fireEvent.click(slot.getByRole("button", { name: "Переместить Второй вверх" }));
    await waitFor(() => expect(reorderFilters).toHaveBeenCalledOnce());
    expect(reorderFilters).toHaveBeenCalledWith({ expectedRevision: 1, filterIds: ["second", "first"] });

    fireEvent.click(slot.getByLabelText("Не фильтровать"));
    await waitFor(() => expect(setPinnedMode).toHaveBeenCalledOnce());
    expect(setPinnedMode).toHaveBeenCalledWith({ expectedRevision: 2, pinnedMode: "always-show" });

    fireEvent.click(slot.getByRole("button", { name: "Удалить Первый" }));
    const dialog = await slot.findByRole("dialog");
    expect(deleteFilter).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(deleteFilter).not.toHaveBeenCalled();

    fireEvent.click(slot.getByRole("button", { name: "Удалить Первый" }));
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Удалить фильтр" }));
    await waitFor(() => expect(deleteFilter).toHaveBeenCalledOnce());
    expect(deleteFilter).toHaveBeenCalledWith({ expectedRevision: 3, filterId: "first" });
    await waitFor(() => expect(store.getSnapshot().activeFilterId).toBe("all"));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  });

  it("requires a fresh document and new confirmation before retrying a conflicted delete", async () => {
    const initial = document(1, [
      { id: "first", name: "Первый", rule: { kind: "projectIds", projectIds: [] } },
      { id: "second", name: "Второй", rule: { kind: "projectIds", projectIds: [] } },
    ]);
    const renamed = document(2, [
      { ...initial.filters[0]!, name: "Переименованный" },
      initial.filters[1]!,
    ]);
    const finalDocument = document(3, [initial.filters[1]!]);
    let current = initial;
    let allowFreshRead = false;
    const finalAttempt = deferred<FilterMutationResult>();
    let freshAttempts = 0;
    const deleteFilter = vi.fn((input: RpcInput<"deleteFilter">) => {
      if (input.expectedRevision !== current.revision) {
        return Promise.resolve({
          status: "conflict" as const,
          currentRevision: current.revision,
        });
      }
      freshAttempts += 1;
      if (freshAttempts === 1) return Promise.reject(new Error("Соединение потеряно"));
      return finalAttempt.promise;
    });
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects },
      {
        rpc: {
          listFilters: () => allowFreshRead
            ? { status: "success", document: current }
            : current.revision === initial.revision
              ? { status: "success", document: current }
              : {
                  status: "error",
                  code: "filter_document_invalid",
                  issues: [{ path: [], message: "read failed" }],
                },
          deleteFilter,
        },
      },
    );
    await slot.findByRole("button", { name: "Удалить Первый" });
    store.setActiveFilterId("first");

    fireEvent.click(slot.getByRole("button", { name: "Удалить Первый" }));
    const dialog = await slot.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Удалить фильтр" });
    current = renamed;
    fireEvent.click(confirm);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(deleteFilter).toHaveBeenCalledWith({ expectedRevision: 1, filterId: "first" });
    expect((await slot.findByRole("alert")).textContent).toContain("ревизия 2");
    expect(slot.getByRole("button", { name: "Удалить Первый" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(slot.getByRole("button", { name: "Перечитать фильтры" }));
    expect((await slot.findByRole("alert")).textContent).toContain("ошибка чтения");
    expect(deleteFilter).toHaveBeenCalledOnce();

    allowFreshRead = true;
    fireEvent.click(slot.getByRole("button", { name: "Перечитать фильтры" }));
    const freshDelete = await slot.findByRole("button", { name: "Удалить Переименованный" });
    fireEvent.click(freshDelete);
    const freshDialog = await slot.findByRole("dialog");
    const freshConfirm = within(freshDialog).getByRole("button", { name: "Удалить фильтр" });
    fireEvent.click(freshConfirm);
    expect((await within(freshDialog).findByRole("alert")).textContent).toContain("Соединение потеряно");
    expect(deleteFilter).toHaveBeenNthCalledWith(2, { expectedRevision: 2, filterId: "first" });

    fireEvent.click(freshConfirm);
    await waitFor(() => expect(deleteFilter).toHaveBeenCalledTimes(3));
    expect(deleteFilter).toHaveBeenNthCalledWith(3, { expectedRevision: 2, filterId: "first" });
    expect(freshConfirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(freshConfirm);
    expect(deleteFilter).toHaveBeenCalledTimes(3);

    current = finalDocument;
    finalAttempt.resolve({ status: "success", document: finalDocument });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(store.getSnapshot().activeFilterId).toBe("all"));
  });

  it("drops a conflicted delete target that is absent from the fresh document", async () => {
    const initial = document(5, [{
      id: "removed",
      name: "Удалённый сервером",
      rule: { kind: "projectIds", projectIds: [] },
    }]);
    const fresh = document(6, []);
    let current = initial;
    const deleteFilter = vi.fn((input: RpcInput<"deleteFilter">) => input.expectedRevision === current.revision
      ? {
          status: "error" as const,
          code: "filter_not_found" as const,
          issues: [{ path: ["filterId"], message: "filter not found" }],
        }
      : { status: "conflict" as const, currentRevision: current.revision });
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store: createWindowFilterStore(), projects },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: current }),
          deleteFilter,
        },
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Удалить Удалённый сервером" }));
    current = fresh;
    fireEvent.click(within(await slot.findByRole("dialog")).getByRole("button", { name: "Удалить фильтр" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());

    fireEvent.click(slot.getByRole("button", { name: "Перечитать фильтры" }));
    expect((await slot.findByRole("alert")).textContent).toContain("больше не существует");
    expect(slot.queryByRole("button", { name: "Удалить Удалённый сервером" })).toBeNull();
    expect(deleteFilter).toHaveBeenCalledOnce();
  });

  it("keeps the draft visible and disables finishing actions while a save is pending or fails", async () => {
    let rejectSave!: (reason: Error) => void;
    const createFilter = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectSave = reject;
    }));
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store: createWindowFilterStore(), projects },
      {
        rpc: {
          listFilters: () => ({ status: "success", document: defaultFilterDocument() }),
          createFilter,
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Создать фильтр" }));
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "Черновик" } });
    fireEvent.change(slot.getByLabelText("Маски проектов"), { target: { value: "work-*" } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await waitFor(() => expect(createFilter).toHaveBeenCalledOnce());
    expect(slot.getByRole("button", { name: "Сохранить фильтр" }).hasAttribute("disabled")).toBe(true);
    expect(slot.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);

    rejectSave(new Error("Соединение потеряно"));
    expect((await slot.findByRole("alert")).textContent).toContain("Соединение потеряно");
    expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Черновик");
    expect(slot.getByRole("button", { name: "Сохранить фильтр" }).hasAttribute("disabled")).toBe(false);
  });

  it("re-enables explicit reread after a read error and replaces the draft only after retry success", async () => {
    const initial = document(7, [{
      id: "work-filter",
      name: "Рабочие",
      rule: { kind: "nameGlobs", globs: ["work-*"] },
    }]);
    const incoming = document(8, [{
      id: "work-filter",
      name: "Серверное имя",
      rule: { kind: "nameGlobs", globs: ["server-*"] },
    }]);
    let reads = 0;
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store: createWindowFilterStore(), projects },
      {
        rpc: {
          listFilters: () => {
            reads += 1;
            if (reads <= 2) return { status: "success", document: initial };
            if (reads === 3) return {
              status: "error" as const,
              code: "filter_document_invalid" as const,
              issues: [{ path: [], message: "read failed" }],
            };
            return { status: "success", document: incoming };
          },
          updateFilter: () => ({ status: "conflict", currentRevision: 8 }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Рабочие" }));
    fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "Черновик" } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await slot.findByRole("button", { name: "Перечитать" });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.click(slot.getByRole("button", { name: "Перечитать" }));
    await waitFor(() => expect(reads).toBe(3));
    expect((await slot.findByRole("alert")).textContent).toContain("ошибка чтения");
    expect(slot.getByRole("button", { name: "Перечитать" }).hasAttribute("disabled")).toBe(false);
    expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Черновик");

    fireEvent.click(slot.getByRole("button", { name: "Перечитать" }));
    await waitFor(() => expect(reads).toBe(4));
    await waitFor(() => expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Серверное имя"));
    expect((slot.getByLabelText("Маски проектов") as HTMLTextAreaElement).value).toBe("server-*");
  });

  it.each(["success", "error"] as const)(
    "does not let a late owned reread %s replace or block a newer draft",
    async (outcome) => {
      const initial = document(7, [{
        id: "work-filter",
        name: "Рабочие",
        rule: { kind: "nameGlobs", globs: ["work-*"] },
      }]);
      const incoming = document(8, [{
        id: "work-filter",
        name: "Серверное имя",
        rule: { kind: "nameGlobs", globs: ["server-*"] },
      }]);
      const lateRead = deferred<{ status: "success"; document: FilterDocumentV1 }>();
      let reads = 0;
      const slot = renderTypedSlot(
        { component: ProjectFilterEditor },
        { store: createWindowFilterStore(), projects },
        {
          rpc: {
            listFilters: () => {
              reads += 1;
              if (reads <= 2) return { status: "success", document: initial };
              return lateRead.promise;
            },
            updateFilter: () => ({ status: "conflict", currentRevision: 8 }),
          },
        },
      );
      fireEvent.click(await slot.findByRole("button", { name: "Редактировать Рабочие" }));
      fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "Старый черновик" } });
      fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
      await slot.findByRole("button", { name: "Перечитать" });
      await waitFor(() => expect(reads).toBe(2));
      fireEvent.click(slot.getByRole("button", { name: "Перечитать" }));
      await waitFor(() => expect(reads).toBe(3));
      fireEvent.click(slot.getByRole("button", { name: "Отменить редактирование" }));
      fireEvent.click(slot.getByRole("button", { name: "Создать фильтр" }));
      fireEvent.change(slot.getByLabelText("Имя фильтра"), { target: { value: "Новый черновик" } });

      if (outcome === "success") lateRead.resolve({ status: "success", document: incoming });
      else lateRead.reject(new Error("late read failed"));
      await lateRead.promise.catch(() => undefined);
      await Promise.resolve();

      expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Новый черновик");
      expect(slot.queryByRole("button", { name: "Перечитать" })).toBeNull();
      expect(slot.getByRole("button", { name: "Сохранить фильтр" }).hasAttribute("disabled")).toBe(false);
      expect(slot.queryByText(/late read failed/)).toBeNull();
    },
  );

  it("gates static catalog operations through loading and error until the public catalog is ready", async () => {
    const initial = document(1, [{
      id: "static",
      name: "Статика",
      rule: { kind: "projectIds", projectIds: ["work"] },
    }]);
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects: [], catalogStatus: "loading" },
      { rpc: { listFilters: () => ({ status: "success", document: initial }) } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Статика" }));
    expect(slot.getByRole("status").textContent).toContain("Загрузка каталога проектов");
    expect(slot.queryByText("Недоступный проект: work")).toBeNull();
    expect(slot.queryByText("Нет подходящих проектов.")).toBeNull();

    slot.lifecycle.rerender(<ProjectFilterEditor store={store} projects={[]} catalogStatus="error" />);
    expect(slot.getByRole("alert").textContent).toContain("Не удалось загрузить каталог проектов");
    expect(slot.queryByText("Недоступный проект: work")).toBeNull();
    expect((slot.getByLabelText("Имя фильтра") as HTMLInputElement).value).toBe("Статика");

    slot.lifecycle.rerender(<ProjectFilterEditor store={store} projects={projects} catalogStatus="ready" />);
    expect(slot.getAllByText("WORK-API")).toHaveLength(2);
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("WORK-API")).not.toBeNull();
  });

  it("keeps a glob draft across ready-error-ready catalog transitions", async () => {
    const initial = document(1, [{
      id: "glob",
      name: "Рабочие",
      rule: { kind: "nameGlobs", globs: ["work-*"] },
    }]);
    const store = createWindowFilterStore();
    const slot = renderTypedSlot(
      { component: ProjectFilterEditor },
      { store, projects, catalogStatus: "ready" },
      { rpc: { listFilters: () => ({ status: "success", document: initial }) } },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Рабочие" }));
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("WORK-API")).not.toBeNull();

    slot.lifecycle.rerender(<ProjectFilterEditor store={store} projects={[]} catalogStatus="error" />);
    expect(slot.getByRole("alert").textContent).toContain("Не удалось загрузить каталог проектов");
    expect(slot.queryByText("Нет подходящих проектов.")).toBeNull();
    expect((slot.getByLabelText("Маски проектов") as HTMLTextAreaElement).value).toBe("work-*");

    slot.lifecycle.rerender(
      <ProjectFilterEditor
        store={store}
        catalogStatus="ready"
        projects={[{ ...projects[0], name: "WORK-RENAMED" }, projects[1], projects[2]]}
      />,
    );
    expect(within(slot.getByRole("list", { name: "Подходящие проекты" })).getByText("WORK-RENAMED")).not.toBeNull();
    expect((slot.getByLabelText("Маски проектов") as HTMLTextAreaElement).value).toBe("work-*");
  });

  it("scopes radio ids, labels and native groups to each simultaneous editor mount", async () => {
    const firstStore = createWindowFilterStore();
    const secondStore = createWindowFilterStore();
    const initial = defaultFilterDocument();
    const slot = renderTypedSlot(
      {
        component: () => (
          <>
            <ProjectFilterEditor store={firstStore} projects={projects} />
            <ProjectFilterEditor store={secondStore} projects={projects} />
          </>
        ),
      },
      {},
      {
        rpc: {
          listFilters: () => ({ status: "success", document: initial }),
          setPinnedMode: ({ pinnedMode }: { pinnedMode: FilterDocumentV1["pinnedMode"] }) => ({
            status: "success",
            document: document(1, [], pinnedMode),
          }),
        },
      },
    );
    const filterPinned = (await slot.findAllByLabelText("Фильтровать")).map(requireInput);
    const alwaysPinned = slot.getAllByLabelText("Не фильтровать").map(requireInput);
    const radios = slot.container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const ids = Array.from(radios, (radio) => radio.id);
    const labelTargets = new Set(
      Array.from(slot.container.querySelectorAll<HTMLLabelElement>("label[for]"), (label) => label.htmlFor),
    );
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    for (const radio of radios) {
      expect(labelTargets.has(radio.id)).toBe(true);
    }

    fireEvent.click(alwaysPinned[0]!);
    await waitFor(() => expect(alwaysPinned[0]!.checked).toBe(true));
    expect(filterPinned[1]!.checked).toBe(true);
    expect(alwaysPinned[1]!.checked).toBe(false);
    expect(filterPinned[0]!.name).not.toBe(filterPinned[1]!.name);
  });
});
