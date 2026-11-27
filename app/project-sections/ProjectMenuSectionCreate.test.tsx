// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server.js";
import { ALL_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { sdkResult, makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import {
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "../preferences/preferences-sync.js";

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

async function mount() {
  const host = createFakePluginHost({ pluginId: "project-first-sidebar" });
  await plugin(host.bb);
  setPreferencesMirrorStorageForTest(null);
  const slot = renderSlot(registration, props(), {
    pluginId: "project-first-sidebar",
    sidebarThreads: { projects: PROJECTS, sections: [], threads: THREADS },
    sdk: {
      threadSections: {
        create: sdkResult({ id: "sec_created", name: "Alpha", createdAt: 1, updatedAt: 1 }),
      },
    },
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
  await screen.findByText("App");
  return { host, slot };
}

function projectRow(): HTMLElement {
  const row = document.querySelector("[data-sidebar-project-id='proj_app']");
  if (!(row instanceof HTMLElement)) throw new Error("project row proj_app is missing");
  return row;
}

function menuOf(item: HTMLElement): HTMLElement {
  const menu = item.closest('[role="menu"]');
  if (!(menu instanceof HTMLElement)) throw new Error("section menu is missing");
  return menu;
}

function assertNoStandardNewSection(menu: HTMLElement) {
  expect(within(menu).queryByRole("menuitem", { name: "New section" })).toBeNull();
  const organize = within(menu).queryByRole("menuitem", { name: "Organize" });
  if (organize === null) return;
  const separatorBeforeOrganize = [...menu.querySelectorAll('[role="separator"]')].some(
    (separator) =>
      (organize.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
  );
  expect(separatorBeforeOrganize).toBe(false);
}

async function submitProjectSection(item: HTMLElement) {
  fireEvent.click(item);
  const input = await screen.findByRole("textbox", { name: "Имя секции" });
  fireEvent.change(input, { target: { value: "Alpha" } });
  fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
}

function standardSectionCreates(slot: Awaited<ReturnType<typeof mount>>["slot"]) {
  return slot.inspection.sdkCalls.filter((call) => call.method === "threadSections.create");
}

async function expectProjectSectionCreate(
  slot: Awaited<ReturnType<typeof mount>>["slot"],
) {
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSection"),
    ).toEqual([
      {
        method: "createProjectSection",
        input: { expectedRevision: 0, projectId: "proj_app", name: "Alpha" },
      },
    ]),
  );
  expect(standardSectionCreates(slot)).toEqual([]);
  await within(projectRow()).findByText("Alpha");
}

describe("project row section creation", () => {
  it("creates a project section from App actions and does not offer New section", async () => {
    const { slot } = await mount();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "App actions" }), { button: 0 });
    const create = await screen.findByRole("menuitem", { name: "Создать секцию" });
    assertNoStandardNewSection(menuOf(create));
    await submitProjectSection(create);
    await expectProjectSectionCreate(slot);
  });

  it("creates a project section from the project row context menu and does not offer New section", async () => {
    const { slot } = await mount();
    fireEvent.contextMenu(within(projectRow()).getByTitle("App"));
    const create = await screen.findByRole("menuitem", { name: "Создать секцию" });
    assertNoStandardNewSection(menuOf(create));
    await submitProjectSection(create);
    await expectProjectSectionCreate(slot);
  });
});
