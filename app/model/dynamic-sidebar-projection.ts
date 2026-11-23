import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { UNREAD_FILTER_ID, type DynamicFilterId } from "../filters/dynamic-filter-ids.js";
import { compareStandardThreads, createSidebarProjectIdResolver } from "./project-thread-groups.js";
import type { FullSidebarSnapshot } from "./sidebar-projection.js";
import type { SidebarThread } from "./sidebar-thread.js";

interface DynamicSidebarGroup {
  project: PluginSidebarProject;
  threads: readonly SidebarThread[];
}

export interface DynamicSidebarProjection {
  groups: readonly DynamicSidebarGroup[];
  threadIds: ReadonlySet<string>;
}

export function projectDynamicSidebar(
  { projects, threads }: FullSidebarSnapshot,
  filterId: DynamicFilterId,
): DynamicSidebarProjection {
  const threadById = new Map(
    threads.filter((thread) => !thread.isArchived).map((thread) => [thread.id, thread]),
  );
  const resolveProjectId = createSidebarProjectIdResolver(threadById);
  const threadsByProjectId = new Map<string, SidebarThread[]>(
    projects.map((project) => [project.id, []]),
  );
  for (const thread of threadById.values()) {
    const projectId = resolveProjectId(thread);
    if (thread.isHidden) continue;
    const matches = filterId === UNREAD_FILTER_ID
      ? thread.isUnread === true
      : thread.hasPendingInteraction === true;
    if (matches) threadsByProjectId.get(projectId)?.push(thread);
  }

  const groups: DynamicSidebarGroup[] = [];
  const threadIds = new Set<string>();
  for (const project of projects) {
    const threads = threadsByProjectId.get(project.id);
    if (!threads?.length) continue;
    threads.sort(compareStandardThreads);
    groups.push({ project, threads });
    for (const thread of threads) threadIds.add(thread.id);
  }
  return { groups, threadIds };
}
