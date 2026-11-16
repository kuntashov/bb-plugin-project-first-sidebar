import type { ProjectSectionAssignment } from "../../shared/project-section-assignment.js";
import {
  projectSectionCollapseKey,
  projectSectionLooseDropKey,
} from "../../shared/project-sections.js";
import {
  arrangeProjectThreadRoots,
  buildProjectThreadRootNodes,
  getProjectThreadItemDescendants,
  type ProjectThreadItem,
  type ProjectThreadNode,
  type ThreadComparator,
} from "./project-thread-groups.js";
import type { SidebarThread } from "./sidebar-thread.js";
import { getCollapsedChildActivity } from "./thread-activity.js";

export interface ProjectSectionPlacementSection {
  id: string;
  name: string;
  items: ProjectThreadItem[];
}

export interface ProjectSectionPlacement {
  sections: ProjectSectionPlacementSection[];
  looseItems: ProjectThreadItem[];
}

export interface ProjectSectionLayoutDefinition {
  id: string;
  name: string;
}

export interface ProjectSectionAssignmentRead {
  status: "loading" | "error" | "ready";
  assignment: ProjectSectionAssignment | null;
}

export function shownProjectSectionId(
  projectId: string,
  knownSectionIds: ReadonlySet<string>,
  assignment: ProjectSectionAssignment | null,
): string | null {
  if (assignment === null) return null;
  if (assignment.projectId !== projectId) return null;
  if (!knownSectionIds.has(assignment.projectSectionId)) return null;
  return assignment.projectSectionId;
}

function threadIdsUnder(node: ProjectThreadNode): string[] {
  return [node.thread.id, ...getProjectThreadItemDescendants(node.children).map((thread) => thread.id)];
}

function readBlocksPlacement(
  roots: readonly { thread: { id: string } }[],
  reads: ReadonlyMap<string, ProjectSectionAssignmentRead>,
): "loading" | "error" | null {
  let error = false;
  for (const root of roots) {
    const read = reads.get(root.thread.id);
    if (read === undefined || read.status === "loading") return "loading";
    if (read.status === "error") error = true;
  }
  return error ? "error" : null;
}

export function layoutVisibleProjectSections({
  assignmentReads,
  compareThreads,
  groupEnvironmentThreads,
  preview,
  projectId,
  sections,
  threads,
}: {
  assignmentReads: ReadonlyMap<string, ProjectSectionAssignmentRead>;
  compareThreads: ThreadComparator;
  groupEnvironmentThreads: boolean;
  preview?: ReadonlyMap<string, string | null> | null;
  projectId: string;
  sections: readonly ProjectSectionLayoutDefinition[];
  threads: readonly SidebarThread[];
}): { blocked: "loading" | "error" | null; layout: ProjectSectionPlacement | null } {
  const roots = buildProjectThreadRootNodes(threads, compareThreads, groupEnvironmentThreads);
  const readyRoots = roots.filter((root) => assignmentReads.get(root.thread.id)?.status === "ready");
  if (roots.length > 0 && readyRoots.length === 0) {
    return { blocked: readBlocksPlacement(roots, assignmentReads) ?? "loading", layout: null };
  }
  const shownIds = new Set(readyRoots.flatMap(threadIdsUnder));
  const shownThreads = roots.length === 0 ? threads : threads.filter((thread) => shownIds.has(thread.id));
  const assignments = new Map<string, ProjectSectionAssignment | null>(
    readyRoots.map((root) => [root.thread.id, assignmentReads.get(root.thread.id)?.assignment ?? null]),
  );
  if (preview) {
    for (const [threadId, sectionId] of preview) {
      if (!assignments.has(threadId)) continue;
      assignments.set(
        threadId,
        sectionId === null ? null : { projectId, projectSectionId: sectionId },
      );
    }
  }
  return {
    blocked: null,
    layout: layoutProjectSectionThreads({
      assignments,
      compareThreads,
      groupEnvironmentThreads,
      projectId,
      sections,
      threads: shownThreads,
    }),
  };
}

export function buildProjectSectionDndItems(
  projectId: string,
  layout: ProjectSectionPlacement,
): ProjectThreadItem[] {
  const sectionItems = layout.sections.map((section) => {
    const sectionThreads = getProjectThreadItemDescendants(section.items);
    return {
      kind: "section" as const,
      group: {
        id: section.id,
        key: projectSectionCollapseKey(projectId, section.id),
        name: section.name,
        items: section.items,
        threadCount: sectionThreads.length,
        activity: getCollapsedChildActivity(sectionThreads),
      },
    };
  });
  const looseThreads = getProjectThreadItemDescendants(layout.looseItems);
  return [
    ...sectionItems,
    {
      kind: "section" as const,
      group: {
        id: `loose:${projectId}`,
        key: projectSectionLooseDropKey(projectId),
        name: "",
        items: layout.looseItems,
        threadCount: looseThreads.length,
        activity: getCollapsedChildActivity(looseThreads),
      },
    },
  ];
}

function activeSectionId(
  node: ProjectThreadNode,
  projectId: string,
  knownSectionIds: ReadonlySet<string>,
  assignments: ReadonlyMap<string, ProjectSectionAssignment | null>,
): string | null {
  const assignment = assignments.get(node.thread.id) ?? null;
  if (assignment === null) return null;
  if (assignment.projectId !== projectId) return null;
  if (!knownSectionIds.has(assignment.projectSectionId)) return null;
  return assignment.projectSectionId;
}

export function layoutProjectSectionThreads({
  assignments,
  compareThreads,
  groupEnvironmentThreads,
  projectId,
  sections,
  threads,
}: {
  assignments: ReadonlyMap<string, ProjectSectionAssignment | null>;
  compareThreads: ThreadComparator;
  groupEnvironmentThreads: boolean;
  projectId: string;
  sections: readonly ProjectSectionLayoutDefinition[];
  threads: readonly SidebarThread[];
}): ProjectSectionPlacement {
  const roots = buildProjectThreadRootNodes(
    threads,
    compareThreads,
    groupEnvironmentThreads,
  );
  const knownSectionIds = new Set(sections.map((section) => section.id));
  const nodesBySectionId = new Map<string, ProjectThreadNode[]>(
    sections.map((section) => [section.id, []]),
  );
  const looseNodes: ProjectThreadNode[] = [];
  for (const node of roots) {
    const sectionId = activeSectionId(node, projectId, knownSectionIds, assignments);
    if (sectionId === null) {
      looseNodes.push(node);
      continue;
    }
    nodesBySectionId.get(sectionId)?.push(node);
  }
  return {
    sections: sections.map((section) => ({
      id: section.id,
      name: section.name,
      items: arrangeProjectThreadRoots(
        nodesBySectionId.get(section.id) ?? [],
        compareThreads,
        groupEnvironmentThreads,
      ),
    })),
    looseItems: arrangeProjectThreadRoots(
      looseNodes,
      compareThreads,
      groupEnvironmentThreads,
    ),
  };
}

export function projectSectionRootIds(items: readonly ProjectThreadItem[]): string[] {
  return items.flatMap((item) => {
    switch (item.kind) {
      case "thread":
        return [item.node.thread.id];
      case "environment":
        return item.group.nodes.map((node) => node.thread.id);
      case "section":
        return projectSectionRootIds(item.group.items);
    }
  });
}
