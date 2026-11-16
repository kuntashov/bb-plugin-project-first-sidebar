import { useLayoutEffect, useRef } from "react";
import { useStore } from "jotai";
import { experimental_usePluginId, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { windowFilterStore } from "../filters/filter-store.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import { sidebarHiddenGroupsAtom, sidebarOrganizationModeAtom, sidebarThreadLifecyclesAtom } from "../preferences/atoms.js";
import { useExpandSidebarThreadPath } from "../list/useSidebarThreadReveal.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { projectSidebarSnapshot } from "../model/sidebar-projection.js";
import { loadRevealTarget } from "../reveal/reveal-data.js";
import { planThreadReveal, type RevealThread } from "../reveal/reveal-plan.js";
import { openRevealSidebar, positionRevealThread, waitForReveal } from "../reveal/reveal-position.js";
import { completeAncestors, effectiveProject, filterProjectIds, rawTitle, threadChain, type SearchProject, type SearchThread } from "./search-model.js";

export interface SearchSelection { threadId: string; expectedTitle: string; filterId: string; revision: number; includeArchived: boolean }
export interface PreparedSelection { selection: SearchSelection; target: SearchThread; chain: SearchThread[]; signal: AbortSignal }

export function useSearchNavigation() {
  const sdk = useSdk();
  const pluginId = experimental_usePluginId();
  const navigate = useBbNavigate();
  const store = useStore();
  const data = useSidebarData();
  const preferencesReady = usePreferencesReady();
  const expandPath = useExpandSidebarThreadPath();
  const latest = useRef({ data, preferencesReady, expandPath });
  useLayoutEffect(() => { latest.current = { data, preferencesReady, expandPath }; });

  const validateFilter = (selection: SearchSelection, target: SearchThread, byId: ReadonlyMap<string, SearchThread>, projects: readonly SearchProject[]) => {
    const snapshot = windowFilterStore.getSnapshot();
    if (!snapshot.document || snapshot.status !== "ready" || snapshot.isRefreshing || snapshot.document.revision !== selection.revision) {
      throw new Error("Фильтры обновились. Проверьте результат и повторите Enter.");
    }
    if (target.deletedAt !== null || (!selection.includeArchived && target.archivedAt !== null)) {
      throw new Error("Состояние треда изменилось. Обновите список.");
    }
    if (!filterProjectIds(selection.filterId, snapshot.document, projects).has(effectiveProject(target, byId))) {
      throw new Error("Тред больше не входит в выбранный фильтр.");
    }
  };
  const prepare = async (selection: SearchSelection, signal: AbortSignal): Promise<PreparedSelection> => {
    if (!latest.current.preferencesReady) throw new Error("Настройки ещё загружаются.");
    // Validation reads only; opening the drawer belongs to commit.
    if (!document.querySelector("[data-project-first-sidebar]")) {
      const preferences = await sdk.system.uiPreferences.list({ signal });
      signal.throwIfAborted();
      const selected = preferences.preferences["sidebar.threadListProvider"]?.value;
      if (selected !== `${pluginId}/project-first-sidebar` || !document.querySelector('[data-sidebar="trigger"]')) {
        throw new Error("Откройте Project-first sidebar или выберите его в настройках BB.");
      }
    }
    const [target, projects] = await Promise.all([
      sdk.threads.get({ threadId: selection.threadId, signal }),
      sdk.projects.list({ includePersonal: true, signal }),
    ]);
    if (target.deletedAt !== null) throw new Error("Тред удалён.");
    if (rawTitle(target) !== selection.expectedTitle) throw new Error("Название треда изменилось. Обновите список и повторите выбор.");
    const byId = await completeAncestors(sdk, [target], signal);
    signal.throwIfAborted();
    validateFilter(selection, target, byId, projects.map((project) => ({ ...project, isPersonal: project.kind === "personal" })));
    return { selection, target, chain: threadChain(target, byId), signal };
  };
  const commit = async ({ selection, target, chain, signal: preparedSignal }: PreparedSelection, signal: AbortSignal) => {
    preparedSignal.throwIfAborted();
    signal.throwIfAborted();
    const snapshot = windowFilterStore.getSnapshot();
    if (snapshot.status !== "ready" || snapshot.isRefreshing || snapshot.document?.revision !== selection.revision) throw new Error("Фильтры обновились. Повторите поиск.");
    windowFilterStore.setActiveFilterId(selection.filterId);
    const lifecycles = new Set(store.get(sidebarThreadLifecyclesAtom));
    for (const thread of chain) lifecycles.add(thread.archivedAt !== null ? "archived" : "active");
    store.set(sidebarThreadLifecyclesAtom, [...lifecycles]);
    // Selecting a hidden result reveals that result only, never its ancestors.
    if (target.visibility === "hidden") await sdk.threads.update({ threadId: target.id, visibility: "visible" });
    signal.throwIfAborted();
    navigate.toThread(target.id);
    const root = await openRevealSidebar(signal);
    await waitForReveal(() => latest.current.preferencesReady && latest.current.data.status === "ready", signal);
    const revealChain: RevealThread[] = chain.map((thread) => ({
      id: thread.id, projectId: thread.projectId, parentThreadId: thread.parentThreadId,
      sectionId: thread.sectionId, isPinned: thread.pinnedAt !== null, isArchived: thread.archivedAt !== null,
      isHidden: false, environment: { id: thread.environmentId }, host: null,
    }));
    // Hidden ancestors are placement metadata, not rows that must become visible.
    const loadedTarget = await loadRevealTarget(revealChain, () => latest.current.data, signal);
    const current = latest.current.data;
    const threadById = new Map(current.threads.filter((thread) => !thread.isHidden).map((thread) => [thread.id, thread]));
    const projection = projectSidebarSnapshot({ activeFilterId: selection.filterId, document: snapshot.document,
      snapshot: { projects: current.projects, threads: current.threads } });
    if (!projection.visible.threadIds.has(target.id)) throw new Error("Тред открыт, но его текущий путь не попадает в выбранный фильтр сайдбара.");
    const visiblePath: RevealThread[] = [loadedTarget];
    let ancestorId = loadedTarget.parentThreadId;
    const seen = new Set([loadedTarget.id]);
    while (ancestorId && threadById.has(ancestorId) && !seen.has(ancestorId)) {
      seen.add(ancestorId);
      const ancestor = threadById.get(ancestorId)!;
      visiblePath.push(ancestor); ancestorId = ancestor.parentThreadId;
    }
    const sidebarProjectId = chain.at(-1)!.projectId;
    const placementChain = visiblePath.map((thread, index) => index === visiblePath.length - 1 ? { ...thread, projectId: sidebarProjectId } : thread);
    // Effective placement comes from the full accessible chain, including a
    // hidden parent that need not have a row in the tree.
    const plan = planThreadReveal(placementChain, { organizationMode: store.get(sidebarOrganizationModeAtom),
      threadLifecycles: store.get(sidebarThreadLifecyclesAtom), hiddenGroups: store.get(sidebarHiddenGroupsAtom) }, current.personalProject?.id ?? null);
    if (plan.hiddenGroupId) store.set(sidebarHiddenGroupsAtom, (ids) => ids.filter((id) => id !== plan.hiddenGroupId));
    latest.current.expandPath({ thread: loadedTarget, threadById, sidebarProjectId,
      effectivePinnedThreadIds: buildPinnedSidebarState({ threads: current.threads }).effectivePinnedThreadIds,
      personalProjectId: current.personalProject?.id ?? null });
    await positionRevealThread(root, target.id, signal);
  };
  return { prepare, commit };
}
