import type { FilterDocumentV1, FilterReadResult } from "../../shared/filters.js";
import { BUILT_IN_FILTER_IDS } from "../../shared/filters.js";
import { isDynamicFilterId, type DynamicFilterId } from "./dynamic-filter-ids.js";

export const ALL_FILTER_ID = BUILT_IN_FILTER_IDS[0];
export const PROJECTLESS_FILTER_ID = BUILT_IN_FILTER_IDS[1];

export type BuiltInFilterId = typeof ALL_FILTER_ID | typeof PROJECTLESS_FILTER_ID | DynamicFilterId;

export function isBuiltInFilterId(id: ActiveFilterId): id is BuiltInFilterId {
  return id === ALL_FILTER_ID || id === PROJECTLESS_FILTER_ID || isDynamicFilterId(id);
}

// User filter IDs are opaque strings; availability is enforced against the live document.
export type ActiveFilterId = string | DynamicFilterId;

export interface FilterListRpc {
  call(method: "listFilters", input: null): Promise<FilterReadResult>;
}

export interface WindowFilterSnapshot {
  activeFilterId: ActiveFilterId;
  hiddenBuiltInFilterIds: ReadonlySet<BuiltInFilterId>;
  builtInVisibilityReady: boolean;
  document: FilterDocumentV1 | null;
  status: "loading" | "ready" | "error";
  isRefreshing: boolean;
  errorMessage: string | null;
  removedActiveFilterId: string | null;
  removalVersion: number;
}

export interface WindowFilterStore {
  acquire(rpc: FilterListRpc): () => void;
  getSnapshot(): WindowFilterSnapshot;
  subscribe(listener: () => void): () => void;
  setActiveFilterId(filterId: ActiveFilterId): void;
  setBuiltInFilterVisible(filterId: BuiltInFilterId, visible: boolean): void;
  setBuiltInVisibilityReady(ready: boolean): void;
  isFilterAvailable(filterId: ActiveFilterId): boolean;
  invalidate(): void;
  reconnect(): void;
}

function describeReadError(result: Extract<FilterReadResult, { status: "error" }>): string {
  const detail = result.issues[0]?.message;
  return detail ? `Could not load project filters: ${detail}` : "Could not load project filters.";
}

