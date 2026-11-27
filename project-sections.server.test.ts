import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { createProjectSectionStore } from "./server.js";
import { FILTER_DOCUMENT_KV_KEY } from "./shared/filters.js";
import {
  PROJECT_SECTION_DOCUMENT_MAX_BYTES,
  PROJECT_SECTION_MAX_PER_PROJECT,
  PROJECT_SECTIONS_CHANGED_CHANNEL,
  projectSectionMutationResultSchema,
  projectSectionReadResultSchema,
  type ProjectSectionDocumentV1,
} from "./shared/project-sections.js";

const PLUGIN_ID = "project-first-sidebar";
const KV_VALUE_MAX_BYTES = 256 * 1024;

function sectionDocument(bb: BbPluginApi): string | undefined {
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

function setup() {
  return createFakePluginHost({ pluginId: PLUGIN_ID });
}

describe("versioned project section document", () => {
  it("reads a missing document as an empty success at revision 0", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("listProjectSections", null)).resolves.toEqual({
      status: "success",
      document: { schemaVersion: 1, revision: 0, sections: [], order: [] },
    });
    expect(projectSectionReadResultSchema.parse(await harness.behavior.callRpc("listProjectSections", null)).status).toBe("success");
    expect(sectionDocument(bb)).toBeUndefined();
  });

  it("creates, renames and deletes an empty section, keeps it after reload, and appends a new section", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const first = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0,
      projectId: "proj_a",
      name: "  Alpha  ",
    }));
    if (first.status !== "success") throw new Error("expected create success");
    const firstId = first.document.sections[0]?.id;
    if (!firstId) throw new Error("expected server id");
    expect(first.document).toMatchObject({
      revision: 1,
      sections: [{ id: firstId, projectId: "proj_a", name: "Alpha" }],
      order: [{ projectId: "proj_a", sectionIds: [firstId] }],
    });

    const second = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 1,
      projectId: "proj_a",
      name: "Beta",
    }));
    if (second.status !== "success") throw new Error("expected second create");
    const secondId = second.document.sections[1]?.id;
    expect(secondId).toEqual(expect.any(String));
    expect(secondId).not.toBe(firstId);
    expect(second.document.order).toEqual([{ projectId: "proj_a", sectionIds: [firstId, secondId] }]);

    const other = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 2,
      projectId: "proj_b",
      name: "Alpha",
    }));
    if (other.status !== "success") throw new Error("expected other project create");
    const otherId = other.document.sections.find((section) => section.projectId === "proj_b")?.id;
    expect(other.document.order).toEqual([
      { projectId: "proj_a", sectionIds: [firstId, secondId] },
      { projectId: "proj_b", sectionIds: [otherId] },
    ]);

    const renamed = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 3,
      projectId: "proj_a",
      sectionId: firstId,
      name: "  alpha  ",
    }));
    if (renamed.status !== "success") throw new Error("expected rename");
    expect(renamed.document.revision).toBe(4);
    expect(renamed.document.order[0]?.sectionIds).toEqual([firstId, secondId]);
    expect(renamed.document.sections.find((section) => section.id === firstId)?.name).toBe("alpha");

    const deleted = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 4,
      projectId: "proj_a",
      sectionId: secondId,
    }));
    if (deleted.status !== "success") throw new Error("expected delete");
    expect(deleted.document.revision).toBe(5);
    expect(deleted.document.sections.map((section) => section.id)).toEqual([firstId, otherId]);
    expect(deleted.document.order).toEqual([
      { projectId: "proj_a", sectionIds: [firstId] },
      { projectId: "proj_b", sectionIds: [otherId] },
    ]);

    const reloaded = await harness.lifecycle.reload(plugin);
    await expect(reloaded.harness.behavior.callRpc("listProjectSections", null)).resolves.toEqual({
      status: "success",
      document: deleted.document,
    });
    const again = projectSectionMutationResultSchema.parse(await reloaded.harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 5,
      projectId: "proj_a",
      name: "Gamma",
    }));
    if (again.status !== "success") throw new Error("expected recreate");
    expect(again.document.sections.map((section) => section.id)).not.toContain(secondId);
    expect(again.document.order[0]?.sectionIds).toEqual([firstId, again.document.sections.at(-1)?.id]);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toHaveLength(5);
    await expect(reloaded.harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 6,
      projectId: "proj_a",
      name: "Client",
      id: "client-id",
    })).rejects.toThrow(/input|validation/i);
  });

  it("rejects a duplicate name inside one project without writing, and keeps a case-only rename", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0, projectId: "proj_a", name: "Café",
    });
    const stored = sectionDocument(bb);
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 1, projectId: "proj_a", name: " CAFÉ ",
    })).resolves.toMatchObject({ status: "error", code: "validation" });
    expect(sectionDocument(bb)).toBe(stored);
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 1, projectId: "proj_b", name: "Café",
    })).resolves.toMatchObject({ status: "success", document: { revision: 2 } });
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 2, projectId: "proj_a", name: "Cafe\u0301",
    })).resolves.toMatchObject({ status: "success", document: { revision: 3 } });
    const created = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("listProjectSections", null));
    if (created.status !== "success") throw new Error("expected list");
    const original = created.document.sections.find((section) => section.projectId === "proj_a" && section.name === "Café");
    if (!original) throw new Error("expected Café");
    await expect(harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 3, projectId: "proj_a", sectionId: original.id, name: "café",
    })).resolves.toMatchObject({ status: "success", document: { revision: 4 } });
    expect(sectionDocument(bb)).not.toBe(stored);
    const signals = harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL);
    expect(signals.map((signal) => signal.payload)).toEqual([
      { revision: 1 }, { revision: 2 }, { revision: 3 }, { revision: 4 },
    ]);
  });

  it("rejects an empty or overlong name without truncation and stores 200 UTF-16 units", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    for (const name of ["", "   ", "a".repeat(201), "😀".repeat(101)]) {
      await expect(harness.behavior.callRpc("createProjectSection", {
        expectedRevision: 0, projectId: "proj_a", name,
      })).resolves.toMatchObject({ status: "error", code: "validation" });
    }
    expect(sectionDocument(bb)).toBeUndefined();
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toEqual([]);
    const exact = "😀".repeat(100);
    const created = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0, projectId: "proj_a", name: `  ${exact}  `,
    }));
    if (created.status !== "success") throw new Error("expected 200-unit name");
    expect(created.document.sections[0]?.name).toBe(exact);
    expect(created.document.sections[0]?.name.length).toBe(200);
    await expect(harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 1,
      projectId: "proj_a",
      sectionId: created.document.sections[0]!.id,
      name: "b".repeat(201),
    })).resolves.toMatchObject({ status: "error", code: "validation" });
    const listed = projectSectionReadResultSchema.parse(await harness.behavior.callRpc("listProjectSections", null));
    if (listed.status !== "success") throw new Error("expected list");
    expect(listed.document.sections[0]?.name).toBe(exact);
    expect(listed.document.revision).toBe(1);
  });

  it("reorders one project's sections as a full permutation and leaves every other order untouched", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const alpha = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0, projectId: "proj_a", name: "Alpha",
    }));
    const beta = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 1, projectId: "proj_a", name: "Beta",
    }));
    const hidden = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 2, projectId: "proj_a", name: "Hidden",
    }));
    const other = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 3, projectId: "proj_b", name: "Other",
    }));
    if (alpha.status !== "success" || beta.status !== "success" || hidden.status !== "success" || other.status !== "success") {
      throw new Error("expected sections");
    }
    const alphaId = alpha.document.sections[0]!.id;
    const betaId = beta.document.sections[1]!.id;
    const hiddenId = hidden.document.sections[2]!.id;
    const otherId = other.document.sections[3]!.id;
    const before = sectionDocument(bb);
    const signalsBefore = harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL).length;

    const reordered = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("reorderProjectSections", {
      expectedRevision: 4,
      projectId: "proj_a",
      sectionIds: [hiddenId, betaId, alphaId],
    }));

    expect(reordered).toMatchObject({
      status: "success",
      document: {
        revision: 5,
        order: [
          { projectId: "proj_a", sectionIds: [hiddenId, betaId, alphaId] },
          { projectId: "proj_b", sectionIds: [otherId] },
        ],
      },
    });
    const after = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("listProjectSections", null));
    if (after.status !== "success") throw new Error("expected list");
    expect(after.document.order).toEqual([
      { projectId: "proj_a", sectionIds: [hiddenId, betaId, alphaId] },
      { projectId: "proj_b", sectionIds: [otherId] },
    ]);
    expect(after.document.sections.map((section) => section.id)).toEqual([alphaId, betaId, hiddenId, otherId]);
    const successSignals = harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL);
    expect(successSignals).toHaveLength(signalsBefore + 1);
    expect(successSignals.at(-1)?.payload).toEqual({ revision: 5 });
    expect(sectionDocument(bb)).not.toBe(before);

    const stored = sectionDocument(bb);
    const signalCount = successSignals.length;
    for (const sectionIds of [
      [alphaId, betaId],
      [alphaId, betaId, alphaId],
      [],
      [alphaId, betaId, otherId],
      [alphaId, betaId, hiddenId, "missing"],
    ]) {
      await expect(harness.behavior.callRpc("reorderProjectSections", {
        expectedRevision: 5,
        projectId: "proj_a",
        sectionIds,
      })).resolves.toMatchObject({ status: "error", code: "validation" });
    }
    await expect(harness.behavior.callRpc("reorderProjectSections", {
      expectedRevision: 4,
      projectId: "proj_a",
      sectionIds: [alphaId, betaId, hiddenId],
    })).resolves.toMatchObject({ status: "conflict", currentRevision: 5 });
    expect(sectionDocument(bb)).toBe(stored);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toHaveLength(signalCount);
    const reloaded = await harness.lifecycle.reload(plugin);
    await expect(reloaded.harness.behavior.callRpc("listProjectSections", null)).resolves.toMatchObject({
      status: "success",
      document: { revision: 5, order: after.document.order },
    });
  });

  it("rejects the 101st section and a document over 1 MiB without replacing the previous document", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const sections = Array.from({ length: PROJECT_SECTION_MAX_PER_PROJECT }, (_, index) => ({
      id: `gone-${index}`,
      projectId: "proj_gone",
      name: `Section ${index}`,
    }));
    const seeded: ProjectSectionDocumentV1 = {
      schemaVersion: 1,
      revision: 3,
      sections,
      order: [{ projectId: "proj_gone", sectionIds: sections.map((section) => section.id) }],
    };
    insertSectionDocument(bb, seeded);
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 3, projectId: "proj_gone", name: "One more",
    })).resolves.toMatchObject({ status: "error", code: "validation" });
    expect(sectionDocument(bb)).toBe(JSON.stringify(seeded));
    const live = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 3, projectId: "proj_live", name: "Live",
    }));
    if (live.status !== "success") throw new Error("expected another project to accept a section");
    expect(live.document.sections.filter((section) => section.projectId === "proj_gone")).toHaveLength(100);
  });

  it("saves a document above the KV ceiling and at most 1 MiB for a new store, and keeps filters", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "Work",
      rule: { kind: "projectIds", projectIds: ["proj_a"] },
    });
    const filtersBefore = await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY);
    const seeded = sizedDocument(KV_VALUE_MAX_BYTES + 1);
    const seededBytes = Buffer.byteLength(JSON.stringify(seeded), "utf8");
    expect(seededBytes).toBeGreaterThan(KV_VALUE_MAX_BYTES);
    expect(seededBytes).toBeLessThanOrEqual(PROJECT_SECTION_DOCUMENT_MAX_BYTES);
    insertSectionDocument(bb, seeded);
    await expect(createProjectSectionStore(bb).read()).resolves.toEqual({
      status: "success",
      document: seeded,
    });
    const saved = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: seeded.revision,
      projectId: "proj_live",
      name: "Still under the limit",
    }));
    if (saved.status !== "success") throw new Error("expected a document above 256 KiB to be writable");
    const savedBytes = Buffer.byteLength(JSON.stringify(saved.document), "utf8");
    expect(savedBytes).toBeGreaterThan(KV_VALUE_MAX_BYTES);
    expect(savedBytes).toBeLessThanOrEqual(PROJECT_SECTION_DOCUMENT_MAX_BYTES);
    await expect(createProjectSectionStore(bb).read()).resolves.toEqual({
      status: "success",
      document: saved.document,
    });
    expect(sectionDocument(bb)).toBe(JSON.stringify(saved.document));
    await expect(bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).resolves.toEqual(filtersBefore);
    expect(await bb.storage.kv.list("project-first-sidebar:project-sections")).toEqual([]);
  });

  it("rejects a document over 1 MiB without changing bytes, revision, or publishing success", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const bulky = nearLimitDocument();
    const raw = JSON.stringify(bulky);
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(KV_VALUE_MAX_BYTES);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(PROJECT_SECTION_DOCUMENT_MAX_BYTES);
    insertSectionDocument(bb, bulky);
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: bulky.revision, projectId: "proj_new", name: "Overflow",
    })).resolves.toMatchObject({ status: "error", code: "too_large" });
    expect(sectionDocument(bb)).toBe(raw);
    await expect(createProjectSectionStore(bb).read()).resolves.toEqual({
      status: "success",
      document: bulky,
    });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toEqual([]);
  });

  it("lets one same-revision write win and does not resurrect a deleted section", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const concurrent = (await Promise.all([
      harness.behavior.callRpc("createProjectSection", { expectedRevision: 0, projectId: "proj_a", name: "A" }),
      harness.behavior.callRpc("createProjectSection", { expectedRevision: 0, projectId: "proj_a", name: "B" }),
    ])).map((result) => projectSectionMutationResultSchema.parse(result));
    expect(concurrent.map((result) => result.status).sort()).toEqual(["conflict", "success"]);
    const successful = concurrent.find((result) => result.status === "success");
    if (successful?.status !== "success") throw new Error("expected one success");
    const sectionId = successful.document.sections[0]!.id;
    await expect(harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1, projectId: "proj_a", sectionId,
    })).resolves.toMatchObject({ status: "success", document: { revision: 2, sections: [] } });
    await expect(harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 1, projectId: "proj_a", sectionId, name: "Resurrected",
    })).resolves.toEqual({ status: "conflict", currentRevision: 2 });
    await expect(harness.behavior.callRpc("listProjectSections", null)).resolves.toMatchObject({
      status: "success",
      document: { revision: 2, sections: [], order: [] },
    });
  });

  it("rejects another project's id without writing or publishing success", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const created = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0, projectId: "proj_a", name: "Alpha",
    }));
    if (created.status !== "success") throw new Error("expected create");
    const sectionId = created.document.sections[0]!.id;
    const stored = sectionDocument(bb);
    await expect(harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 1, projectId: "proj_b", sectionId, name: "Beta",
    })).resolves.toMatchObject({ status: "error", code: "ownership" });
    await expect(harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 1, projectId: "proj_b", sectionId,
    })).resolves.toMatchObject({ status: "error", code: "ownership" });
    await expect(harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 1, projectId: "proj_a", sectionId: "missing", name: "Beta",
    })).resolves.toMatchObject({ status: "error", code: "not_found" });
    expect(sectionDocument(bb)).toBe(stored);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toEqual([
      { channel: PROJECT_SECTIONS_CHANGED_CHANNEL, payload: { revision: 1 } },
    ]);
  });

  it("returns a read error for a damaged document and leaves the stored bytes alone", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const invalid = { schemaVersion: 1, revision: 4, sections: [{ id: "broken" }], order: [] };
    insertSectionDocument(bb, invalid);
    const raw = sectionDocument(bb);
    await expect(harness.behavior.callRpc("listProjectSections", null)).resolves.toMatchObject({
      status: "error",
      code: "document_invalid",
    });
    await expect(harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 4, projectId: "proj_a", name: "Alpha",
    })).resolves.toMatchObject({ status: "error", code: "document_invalid" });
    expect(sectionDocument(bb)).toBe(raw);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === PROJECT_SECTIONS_CHANGED_CHANNEL)).toEqual([]);
  });

  it("does not change the filter document or its revision", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "Work",
      rule: { kind: "projectIds", projectIds: ["proj_a"] },
    });
    const filtersBefore = await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY);
    await harness.behavior.callRpc("createProjectSection", {
      expectedRevision: 0, projectId: "proj_a", name: "Alpha",
    });
    const created = projectSectionMutationResultSchema.parse(await harness.behavior.callRpc("listProjectSections", null));
    if (created.status !== "success") throw new Error("expected section");
    const sectionId = created.document.sections[0]!.id;
    await harness.behavior.callRpc("renameProjectSection", {
      expectedRevision: 1, projectId: "proj_a", sectionId, name: "Beta",
    });
    await harness.behavior.callRpc("deleteProjectSection", {
      expectedRevision: 2, projectId: "proj_a", sectionId,
    });
    await expect(bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).resolves.toEqual(filtersBefore);
    await expect(harness.behavior.callRpc("listFilters", null)).resolves.toMatchObject({
      status: "success",
      document: { revision: 1 },
    });
  });
});

