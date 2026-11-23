import { ExecutionProjectionSync } from "./app/execution/ExecutionProjectionSync.js";
import { RebuildSettings } from "./app/execution/RebuildSettings.js";
import { useCallback, useRef, useState, type ComponentType } from "react";
import { Provider as JotaiProvider } from "jotai";
import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BuiltInFilterVisibilitySettings } from "./app/preferences/BuiltInFilterVisibilitySettings.js";
import { ImportPreferences } from "./app/preferences/ImportPreferences.js";
import { PreferencesSync, sidebarPreferencesStore } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { ProjectFilterEditor } from "./app/filters/ProjectFilterEditor.js";
import { ProjectFilterDialog } from "./app/filters/ProjectFilterDialog.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
import { ThreadReveal, requestThreadReveal } from "./app/reveal/ThreadReveal.js";
import { QuickThreadSearch, requestQuickThreadSearch } from "./app/search/QuickThreadSearch.js";
import { moveThreadAction } from "./app/rows/moveThreadAction.js";

function ThreadList({
  activeThreadId,
  isCompactViewport,
  onNavigate,
}: PluginThreadListProps) {
  const [isFilterDialogOpen, setIsFilterDialogOpen] = useState(false);
  const filterDialogTrigger = useRef<HTMLButtonElement | null>(null);
  const openFilterDialog = useCallback((trigger: HTMLButtonElement) => {
    filterDialogTrigger.current = trigger;
    setIsFilterDialogOpen(true);
  }, []);
  const restoreFilterDialogFocus = useCallback(() => {
    filterDialogTrigger.current?.focus();
  }, []);
  useSidebarThreadReveal();
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ExecutionProjectionSync />
        <div data-project-first-sidebar="" className="contents">
          <ProjectList
            activeThreadId={activeThreadId}
            onProjectSelect={onNavigate}
            onManageFilters={openFilterDialog}
          />
        </div>
        <ProjectFilterDialog
          open={isFilterDialogOpen}
          onOpenChange={setIsFilterDialogOpen}
          onAfterCloseAutoFocus={restoreFilterDialogFocus}
        />
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

function withSidebarPreferences<Props extends object>(Slot: ComponentType<Props>) {
  return function SidebarPreferencesSlot(props: Props) {
    return (
      <JotaiProvider store={sidebarPreferencesStore}>
        <Slot {...props} />
      </JotaiProvider>
    );
  };
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "quick-thread-search", component: withSidebarPreferences(QuickThreadSearch) });
  app.commands.register({ id: "quick-thread-search", title: "Найти тред по фильтру", run: requestQuickThreadSearch });
  app.slots.experimental_appOverlay({ id: "thread-reveal", component: withSidebarPreferences(ThreadReveal) });
  app.commands.register({
    id: "reveal-current-thread",
    title: "Показать текущий тред в дереве",
    defaultShortcut: { key: "l", mod: true, shift: true },
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ threadId }) => { if (threadId) requestThreadReveal(threadId); },
  });
  app.slots.experimental_threadAction({
    id: "reveal-thread",
    title: "Показать в дереве",
    icon: "ListTree",
    placement: "header",
    group: "navigation",
    item: ({ thread }) => ({ label: "Показать в дереве", icon: "ListTree", run: () => requestThreadReveal(thread.id) }),
  });
  app.slots.settingsSection({
    id: "project-first-sidebar-import",
    title: "Thread-list preferences import",
    component: ImportPreferences,
  });
  app.slots.settingsSection({
    id: "project-first-sidebar-filters",
    title: "Фильтры проектов",
    component: ProjectFilterEditor,
  });
  app.slots.settingsSection({
    id: "built-in-filter-visibility",
    title: "Встроенные фильтры",
    component: withSidebarPreferences(BuiltInFilterVisibilitySettings),
  });
  app.slots.settingsSection({ id: "execution-index", title: "Execution index", component: RebuildSettings });
  app.slots.experimental_threadList({
    id: "project-first-sidebar",
    title: "Project-first sidebar",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: withSidebarPreferences(ThreadList),
  });
  app.slots.experimental_threadAction(moveThreadAction);
});