export function createWindowFilterStore({
  builtInVisibilityReady = true,
}: { builtInVisibilityReady?: boolean } = {}): WindowFilterStore {
  let snapshot: WindowFilterSnapshot = {
    activeFilterId: ALL_FILTER_ID,
    hiddenBuiltInFilterIds: new Set(),
    builtInVisibilityReady,
    document: null,
    status: "loading",
    isRefreshing: false,
    errorMessage: null,
    removedActiveFilterId: null,
    removalVersion: 0,
  };
  const listeners = new Set<() => void>();
  let rpc: FilterListRpc | null = null;
  let ownerCount = 0;
  let lifetime = 0;
  let disposalVersion = 0;
  const pendingRequestsByLifetime = new Map<number, number>();
  let readScheduled = false;
  let requestSequence = 0;
  let latestStartedRequest = 0;

  const publish = (next: WindowFilterSnapshot) => {
    if (Object.is(snapshot, next)) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const isFilterAvailable = (filterId: ActiveFilterId): boolean => {
    if (filterId === ALL_FILTER_ID) return true;
    if (isBuiltInFilterId(filterId)) {
      return snapshot.builtInVisibilityReady && !snapshot.hiddenBuiltInFilterIds.has(filterId);
    }
    return snapshot.document?.filters.some((filter) => filter.id === filterId) ?? false;
  };

  const applyDocument = (
    document: FilterDocumentV1,
    requestId: number,
  ) => {
    const currentRevision = snapshot.document?.revision ?? -1;
    const acceptsDocument = document.revision > currentRevision;
    const isLatestRequest = requestId === latestStartedRequest;
    if (!acceptsDocument && !isLatestRequest) return;

    const nextDocument = acceptsDocument ? document : snapshot.document;
    if (nextDocument === null) return;
    const { activeFilterId } = snapshot;
    const activeWasRemoved = typeof activeFilterId === "string"
      && !isBuiltInFilterId(activeFilterId)
      && !nextDocument.filters.some((filter) => filter.id === activeFilterId);
    publish({
      ...snapshot,
      activeFilterId: activeWasRemoved ? ALL_FILTER_ID : activeFilterId,
      document: nextDocument,
      status: "ready",
      isRefreshing: isLatestRequest ? false : snapshot.isRefreshing,
      errorMessage: isLatestRequest || acceptsDocument ? null : snapshot.errorMessage,
      removedActiveFilterId: activeWasRemoved
        ? activeFilterId
        : snapshot.removedActiveFilterId,
      removalVersion: activeWasRemoved
        ? snapshot.removalVersion + 1
        : snapshot.removalVersion,
    });
  };

  const read = () => {
    const client = rpc;
    if (client === null || ownerCount === 0) return;
    const requestLifetime = lifetime;
    const requestId = ++requestSequence;
    pendingRequestsByLifetime.set(
      requestLifetime,
      (pendingRequestsByLifetime.get(requestLifetime) ?? 0) + 1,
    );
    latestStartedRequest = requestId;
    publish({
      ...snapshot,
      status: snapshot.document === null ? "loading" : snapshot.status,
      isRefreshing: snapshot.document !== null,
      errorMessage: null,
    });
    void client.call("listFilters", null).then(
      (result) => {
        if (requestLifetime !== lifetime || ownerCount === 0) return;
        if (result.status === "success") {
          applyDocument(result.document, requestId);
          return;
        }
        if (requestId !== latestStartedRequest) return;
        publish({
          ...snapshot,
          status: "error",
          isRefreshing: false,
          errorMessage: describeReadError(result),
        });
      },
      (error: unknown) => {
        if (
          requestLifetime !== lifetime
          || ownerCount === 0
          || requestId !== latestStartedRequest
        ) return;
        const detail = error instanceof Error ? error.message : String(error);
        publish({
          ...snapshot,
          status: "error",
          isRefreshing: false,
          errorMessage: `Could not load project filters: ${detail}`,
        });
      },
    ).finally(() => {
      const pendingForLifetime = pendingRequestsByLifetime.get(requestLifetime);
      if (pendingForLifetime === undefined || pendingForLifetime === 1) {
        pendingRequestsByLifetime.delete(requestLifetime);
      } else {
        pendingRequestsByLifetime.set(requestLifetime, pendingForLifetime - 1);
      }
    });
  };

  const scheduleRead = () => {
    if (readScheduled) return;
    readScheduled = true;
    queueMicrotask(() => {
      readScheduled = false;
      read();
    });
  };

  return {
    acquire(client) {
      ownerCount += 1;
      if (ownerCount === 1) {
        disposalVersion += 1;
        rpc = client;
        if ((pendingRequestsByLifetime.get(lifetime) ?? 0) === 0) read();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ownerCount -= 1;
        if (ownerCount === 0) {
          const releaseVersion = ++disposalVersion;
          queueMicrotask(() => {
            if (ownerCount === 0 && disposalVersion === releaseVersion) {
              rpc = null;
              lifetime += 1;
            }
          });
        }
      };
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isFilterAvailable,
    setBuiltInVisibilityReady(ready) {
      if (snapshot.builtInVisibilityReady === ready) return;
      publish({
        ...snapshot,
        builtInVisibilityReady: ready,
        activeFilterId: !ready && isBuiltInFilterId(snapshot.activeFilterId) ? ALL_FILTER_ID : snapshot.activeFilterId,
      });
    },
    setBuiltInFilterVisible(filterId, visible) {
      if (filterId === ALL_FILTER_ID || snapshot.hiddenBuiltInFilterIds.has(filterId) === !visible) return;
      const hiddenBuiltInFilterIds = new Set(snapshot.hiddenBuiltInFilterIds);
      if (visible) hiddenBuiltInFilterIds.delete(filterId);
      else hiddenBuiltInFilterIds.add(filterId);
      publish({
        ...snapshot,
        hiddenBuiltInFilterIds,
        activeFilterId: !visible && snapshot.activeFilterId === filterId ? ALL_FILTER_ID : snapshot.activeFilterId,
      });
    },
    setActiveFilterId(filterId) {
      if (!isFilterAvailable(filterId) || filterId === snapshot.activeFilterId) return;
      publish({
        ...snapshot,
        activeFilterId: filterId,
        removedActiveFilterId: null,
      });
    },
    invalidate: scheduleRead,
    reconnect: scheduleRead,
  };
}

export const windowFilterStore = createWindowFilterStore({ builtInVisibilityReady: false });
