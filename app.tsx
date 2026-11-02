import { useCallback, useRef, useState } from "react";
import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ImportPreferences } from "./app/preferences/ImportPreferences.js";
import { PreferencesSync } from "./app/preferences/PreferencesSync.js";
import { ProjectList } from "./app/list/ProjectList.js";
import { ProjectFilterEditor } from "./app/filters/ProjectFilterEditor.js";
import { ProjectFilterDialog } from "./app/filters/ProjectFilterDialog.js";
import { useSidebarThreadReveal } from "./app/list/useSidebarThreadReveal.js";
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
        <ProjectList
          activeThreadId={activeThreadId}
          onProjectSelect={onNavigate}
          onManageFilters={openFilterDialog}
        />
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
  app.slots.experimental_threadList({
    id: "project-first-sidebar",
    title: "Project-first sidebar",
    description:
      "Pinned threads, custom sections, projects, machines, and nested threads.",
    component: ThreadList,
  });
  app.slots.experimental_threadAction(moveThreadAction);
});
