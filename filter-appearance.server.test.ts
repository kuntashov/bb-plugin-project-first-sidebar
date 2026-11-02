import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { FILTER_DOCUMENT_KV_KEY, FILTERS_CHANGED_CHANNEL, filterMutationResultSchema, filterReadResultSchema } from "./shared/filters.js";
import { TINY_PNG } from "./checks/filter-appearance/png-fixture.js";

const rule = { kind: "projectIds", projectIds: [] };
const icon = { kind: "png", data: TINY_PNG };
const legacy = { schemaVersion: 1, revision: 8, pinnedMode: "always-show", filters: [{ id: "old", name: "Старый", rule }] };
describe("appearance persistence and compatible field mutations", () => {
  it("reads legacy documents without writing/migrating and preserves icons for old RPC/CLI update payloads", async () => {
    let { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar" });
    await bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, legacy);
    await plugin(bb);
    expect(await harness.behavior.callRpc("listFilters", null)).toEqual({ status: "success", document: legacy });
    expect(await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).toEqual(legacy);
    expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL)).toEqual([]);
    const update = filterMutationResultSchema.parse(await harness.behavior.callRpc("updateFilter", { expectedRevision: 8, filterId: "old", name: "Иконка", rule, icon }));
    expect(update.status).toBe("success");
    const mode = filterMutationResultSchema.parse(await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 9, displayMode: "icon-text" }));
    expect(mode).toMatchObject({ status: "success", document: { revision: 10, displayMode: "icon-text", pinnedMode: "always-show", filters: [{ icon }] } });
    expect(await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 9, displayMode: "text" })).toEqual({ status: "conflict", currentRevision: 10 });
    const oldClient = await harness.behavior.runCli(["filters", "update", "old", "--name", "Новое имя", "--project-ids-json", "[]", "--expected-revision", "10"]);
    expect(oldClient.exitCode).toBe(0);
    expect(oldClient.stdout).not.toContain(TINY_PNG);
    ({ bb, harness } = await harness.lifecycle.reload(plugin));
    const read = filterReadResultSchema.parse(await harness.behavior.callRpc("listFilters", null));
    expect(read).toMatchObject({ status: "success", document: { revision: 11, displayMode: "icon-text", pinnedMode: "always-show", filters: [{ name: "Новое имя", icon }] } });
    const saved = await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY);
    await expect(harness.behavior.callRpc("createFilter", { expectedRevision: 11, name: "Bad", rule, icon: { kind: "png", data: btoa("<svg onload=evil() />") } })).rejects.toThrow();
    expect(await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).toEqual(saved);
    expect((await harness.behavior.runCli(["filters", "list"])).stdout).not.toContain(TINY_PNG);
    await harness.lifecycle.dispose();
  });
  it("serializes concurrent icon/display mutations; stale writer cannot overwrite either field", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar" });
    await bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, legacy); await plugin(bb);
    const results = await Promise.all([
      harness.behavior.callRpc("setDisplayMode", { expectedRevision: 8, displayMode: "icon" }),
      harness.behavior.callRpc("updateFilter", { expectedRevision: 8, filterId: "old", name: "Новый", rule, icon }),
    ]);
    expect(results).toMatchObject([{ status: "success" }, { status: "conflict", currentRevision: 9 }]);
    const retried = await harness.behavior.callRpc("updateFilter", { expectedRevision: 9, filterId: "old", name: "Новый", rule, icon });
    expect(retried).toMatchObject({ status: "success", document: { displayMode: "icon", filters: [{ icon }] } });
    expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL).map((signal) => signal.payload)).toEqual([{ revision: 9 }, { revision: 10 }]);
    await harness.lifecycle.dispose();
  });
});

// Pinned baseline 2209cef shared/filters.ts: strict v1 object shapes. Keeping the
// old shape independent makes a new-field leak fail this compatibility assertion.
const baseline021Document = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative().safe(),
  pinnedMode: z.enum(["filter", "always-show"]),
  filters: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1),
    rule: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("projectIds"), projectIds: z.array(z.string().min(1)) }).strict(),
      z.object({ kind: z.literal("nameGlobs"), globs: z.array(z.string()) }).strict(),
    ]),
  }).strict()),
}).strict();

it("canonically omits text after own icon/mode smoke cleanup so strict baseline0.2.1 can read original user definitions", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "project-first-sidebar" });
  const original = { ...legacy, revision: 12, filters: [legacy.filters[0]!, { id: "second", name: "Другой", rule: { kind: "nameGlobs", globs: ["bb-*"] } }] };
  await bb.storage.kv.set(FILTER_DOCUMENT_KV_KEY, original); await plugin(bb);
  const created = filterMutationResultSchema.parse(await harness.behavior.callRpc("createFilter", { expectedRevision: 12, name: "Own smoke", rule, icon }));
  if (created.status !== "success") throw new Error("expected smoke create");
  const ownId = created.document.filters[2]!.id;
  await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 13, displayMode: "icon-text" });
  await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 14, displayMode: "icon" });
  expect(await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 14, displayMode: "text" })).toEqual({ status: "conflict", currentRevision: 15 });
  const restored = filterMutationResultSchema.parse(await harness.behavior.callRpc("setDisplayMode", { expectedRevision: 15, displayMode: "text" }));
  if (restored.status !== "success") throw new Error("expected mode restore");
  expect(restored.document).not.toHaveProperty("displayMode");
  expect(restored.document.filters).toEqual(created.document.filters); // Canonicalizing text must preserve icons, including anybody else's.
  expect(restored.document.pinnedMode).toBe(original.pinnedMode);
  const cleaned = filterMutationResultSchema.parse(await harness.behavior.callRpc("deleteFilter", { expectedRevision: 16, filterId: ownId }));
  if (cleaned.status !== "success") throw new Error("expected own smoke deletion");
  expect(cleaned.document).toEqual({ ...original, revision: 17 });
  expect(baseline021Document.parse(cleaned.document)).toEqual(cleaned.document);
  expect(await bb.storage.kv.get(FILTER_DOCUMENT_KV_KEY)).toEqual(cleaned.document);
  expect(harness.realtimeSignals.filter((signal) => signal.channel === FILTERS_CHANGED_CHANNEL).map((signal) => signal.payload)).toEqual([13, 14, 15, 16, 17].map((revision) => ({ revision })));
  await harness.lifecycle.dispose();
});
