import { useCallback, useRef, useState } from "react";
import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImportPreferences } from "./app/preferences/ImportPreferences.js";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { ProjectSectionSync } from "./app/project-sections/ProjectSectionSync.js";
import { ProjectFilterEditor } from "./app/filters/ProjectFilterEditor.js";
import { ProjectFilterDialog } from "./app/filters/ProjectFilterDialog.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
import { ThreadReveal, requestThreadReveal } from "./app/reveal/ThreadReveal.js";
import { QuickThreadSearch, requestQuickThreadSearch } from "./app/search/QuickThreadSearch.js";
import { assignProjectSectionAction } from "./app/rows/assignProjectSectionAction.js";
import { moveThreadAction } from "./app/rows/moveThreadAction.js";

function ProjectSidebarReveal() {
  useSidebarThreadReveal();
  return null;
}

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
  return (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      <TooltipProvider>
        <PreferencesSync />
        <ProjectSectionSync>
          <div data-project-first-sidebar="" className="contents">
            <ProjectList
              activeThreadId={activeThreadId}
              onProjectSelect={onNavigate}
              onManageFilters={openFilterDialog}
              onQuickSearch={requestQuickThreadSearch}
            />
          </div>
          <ProjectSidebarReveal />
        </ProjectSectionSync>
        <ProjectFilterDialog
          open={isFilterDialogOpen}
          onOpenChange={setIsFilterDialogOpen}
          onAfterCloseAutoFocus={restoreFilterDialogFocus}
        />
      </TooltipProvider>
    </CompactViewportOverrideProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "quick-thread-search", component: QuickThreadSearch });
  app.commands.register({ id: "quick-thread-search", title: "Найти тред по фильтру", run: requestQuickThreadSearch });
  app.slots.experimental_appOverlay({ id: "thread-reveal", component: ThreadReveal });
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
    component: () => <ProjectFilterEditor />,
  });
  app.slots.experimental_threadList({
    id: "project-first-sidebar",
    title: "Project-first sidebar",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: ThreadList,
  });
  app.slots.experimental_threadAction(moveThreadAction);
  app.slots.experimental_threadAction(assignProjectSectionAction);
});
