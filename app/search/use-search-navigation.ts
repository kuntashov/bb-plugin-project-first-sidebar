import { useLayoutEffect, useRef } from "react";
import { useStore } from "jotai";
import { experimental_usePluginId, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import { windowFilterStore } from "../filters/filter-store.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";
import { sidebarHiddenGroupsAtom, sidebarOrganizationModeAtom, sidebarThreadLifecyclesAtom } from "../preferences/atoms.js";
import { projectSectionRevealPlacement, useExpandSidebarThreadPath } from "../list/useSidebarThreadReveal.js";
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
    await loadRevealTarget(revealChain, () => latest.current.data, signal);
    const currentPlacement = () => {
      const current = latest.current.data;
      const filters = windowFilterStore.getSnapshot();
      if (filters.activeFilterId !== selection.filterId) throw new Error("Отбор сайдбара изменился. Повторите выбор.");
      if (current.status !== "ready" || filters.status !== "ready" || filters.isRefreshing || !filters.document) return null;
      const thread = current.threads.find((item) => item.id === target.id && !item.isHidden);
      if (!thread) return null;
      const projection = projectSidebarSnapshot({ activeFilterId: selection.filterId, document: filters.document,
        snapshot: { projects: current.projects, threads: current.threads } });
      const sidebarProjectId = projection.full.effectiveProjectIdByThreadId.get(thread.id)!;
      const projectIds = filterProjectIds(selection.filterId, filters.document, current.projects);
      if (!projection.visible.threadIds.has(thread.id) || !projectIds.has(sidebarProjectId)) {
        throw new Error("Тред открыт, но его текущий путь не попадает в выбранный фильтр сайдбара.");
      }
      const threadById = new Map(current.threads.filter((item) => !item.isHidden).map((item) => [item.id, item]));
      const visiblePath: RevealThread[] = [thread];
      let ancestorId = thread.parentThreadId;
      const seen = new Set([thread.id]);
      while (ancestorId && threadById.has(ancestorId) && !seen.has(ancestorId)) {
        seen.add(ancestorId);
        const ancestor = threadById.get(ancestorId)!;
        visiblePath.push(ancestor); ancestorId = ancestor.parentThreadId;
      }
      const placementChain = visiblePath.map((item, index) => index === visiblePath.length - 1 ? { ...item, projectId: sidebarProjectId } : item);
      const plan = planThreadReveal(placementChain, { organizationMode: store.get(sidebarOrganizationModeAtom),
        threadLifecycles: store.get(sidebarThreadLifecyclesAtom), hiddenGroups: store.get(sidebarHiddenGroupsAtom) }, current.personalProject?.id ?? null);
      if (plan.hiddenGroupId) store.set(sidebarHiddenGroupsAtom, (ids) => ids.filter((id) => id !== plan.hiddenGroupId));
      const pinnedIds = projection.full.effectivePinnedThreadIds;
      const value = document.querySelector("[data-project-section-status]")?.getAttribute("data-project-section-status");
      const sectionStatus = value === "ready" || value === "error" ? value : "loading";
      const placement = projectSectionRevealPlacement({ thread, threadById, sidebarProjectId,
        organizationMode: store.get(sidebarOrganizationModeAtom), personalProjectId: current.personalProject?.id ?? null,
        pinned: pinnedIds.has(thread.id), sectionStatus });
      return { thread, threadById, sidebarProjectId, pinnedIds, personalProjectId: current.personalProject?.id ?? null, pending: placement.pending };
    };
    await waitForReveal(() => {
      const placement = currentPlacement();
      return placement && !placement.pending;
    }, signal);
    // Metadata reads may span multiple sidebar updates; expand the latest path.
    const placement = currentPlacement();
    if (!placement || placement.pending) throw new Error("Путь треда обновился. Повторите выбор.");
    latest.current.expandPath({ thread: placement.thread, threadById: placement.threadById, sidebarProjectId: placement.sidebarProjectId,
      effectivePinnedThreadIds: placement.pinnedIds, personalProjectId: placement.personalProjectId });
    await positionRevealThread(root, target.id, signal);
  };
  return { prepare, commit };
}
