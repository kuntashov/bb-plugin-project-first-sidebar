import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "jotai";
import { useSdk, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { windowFilterStore, ALL_FILTER_ID, PROJECTLESS_FILTER_ID } from "../filters/filter-store.js";
import { useFilterDocumentSync } from "../filters/use-filter-document-sync.js";
import { hasProjectModeThreadsSection, projectSidebarSnapshot } from "../model/sidebar-projection.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import { useExpandSidebarThreadPath } from "../list/useSidebarThreadReveal.js";
import { usePreferencesReady, usePreferencesSync } from "../preferences/PreferencesSync.js";
import { sidebarHiddenGroupsAtom, sidebarOrganizationModeAtom, sidebarThreadLifecyclesAtom, collapsedProjectIdsAtom, collapsedSidebarSectionIdsAtom } from "../preferences/atoms.js";
import { planThreadReveal } from "./reveal-plan.js";
import { openRevealSidebar, positionRevealProject, positionRevealThread, waitForReveal } from "./reveal-position.js";
import { loadRevealChain, loadRevealTarget } from "./reveal-data.js";
import "./reveal.css";

const REQUEST_EVENT = "project-first-sidebar:reveal-thread";
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
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const store = useStore();
  const expandPath = useExpandSidebarThreadPath();
  const latest = useRef({ data, preferencesReady, expandPath });
  useLayoutEffect(() => { latest.current = { data, preferencesReady, expandPath }; });
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
    const perform = async (threadId: string, signal: AbortSignal) => {
      const root = await openRevealSidebar(signal);
      await waitForReveal(() => latest.current.preferencesReady && latest.current.data.status === "ready"
        && windowFilterStore.getSnapshot().status === "ready", signal);
      let chain = await loadChain(threadId, signal);
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
        chain = await loadChain(threadId, signal);
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
        windowFilterStore.setActiveFilterId(showPersonalFilter ? PROJECTLESS_FILTER_ID : ALL_FILTER_ID);
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
        signal.throwIfAborted();
        const snapshot = windowFilterStore.getSnapshot();
        const projection = projectSidebarSnapshot({ activeFilterId: snapshot.activeFilterId, document: snapshot.document,
          snapshot: { projects: latest.current.data.projects, threads: latest.current.data.threads } });
        if (!projection.visible.threadIds.has(threadId)) {
          windowFilterStore.setActiveFilterId(ALL_FILTER_ID);
          toast.info("Выбран отбор «Все», чтобы показать тред.");
        }
        latest.current.expandPath({ thread: target,
          threadById: new Map(latest.current.data.threads.map((item) => [item.id, item])),
          effectivePinnedThreadIds: buildPinnedSidebarState({ threads: latest.current.data.threads }).effectivePinnedThreadIds,
          personalProjectId: personalId,
        });
        row = await positionRevealThread(root, threadId, signal);
      }
      row.setAttribute("data-project-first-reveal-highlight", "");
      highlighted = row;
      highlightTimer = setTimeout(clearHighlight, 1800);
    };
    const onRequest = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string") return;
      operation?.abort();
      clearHighlight();
      operation = new AbortController();
      const signal = operation.signal;
      void perform(event.detail, signal).catch((error: unknown) => {
        if (!signal.aborted) toast.error(error instanceof Error ? error.message : "Не удалось показать тред.");
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
