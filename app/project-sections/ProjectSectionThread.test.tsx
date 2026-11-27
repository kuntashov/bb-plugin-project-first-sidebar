// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server.js";
import { PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL } from "../../shared/project-section-assignment.js";
import { ALL_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
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

const REQUEST = {
  projectId: "proj_app",
  providerId: "codex",
  model: "gpt-5.4",
  reasoningLevel: "medium",
  permissionMode: "auto",
  executionInputSources: { model: "caller" },
  environment: { type: "project-default" },
  input: [{ type: "text", text: "Ship the section", mentions: [] }],
};

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

async function mount(options?: { threads?: ReturnType<typeof makeSidebarThread>[] }) {
  const host = createFakePluginHost({ pluginId: "project-first-sidebar" });
  const metadata = new Map<string, Record<string, unknown>>();
  const loseResponse = { current: false };
  host.harness.sdk.stub("threads.spawn", async (args: {
    projectId: string;
    sectionId?: string | null;
    originPluginId?: string | null;
    pluginMetadata?: Record<string, unknown>;
  }) => {
    const thread = makeThreadResponse({
      id: "thr_seeded",
      projectId: args.projectId,
      sectionId: args.sectionId ?? null,
      originPluginId: args.originPluginId ?? null,
    });
    if (args.pluginMetadata !== undefined) metadata.set(thread.id, { ...args.pluginMetadata });
    return thread;
  });
  host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: {
    threadIds: readonly string[];
  }) => ({
    threads: args.threadIds.map((threadId) => ({
      threadId,
      metadata: metadata.get(threadId) ?? {},
    })),
  }));
  await plugin(host.bb);
  setPreferencesMirrorStorageForTest(null);
  const rpc = {
    listPreferences: () => host.harness.behavior.callRpc("listPreferences", null),
    setPreference: (input: unknown) => host.harness.behavior.callRpc("setPreference", input),
    listFilters: () => host.harness.behavior.callRpc("listFilters", null),
    listProjectSections: () => host.harness.behavior.callRpc("listProjectSections", null),
    createProjectSection: (input: unknown) => host.harness.behavior.callRpc("createProjectSection", input),
    renameProjectSection: (input: unknown) => host.harness.behavior.callRpc("renameProjectSection", input),
    deleteProjectSection: (input: unknown) => host.harness.behavior.callRpc("deleteProjectSection", input),
    readProjectSectionMetadata: (input: unknown) => host.harness.behavior.callRpc("readProjectSectionMetadata", input),
    createProjectSectionThread: async (input: unknown) => {
      const result = await host.harness.behavior.callRpc("createProjectSectionThread", input);
      if (loseResponse.current) throw new Error("response lost");
      return result;
    },
  };
  const open = (threads: ReturnType<typeof makeSidebarThread>[] = options?.threads ?? THREADS) => renderSlot(registration, props(), {
    pluginId: "project-first-sidebar",
    sidebarThreads: { projects: PROJECTS, sections: [], threads },
    rpc,
  });
  return { host, metadata, loseResponse, slot: open(), open };
}

async function openActions(container: ParentNode, name: string) {
  fireEvent.pointerDown(await within(container as HTMLElement).findByRole("button", { name }), { button: 0 });
}

async function createSection(container: HTMLElement, projectName: string, name: string) {
  await openActions(container, `${projectName} actions`);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Создать секцию" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "Имя секции" }), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Создать секцию" }));
  await within(container).findByText(name);
}

function sectionIdByName(container: ParentNode, name: string): string {
  const element = [...container.querySelectorAll("[data-project-section-id]")].find((node) => node.textContent?.includes(name));
  const id = element?.getAttribute("data-project-section-id");
  if (!id) throw new Error(`section ${name} is missing`);
  return id;
}

