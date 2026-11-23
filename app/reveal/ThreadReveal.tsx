import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { useSdk, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { windowFilterStore, ALL_FILTER_ID, PROJECTLESS_FILTER_ID, type ActiveFilterId } from "../filters/filter-store.js";
import { DYNAMIC_FILTERS, isDynamicFilterId, type DynamicFilterId } from "../filters/dynamic-filter-ids.js";
import { useFilterDocumentSync } from "../filters/use-filter-document-sync.js";
import { useWindowFilterSnapshot } from "../filters/use-filter-snapshot.js";
import { hasProjectModeThreadsSection, projectSidebarSnapshot } from "../model/sidebar-projection.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { useDynamicSidebar } from "../model/use-dynamic-sidebar.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { useExpandSidebarThreadPath } from "../list/useSidebarThreadReveal.js";
import { usePreferencesReady, usePreferencesSync } from "../preferences/PreferencesSync.js";
import { sidebarHiddenGroupsAtom, sidebarOrganizationModeAtom, sidebarThreadLifecyclesAtom, collapsedProjectIdsAtom, collapsedSidebarSectionIdsAtom } from "../preferences/atoms.js";
import { planThreadReveal } from "./reveal-plan.js";
import { openRevealSidebar, positionRevealProject, positionRevealThread, waitForReveal } from "./reveal-position.js";
import { loadRevealChain, loadRevealTarget } from "./reveal-data.js";
import "./reveal.css";

const REQUEST_EVENT = "project-first-sidebar:reveal-thread";
const DYNAMIC_MATCH_REMOVED = Symbol("dynamic-match-removed");
export function requestThreadReveal(threadId: string): void {
  window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: threadId }));
}

type Choice = "thread" | "project" | "cancel";
interface Confirmation {
  projectName: string;
  personal: boolean;
  reasons: readonly string[];
  resolve(choice: Choice): void;
}

