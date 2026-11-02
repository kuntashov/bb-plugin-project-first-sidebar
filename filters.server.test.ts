import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import {
  FILTER_DOCUMENT_KV_KEY,
  FILTERS_CHANGED_CHANNEL,
  FILTER_VALIDATION_MAX_ISSUES,
  FILTER_VALIDATION_MAX_MESSAGE_CHARS,
  FILTER_VALIDATION_MAX_PATH_SEGMENT_CHARS,
  FILTER_VALIDATION_MAX_PATH_SEGMENTS,
  FILTER_VALIDATION_MAX_TOTAL_BYTES,
  FILTER_VALIDATION_TRUNCATED_MESSAGE,
  filterMutationResultSchema,
  filterReadResultSchema,
} from "./shared/filters.js";

const PLUGIN_ID = "project-first-sidebar";

function setup() {
  return createFakePluginHost({ pluginId: PLUGIN_ID });
}

const staticRule = { kind: "projectIds", projectIds: ["proj_a"] } as const;

describe("versioned filter RPC", () => {
  it("persists CRUD, order and pinned mode with one revision per successful mutation", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("listFilters", null)).resolves.toEqual({
      status: "success",
      document: { schemaVersion: 1, revision: 0, pinnedMode: "filter", filters: [] },
    });

    const first = filterMutationResultSchema.parse(await harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "  😀  ",
      rule: { kind: "projectIds", projectIds: ["proj_a", "proj_a"] },
    }));
    expect(first.status).toBe("success");
    if (first.status !== "success") throw new Error("expected create success");
    expect(first).toMatchObject({ status: "success", document: { revision: 1 } });
    expect(first.document.filters[0]).toMatchObject({ name: "😀", rule: staticRule });
    const firstId = first.document.filters[0].id;

    const second = filterMutationResultSchema.parse(await harness.behavior.callRpc("createFilter", {
      expectedRevision: 1,
      name: "Work",
      rule: { kind: "nameGlobs", globs: ["", "work-*", "   "] },
    }));
    if (second.status !== "success") throw new Error("expected create success");
    const secondId = second.document.filters[1].id;
    expect(second).toMatchObject({ status: "success", document: { revision: 2 } });

    const updated = filterMutationResultSchema.parse(await harness.behavior.callRpc("updateFilter", {
      expectedRevision: 2,
      filterId: firstId,
      name: "Empty",
      rule: { kind: "projectIds", projectIds: [] },
    }));
    if (updated.status !== "success") throw new Error("expected update success");
    expect(updated).toMatchObject({ status: "success", document: { revision: 3 } });
    const updatedRule = updated.document.filters[0].rule;
    expect(updatedRule.kind).toBe("projectIds");
    if (updatedRule.kind !== "projectIds") throw new Error("expected static rule");
    expect(updatedRule.projectIds).toEqual([]);

    const reordered = filterMutationResultSchema.parse(await harness.behavior.callRpc("reorderFilters", {
      expectedRevision: 3,
      filterIds: [secondId, firstId],
    }));
    if (reordered.status !== "success") throw new Error("expected reorder success");
    expect(reordered.document.filters.map((filter) => filter.id)).toEqual([secondId, firstId]);
    expect(reordered.document.revision).toBe(4);

    const pinned = filterMutationResultSchema.parse(await harness.behavior.callRpc("setPinnedMode", {
      expectedRevision: 4,
      pinnedMode: "always-show",
    }));
    expect(pinned).toMatchObject({ status: "success", document: { revision: 5, pinnedMode: "always-show" } });

    const deleted = filterMutationResultSchema.parse(await harness.behavior.callRpc("deleteFilter", {
      expectedRevision: 5,
      filterId: firstId,
    }));
    if (deleted.status !== "success") throw new Error("expected delete success");
    expect(deleted).toMatchObject({ status: "success", document: { revision: 6 } });
    expect(deleted.document.filters).toHaveLength(1);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL))
      .toHaveLength(6);
  });

  it("serializes same-revision writes so exactly one succeeds and a stale update cannot resurrect a deletion", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const concurrent = (await Promise.all([
      harness.behavior.callRpc("createFilter", { expectedRevision: 0, name: "A", rule: staticRule }),
      harness.behavior.callRpc("createFilter", { expectedRevision: 0, name: "B", rule: staticRule }),
    ])).map((result) => filterMutationResultSchema.parse(result));
    expect(concurrent.map((result) => result.status).sort()).toEqual(["conflict", "success"]);
    const successful = concurrent.find((result) => result.status === "success");
    if (successful?.status !== "success") throw new Error("expected one concurrent success");
    const document = successful.document;
    const filterId = document.filters[0].id;
    await expect(harness.behavior.callRpc("deleteFilter", {
      expectedRevision: 1,
      filterId,
    })).resolves.toMatchObject({ status: "success", document: { revision: 2 } });
    await expect(harness.behavior.callRpc("updateFilter", {
      expectedRevision: 1,
      filterId,
      name: "Resurrected",
      rule: staticRule,
    })).resolves.toEqual({ status: "conflict", currentRevision: 2 });
    await expect(harness.behavior.callRpc("listFilters", null)).resolves.toMatchObject({
      status: "success",
      document: { revision: 2, filters: [] },
    });
  });

  it("survives reload and reports invalid stored data without overwriting it", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await harness.behavior.callRpc("createFilter", { expectedRevision: 0, name: "A", rule: staticRule });
    const reloaded = await harness.lifecycle.reload(plugin);
    await expect(reloaded.harness.behavior.callRpc("listFilters", null)).resolves.toMatchObject({
      status: "success",
      document: { revision: 1, filters: [{ name: "A" }] },
    });

    const invalid = { schemaVersion: 1, revision: 7, pinnedMode: "filter", filters: [{ id: "all" }] };
    await reloaded.bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, invalid);
    await expect(reloaded.harness.behavior.callRpc("listFilters", null)).resolves.toMatchObject({
      status: "error",
      code: "filter_document_invalid",
    });
    await expect(reloaded.bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).resolves.toEqual(invalid);
  });

  it("does not write or publish for invalid, missing, reorder, or oversized failures", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    for (const input of [
      { expectedRevision: 0, name: " ВСЕ ", rule: staticRule },
      { expectedRevision: 0, name: "Empty glob", rule: { kind: "nameGlobs", globs: [""] } },
    ]) {
      await expect(harness.behavior.callRpc("createFilter", input)).resolves.toMatchObject({
        status: "error",
        code: "filter_validation_failed",
      });
    }
    await expect(harness.behavior.callRpc("updateFilter", {
      expectedRevision: 0, filterId: "missing", name: "A", rule: staticRule,
    })).resolves.toMatchObject({ status: "error", code: "filter_not_found" });
    await expect(harness.behavior.callRpc("reorderFilters", {
      expectedRevision: 0, filterIds: ["missing"],
    })).resolves.toMatchObject({ status: "error", code: "filter_validation_failed" });
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "😀".repeat(70_000),
      rule: staticRule,
    })).resolves.toMatchObject({ status: "error", code: "filter_document_too_large" });
    await expect(bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).resolves.toBeUndefined();
    expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL)).toEqual([]);
  });

  it("rejects structurally malformed mutation input at the RPC boundary", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: 42,
      rule: staticRule,
    })).rejects.toThrow(/input|validation/i);
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "Mixed",
      rule: { kind: "projectIds", projectIds: [], globs: ["*"] },
    })).rejects.toThrow(/input|validation/i);
    await expect(bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).resolves.toBeUndefined();
  });

  it("compares duplicate names after trim and lowercase without Unicode normalization", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 0, name: "Café", rule: staticRule,
    })).resolves.toMatchObject({ status: "success", document: { revision: 1 } });
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 1, name: " CAFÉ ", rule: staticRule,
    })).resolves.toMatchObject({ status: "error", code: "filter_validation_failed" });
    await expect(harness.behavior.callRpc("createFilter", {
      expectedRevision: 1, name: "Cafe\u0301", rule: staticRule,
    })).resolves.toMatchObject({ status: "success", document: { revision: 2 } });
  });

  it("publishes invalidation only after the durable KV write resolves", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const realSet = bb.storage.kv.set.bind(bb.storage.kv);
    let finishWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { finishWrite = resolve; });
    const setSpy = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === FILTER_DOCUMENT_KV_KEY) await writeGate;
      return realSet(key, value);
    });
    const mutation = harness.behavior.callRpc("createFilter", {
      expectedRevision: 0,
      name: "A",
      rule: staticRule,
    });
    await vi.waitFor(() => expect(setSpy).toHaveBeenCalledWith(FILTER_DOCUMENT_KV_KEY, expect.anything()));
    expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL)).toEqual([]);
    finishWrite();
    await expect(mutation).resolves.toMatchObject({ status: "success" });
    expect(harness.realtimeSignals).toContainEqual({
      channel: FILTERS_CHANGED_CHANNEL,
      payload: { revision: 1 },
    });
  });
});

