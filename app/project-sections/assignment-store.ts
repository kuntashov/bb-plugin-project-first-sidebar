import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import {
  PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL,
  interpretProjectSectionAssignment,
  type ProjectSectionAssignment,
  type ProjectSectionMetadataReadResult,
} from "../../shared/project-section-assignment.js";
import {
  buildProjectThreadRootNodes,
  createSidebarProjectIdResolver,
  type ThreadComparator,
} from "../model/project-thread-groups.js";
import type { SidebarThread } from "../model/sidebar-thread.js";

export interface AssignmentReadState {
  status: "loading" | "error" | "ready";
  assignment: ProjectSectionAssignment | null;
}

export interface VisibleProjectRoot {
  projectId: string;
  shownSectionId: string | null;
}

export interface AssignmentSnapshot {
  epoch: number;
  reads: ReadonlyMap<string, AssignmentReadState>;
  roots: ReadonlyMap<string, VisibleProjectRoot>;
}

interface AssignmentRpc {
  call(
    method: "readProjectSectionMetadata",
    input: { threadIds: string[] },
  ): Promise<ProjectSectionMetadataReadResult>;
}

const ASSIGNMENT_READ_BATCH = 200;

const EMPTY_SNAPSHOT: AssignmentSnapshot = {
  epoch: 0,
  reads: new Map(),
  roots: new Map(),
};

function threadIdsFromSignal(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || !("threadIds" in payload)) return [];
  const threadIds = payload.threadIds;
  if (!Array.isArray(threadIds)) return [];
  return threadIds.filter((threadId): threadId is string => typeof threadId === "string" && threadId.length > 0);
}

