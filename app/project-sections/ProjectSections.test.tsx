// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server.js";
import { ALL_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "../preferences/preferences-sync.js";
import {
  PROJECT_SECTIONS_CHANGED_CHANNEL,
  projectSectionReadResultSchema,
} from "../../shared/project-sections.js";
import type { OrganizationMode } from "../../shared/preferences.js";

const app = await loadPluginApp(() => import("../../app.js"));
const registration = app.threadLists[0];
if (!registration) throw new Error("thread-list slot not registered");

const PROJECTS = [
  makePluginProject({ id: "proj_app", name: "App" }),
  makePluginProject({ id: "proj_web", name: "Web" }),
];
const THREADS = [
  makeSidebarThread({ id: "thr_keep", projectId: "proj_app", title: "Keep me" }),
];

function emptyAssignmentRead(input: unknown) {
  const threadIds = (input as { threadIds?: string[] } | null)?.threadIds ?? [];
  return {
    status: "success" as const,
    threads: threadIds.map((threadId) => ({ threadId, metadata: {} })),
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
  windowFilterStore.setActiveFilterId(ALL_FILTER_ID);
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

const DAMAGED_DOCUMENT = { schemaVersion: 1, revision: 4, sections: [{ id: "broken" }], order: [] };

function storedSectionDocument(bb: BbPluginApi): string | undefined {
  const row = bb.storage.database().prepare(
    "SELECT document FROM project_section_document WHERE id = 1",
  ).get() as { document: string } | undefined;
  return row?.document;
}

function insertSectionDocument(bb: BbPluginApi, document: unknown): void {
  bb.storage.database().prepare(
    "INSERT INTO project_section_document (id, document) VALUES (1, ?)",
  ).run(JSON.stringify(document));
}

async function readErrorMessage(callRpc: (method: string, input: null) => Promise<unknown>): Promise<string> {
  const read = projectSectionReadResultSchema.parse(await callRpc("listProjectSections", null));
  if (read.status !== "error") throw new Error("expected a project section read error");
  return read.issues[0]?.message ?? "Не удалось прочитать секции проекта";
}

async function mount(mode?: OrganizationMode, prepare?: (bb: BbPluginApi) => void) {
  const host = createFakePluginHost({ pluginId: "project-first-sidebar" });
  await plugin(host.bb);
  prepare?.(host.bb);
  if (mode) {
    await host.harness.behavior.callRpc("setPreference", { key: "organizationMode", value: mode });
  }
  setPreferencesMirrorStorageForTest(null);
  const slot = renderSlot(registration, props(), {
    pluginId: "project-first-sidebar",
    sidebarThreads: { projects: PROJECTS, sections: [], threads: THREADS },
    rpc: {
      listPreferences: () => host.harness.behavior.callRpc("listPreferences", null),
      setPreference: (input: unknown) => host.harness.behavior.callRpc("setPreference", input),
      listFilters: () => host.harness.behavior.callRpc("listFilters", null),
      listProjectSections: () => host.harness.behavior.callRpc("listProjectSections", null),
      createProjectSection: (input: unknown) => host.harness.behavior.callRpc("createProjectSection", input),
      renameProjectSection: (input: unknown) => host.harness.behavior.callRpc("renameProjectSection", input),
      deleteProjectSection: (input: unknown) => host.harness.behavior.callRpc("deleteProjectSection", input),
      readProjectSectionMetadata: (input: unknown) => emptyAssignmentRead(input),
    },
  });
  return { host, slot };
}

function sectionIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll("[data-project-section-id]"),
    (element) => element.getAttribute("data-project-section-id") ?? "",
  );
}

async function openActions(container: ParentNode, name: string) {
  fireEvent.pointerDown(await within(container as HTMLElement).findByRole("button", { name }), { button: 0 });
}

async function createSection(container: HTMLElement, projectName: string, name: string) {
  await openActions(container, `${projectName} actions`);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Создать секцию" }));
  const input = await screen.findByRole("textbox", { name: "Имя секции" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
  await within(container).findByText(name);
}

describe("empty project sections", () => {
  it("creates, renames, collapses and deletes an empty section without touching the thread", async () => {
    const { slot } = await mount();
    await screen.findByText("Keep me");
    expect(screen.queryByRole("menuitem", { name: "Создать секцию" })).toBeNull();
    await createSection(slot.container, "App", "Alpha");
    await createSection(slot.container, "App", "Beta");
    const created = sectionIds(slot.container);
    expect(created).toHaveLength(2);
    expect(slot.container.querySelectorAll("[data-project-section-collapsed='false']")).toHaveLength(2);

    await openActions(slot.container, "Alpha: действия");
    const sectionMenu = screen.getByRole("menuitem", { name: "Переименовать" }).closest('[role="menu"]');
    expect(Array.from(sectionMenu?.querySelectorAll('[role="menuitem"]') ?? [], (item) => item.textContent)).toEqual([
      "Новый тред",
      "Переименовать",
      "Удалить секцию",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Переименовать" }));
    const rename = await screen.findByRole("textbox", { name: "Имя секции" });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Имя секции" })).toBeNull());
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "renameProjectSection")).toEqual([]);

    await openActions(slot.container, "Alpha: действия");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }));
    const next = await screen.findByRole("textbox", { name: "Имя секции" });
    fireEvent.change(next, { target: { value: "alpha" } });
    fireEvent.keyDown(next, { key: "Enter" });
    await within(slot.container).findByText("alpha");

    fireEvent.click(screen.getByRole("button", { name: "Свернуть alpha" }));
    expect(slot.container.querySelector("[data-project-section-id]")?.getAttribute("data-project-section-collapsed")).toBe("true");
    expect(slot.container.querySelectorAll("[data-project-section-collapsed='false']")).toHaveLength(1);
    const collapsedSection = slot.container.querySelector("[data-project-section-collapsed='true']");
    const { SidebarSectionRow } = await import("../list/SidebarSectionRow.js");
    const standard = renderSlot({ component: SidebarSectionRow }, {
      name: "Empty standard",
      label: "Empty standard",
      depth: 1,
      activity: getCollapsedChildActivity([]),
      isCollapsed: true,
      onToggleCollapsed: () => undefined,
    });
    expect(collapsedSection?.querySelector("[data-thread-status-glyph]")).toBeNull();
    expect(standard.container.querySelector("[data-thread-status-glyph]")).toBeNull();

    await openActions(slot.container, "alpha: действия");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Удалить секцию" }));
    expect(screen.getByRole("dialog").textContent).toContain("Треды снова показываются непосредственно под проектом");
    expect(screen.getByRole("dialog").textContent).toContain("штатная секция не изменяются");
    const sdkBeforeDelete = slot.inspection.sdkCalls.length;
    fireEvent.click(screen.getByRole("button", { name: "Удалить секцию" }));
    await waitFor(() => expect(sectionIds(slot.container)).toEqual([created[1]]));
    expect(screen.getByText("Keep me")).not.toBeNull();
    expect(slot.inspection.sdkCalls.slice(sdkBeforeDelete)).toEqual([]);
  });

  it("keeps the same name in another project, rejects a duplicate, and keeps a rename draft", async () => {
    const { host, slot } = await mount();
    await screen.findByText("App");
    await createSection(slot.container, "App", "Alpha");
    await openActions(slot.container, "Web actions");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Создать секцию" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Имя секции" }), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
    await waitFor(() => expect(screen.getAllByText("Alpha")).toHaveLength(2));

    await openActions(slot.container, "App actions");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Создать секцию" }));
    const input = await screen.findByRole("textbox", { name: "Имя секции" });
    fireEvent.change(input, { target: { value: ` ${"b".repeat(201)} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
    expect(await screen.findByText("Имя секции не длиннее 200 символов.")).not.toBeNull();
    expect((input as HTMLInputElement).value).toBe(` ${"b".repeat(201)} `);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSection")).toHaveLength(2);

    fireEvent.change(input, { target: { value: " Alpha " } });
    fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
    expect(await screen.findByText("section names must be unique within a project")).not.toBeNull();
    expect(sectionIds(slot.container)).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Escape" });

    const appList = slot.container.querySelector("[data-project-section-list='proj_app']");
    if (appList === null) throw new Error("expected the App section list");
    await openActions(appList as HTMLElement, "Alpha: действия");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Переименовать" }));
    const rename = await screen.findByRole("textbox", { name: "Имя секции" });
    fireEvent.change(rename, { target: { value: "Draft" } });
    await host.harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 2,
      projectId: "proj_app",
      name: "Elsewhere",
    });
    fireEvent.keyDown(rename, { key: "Enter" });
    await waitFor(() => expect((rename as HTMLInputElement).value).toBe("Draft"));
    expect(screen.getByRole("alert").textContent).toContain("Could not save the name");
    await waitFor(() => expect(within(slot.container).getByText("Elsewhere")).not.toBeNull());
    expect(within(slot.container).getByText("Alpha")).not.toBeNull();
  });

  it("shows the section after remount and in a second window", async () => {
    const { host, slot } = await mount();
    await screen.findByText("App");
    await createSection(slot.container, "App", "Shared");
    const second = renderSlot(registration, props(), {
      pluginId: "project-first-sidebar",
      sidebarThreads: { projects: PROJECTS, sections: [], threads: THREADS },
      rpc: {
        listPreferences: () => host.harness.behavior.callRpc("listPreferences", null),
        setPreference: (input: unknown) => host.harness.behavior.callRpc("setPreference", input),
        listFilters: () => host.harness.behavior.callRpc("listFilters", null),
        listProjectSections: () => host.harness.behavior.callRpc("listProjectSections", null),
        createProjectSection: (input: unknown) => host.harness.behavior.callRpc("createProjectSection", input),
        renameProjectSection: (input: unknown) => host.harness.behavior.callRpc("renameProjectSection", input),
        deleteProjectSection: (input: unknown) => host.harness.behavior.callRpc("deleteProjectSection", input),
      readProjectSectionMetadata: (input: unknown) => emptyAssignmentRead(input),
      },
    });
    await second.behavior.emitRealtime(PROJECT_SECTIONS_CHANGED_CHANNEL, { revision: 1 });
    await within(second.container).findByText("Shared");
    slot.unmount();
    second.unmount();
    const reloaded = renderSlot(registration, props(), {
      pluginId: "project-first-sidebar",
      sidebarThreads: { projects: PROJECTS, sections: [], threads: THREADS },
      rpc: {
        listPreferences: () => host.harness.behavior.callRpc("listPreferences", null),
        setPreference: (input: unknown) => host.harness.behavior.callRpc("setPreference", input),
        listFilters: () => host.harness.behavior.callRpc("listFilters", null),
        listProjectSections: () => host.harness.behavior.callRpc("listProjectSections", null),
        createProjectSection: (input: unknown) => host.harness.behavior.callRpc("createProjectSection", input),
        renameProjectSection: (input: unknown) => host.harness.behavior.callRpc("renameProjectSection", input),
        deleteProjectSection: (input: unknown) => host.harness.behavior.callRpc("deleteProjectSection", input),
      readProjectSectionMetadata: (input: unknown) => emptyAssignmentRead(input),
      },
    });
    await within(reloaded.container).findByText("Shared");
  });

  it("hides project sections outside project mode and in Без проектов", async () => {
    const chronological = await mount("chronological");
    await screen.findByText("Keep me");
    expect(chronological.slot.container.textContent).not.toContain("Создать секцию");
    expect(chronological.slot.container.textContent).not.toContain("Новый тред");
    expect(chronological.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    chronological.slot.unmount();
    resetPreferencesSyncForTest();

    const machine = await mount("machine");
    await screen.findByText("Keep me");
    expect(machine.slot.container.textContent).not.toContain("Создать секцию");
    expect(machine.slot.container.textContent).not.toContain("Новый тред");
    expect(machine.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    machine.slot.unmount();
    resetPreferencesSyncForTest();

    const projects = await mount();
    await screen.findByText("App");
    await createSection(projects.slot.container, "App", "Hidden");
    fireEvent.click(await screen.findByRole("radio", { name: "Без проектов" }));
    await waitFor(() => expect(projects.slot.container.textContent).not.toContain("Создать секцию"));
    expect(projects.slot.container.textContent).not.toContain("Новый тред");
    expect(projects.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    expect(screen.queryByText("Hidden")).toBeNull();
  });

  it("shows a damaged document on the first read and again after an empty document", async () => {
    const first = await mount(undefined, (bb) => insertSectionDocument(bb, DAMAGED_DOCUMENT));
    const firstBytes = storedSectionDocument(first.host.bb);
    const firstMessage = await readErrorMessage((method, input) => first.host.harness.behavior.callRpc(method, input));
    await screen.findByText("App");
    expect(await within(first.slot.container).findAllByRole("alert")).not.toHaveLength(0);
    expect(first.slot.container.textContent).toContain(firstMessage);
    expect(first.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    expect(first.slot.container.querySelector("[data-project-section-status]")?.getAttribute("data-project-section-status")).toBe("error");
    expect(storedSectionDocument(first.host.bb)).toBe(firstBytes);
    first.slot.unmount();
    resetPreferencesSyncForTest();

    const second = await mount();
    await screen.findByText("App");
    await waitFor(() => expect(
      second.slot.container.querySelector("[data-project-section-status]")?.getAttribute("data-project-section-status"),
    ).toBe("ready"));
    expect(second.slot.container.querySelector("[data-project-section-read-error]")).toBeNull();
    expect(second.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    insertSectionDocument(second.host.bb, DAMAGED_DOCUMENT);
    const secondBytes = storedSectionDocument(second.host.bb);
    await second.slot.behavior.emitRealtime(PROJECT_SECTIONS_CHANGED_CHANNEL, { revision: 1 });
    const secondMessage = await readErrorMessage((method, input) => second.host.harness.behavior.callRpc(method, input));
    await waitFor(() => expect(second.slot.container.textContent).toContain(secondMessage));
    expect(second.slot.container.querySelectorAll("[role='alert']").length).toBeGreaterThan(0);
    expect(second.slot.container.querySelector("[data-project-section-id]")).toBeNull();
    expect(second.slot.container.querySelector("[data-project-section-status]")?.getAttribute("data-project-section-status")).toBe("error");
    expect(storedSectionDocument(second.host.bb)).toBe(secondBytes);
    expect(secondBytes).not.toBe(JSON.stringify({ schemaVersion: 1, revision: 0, sections: [], order: [] }));
  });
});
