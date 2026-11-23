import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSetAtom, useStore } from "jotai";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { NO_MACHINE_GROUP_KEY } from "../model/machine-thread-groups.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import {
  CHRONOLOGICAL_CONTAINER_ID,
  resolveSidebarProjectId,
} from "../model/project-thread-groups.js";
import { sectionKeyForThreadSection } from "../model/section-keys.js";
import type { CollapsibleSidebarSectionId } from "../model/sidebar-section-id.js";
import { useBbContext } from "@get-bb/plugin-sdk/app";
import type { OrganizationMode as SidebarOrganizationMode } from "../../shared/preferences.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { projectSidebarSnapshot } from "../model/sidebar-projection.js";
import { useWindowFilterSnapshot } from "../filters/use-filter-snapshot.js";
import { isDynamicFilterId } from "../filters/dynamic-filter-ids.js";
import {
  collapsedEnvironmentIdsAtom,
  collapsedProjectIdsAtom,
  collapsedSidebarSectionIdsAtom,
  sidebarCollapsedMachinesAtom,
  sidebarCollapsedThreadSectionsAtom,
  sidebarOrganizationModeAtom,
  sidebarHiddenGroupsAtom,
  sidebarThreadLifecyclesAtom,
} from "../preferences/atoms.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import { planThreadReveal } from "../reveal/reveal-plan.js";
import { useExpandThreadAncestors } from "./useReadStatusGrouping.js";

interface ThreadSidebarExpansionArgs {
  organizationMode: SidebarOrganizationMode;
  isPinned: boolean;
  thread: SidebarThread;
  sidebarProjectId: string;
  personalProjectId: string | null;
}

interface ThreadSidebarExpansion {
  sectionKey?: string;
  machineKey?: string;
  projectId?: string;
  sidebarSectionId?: CollapsibleSidebarSectionId;
}

function removeCollapsedIds<T extends string>(
  current: T[],
  idsToRemove: ReadonlySet<string>,
): T[] {
  if (idsToRemove.size === 0) {
    return current;
  }
  let removed = false;
  const next = current.filter((id) => {
    if (!idsToRemove.has(id)) {
      return true;
    }
    removed = true;
    return false;
  });
  return removed ? next : current;
}

export function getThreadSidebarExpansion({
  organizationMode,
  isPinned,
  thread,
  sidebarProjectId,
  personalProjectId,
}: ThreadSidebarExpansionArgs): ThreadSidebarExpansion {
  if (isPinned) {
    return { sidebarSectionId: "pinned" };
  }

  if (organizationMode === "machine") {
    return {
      machineKey: thread.host?.id ?? NO_MACHINE_GROUP_KEY,
    };
  }

  if (organizationMode === "chronological") {
    const sectionKey = sectionKeyForThreadSection(
      CHRONOLOGICAL_CONTAINER_ID,
      thread.sectionId,
    );
    return sectionKey ? { sectionKey } : { sidebarSectionId: "threads" };
  }

  if (sidebarProjectId === personalProjectId) {
    return { sidebarSectionId: "threads" };
  }

  return { projectId: sidebarProjectId };
}

export function useSidebarThreadReveal(): void {
  const { threadId: routedThreadId } = useBbContext();
  const {
    status,
    projects,
    threads: fullThreads,
    personalProject,
  } = useSidebarData();
  const { activeFilterId, document } = useWindowFilterSnapshot();
  const suppressExpansion = isDynamicFilterId(activeFilterId);
  const preferencesReady = usePreferencesReady();
  const projection = useMemo(
    () => typeof activeFilterId === "string"
      ? projectSidebarSnapshot({ activeFilterId, document, snapshot: { projects, threads: fullThreads } })
      : null,
    [
      activeFilterId,
      document,
      fullThreads,
      projects,
    ],
  );
  useSidebarThreadRevealCore({
    selectedThreadId: routedThreadId ?? undefined,
    fullThreads,
    visibleThreadIds: projection?.visible.threadIds,
    threadsReady: status === "ready",
    preferencesReady,
    personalProjectId: personalProject?.id ?? null,
    suppressExpansion,
  });
}

export interface SidebarThreadRevealState {
  previousThreadId: string | undefined;
  pendingNavigation: string | undefined;
  previousUnreadIds: ReadonlySet<string> | null;
}

export const INITIAL_SIDEBAR_THREAD_REVEAL_STATE: SidebarThreadRevealState = {
  previousThreadId: undefined,
  pendingNavigation: undefined,
  previousUnreadIds: null,
};

interface SidebarThreadRevealStepInputs {
  selectedThreadId: string | undefined;
  threads: readonly SidebarThread[];
  threadById: ReadonlyMap<string, SidebarThread>;
  threadsReady: boolean;
  preferencesReady: boolean;
}