function createAssignmentStore() {
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  const reads = new Map<string, AssignmentReadState>();
  const roots = new Map<string, VisibleProjectRoot>();
  const watches = new Map<symbol, ReadonlySet<string>>();
  const generation = new Map<string, number>();
  const desired = new Map<string, number>();
  const inflight = new Set<string>();
  let rpc: AssignmentRpc | null = null;
  let ownerCount = 0;
  let watched = new Set<string>();
  let recomputeScheduled = false;
  let pumping = false;
  const readWaiters = new Map<string, Array<{ generation: number; resolve: () => void }>>();

  const settleReadWaiters = (id: string) => {
    const pending = readWaiters.get(id);
    if (pending === undefined) return;
    const current = generation.get(id) ?? 0;
    const open = pending.filter((waiter) => {
      const settled = current >= waiter.generation && !desired.has(id);
      if (settled) waiter.resolve();
      return !settled;
    });
    if (open.length === 0) readWaiters.delete(id);
    else readWaiters.set(id, open);
  };

  const resolveAllReadWaiters = () => {
    for (const pending of readWaiters.values()) {
      for (const waiter of pending) waiter.resolve();
    }
    readWaiters.clear();
  };

  const publish = () => {
    snapshot = {
      epoch: snapshot.epoch + 1,
      reads: new Map(reads),
      roots: new Map(roots),
    };
    listeners.forEach((listener) => listener());
  };

  const reset = () => {
    reads.clear();
    roots.clear();
    watches.clear();
    generation.clear();
    desired.clear();
    inflight.clear();
    watched = new Set();
    rpc = null;
    resolveAllReadWaiters();
    publish();
  };

  const queueRead = (id: string) => {
    const next = (generation.get(id) ?? 0) + 1;
    generation.set(id, next);
    desired.set(id, next);
  };

  const fetchIds = (ids: readonly string[]) => {
    const client = rpc;
    if (client === null) return;
    let queued = false;
    for (const id of new Set(ids)) {
      if (!watched.has(id)) continue;
      queueRead(id);
      queued = true;
    }
    for (const [id, read] of reads) {
      if (read.status !== "loading" || !watched.has(id) || desired.has(id) || inflight.has(id)) continue;
      queueRead(id);
      queued = true;
    }
    if (queued) void pump(client);
  };

  const pump = async (client: AssignmentRpc) => {
    if (pumping) return;
    pumping = true;
    try {
      while (desired.size > 0 && rpc === client) {
        const chunk: string[] = [];
        const token = new Map<string, number>();
        for (const [id, gen] of desired) {
          if (chunk.length === ASSIGNMENT_READ_BATCH) break;
          chunk.push(id);
          token.set(id, gen);
        }
        for (const [id, gen] of token) {
          if (desired.get(id) === gen) desired.delete(id);
        }
        for (const id of chunk) inflight.add(id);
        try {
          const result = await client.call("readProjectSectionMetadata", { threadIds: chunk });
          applyRead(chunk, token, result);
        } catch {
          applyRead(chunk, token, null);
        } finally {
          for (const id of chunk) inflight.delete(id);
        }
      }
    } finally {
      pumping = false;
      if (desired.size > 0 && rpc === client) {
        void pump(client);
      } else if (rpc !== client && rpc !== null) {
        const stuck = new Set<string>(desired.keys());
        for (const [id, read] of reads) {
          if (read.status === "loading" && watched.has(id)) stuck.add(id);
        }
        const resume = [...stuck].filter((id) => watched.has(id));
        if (resume.length > 0) fetchIds(resume);
      }
    }
  };

  const applyRead = (
    ids: readonly string[],
    token: ReadonlyMap<string, number>,
    result: ProjectSectionMetadataReadResult | null,
  ) => {
    let changed = false;
    const returned = result?.status === "success"
      ? new Map(result.threads.map((thread) => [thread.threadId, thread.metadata]))
      : null;
    for (const id of ids) {
      if (generation.get(id) !== token.get(id) || !watched.has(id)) continue;
      const current = reads.get(id);
      if (returned === null || !returned.has(id)) {
        if (current?.status === "ready") continue;
        reads.set(id, { status: "error", assignment: null });
        changed = true;
        continue;
      }
      const metadata = returned.get(id);
      if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
        if (current?.status === "ready") continue;
        reads.set(id, { status: "error", assignment: null });
        changed = true;
        continue;
      }
      const interpreted = interpretProjectSectionAssignment(metadata);
      if (interpreted.kind === "invalid") {
        if (current?.status === "ready") continue;
        reads.set(id, { status: "error", assignment: null });
        changed = true;
        continue;
      }
      reads.set(id, interpreted.kind === "absent"
        ? { status: "ready", assignment: null }
        : { status: "ready", assignment: interpreted.assignment });
      changed = true;
    }
    for (const id of ids) settleReadWaiters(id);
    if (changed) publish();
  };

  const recompute = () => {
    const next = new Set<string>();
    for (const ids of watches.values()) {
      for (const id of ids) next.add(id);
    }
    watched = next;
    let changed = false;
    for (const id of [...reads.keys()]) {
      if (next.has(id)) continue;
      reads.delete(id);
      generation.delete(id);
      desired.delete(id);
      inflight.delete(id);
      changed = true;
    }
    const missing: string[] = [];
    for (const id of next) {
      if (reads.has(id)) continue;
      reads.set(id, { status: "loading", assignment: null });
      missing.push(id);
      changed = true;
    }
    if (changed) publish();
    fetchIds(missing);
  };

  const scheduleRecompute = () => {
    if (recomputeScheduled) return;
    recomputeScheduled = true;
    queueMicrotask(() => {
      recomputeScheduled = false;
      if (ownerCount === 0) return;
      recompute();
    });
  };

  return {
    acquire(client: AssignmentRpc) {
      ownerCount += 1;
      rpc = client;
      if (ownerCount === 1) scheduleRecompute();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ownerCount -= 1;
        if (ownerCount > 0) return;
        queueMicrotask(() => {
          if (ownerCount === 0) reset();
        });
      };
    },
    watch(owner: symbol, threadIds: readonly string[]) {
      watches.set(owner, new Set(threadIds));
      scheduleRecompute();
    },
    unwatch(owner: symbol) {
      watches.delete(owner);
      scheduleRecompute();
    },
    invalidate(threadIds: readonly string[]) {
      fetchIds(threadIds.filter((id) => watched.has(id)));
    },
    reread(threadIds: readonly string[]): Promise<void> {
      const ids = [...new Set(threadIds)].filter((id) => watched.has(id));
      if (ids.length === 0 || rpc === null) return Promise.resolve();
      fetchIds(ids);
      return Promise.all(ids.map((id) => new Promise<void>((resolve) => {
        const current = generation.get(id) ?? 0;
        if (!desired.has(id) && !inflight.has(id)) {
          resolve();
          return;
        }
        const pending = readWaiters.get(id) ?? [];
        pending.push({ generation: current, resolve });
        readWaiters.set(id, pending);
      }))).then(() => undefined);
    },
    reconnect() {
      fetchIds([...watched]);
    },
    replaceRoots(entries: readonly (VisibleProjectRoot & { threadId: string })[]) {
      if (
        entries.length === roots.size
        && entries.every((entry) => {
          const current = roots.get(entry.threadId);
          return current?.projectId === entry.projectId && current.shownSectionId === entry.shownSectionId;
        })
      ) {
        return;
      }
      roots.clear();
      for (const entry of entries) {
        roots.set(entry.threadId, { projectId: entry.projectId, shownSectionId: entry.shownSectionId });
      }
      publish();
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const projectSectionAssignmentStore = createAssignmentStore();

function subscribeNothing() {
  return () => undefined;
}

export function useAssignmentSnapshot(): AssignmentSnapshot {
  return useSyncExternalStore(
    projectSectionAssignmentStore.subscribe,
    projectSectionAssignmentStore.getSnapshot,
    projectSectionAssignmentStore.getSnapshot,
  );
}

export function assignmentReadIds(
  threads: readonly SidebarThread[],
  personalProjectId: string | null,
  compareThreads: ThreadComparator,
): string[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const resolveProjectId = createSidebarProjectIdResolver(threadById);
  return buildProjectThreadRootNodes(threads, compareThreads, false).flatMap((node) => {
    const projectId = resolveProjectId(node.thread);
    if (personalProjectId !== null && projectId === personalProjectId) return [];
    return [node.thread.id];
  });
}

export function useProjectSectionAssignmentReads(
  threads: readonly SidebarThread[],
  personalProjectId: string | null,
  compareThreads: ThreadComparator,
) {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const [owner] = useState(() => Symbol());
  const readIds = useMemo(
    () => assignmentReadIds(threads, personalProjectId, compareThreads),
    [compareThreads, personalProjectId, threads],
  );
  const readKey = readIds.join("\0");
  const readIdsRef = useRef(readIds);
  readIdsRef.current = readIds;
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => {
    const release = projectSectionAssignmentStore.acquire(rpc);
    projectSectionAssignmentStore.watch(owner, readIdsRef.current);
    return () => {
      projectSectionAssignmentStore.unwatch(owner);
      release();
    };
  }, [owner, readKey, rpc]);
  useEffect(() => {
    if (
      previousConnectionState.current === "reconnecting"
      && connectionState === "connected"
    ) {
      projectSectionAssignmentStore.reconnect();
    }
    previousConnectionState.current = connectionState;
  }, [connectionState]);
  useRealtime(PROJECT_SECTION_ASSIGNMENTS_CHANGED_CHANNEL, (payload: unknown) => {
    projectSectionAssignmentStore.invalidate(threadIdsFromSignal(payload));
  });
  return useAssignmentSnapshot();
}
