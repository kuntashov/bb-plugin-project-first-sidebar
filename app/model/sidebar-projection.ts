import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { FilterDocumentV1 } from "../../shared/filters.js";
import { ALL_FILTER_ID, PROJECTLESS_FILTER_ID } from "../filters/filter-store.js";
import {
  buildPinnedSidebarState,
  type PinnedSidebarState,
} from "./pinned-sidebar-threads.js";
import { createSidebarProjectIdResolver } from "./project-thread-groups.js";

export interface FullSidebarSnapshot {
  projects: readonly PluginSidebarProject[];
  threads: readonly PluginSidebarThread[];
}

export interface SidebarProjectionInput {
  activeFilterId: string;
  document: FilterDocumentV1 | null;
  snapshot: FullSidebarSnapshot;
}

export interface ProjectedSidebarData {
  full: {
    projects: readonly PluginSidebarProject[];
    ordinaryProjects: readonly PluginSidebarProject[];
    threads: readonly PluginSidebarThread[];
    threadById: ReadonlyMap<string, PluginSidebarThread>;
    effectiveProjectIdByThreadId: ReadonlyMap<string, string>;
    effectivePinnedThreadIds: ReadonlySet<string>;
    pinned: PinnedSidebarState;
  };
  visible: {
    projects: readonly PluginSidebarProject[];
    threads: readonly PluginSidebarThread[];
    threadIds: ReadonlySet<string>;
    pinned: PinnedSidebarState;
  };
  projectionKey: string;
}

export function matchesProjectNameGlob(name: string, glob: string): boolean {
  const nameCodePoints = Array.from(name.toLowerCase());
  const globCodePoints = Array.from(glob.toLowerCase());
  let previous = new Array<boolean>(nameCodePoints.length + 1).fill(false);
  previous[0] = true;

  for (const token of globCodePoints) {
    const current = new Array<boolean>(nameCodePoints.length + 1).fill(false);
    if (token === "*") current[0] = previous[0]!;
    for (let index = 1; index <= nameCodePoints.length; index += 1) {
      current[index] =
        token === "*"
          ? previous[index]! || current[index - 1]!
          : previous[index - 1]!
            && (token === "?" || token === nameCodePoints[index - 1]);
    }
    previous = current;
  }

  return previous[nameCodePoints.length]!;
}

function selectedProjectIds({
  activeFilterId,
  document,
  projects,
}: {
  activeFilterId: string;
  document: FilterDocumentV1 | null;
  projects: readonly PluginSidebarProject[];
}): Set<string> {
  if (activeFilterId === ALL_FILTER_ID) {
    return new Set(projects.map((project) => project.id));
  }
  if (activeFilterId === PROJECTLESS_FILTER_ID) {
    return new Set(
      projects
        .filter((project) => project.isPersonal)
        .map((project) => project.id),
    );
  }
  const definition = document?.filters.find(
    (filter) => filter.id === activeFilterId,
  );
  const personalProjectIds = new Set(
    projects
      .filter((project) => project.isPersonal)
      .map((project) => project.id),
  );
  if (definition?.rule.kind === "projectIds") {
    return new Set(
      definition.rule.projectIds.filter((id) => !personalProjectIds.has(id)),
    );
  }
  if (definition?.rule.kind === "nameGlobs") {
    const globs = definition.rule.globs.filter((glob) => glob !== "");
    return new Set(
      projects
        .filter(
          (project) =>
            !project.isPersonal &&
            globs.some((glob) => matchesProjectNameGlob(project.name, glob)),
        )
        .map((project) => project.id),
    );
  }
  return new Set();
}

function structuralThreadKey(thread: PluginSidebarThread): readonly unknown[] {
  return [
    thread.id,
    thread.projectId,
    thread.parentThreadId,
    thread.sectionId,
    thread.host?.id ?? null,
    thread.host?.name ?? null,
    thread.environment?.id ?? null,
    thread.environment?.name ?? null,
    thread.environment?.branchName ?? null,
    thread.environment?.isWorktree ?? null,
    thread.isHidden,
    thread.isArchived,
    thread.archivedAt,
    thread.pinnedAt,
    thread.pinSortKey,
    thread.createdAt,
    thread.updatedAt,
    thread.lastReadAt,
    thread.latestAttentionAt,
    thread.displayTitle,
  ];
}

export function projectSidebarSnapshot({
  activeFilterId,
  document,
  snapshot,
}: SidebarProjectionInput): ProjectedSidebarData {
  const threadById = new Map(
    snapshot.threads.map((thread) => [thread.id, thread]),
  );
  const resolveProjectId = createSidebarProjectIdResolver(threadById);
  const projectIds = selectedProjectIds({
    activeFilterId,
    document,
    projects: snapshot.projects,
  });
  const fullPinned = buildPinnedSidebarState({ threads: snapshot.threads });
  const effectiveProjectIdByThreadId = new Map(
    snapshot.threads.map((thread) => [thread.id, resolveProjectId(thread)]),
  );
  const alwaysShowPinned = document?.pinnedMode === "always-show";
  const visibleThreads = snapshot.threads.filter(
    (thread) =>
      activeFilterId === ALL_FILTER_ID ||
      projectIds.has(effectiveProjectIdByThreadId.get(thread.id)!) ||
      (alwaysShowPinned && fullPinned.effectivePinnedThreadIds.has(thread.id)),
  );
  const visibleThreadIds = new Set(visibleThreads.map((thread) => thread.id));
  const visibleProjects = snapshot.projects.filter(
    (project) =>
      projectIds.has(project.id) &&
      (activeFilterId === ALL_FILTER_ID ||
        activeFilterId === PROJECTLESS_FILTER_ID ||
        !project.isPersonal),
  );
  const visiblePinned = buildPinnedSidebarState({ threads: visibleThreads });

  return {
    full: {
      projects: snapshot.projects,
      ordinaryProjects: snapshot.projects.filter(
        (project) => !project.isPersonal,
      ),
      threads: snapshot.threads,
      threadById,
      effectiveProjectIdByThreadId,
      effectivePinnedThreadIds: fullPinned.effectivePinnedThreadIds,
      pinned: fullPinned,
    },
    visible: {
      projects: visibleProjects,
      threads: visibleThreads,
      threadIds: visibleThreadIds,
      pinned: visiblePinned,
    },
    projectionKey: JSON.stringify([
      activeFilterId,
      document?.revision ?? -1,
      document?.pinnedMode ?? "filter",
      snapshot.projects.map((project) => [
        project.id,
        project.name,
        project.isPersonal,
      ]),
      snapshot.threads.map(structuralThreadKey),
      visibleProjects.map((project) => project.id),
      visibleThreads.map((thread) => thread.id),
    ]),
  };
}
