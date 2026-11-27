import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL } from "./shared/project-section-assignment.js";

const PLUGIN_ID = "project-first-sidebar";

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

function threadHost() {
  const metadata = new Map<string, Record<string, unknown>>();
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const host = createFakePluginHost({ pluginId: PLUGIN_ID });
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
    threads.set(thread.id, thread);
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
  return { host, metadata, threads };
}

async function createSection(
  callRpc: (method: string, input: unknown) => Promise<unknown>,
  projectId: string,
  name: string,
  expectedRevision: number,
) {
  const created = await callRpc("createProjectSection", { expectedRevision, projectId, name }) as {
    status: string;
    document: { sections: { id: string; projectId: string; name: string }[] };
  };
  if (created.status !== "success") throw new Error("expected section create");
  const section = created.document.sections.find((item) => item.projectId === projectId && item.name === name);
  if (!section) throw new Error("expected created section");
  return section.id;
}

function tableNames(host: ReturnType<typeof threadHost>["host"]): string[] {
  return (host.bb.storage.database().prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as { name: string }[]).map((row) => row.name);
}

describe("create a thread in a project section", () => {
  it("spawns one thread with the assignment seed and does not write the assignment again", async () => {
    const { host, threads } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    const tablesBefore = tableNames(host);

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toEqual({
      status: "success",
      threadId: "thr_seeded",
      assignment: { projectId: "proj_app", projectSectionId: sectionId },
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([[{
      ...REQUEST,
      pluginMetadata: { projectId: "proj_app", projectSectionId: sectionId },
      origin: "plugin",
      originPluginId: PLUGIN_ID,
    }]]);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(threads.get("thr_seeded")?.sectionId).toBeNull();
    expect(threads.get("thr_seeded")?.sectionId).not.toBe(sectionId);
    expect(threads.get("thr_seeded")?.originPluginId).toBe(PLUGIN_ID);
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_seeded"],
    })).resolves.toEqual({
      status: "success",
      threads: [{
        threadId: "thr_seeded",
        metadata: { projectId: "proj_app", projectSectionId: sectionId },
      }],
    });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([
      { channel: PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, payload: { threadIds: ["thr_seeded"] } },
    ]);
    expect(tableNames(host)).toEqual(tablesBefore);
  });

  it("rejects a different project without spawning or rewriting the request", async () => {
    const { host } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    const listed = await harness.behavior.callRpc("listProjectSections", null);

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: { ...REQUEST, projectId: "proj_other" },
    })).resolves.toEqual({
      status: "error",
      code: "project_mismatch",
      issues: [{ path: ["request", "projectId"], message: "request projectId does not match the project section" }],
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);
    await expect(harness.behavior.callRpc("listProjectSections", null)).resolves.toEqual(listed);
  });

  it("rejects a section deleted before the check and does not spawn", async () => {
    const { host } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    await harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1,
      projectId: "proj_app",
      sectionId,
    });

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toEqual({
      status: "error",
      code: "section_unavailable",
      issues: [{ path: ["projectSectionId"], message: "project section was not found" }],
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);
  });

  it("does not fill the standard sectionId with the project section id", async () => {
    const { host, threads } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: { ...REQUEST, sectionId },
    })).resolves.toMatchObject({ status: "success", threadId: "thr_seeded" });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([[{
      ...REQUEST,
      pluginMetadata: { projectId: "proj_app", projectSectionId: sectionId },
      origin: "plugin",
      originPluginId: PLUGIN_ID,
    }]]);
    expect(threads.get("thr_seeded")?.sectionId).toBeNull();
  });

  it("reports spawn_failed once and does not publish an assignment", async () => {
    const { host } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    harness.sdk.stub("threads.spawn", async () => {
      throw new Error("spawn down");
    });

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toEqual({
      status: "error",
      code: "spawn_failed",
      issues: [{ path: [], message: "thread spawn failed" }],
    });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_seeded"],
    })).resolves.toEqual({
      status: "success",
      threads: [{ threadId: "thr_seeded", metadata: {} }],
    });
  });

  it("leaves one inactive assignment when the section disappears after the check", async () => {
    const { host, metadata } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    harness.sdk.stub("threads.spawn", async (args: {
      projectId: string;
      sectionId?: string | null;
      originPluginId?: string | null;
      pluginMetadata?: Record<string, unknown>;
    }) => {
      await harness.behavior.callRpc("deleteProjectSection", {
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
      if (args.pluginMetadata !== undefined) metadata.set(thread.id, { ...args.pluginMetadata });
      return thread;
    });

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toEqual({
      status: "success",
      threadId: "thr_seeded",
      assignment: { projectId: "proj_app", projectSectionId: sectionId },
    });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    await expect(harness.behavior.callRpc("listProjectSections", null)).resolves.toMatchObject({
      status: "success",
      document: { sections: [], order: [] },
    });
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_seeded"],
    })).resolves.toEqual({
      status: "success",
      threads: [{
        threadId: "thr_seeded",
        metadata: { projectId: "proj_app", projectSectionId: sectionId },
      }],
    });
  });

  it("does not hold the section writer while spawn is in flight", async () => {
    const { host, metadata } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    let releaseSpawn: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    harness.sdk.stub("threads.spawn", async (args: {
      projectId: string;
      pluginMetadata?: Record<string, unknown>;
    }) => {
      await gate;
      const thread = makeThreadResponse({ id: "thr_seeded", projectId: args.projectId, sectionId: null });
      if (args.pluginMetadata !== undefined) metadata.set(thread.id, { ...args.pluginMetadata });
      return thread;
    });

    const pending = harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    });
    const created = await Promise.race([
      harness.behavior.callRpc("createProjectSection", {
        expectedRevision: 1,
        projectId: "proj_app",
        name: "Beta",
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("writer held during spawn")), 300);
      }),
    ]);
    expect(created).toMatchObject({ status: "success", document: { revision: 2 } });
    releaseSpawn();
    await expect(pending).resolves.toMatchObject({
      status: "success",
      threadId: "thr_seeded",
      assignment: { projectId: "proj_app", projectSectionId: sectionId },
    });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
  });

  it("spawns again when the caller repeats a create, without an idempotency journal", async () => {
    const { host, metadata } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    const tablesBefore = tableNames(host);
    let created = 0;
    harness.sdk.stub("threads.spawn", async (args: {
      projectId: string;
      pluginMetadata?: Record<string, unknown>;
    }) => {
      created += 1;
      const thread = makeThreadResponse({
        id: created === 1 ? "thr_one" : "thr_two",
        projectId: args.projectId,
        sectionId: null,
      });
      if (args.pluginMetadata !== undefined) metadata.set(thread.id, { ...args.pluginMetadata });
      return thread;
    });

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toMatchObject({ status: "success", threadId: "thr_one" });
    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: sectionId,
      request: REQUEST,
    })).resolves.toMatchObject({ status: "success", threadId: "thr_two" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(tableNames(host)).toEqual(tablesBefore);
  });

  it("does not spawn when the section document cannot be read", async () => {
    const { host } = threadHost();
    const { bb, harness } = host;
    await plugin(bb);
    bb.storage.database().prepare(
      "INSERT INTO project_section_document (id, document) VALUES (1, ?)",
    ).run("{");

    await expect(harness.behavior.callRpc("createProjectSectionThread", {
      projectSectionId: "sec_unread",
      request: REQUEST,
    })).resolves.toMatchObject({ status: "error", code: "storage" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toEqual([]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);
    expect(bb.storage.database().prepare(
      "SELECT document FROM project_section_document WHERE id = 1",
    ).get()).toEqual({ document: "{" });
  });
});
