import { describe, expect, it } from "vitest";
import type { FilterReadResult } from "../../shared/filters.js";
import { createWindowFilterStore, type FilterListRpc } from "./filter-store.js";

function document(revision: number, ids: string[]) {
  return {
    schemaVersion: 1 as const,
    revision,
    pinnedMode: "filter" as const,
    filters: ids.map((id) => ({
      id,
      name: id,
      rule: { kind: "projectIds" as const, projectIds: [] },
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rpcFrom(reads: Array<Promise<FilterReadResult>>): FilterListRpc {
  return {
    call(method, input) {
      expect(method).toBe("listFilters");
      expect(input).toBeNull();
      const read = reads.shift();
      if (!read) throw new Error("unexpected read");
      return read;
    },
  };
}

describe("window filter store", () => {
  it("keeps active selection per window, across remounts, and resets a new runtime", async () => {
    const first = createWindowFilterStore();
    const second = createWindowFilterStore();
    const release = first.acquire(rpcFrom([
      Promise.resolve({ status: "success", document: document(1, ["work"]) }),
    ]));
    second.acquire(rpcFrom([
      Promise.resolve({ status: "success", document: document(1, ["work"]) }),
    ]));
    await Promise.resolve();
    await Promise.resolve();

    first.setActiveFilterId("work");
    expect(first.getSnapshot().activeFilterId).toBe("work");
    expect(second.getSnapshot().activeFilterId).toBe("all");

    release();
    const remountRelease = first.acquire(rpcFrom([
      Promise.resolve({ status: "success", document: document(1, ["work"]) }),
    ]));
    await Promise.resolve();
    expect(first.getSnapshot().activeFilterId).toBe("work");
    remountRelease();

    expect(createWindowFilterStore().getSnapshot().activeFilterId).toBe("all");
  });

  it("subscribes before the initial read and ignores older revisions and errors", async () => {
    const store = createWindowFilterStore();
    const initial = deferred<FilterReadResult>();
    const invalidation = deferred<FilterReadResult>();
    const changes: number[] = [];
    store.subscribe(() => changes.push(store.getSnapshot().document?.revision ?? -1));
    store.acquire(rpcFrom([initial.promise, invalidation.promise]));

    store.invalidate();
    invalidation.resolve({ status: "success", document: document(2, ["new"]) });
    await invalidation.promise;
    await Promise.resolve();
    initial.resolve({ status: "success", document: document(1, ["old"]) });
    await initial.promise;
    await Promise.resolve();

    expect(store.getSnapshot()).toMatchObject({
      status: "ready",
      errorMessage: null,
      document: { revision: 2, filters: [{ id: "new" }] },
    });
    expect(changes).toContain(2);

    const olderFailure = deferred<FilterReadResult>();
    const newerSuccess = deferred<FilterReadResult>();
    const errorStore = createWindowFilterStore();
    errorStore.acquire(rpcFrom([olderFailure.promise, newerSuccess.promise]));
    errorStore.invalidate();
    newerSuccess.resolve({ status: "success", document: document(3, []) });
    await newerSuccess.promise;
    await Promise.resolve();
    olderFailure.reject(new Error("late failure"));
    await olderFailure.promise.catch(() => undefined);
    await Promise.resolve();
    expect(errorStore.getSnapshot()).toMatchObject({
      status: "ready",
      errorMessage: null,
      document: { revision: 3 },
    });
  });

  it("refetches on reconnect and atomically falls back when the active filter was deleted", async () => {
    const store = createWindowFilterStore();
    store.acquire(rpcFrom([
      Promise.resolve({ status: "success", document: document(4, ["work"]) }),
      Promise.resolve({ status: "success", document: document(5, []) }),
    ]));
    await Promise.resolve();
    await Promise.resolve();
    store.setActiveFilterId("work");

    store.reconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot()).toMatchObject({
      activeFilterId: "all",
      removedActiveFilterId: "work",
      document: { revision: 5 },
    });
  });
});