interface SidebarThreadRevealStep {
  state: SidebarThreadRevealState;
  revealIds: ReadonlySet<string>;
  navigationRevealId: string | undefined;
}

export function stepSidebarThreadReveal(
  state: SidebarThreadRevealState,
  {
    selectedThreadId,
    threads,
    threadById,
    threadsReady,
    preferencesReady,
  }: SidebarThreadRevealStepInputs,
): SidebarThreadRevealStep {
  let { previousThreadId, pendingNavigation } = state;
  if (previousThreadId !== selectedThreadId) {
    previousThreadId = selectedThreadId;
    pendingNavigation = selectedThreadId;
  }
  if (!preferencesReady || !threadsReady) {
    return {
      state: {
        previousThreadId,
        pendingNavigation,
        previousUnreadIds: state.previousUnreadIds,
      },
      revealIds: new Set(),
      navigationRevealId: undefined,
    };
  }
  const revealIds = new Set<string>();
  const navigationRevealId = pendingNavigation;
  if (navigationRevealId && threadById.has(navigationRevealId)) {
    revealIds.add(navigationRevealId);
    pendingNavigation = undefined;
  }
  const unreadIds = new Set<string>();
  for (const thread of threads) {
    if (thread.isHidden || !thread.isUnread) {
      continue;
    }
    unreadIds.add(thread.id);
    if (
      state.previousUnreadIds &&
      !state.previousUnreadIds.has(thread.id) &&
      thread.id !== selectedThreadId
    ) {
      revealIds.add(thread.id);
    }
  }
  return {
    state: {
      previousThreadId,
      pendingNavigation,
      previousUnreadIds: unreadIds,
    },
    revealIds,
    navigationRevealId,
  };
}

interface ThreadRevealExpansionArgs {
  /** Full placement project when hidden ancestors are absent from the rendered path. */
  sidebarProjectId?: string;
  thread: SidebarThread;
  threadById: ReadonlyMap<string, SidebarThread>;
  effectivePinnedThreadIds: ReadonlySet<string>;
  organizationMode: SidebarOrganizationMode;
  personalProjectId: string | null;
}

export function resolveThreadRevealExpansion({
  thread,
  threadById,
  effectivePinnedThreadIds,
  organizationMode,
  personalProjectId,
  sidebarProjectId,
}: ThreadRevealExpansionArgs) {
  const threadIdsToExpand = new Set<string>();
  const environmentIdsToExpand = new Set<string>();
  let currentThread: SidebarThread | undefined = thread;
  let remainingHops = threadById.size;
  while (currentThread && remainingHops > 0) {
    const environmentId = currentThread.environment?.id ?? null;
    if (environmentId !== null) {
      environmentIdsToExpand.add(environmentId);
    }
    const parentThreadId = currentThread.parentThreadId;
    if (parentThreadId === null) {
      break;
    }
    const parentThread = threadById.get(parentThreadId);
    if (!parentThread) {
      break;
    }
    threadIdsToExpand.add(parentThread.id);
    currentThread = parentThread;
    remainingHops -= 1;
  }
  const expansion = getThreadSidebarExpansion({
    organizationMode,
    isPinned: effectivePinnedThreadIds.has(thread.id),
    thread: organizationMode === "chronological" && currentThread ? currentThread : thread,
    sidebarProjectId: sidebarProjectId ?? resolveSidebarProjectId(thread, threadById),
    personalProjectId,
  });
  if (!effectivePinnedThreadIds.has(thread.id) && organizationMode !== "machine") {
    const root = currentThread ?? thread;
    const containerId = organizationMode === "chronological"
      ? CHRONOLOGICAL_CONTAINER_ID
      : sidebarProjectId ?? resolveSidebarProjectId(thread, threadById);
    const sectionKey = sectionKeyForThreadSection(containerId, root.sectionId);
    if (sectionKey) expansion.sectionKey = sectionKey;
  }
  return { threadIdsToExpand, environmentIdsToExpand, expansion };
}

interface SidebarThreadRevealInputs {
  selectedThreadId: string | undefined;
  fullThreads: readonly SidebarThread[];
  visibleThreadIds: ReadonlySet<string> | undefined;
  threadsReady: boolean;
  preferencesReady: boolean;
  personalProjectId: string | null;
  suppressExpansion: boolean;
}