function project(projectId: string): HTMLElement {
  const element = document.querySelector(`[data-sidebar-project-id="${projectId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`project ${projectId} is missing`);
  return element;
}

function idsInside(root: ParentNode): string[] {
  return [...root.querySelectorAll("[data-sidebar-thread-id]")].map((element) => element.getAttribute("data-sidebar-thread-id") ?? "");
}

function looseIds(projectId: string): string[] {
  return idsInside(project(projectId)).filter((id) => {
    const link = project(projectId).querySelector(`[data-sidebar-thread-id="${id}"]`);
    return link?.closest("[data-project-section-id]") === null;
  });
}

function sectionBox(sectionId: string): HTMLElement {
  const element = document.querySelector(`[data-project-section-id="${sectionId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`section ${sectionId} is missing`);
  return element;
}

async function openComposer(container: HTMLElement, sectionName: string) {
  await openActions(container, `${sectionName}: действия`);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Новый тред" }));
  return screen.findByTestId("bb-new-thread-composer");
}

function promptBox(): HTMLTextAreaElement {
  const input = screen.getByTestId("bb-new-thread-composer-input");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("composer prompt is missing");
  return input;
}

function sectionDocument(host: { bb: { storage: { database(): { prepare(sql: string): { get(): unknown } } } } }): string | undefined {
  const row = host.bb.storage.database().prepare(
    "SELECT document FROM project_section_document WHERE id = 1",
  ).get() as { document: string } | undefined;
  return row?.document;
}

describe("new thread in a project section", () => {
  it("opens the hosted composer seeded with the section project", async () => {
    const { slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    const sectionId = slot.container.querySelector("[data-project-section-id]")?.getAttribute("data-project-section-id");
    if (!sectionId) throw new Error("expected a project section");

    await openActions(slot.container, "Alpha: действия");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Новый тред" }));

    const composer = await screen.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe("proj_app");
    expect(composer.getAttribute("data-draft-key")).toBe(`project-section:${sectionId}`);
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread")).toEqual([]);
  });

  it("creates one seeded thread from the submitted selection and opens it", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    const sectionId = sectionIdByName(slot.container, "Alpha");
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Ship the section" } });
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));

    await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_seeded" },
    ]));
    expect(screen.queryByTestId("bb-new-thread-composer")).toBeNull();
    const creates = slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.input).toMatchObject({
      projectSectionId: sectionId,
      request: {
        projectId: "proj_app",
        providerId: "codex",
        model: "gpt-5",
        input: [{ type: "text", text: "Ship the section", mentions: [] }],
      },
    });
    expect(creates[0]?.input).toMatchObject({ request: expect.not.objectContaining({ sectionId: sectionId }) });
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([[expect.objectContaining({
      projectId: "proj_app",
      pluginMetadata: { projectId: "proj_app", projectSectionId: sectionId },
      origin: "plugin",
      originPluginId: "project-first-sidebar",
    })]]);
    const spawnArgs = host.harness.sdk.callsTo("threads.spawn")[0]?.[0] as { sectionId?: string };
    expect(spawnArgs.sectionId).toBeUndefined();
    expect(host.harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(slot.inspection.navigateCalls.filter((call) => call.method === "toCompose")).toEqual([]);
  });

  it("does not create a thread when the composer is cancelled", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(screen.queryByTestId("bb-new-thread-composer")).toBeNull();
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread")).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("keeps the prompt when spawn fails and does not retry", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    host.harness.sdk.stub("threads.spawn", async () => {
      throw new Error("spawn down");
    });
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Do not lose me" } });
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось создать тред. Черновик сохранён.");
    expect(promptBox().value).toBe("Do not lose me");
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread")).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread")).toHaveLength(1);
  });

  it("keeps the prompt when the response is lost after spawn and does not retry", async () => {
    const { host, loseResponse, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    const sectionId = sectionIdByName(slot.container, "Alpha");
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Already spawned" } });
    loseResponse.current = true;
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain("Не удалось создать тред. Черновик сохранён.");
    expect(promptBox().value).toBe("Already spawned");
    expect(slot.inspection.navigateCalls).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(host.harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    await expect(host.harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_seeded"],
    })).resolves.toMatchObject({
      threads: [{ metadata: { projectId: "proj_app", projectSectionId: sectionId } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
  });

  it("rejects a removed section before spawn and keeps the prompt", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    const sectionId = sectionIdByName(slot.container, "Alpha");
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Section is gone" } });
    await host.harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1,
      projectId: "proj_app",
      sectionId,
    });
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain("Секция уже удалена. Тред не создан, черновик сохранён.");
    expect(promptBox().value).toBe("Section is gone");
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("rejects a project that no longer matches the section and keeps the submitted project", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    const sectionId = sectionIdByName(slot.container, "Alpha");
    await openComposer(slot.container, "Alpha");
    fireEvent.change(promptBox(), { target: { value: "Wrong project" } });
    const stored = sectionDocument(host);
    if (stored === undefined) throw new Error("expected the section document");
    const document = JSON.parse(stored) as {
      sections: { id: string; projectId: string }[];
      order: { projectId: string; sectionIds: string[] }[];
    };
    const section = document.sections.find((item) => item.id === sectionId);
    const order = document.order.find((entry) => entry.sectionIds.includes(sectionId));
    if (!section || !order) throw new Error("expected the section");
    section.projectId = "proj_web";
    order.projectId = "proj_web";
    host.bb.storage.database().prepare(
      "UPDATE project_section_document SET document = ? WHERE id = 1",
    ).run(JSON.stringify(document));
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));

    expect((await screen.findByRole("alert")).textContent).toContain("Выбран другой проект. Тред не создан, черновик сохранён.");
    expect(promptBox().value).toBe("Wrong project");
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(slot.inspection.navigateCalls).toEqual([]);
    const creates = slot.inspection.rpcCalls.filter((call) => call.method === "createProjectSectionThread");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.input).toMatchObject({
      request: { projectId: "proj_app" },
    });
  });

  it("uses a separate stable draft key per section and does not store the draft", async () => {
    const { host, slot } = await mount();
    await screen.findByText("Keep me");
    await createSection(slot.container, "App", "Alpha");
    await createSection(slot.container, "App", "Beta");
    const alphaId = sectionIdByName(slot.container, "Alpha");
    const betaId = sectionIdByName(slot.container, "Beta");
    const writes: string[] = [];
    const kv = host.bb.storage.kv;
    const originalSet = kv.set.bind(kv);
    kv.set = async (key, value) => {
      writes.push(key);
      return originalSet(key, value);
    };
    const stored = sectionDocument(host);

    await openComposer(slot.container, "Alpha");
    expect(screen.getByTestId("bb-new-thread-composer").getAttribute("data-draft-key")).toBe(`project-section:${alphaId}`);
    fireEvent.change(promptBox(), { target: { value: "alpha draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await openComposer(slot.container, "Beta");
    expect(screen.getByTestId("bb-new-thread-composer").getAttribute("data-draft-key")).toBe(`project-section:${betaId}`);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await openComposer(slot.container, "Alpha");
    expect(screen.getByTestId("bb-new-thread-composer").getAttribute("data-draft-key")).toBe(`project-section:${alphaId}`);
    expect(writes).toEqual([]);
    expect(sectionDocument(host)).toBe(stored);
    expect(await host.bb.storage.kv.list()).not.toContain("project-section");
  });

  it("shows the spawned thread in its section from the same metadata read", async () => {
    const view = await mount({ threads: [] });
    const created = await view.host.harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0,
      projectId: "proj_app",
      name: "Alpha",
    }) as { status: string; document: { sections: { id: string; name: string }[] } };
    const sectionId = created.document.sections.find((section) => section.name === "Alpha")?.id;
    if (created.status !== "success" || sectionId === undefined) throw new Error("expected Alpha");
    await view.host.harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    });
    view.slot.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.open([makeSidebarThread({
      id: "thr_seeded",
      projectId: "proj_app",
      title: "Seeded",
      createdAt: 3,
      latestAttentionAt: 3,
    })]);

    await waitFor(() => expect(idsInside(sectionBox(sectionId))).toEqual(["thr_seeded"]));
    expect(looseIds("proj_app")).not.toContain("thr_seeded");
  });

  it("moves the new thread into its section after the assignment signal", async () => {
    const view = await mount({
      threads: [makeSidebarThread({
        id: "thr_seeded",
        projectId: "proj_app",
        title: "Seeded",
        createdAt: 3,
        latestAttentionAt: 3,
      })],
    });
    await createSection(view.slot.container, "App", "Alpha");
    const sectionId = sectionIdByName(view.slot.container, "Alpha");
    await waitFor(() => expect(looseIds("proj_app")).toContain("thr_seeded"));
    await view.host.harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    });
    const signal = view.host.harness.realtimeSignals.find((item) => (
      item.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL
      && JSON.stringify(item.payload) === JSON.stringify({ threadIds: ["thr_seeded"] })
    ));
    if (!signal) throw new Error("expected the assignment signal");
    await view.slot.behavior.emitRealtime(signal.channel, signal.payload);

    await waitFor(() => expect(idsInside(sectionBox(sectionId))).toEqual(["thr_seeded"]));
    expect(looseIds("proj_app")).not.toContain("thr_seeded");
    expect(view.host.harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
  });

  it("shows one loose thread when the section disappears after spawn", async () => {
    const view = await mount({ threads: [] });
    const created = await view.host.harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0,
      projectId: "proj_app",
      name: "Alpha",
    }) as { status: string; document: { sections: { id: string; name: string }[] } };
    const sectionId = created.document.sections.find((section) => section.name === "Alpha")?.id;
    if (created.status !== "success" || sectionId === undefined) throw new Error("expected Alpha");
    view.host.harness.sdk.stub("threads.spawn", async (args: {
      projectId: string;
      sectionId?: string | null;
      originPluginId?: string | null;
      pluginMetadata?: Record<string, unknown>;
    }) => {
      await view.host.harness.behavior.callRpc("deleteProjectSection", {
        expectedRevision: 1,
        projectId: "proj_app",
        sectionId,
      });
      const thread = makeThreadResponse({
        id: "thr_seeded",
        projectId: args.projectId,
        sectionId: args.sectionId ?? null,
        originPluginId: args.originPluginId ?? null,
      });
      if (args.pluginMetadata !== undefined) view.metadata.set(thread.id, { ...args.pluginMetadata });
      return thread;
    });
    await view.host.harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    });
    expect(view.host.harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(view.host.harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    view.slot.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.open([makeSidebarThread({
      id: "thr_seeded",
      projectId: "proj_app",
      title: "Seeded",
      createdAt: 4,
      latestAttentionAt: 4,
    })]);

    await screen.findByText("Seeded");
    expect(document.querySelector("[data-project-section-id]")).toBeNull();
    expect(looseIds("proj_app")).toEqual(["thr_seeded"]);
    await expect(view.host.harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_seeded"],
    })).resolves.toMatchObject({
      threads: [{ metadata: { projectId: "proj_app", projectSectionId: sectionId } }],
    });
  });
});