describe("filters CLI", () => {
  it("supports explicit empty static rules, every mutation, JSON output, conflict errors and boundary errors", async () => {
    const { bb, harness } = setup();
    await plugin(bb);
    const created = await harness.behavior.runCli([
      "filters", "create", "--name", "Empty", "--project-ids-json", "[]",
      "--expected-revision", "0", "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const createdDocument = JSON.parse(created.stdout);
    expect(createdDocument.filters[0].rule).toEqual({ kind: "projectIds", projectIds: [] });
    const id = createdDocument.filters[0].id;

    const conflict = await harness.behavior.runCli([
      "filters", "delete", id, "--expected-revision", "0", "--json",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: false,
      error: { code: "filter_revision_conflict" },
    });
    expect(conflict.stderr).toMatch(/revision/i);

    const mixed = await harness.behavior.runCli([
      "filters", "create", "--name", "Mixed", "--project-ids-json", "[]",
      "--globs-json", '["*"]', "--expected-revision", "1", "--json",
    ]);
    expect(mixed.exitCode).toBe(1);
    expect(JSON.parse(mixed.stdout).error.code).toBe("unexpected_argument");

    const badJson = await harness.behavior.runCli([
      "filters", "update", id, "--name", "Work", "--globs-json", "nope",
      "--expected-revision", "1", "--json",
    ]);
    expect(badJson.exitCode).toBe(1);
    expect(JSON.parse(badJson.stdout).error.code).toBe("invalid_filter_rule_json");

    const updated = await harness.behavior.runCli([
      "filters", "update", id, "--name", "Work", "--globs-json", '["work-*"]',
      "--expected-revision", "1",
    ]);
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toMatch(/revision 2/);
    const cleared = await harness.behavior.runCli([
      "filters", "update", id, "--name", "Empty again", "--project-ids-json", "[]",
      "--expected-revision", "2", "--json",
    ]);
    expect(JSON.parse(cleared.stdout).filters[0].rule).toEqual({ kind: "projectIds", projectIds: [] });
    expect((await harness.behavior.runCli(["filters", "reorder", id, "--expected-revision", "3"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["filters", "pinned-mode", "always-show", "--expected-revision", "4"])).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["filters", "list"])).stdout).toMatch(/Empty again/);
    expect((await harness.behavior.runCli(["filters", "delete", id, "--expected-revision", "5"])).exitCode).toBe(0);
  });

  it("bounds corrupt-document issues and marks truncation at the public read boundary", async () => {
    const { bb, harness } = setup();
    const corrupt = {
      schemaVersion: 1,
      revision: 9,
      pinnedMode: "filter",
      filters: [
        { ["x".repeat(1_000)]: true },
        ...Array.from({ length: 4_999 }, () => ({})),
      ],
    };
    expect(new TextEncoder().encode(JSON.stringify(corrupt)).byteLength).toBeLessThan(256 * 1024);
    await bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, corrupt);
    await plugin(bb);

    const read = filterReadResultSchema.parse(await harness.behavior.callRpc("listFilters", null));
    if (read.status !== "error") throw new Error("expected corrupt document read error");
    expect(read.issues.length).toBeLessThanOrEqual(FILTER_VALIDATION_MAX_ISSUES);
    expect(read.issues.at(-1)?.message).toBe(FILTER_VALIDATION_TRUNCATED_MESSAGE);
    expect(read.issues.some((issue) => issue.message.includes("[truncated]"))).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(read.issues)).byteLength)
      .toBeLessThanOrEqual(FILTER_VALIDATION_MAX_TOTAL_BYTES);
    for (const issue of read.issues) {
      expect(issue.path.length).toBeLessThanOrEqual(FILTER_VALIDATION_MAX_PATH_SEGMENTS);
      expect(issue.message.length).toBeLessThanOrEqual(FILTER_VALIDATION_MAX_MESSAGE_CHARS);
      for (const segment of issue.path) {
        if (typeof segment === "string") {
          expect(segment.length).toBeLessThanOrEqual(FILTER_VALIDATION_MAX_PATH_SEGMENT_CHARS);
        }
      }
    }

    const result = await harness.behavior.runCli(["filters", "list", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(new TextEncoder().encode(result.stdout + result.stderr).byteLength).toBeLessThan(64 * 1024);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: false, error: { code: "filter_document_invalid" } });
    expect(`${envelope.error.message}\n${envelope.error.hint}`).toMatch(/truncat/i);
    expect(result.stderr).not.toContain(JSON.stringify(corrupt));
  });
});