function useSidebarThreadRevealCore({
  selectedThreadId,
  fullThreads,
  visibleThreadIds,
  threadsReady,
  preferencesReady,
  personalProjectId,
  suppressExpansion,
}: SidebarThreadRevealInputs): void {
  const expandPath = useExpandSidebarThreadPath();
  const threadById = useMemo(
    () => new Map(fullThreads.map((thread) => [thread.id, thread])),
    [fullThreads],
  );
  const visibleThreadById = useMemo(
    () =>
      new Map(
        fullThreads
          .filter((thread) => visibleThreadIds?.has(thread.id))
          .map((thread) => [thread.id, thread]),
      ),
    [fullThreads, visibleThreadIds],
  );
  const effectivePinnedThreadIds = useMemo(
    () =>
      buildPinnedSidebarState({ threads: fullThreads }).effectivePinnedThreadIds,
    [fullThreads],
  );
  const revealState = useRef(INITIAL_SIDEBAR_THREAD_REVEAL_STATE);
  const wasSuppressingExpansion = useRef(suppressExpansion);

  useEffect(() => {
    // The commit that exits the dynamic filter may also carry its last live update.
    const consumeOnly = suppressExpansion || wasSuppressingExpansion.current;
    wasSuppressingExpansion.current = suppressExpansion;
    const step = stepSidebarThreadReveal(revealState.current, {
      selectedThreadId,
      threads: fullThreads,
      threadById,
      threadsReady,
      preferencesReady: preferencesReady || consumeOnly,
    });
    if (consumeOnly) {
      revealState.current = {
        ...step.state,
        pendingNavigation: undefined,
        previousUnreadIds: threadsReady ? step.state.previousUnreadIds : null,
      };
      return;
    }
    revealState.current = step.state;
    for (const threadId of step.revealIds) {
      const thread = visibleThreadById.get(threadId);
      if (!thread || thread.isHidden) {
        continue;
      }
      expandPath({
        thread,
        threadById: visibleThreadById,
        effectivePinnedThreadIds,
        personalProjectId,
      }, threadId === step.navigationRevealId);
    }
  }, [
    selectedThreadId,
    threadsReady,
    preferencesReady,
    personalProjectId,
    fullThreads,
    threadById,
    visibleThreadById,
    effectivePinnedThreadIds,
    expandPath,
    suppressExpansion,
  ]);
}

// Shared by automatic expansion and the explicit reveal command. Only the
// caller decides whether visibility may change and whether focus should move.
export function useExpandSidebarThreadPath() {
  const store = useStore();
  const expandThreadAncestors = useExpandThreadAncestors();
  const setCollapsedEnvironmentIdList = useSetAtom(collapsedEnvironmentIdsAtom);
  const setCollapsedProjectIdList = useSetAtom(collapsedProjectIdsAtom);
  const setCollapsedMachineKeyList = useSetAtom(sidebarCollapsedMachinesAtom);
  const setCollapsedSectionList = useSetAtom(
    sidebarCollapsedThreadSectionsAtom,
  );
  const setCollapsedSidebarSectionIdList = useSetAtom(
    collapsedSidebarSectionIdsAtom,
  );

  return useCallback((args: Omit<ThreadRevealExpansionArgs, "organizationMode">, fromNavigation = true) => {
    const organizationMode = store.get(sidebarOrganizationModeAtom);
    const { threadIdsToExpand, environmentIdsToExpand, expansion } =
      resolveThreadRevealExpansion({ ...args, organizationMode });
    const chain = [args.thread, ...Array.from(threadIdsToExpand)
      .flatMap((id) => { const thread = args.threadById.get(id); return thread ? [thread] : []; })];
    const placementChain = args.sidebarProjectId ? chain.map((thread, index) => index === chain.length - 1 ? { ...thread, projectId: args.sidebarProjectId! } : thread) : chain;
    const plan = planThreadReveal(placementChain, {
      organizationMode,
      threadLifecycles: store.get(sidebarThreadLifecyclesAtom),
      hiddenGroups: store.get(sidebarHiddenGroupsAtom),
    }, args.personalProjectId);
    if (plan.reasons.length) return;
    expandThreadAncestors(threadIdsToExpand, fromNavigation);
    setCollapsedEnvironmentIdList((ids) => removeCollapsedIds(ids, environmentIdsToExpand));
    if (expansion.machineKey) {
      const key = expansion.machineKey;
      setCollapsedMachineKeyList((ids) => removeCollapsedIds(ids, new Set([key])));
    }
    if (expansion.sectionKey) {
      const key = expansion.sectionKey;
      setCollapsedSectionList((ids) => removeCollapsedIds(ids, new Set([key])));
    }
    if (expansion.projectId) {
      const key = expansion.projectId;
      setCollapsedProjectIdList((ids) => removeCollapsedIds(ids, new Set([key])));
    }
    if (expansion.sidebarSectionId) {
      const key = expansion.sidebarSectionId;
      setCollapsedSidebarSectionIdList((ids) => removeCollapsedIds(ids, new Set([key])));
    }
  }, [store, expandThreadAncestors, setCollapsedEnvironmentIdList,
    setCollapsedMachineKeyList, setCollapsedSectionList, setCollapsedProjectIdList,
    setCollapsedSidebarSectionIdList]);
}