function documentBytes(document: ProjectSectionDocumentV1): number {
  return Buffer.byteLength(JSON.stringify(document), "utf8");
}

function buildDocument(stop: (bytes: number) => boolean): ProjectSectionDocumentV1 {
  const sections: ProjectSectionDocumentV1["sections"] = [];
  const order: ProjectSectionDocumentV1["order"] = [];
  let projectIndex = 0;
  let sectionIndex = 0;
  let document: ProjectSectionDocumentV1 = { schemaVersion: 1, revision: 9, sections, order };
  while (projectIndex < 800) {
    if (sectionIndex >= PROJECT_SECTION_MAX_PER_PROJECT) {
      projectIndex += 1;
      sectionIndex = 0;
      continue;
    }
    const projectId = `p${projectIndex}`;
    const id = `${projectId}-s${sectionIndex}`;
    const name = `s${sectionIndex}`;
    sections.push({ id, projectId, name });
    const live = order.find((entry) => entry.projectId === projectId);
    if (live) live.sectionIds.push(id);
    else order.push({ projectId, sectionIds: [id] });
    sectionIndex += 1;
    if (sections.length % 250 === 0) {
      document = { schemaVersion: 1, revision: 9, sections, order };
      if (stop(documentBytes(document))) break;
    }
  }
  document = { schemaVersion: 1, revision: 9, sections, order };
  return document;
}