export function ThreadReveal() {
  usePreferencesSync();
  useFilterDocumentSync(windowFilterStore);
  const preferencesReady = usePreferencesReady();
  const data = useSidebarData();
  const { activeFilterId } = useWindowFilterSnapshot();
  const dynamicFilterId = isDynamicFilterId(activeFilterId) ? activeFilterId : null;
  const dynamic = useDynamicSidebar(dynamicFilterId);
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const store = useStore();
  const expandPath = useExpandSidebarThreadPath();
  const current = { data, preferencesReady, expandPath, dynamic, dynamicFilterId };
  const latest = useRef(current);
  useLayoutEffect(() => { latest.current = current; });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pendingConfirmation = useRef<Confirmation | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let operation: AbortController | null = null;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let highlighted: HTMLElement | null = null;
    const clearHighlight = () => {
      clearTimeout(highlightTimer);
      highlighted?.removeAttribute("data-project-first-reveal-highlight");
      highlighted = null;
    };
    const highlight = (row: HTMLElement, signal: AbortSignal) => {
      signal.throwIfAborted();
      row.setAttribute("data-project-first-reveal-highlight", "");
      highlighted = row;
      highlightTimer = setTimeout(clearHighlight, 1800);
    };
    const preferences = () => ({
      organizationMode: store.get(sidebarOrganizationModeAtom),
      hiddenGroups: store.get(sidebarHiddenGroupsAtom),
      threadLifecycles: store.get(sidebarThreadLifecyclesAtom),
    });
    const loadChain = (threadId: string, signal: AbortSignal) => loadRevealChain(
      threadId, latest.current.data.threads, preferences().threadLifecycles, sdk, signal,
    );
    const confirm = (projectName: string, personal: boolean, reasons: readonly string[], signal: AbortSignal): Promise<Choice> => new Promise((resolve) => {
      const abort = () => finish("cancel");
      const finish = (choice: Choice) => {
        signal.removeEventListener("abort", abort);
        if (pendingConfirmation.current === dialog) {
          pendingConfirmation.current = null;
          setConfirmation(null);
        }
        resolve(choice);
      };
      const dialog: Confirmation = { projectName, personal, reasons, resolve: finish };
      pendingConfirmation.current = dialog;
      setConfirmation(dialog);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const revealDynamicMatch = async (
      root: HTMLElement,
      filterId: DynamicFilterId,
      threadId: string,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const readMatch = (): boolean | null => {
        const { dynamic, dynamicFilterId } = latest.current;
        if (dynamicFilterId !== filterId || dynamic.status === "loading") return null;
        if (dynamic.status === "error") throw new Error("Не удалось загрузить активные треды.");
        return dynamic.projection?.threadIds.has(threadId) ?? null;
      };
      const { matches } = await waitForReveal(() => {
        const matches = readMatch();
        return matches === null ? null : { matches };
      }, signal);
      if (!matches) return false;

      const selector = `[data-sidebar-dynamic-filter="${DYNAMIC_FILTERS[filterId].key}"]`;
      try {
        const row = await positionRevealThread(() => {
          const matches = readMatch();
          if (matches === false) throw DYNAMIC_MATCH_REMOVED;
          return matches === true ? root.querySelector<HTMLElement>(selector) : null;
        }, threadId, signal);
        highlight(row, signal);
        return true;
      } catch (error) {
        if (error === DYNAMIC_MATCH_REMOVED) return false;
        throw error;
      }
    };
    const perform = async (
      threadId: string,
      signal: AbortSignal,
      initialFilterId: ActiveFilterId,
      selectFilter: (id: ActiveFilterId) => void,
    ) => {
      const root = await openRevealSidebar(signal);
      const dynamicId = isDynamicFilterId(initialFilterId) ? initialFilterId : null;
      if (dynamicId && await revealDynamicMatch(root, dynamicId, threadId, signal)) return;
      await waitForReveal(() => latest.current.preferencesReady && latest.current.data.status === "ready"
        && (dynamicId !== null || windowFilterStore.getSnapshot().status === "ready"), signal);
      let chain = await loadChain(threadId, signal);
      if (dynamicId && await revealDynamicMatch(root, dynamicId, threadId, signal)) return;
      const personalId = latest.current.data.personalProject?.id ?? null;
      let plan = planThreadReveal(chain, preferences(), personalId);
      const project = latest.current.data.projects.find((item) => item.id === plan.projectId);
      if (!project) throw new Error("Проект треда недоступен.");
      const projectName = project.isPersonal ? "Без проектов" : project.name;
      let choice: Choice = "thread";
      if (plan.reasons.length) {
        const approved = plan;
        choice = await confirm(projectName, project.isPersonal, plan.reasons, signal);
        signal.throwIfAborted();
        if (choice === "cancel") return;
        await waitForReveal(() => !cancelRef.current, signal);
        if (choice === "thread" && dynamicId && await revealDynamicMatch(root, dynamicId, threadId, signal)) return;
        chain = await loadChain(threadId, signal);
        if (choice === "thread" && dynamicId && await revealDynamicMatch(root, dynamicId, threadId, signal)) return;
        plan = planThreadReveal(chain, preferences(), personalId);
        // A dialog cannot authorize changes that appeared while it was open.
        if (plan.projectId !== approved.projectId || (choice === "thread" && (
          (plan.missingLifecycle && plan.missingLifecycle !== approved.missingLifecycle)
          || (plan.hiddenGroupId && plan.hiddenGroupId !== approved.hiddenGroupId)
          || plan.hiddenThreadIds.some((id) => !approved.hiddenThreadIds.includes(id))
        ))) throw new Error("Видимость треда изменилась. Повторите команду, чтобы проверить новые условия.");
      }
      signal.throwIfAborted();
      let row: HTMLElement;
      if (choice === "project") {
        const showPersonalFilter = project.isPersonal && windowFilterStore.isFilterAvailable(PROJECTLESS_FILTER_ID);
        selectFilter(showPersonalFilter ? PROJECTLESS_FILTER_ID : ALL_FILTER_ID);
        if (store.get(sidebarOrganizationModeAtom) !== "project") {
          navigate.toProject(plan.projectId);
          return;
        }
        const destination = project.isPersonal ? (showPersonalFilter ? "personal-filter" : "personal-section") : "project";
        if (destination === "personal-section") {
          const full = projectSidebarSnapshot({
            activeFilterId: ALL_FILTER_ID,
            document: null,
            snapshot: latest.current.data,
          }).full;
          if (!hasProjectModeThreadsSection(full, personalId)) {
            navigate.toProject(plan.projectId);
            return;
          }
        }
        const groupId = project.isPersonal ? "threads" : `project:${plan.projectId}`;
        store.set(sidebarHiddenGroupsAtom, (ids) => ids.includes(groupId) ? ids.filter((id) => id !== groupId) : ids);
        if (destination !== "personal-section") {
          store.set(collapsedProjectIdsAtom, (ids) => ids.includes(plan.projectId) ? ids.filter((id) => id !== plan.projectId) : ids);
        }
        if (project.isPersonal) {
          store.set(collapsedSidebarSectionIdsAtom, (ids) => ids.includes("threads") ? ids.filter((id) => id !== "threads") : ids);
        }
        row = await positionRevealProject(root, plan.projectId, destination, signal);
      } else {
        for (const id of plan.hiddenThreadIds) {
          signal.throwIfAborted();
          await sdk.threads.update({ threadId: id, visibility: "visible" });
        }
        signal.throwIfAborted();
        if (plan.missingLifecycle) {
          const lifecycle = plan.missingLifecycle;
          store.set(sidebarThreadLifecyclesAtom, (values) => values.includes(lifecycle) ? values : [...values, lifecycle]);
        }
        if (plan.hiddenGroupId) {
          const groupId = plan.hiddenGroupId;
          store.set(sidebarHiddenGroupsAtom, (ids) => ids.filter((id) => id !== groupId));
        }
        const target = await loadRevealTarget(chain, () => latest.current.data, signal);
        if (plan.reasons.length === 0 && dynamicId && await revealDynamicMatch(root, dynamicId, threadId, signal)) return;
        signal.throwIfAborted();
        const snapshot = windowFilterStore.getSnapshot();
        const visibleInCurrentFilter = typeof snapshot.activeFilterId === "string" && projectSidebarSnapshot({
          activeFilterId: snapshot.activeFilterId, document: snapshot.document, snapshot: latest.current.data,
        }).visible.threadIds.has(threadId);
        if (!visibleInCurrentFilter) {
          selectFilter(ALL_FILTER_ID);
          toast.info("Выбран отбор «Все», чтобы показать тред.");
        }
        latest.current.expandPath({ thread: target,
          threadById: new Map(latest.current.data.threads.map((item) => [item.id, item])),
          effectivePinnedThreadIds: buildPinnedSidebarState({ threads: latest.current.data.threads }).effectivePinnedThreadIds,
          personalProjectId: personalId,
        });
        row = await positionRevealThread(root, threadId, signal);
      }
      highlight(row, signal);
    };
    const onRequest = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      operation?.abort();
      clearHighlight();
      const controller = new AbortController();
      operation = controller;
      const signal = controller.signal;
      const initialFilterId = windowFilterStore.getSnapshot().activeFilterId;
      let expectedFilterId = initialFilterId;
      const unsubscribe = windowFilterStore.subscribe(() => {
        const currentFilterId = windowFilterStore.getSnapshot().activeFilterId;
        if (currentFilterId !== expectedFilterId
          && (isDynamicFilterId(initialFilterId) || isDynamicFilterId(currentFilterId))) controller.abort();
      });
      const selectFilter = (id: ActiveFilterId) => {
        signal.throwIfAborted();
        expectedFilterId = id;
        windowFilterStore.setActiveFilterId(id);
      };
      void perform(event.detail, signal, initialFilterId, selectFilter).catch((error: unknown) => {
        if (!signal.aborted) toast.error(error instanceof Error ? error.message : "Не удалось показать тред.");
      }).finally(() => {
        unsubscribe();
        if (operation === controller) operation = null;
      });
    };
    window.addEventListener(REQUEST_EVENT, onRequest);
    return () => { operation?.abort(); clearHighlight(); window.removeEventListener(REQUEST_EVENT, onRequest); };
  }, [sdk, store, navigate]);

  const close = (choice: Choice) => {
    pendingConfirmation.current?.resolve(choice);
  };
  return (
    <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open) close("cancel"); }}>
      <DialogContent
        onOpenAutoFocus={(event) => { event.preventDefault(); cancelRef.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>Показать тред в дереве</DialogTitle>
          <DialogDescription>
            Проект: {confirmation?.projectName}. {confirmation?.reasons.join(" ")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={cancelRef} autoFocus variant="outline" onClick={() => close("cancel")}>Отмена</Button>
          <Button variant="outline" onClick={() => close("project")}>{confirmation?.personal ? "Перейти к «Без проектов»" : "Перейти к проекту"}</Button>
          <Button onClick={() => close("thread")}>Показать в дереве</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
