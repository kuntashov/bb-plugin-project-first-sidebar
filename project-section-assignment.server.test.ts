import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { FILTER_DOCUMENT_KV_KEY } from "./shared/filters.js";
import { PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL } from "./shared/project-section-assignment.js";
import { PROJECT_SECTIONS_CHANGED_CHANNEL } from "./shared/project-sections.js";

const PLUGIN_ID = "project-first-sidebar";

function metadataHost() {
  const metadata = new Map<string, Record<string, unknown>>();
  const host = createFakePluginHost({ pluginId: PLUGIN_ID });
  host.harness.sdk.stub("threads.updatePluginMetadata", async (args: {
    threadId: string;
    set?: Record<string, unknown>;
    remove?: string[];
  }) => {
    const next = { ...(metadata.get(args.threadId) ?? {}) };
    for (const key of args.remove ?? []) delete next[key];
    Object.assign(next, args.set ?? {});
    metadata.set(args.threadId, next);
    return next;
  });
  host.harness.sdk.stub("threads.experimental_listPluginMetadata", async (args: {
    threadIds: readonly string[];
  }) => ({
    threads: args.threadIds.map((threadId) => ({
      threadId,
      metadata: metadata.get(threadId) ?? {},
    })),
  }));
  host.harness.sdk.stub("threads.getPluginMetadata", async (args: { threadId: string }) => (
    metadata.get(args.threadId) ?? {}
  ));
  return host;
}

async function createSection(callRpc: (method: string, input: unknown) => Promise<unknown>, projectId: string, name: string, expectedRevision: number) {
  const created = await callRpc("createProjectSection", { expectedRevision, projectId, name }) as {
    status: string;
    document: { sections: { id: string; projectId: string; name: string }[] };
  };
  if (created.status !== "success") throw new Error("expected section create");
  const section = created.document.sections.find((item) => item.projectId === projectId && item.name === name);
  if (!section) throw new Error("expected created section");
  return section.id;
}

describe("project section assignment", () => {
  it("stores one assignment record and clears only those fields", async () => {
    const { bb, harness } = metadataHost();
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    await bb.sdk.threads.updatePluginMetadata({
      threadId: "thr_root",
      set: { note: "keep" },
    });

    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_root",
      projectId: "proj_app",
      projectSectionId: sectionId,
    })).resolves.toEqual({ status: "success" });

    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_root"],
    })).resolves.toEqual({
      status: "success",
      threads: [{
        threadId: "thr_root",
        metadata: { note: "keep", projectId: "proj_app", projectSectionId: sectionId },
      }],
    });
    expect(harness.sdk.callsTo("threads.update").length).toBe(0);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([
      { channel: PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, payload: { threadIds: ["thr_root"] } },
    ]);

    const replaced = await createSection(harness.behavior.callRpc, "proj_app", "Beta", 1);
    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_root",
      projectId: "proj_app",
      projectSectionId: replaced,
    })).resolves.toEqual({ status: "success" });
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_root"],
    })).resolves.toEqual({
      status: "success",
      threads: [{
        threadId: "thr_root",
        metadata: { note: "keep", projectId: "proj_app", projectSectionId: replaced },
      }],
    });

    await expect(harness.behavior.callRpc("clearProjectSectionAssignment", {
      threadId: "thr_root",
    })).resolves.toEqual({ status: "success" });
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_root"],
    })).resolves.toEqual({
      status: "success",
      threads: [{ threadId: "thr_root", metadata: { note: "keep" } }],
    });
  });

  it("rejects a missing or foreign definition without writing metadata", async () => {
    const { bb, harness } = metadataHost();
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    const before = harness.sdk.callsTo("threads.updatePluginMetadata").length;

    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_child",
      projectId: "proj_app",
      projectSectionId: "sec_missing",
    })).resolves.toMatchObject({ status: "error", code: "section_unavailable" });
    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_child",
      projectId: "proj_other",
      projectSectionId: sectionId,
    })).resolves.toMatchObject({ status: "error", code: "ownership" });
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(before);
    expect(harness.sdk.callsTo("threads.listAncestors")).toEqual([]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);

    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_child",
      projectId: "proj_app",
      projectSectionId: sectionId,
    })).resolves.toEqual({ status: "success" });
    expect(harness.sdk.callsTo("threads.listAncestors")).toEqual([]);
  });

  it("keeps a deleted definition's record and does not touch the filter document", async () => {
    const { bb, harness } = metadataHost();
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    await harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_root",
      projectId: "proj_app",
      projectSectionId: sectionId,
    });
    const filterBefore = await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY);
    const metadataWrites = harness.sdk.callsTo("threads.updatePluginMetadata").length;
    const deleted = await harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1,
      projectId: "proj_app",
      sectionId,
    });
    expect(deleted).toMatchObject({ status: "success", document: { sections: [], order: [] } });
    expect(harness.sdk.callsTo("threads.updatePluginMetadata")).toHaveLength(metadataWrites);
    await expect(harness.behavior.callRpc("readProjectSectionMetadata", {
      threadIds: ["thr_root", "thr_gone"],
    })).resolves.toEqual({
      status: "success",
      threads: [
        { threadId: "thr_root", metadata: { projectId: "proj_app", projectSectionId: sectionId } },
        { threadId: "thr_gone", metadata: {} },
      ],
    });
    expect(await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).toEqual(filterBefore);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toHaveLength(2);
  });

  it("does not hold the document writer while metadata is written", async () => {
    const { bb, harness } = metadataHost();
    let releaseWrite: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    harness.sdk.stub("threads.updatePluginMetadata", async (args: {
      threadId: string;
      set?: Record<string, unknown>;
    }) => {
      await gate;
      return args.set ?? {};
    });
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    const assignment = harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_root",
      projectId: "proj_app",
      projectSectionId: sectionId,
    });
    const created = await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 1,
      projectId: "proj_app",
      name: "Beta",
    });
    expect(created).toMatchObject({ status: "success", document: { revision: 2 } });
    releaseWrite();
    await expect(assignment).resolves.toEqual({ status: "success" });
  });

  it("publishes nothing when the metadata write fails", async () => {
    const { bb, harness } = metadataHost();
    harness.sdk.stub("threads.updatePluginMetadata", async () => {
      throw new Error("metadata down");
    });
    await plugin(bb);
    const sectionId = await createSection(harness.behavior.callRpc, "proj_app", "Alpha", 0);
    await expect(harness.behavior.callRpc("assignProjectSection", {
      threadId: "thr_root",
      projectId: "proj_app",
      projectSectionId: sectionId,
    })).resolves.toMatchObject({ status: "error", code: "storage" });
    await expect(harness.behavior.callRpc("clearProjectSectionAssignment", {
      threadId: "thr_root",
    })).resolves.toMatchObject({ status: "error", code: "storage" });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL)).toEqual([]);
  });
});