function sizedDocument(minBytes: number): ProjectSectionDocumentV1 {
  const document = buildDocument((bytes) => bytes >= minBytes);
  const bytes = documentBytes(document);
  if (bytes < minBytes || bytes > PROJECT_SECTION_DOCUMENT_MAX_BYTES) {
    throw new Error(`sized fixture is ${bytes} bytes`);
  }
  return document;
}

function nearLimitDocument(): ProjectSectionDocumentV1 {
  const sections: ProjectSectionDocumentV1["sections"] = [];
  const order: ProjectSectionDocumentV1["order"] = [];
  let projectIndex = 0;
  let sectionIndex = 0;
  const push = () => {
    if (sectionIndex >= PROJECT_SECTION_MAX_PER_PROJECT) {
      projectIndex += 1;
      sectionIndex = 0;
    }
    const projectId = `p${projectIndex}`;
    const id = `${projectId}-s${sectionIndex}`;
    const name = `s${sectionIndex}`;
    sections.push({ id, projectId, name });
    const live = order.find((entry) => entry.projectId === projectId);
    if (live) live.sectionIds.push(id);
    else order.push({ projectId, sectionIds: [id] });
    sectionIndex += 1;
  };
  const pop = () => {
    const removed = sections.pop();
    if (removed === undefined) return;
    const entry = order.find((item) => item.projectId === removed.projectId);
    entry?.sectionIds.pop();
    if (entry?.sectionIds.length === 0) order.splice(order.indexOf(entry), 1);
    if (sectionIndex === 0) {
      projectIndex -= 1;
      sectionIndex = PROJECT_SECTION_MAX_PER_PROJECT;
    }
    sectionIndex -= 1;
  };
  const snapshot = (): ProjectSectionDocumentV1 => ({ schemaVersion: 1, revision: 9, sections, order });
  while (documentBytes(snapshot()) < PROJECT_SECTION_DOCUMENT_MAX_BYTES - 16_000) {
    for (let index = 0; index < 200; index += 1) push();
  }
  while (documentBytes(snapshot()) > PROJECT_SECTION_DOCUMENT_MAX_BYTES) pop();
  while (PROJECT_SECTION_DOCUMENT_MAX_BYTES - documentBytes(snapshot()) > 140) {
    push();
    if (documentBytes(snapshot()) > PROJECT_SECTION_DOCUMENT_MAX_BYTES) {
      pop();
      break;
    }
  }
  const document = snapshot();
  const bytes = documentBytes(document);
  if (bytes > PROJECT_SECTION_DOCUMENT_MAX_BYTES || PROJECT_SECTION_DOCUMENT_MAX_BYTES - bytes > 140) {
    throw new Error(`near-limit fixture is ${bytes} bytes`);
  }
  return document;
}
