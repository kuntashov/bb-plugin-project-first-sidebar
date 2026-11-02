import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin, { importThreadListPreferences } from "./server.js";
import { defaultPreferences, PREFERENCE_KEYS } from "./shared/preferences.js";

const PREFIX = "project-first-sidebar:preference:";
const MARKER = "project-first-sidebar:import:thread-list:v1";

function setup(options: { absent?: boolean; disabled?: boolean; response?: unknown; fail?: string } = {}) {
  const list = vi.fn(async () => {
    if (options.fail === "list") throw new Error("inventory offline");
    return { plugins: options.absent ? [] : [{ id: "thread-list", enabled: !options.disabled }] };
  });
  const callRpc = vi.fn(async () => {
    if (options.fail === "rpc") throw new Error("source read failed");
    return options.response ?? { preferences: { ...defaultPreferences(), organizationMode: "chronological" } };
  });
  const host = createFakePluginHost({ pluginId: "project-first-sidebar", sdk: { plugins: { list, callRpc } } });
  return { ...host, list, callRpc };
}

describe("thread-list effective preferences snapshot", () => {
  it("imports source defaults, preserves own settings and remaps only the normalized move key", async () => {
    const { bb, callRpc } = setup({ response: { preferences: {
      ...defaultPreferences(), organizationMode: "machine", rowActions: ["move", "core/pin", "other/move"],
    } } });
    await bb.storage.kv.set(`${PREFIX}hiddenGroups`, ["project:mine"]);
    const result = await importThreadListPreferences(bb);
    expect(result.state).toBe("imported");
    expect(result.imported).toHaveLength(PREFERENCE_KEYS.length - 1);
    await expect(bb.storage.kv.get(`${PREFIX}organizationMode`)).resolves.toBe("machine");
    await expect(bb.storage.kv.get(`${PREFIX}hiddenGroups`)).resolves.toEqual(["project:mine"]);
    await expect(bb.storage.kv.get(`${PREFIX}rowActions`)).resolves.toEqual(["project-first-sidebar/move", "bb--core/pin", "other/move"]);
    await expect(bb.storage.kv.get(MARKER)).resolves.toBe(true);
    expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "thread-list", method: "listPreferences", input: null }));
    expect((await importThreadListPreferences(bb)).imported).toEqual([]);
    expect(callRpc).toHaveBeenCalledTimes(1);
    await expect(bb.storage.kv.get("preference:organizationMode")).resolves.toBeUndefined();
  });

  it("preserves effective chronological even though the new default is project", async () => {
    const { bb } = setup();
    expect(defaultPreferences().organizationMode).toBe("project");
    await importThreadListPreferences(bb);
    await expect(bb.storage.kv.get(`${PREFIX}organizationMode`)).resolves.toBe("chronological");
  });

  it.each([
    { absent: true, state: "absent" },
    { disabled: true, state: "failed" },
    { fail: "list", state: "failed" },
    { fail: "rpc", state: "failed" },
    { response: { preferences: { ...defaultPreferences(), collapsedMachines: false } }, state: "failed" },
    { response: { preferences: { organizationMode: "machine" } }, state: "failed" },
  ])("distinguishes missing source and failures without committing a marker: %j", async ({ state, ...options }) => {
    const { bb } = setup(options);
    const result = await importThreadListPreferences(bb);
    expect(result.state).toBe(state);
    expect(result.message.length).toBeGreaterThan(0);
    await expect(bb.storage.kv.get(MARKER)).resolves.toBeUndefined();
    await expect(bb.storage.kv.get(`${PREFIX}organizationMode`)).resolves.toBeUndefined();
  });

  it("retries a partial write failure without replacing later user changes", async () => {
    const { bb } = setup();
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    const spy = vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === `${PREFIX}environmentGrouping`) throw new Error("disk full");
      await set(key, value);
    });
    const first = await importThreadListPreferences(bb);
    expect(first.state).toBe("failed");
    await expect(bb.storage.kv.get(MARKER)).resolves.toBeUndefined();
    spy.mockRestore();
    await bb.storage.kv.set(`${PREFIX}organizationMode`, "machine");
    expect((await importThreadListPreferences(bb)).state).toBe("imported");
    await expect(bb.storage.kv.get(`${PREFIX}organizationMode`)).resolves.toBe("machine");
    await expect(bb.storage.kv.get(`${PREFIX}environmentGrouping`)).resolves.toBe("auto");
  });

  it("does not report success when the marker write fails", async () => {
    const { bb } = setup();
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === MARKER) throw new Error("marker write failed");
      await set(key, value);
    });
    expect((await importThreadListPreferences(bb)).state).toBe("failed");
    await expect(bb.storage.kv.get(MARKER)).resolves.toBeUndefined();
  });

  it("exposes startup failure and explicit successful retry through RPC and CLI", async () => {
    const { bb, harness, callRpc } = setup({ fail: "rpc" });
    await plugin(bb);
    await expect(harness.behavior.callRpc("getImportStatus", null)).resolves.toMatchObject({ state: "failed" });
    const failed = await harness.behavior.runCli(["prefs", "import", "--json"]);
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout).state).toBe("failed");
    callRpc.mockResolvedValue({ preferences: { ...defaultPreferences(), organizationMode: "machine" } });
    await expect(harness.behavior.callRpc("importPreferences", null)).resolves.toMatchObject({ state: "imported" });
    expect((await harness.behavior.runCli(["prefs", "import", "--json"])).exitCode).toBe(0);
  });
});

it("deduplicates move aliases after legacy normalization and preserves third-party keys", async () => {
  const { parsePreferenceValue } = await import("./shared/preferences.js");
  expect(parsePreferenceValue("rowActions", ["move", "thread-list/move", "other/move"])).toEqual({
    success: true, value: ["project-first-sidebar/move", "other/move"],
  });
  expect(parsePreferenceValue("rowActions", ["core/move", "another/move"])).toEqual({
    success: true, value: ["bb--core/move", "another/move"],
  });
});

it("serializes an explicit import retry with a user's preference write", async () => {
  const { bb, harness, callRpc } = setup({ fail: "rpc" });
  await plugin(bb);
  let finishRead!: (value: { preferences: ReturnType<typeof defaultPreferences> }) => void;
  callRpc.mockImplementationOnce(() => new Promise<{ preferences: ReturnType<typeof defaultPreferences> }>((resolve) => { finishRead = resolve; }));
  const importing = harness.behavior.callRpc("importPreferences", null);
  await vi.waitFor(() => expect(finishRead).toBeTypeOf("function"));
  const writing = harness.behavior.callRpc("setPreference", { key: "organizationMode", value: "machine" });
  finishRead({ preferences: { ...defaultPreferences(), organizationMode: "chronological" } });
  await importing;
  await writing;
  await expect(bb.storage.kv.get(`${PREFIX}organizationMode`)).resolves.toBe("machine");
});
