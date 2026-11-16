import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { SearchThread } from "./search-model.js";

export const entry = (overrides: Partial<SearchThread> = {}) => ({
  ...makeThreadResponse({ id: "t", projectId: "app" }),
  environmentBranchName: null, environmentHostId: null, environmentName: null, environmentPath: null,
  environmentProviderId: null, environmentIsWorktree: null, environmentWorkspaceDisplayKind: "other" as const,
  hasPendingInteraction: false, activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  runtime: { displayStatus: "idle" as const }, queuedWork: "none" as const, pinSortKey: null,
  ...overrides,
});

export function uiPreferences(provider: string) {
  return { preferences: {
    "sidebar.organizationMode": { revision: 0, value: "project" as const },
    "sidebar.threadGrouping.environment": { revision: 0, value: "auto" as const },
    "sidebar.chronologicalSort": { revision: 0, value: "updated" as const },
    "sidebar.sortDirection": { revision: 0, value: "default" as const },
    "sidebar.sectionOrder": { revision: 0, value: [] },
    "sidebar.manualSectionOrder": { revision: 0, value: [] },
    "sidebar.machineSectionOrder": { revision: 0, value: [] },
    "sidebar.hiddenGroups": { revision: 0, value: [] },
    "sidebar.footerOrder": { revision: 0, value: [] },
    "sidebar.hiddenFooterItems": { revision: 0, value: [] },
    "sidebar.pluginPanelOrder": { revision: 0, value: [] },
    "sidebar.visiblePluginPanels": { revision: 0, value: null },
    "sidebar.navigationProvider": { revision: 0, value: "__automatic__" },
    "sidebar.threadListProvider": { revision: 0, value: provider },
    "composer.provider": { revision: 0, value: "__automatic__" },
    "infoPanel.collapsedSections": { revision: 0, value: [] },
    "threadContextCard.pinned": { revision: 0, value: false },
  } };
}
