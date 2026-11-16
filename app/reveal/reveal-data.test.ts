import { describe, expect, it, vi } from "vitest";
import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { makeSidebarThread } from "../model/fixtures.js";
import type { useSidebarData } from "../model/use-sidebar-data.js";
import { loadRevealChain, loadRevealTarget } from "./reveal-data.js";

const target = makeSidebarThread({ id: "target", projectId: "app", archivedAt: 1, isArchived: true });
const signal = () => new AbortController().signal;
function state(): ReturnType<typeof useSidebarData> {
  return { status: "ready", projects: [], personalProject: null, hostsById: new Map(), sections: [], threads: [],
    archived: { status: "ready", hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: async () => {} } };
}

describe("explicit reveal archive data", () => {
  it("loads only the pages needed for the target and its archived ancestors", async () => {
    const root = { ...target, id: "root" };
    const child = { ...target, parentThreadId: "root" };
    let current = state();
    let pages = 0;
    const fetchNextPage = vi.fn(async () => {
      pages++;
      current = { ...current, threads: pages === 1 ? [child] : [root, child] };
    });
    current.archived!.fetchNextPage = fetchNextPage;
    expect(await loadRevealTarget([child, root], () => current, signal())).toBe(child);
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
  it("uses an already loaded target without paging", async () => {
    const current = state(); current.threads = [target];
    const fetchNextPage = vi.spyOn(current.archived!, "fetchNextPage");
    expect(await loadRevealTarget([target], () => current, signal())).toBe(target);
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
  it("stops after cancellation during a page request", async () => {
    const current = state(); const controller = new AbortController();
    const fetchNextPage = vi.fn(async () => { controller.abort(); });
    current.archived!.fetchNextPage = fetchNextPage;
    await expect(loadRevealTarget([target], () => current, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchNextPage).toHaveBeenCalledOnce();
  });
  it("reports a failed archive page instead of requesting it again", async () => {
    let current = state();
    current.archived!.fetchNextPage = async () => {
      current = { ...current, archived: { ...current.archived!, isFetchNextPageError: true } };
    };
    await expect(loadRevealTarget([target], () => current, signal())).rejects.toThrow("Не удалось загрузить страницу архива");
  });
  it("does not include an archived parent in active-only placement", async () => {
    const child = makeSidebarThread({ id: "active", parentThreadId: "archived-parent" });
    const get = vi.fn(async () => makeThreadResponse({ id: "archived-parent", archivedAt: 1 }));
    const { sdk } = createFakeSdk({ pluginId: "project-first-sidebar", overrides: { threads: { get } } });
    const chain = await loadRevealChain(child.id, [child], ["active"], sdk, signal());
    expect(chain).toEqual([child]);
    expect(get).toHaveBeenCalledOnce();
  });
  it("rejects a parent cycle and does not loop indefinitely", async () => {
    const child = makeSidebarThread({ id: "cycle", parentThreadId: "cycle" });
    const { sdk } = createFakeSdk({ pluginId: "project-first-sidebar" });
    await expect(loadRevealChain(child.id, [child], ["active"], sdk, signal())).rejects.toThrow("цикл");
  });
});
