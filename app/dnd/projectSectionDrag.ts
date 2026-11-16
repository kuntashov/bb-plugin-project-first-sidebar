import { reorderStoredOrder } from "../model/stored-order.js";
import { parseProjectSectionDropKey } from "../../shared/project-sections.js";
import type { SidebarThread } from "../model/sidebar-thread.js";

export interface ProjectSectionDropTarget {
  projectId: string;
  sectionId: string | null;
}

export interface ProjectSectionAssignmentDecision {
  kind: "assign-project-section";
  activeId: string;
  toParentKey: string;
  projectId: string;
  projectSectionId: string | null;
  threadIds: string[];
}

export interface ProjectSectionRejection {
  kind: "rejected-project-section";
  activeId: string;
  reason: "other-project" | "descendant";
}

export function projectIdFromSectionParent(key: string): string | null {
  const parsed = parseProjectSectionDropKey(key);
  if (parsed) return parsed.projectId;
  if (key.startsWith("project:")) return key.slice("project:".length);
  return null;
}

export function resolveProjectSectionAssignment(args: {
  activeId: string;
  fromParentKey: string;
  nestedThreadIds: { has(threadId: string): boolean };
  shownSectionByThreadId: ReadonlyMap<string, string | null>;
  target: ProjectSectionDropTarget;
  threads: readonly SidebarThread[];
  toParentKey: string;
}): ProjectSectionAssignmentDecision | ProjectSectionRejection | { kind: "unchanged"; activeId: string; toParentKey: string } | null {
  if (args.threads.some((thread) => thread.pinnedAt !== null)) return null;
  const sourceProject = projectIdFromSectionParent(args.fromParentKey);
  if (sourceProject === null || sourceProject !== args.target.projectId) {
    return { kind: "rejected-project-section", activeId: args.activeId, reason: "other-project" };
  }
  if (args.threads.some((thread) => args.nestedThreadIds.has(thread.id))) {
    return { kind: "rejected-project-section", activeId: args.activeId, reason: "descendant" };
  }
  const changing = args.threads
    .map((thread) => thread.id)
    .filter((threadId) => {
      if (!args.shownSectionByThreadId.has(threadId)) return false;
      return args.shownSectionByThreadId.get(threadId) !== args.target.sectionId;
    });
  if (changing.length === 0) {
    return { kind: "unchanged", activeId: args.activeId, toParentKey: args.toParentKey };
  }
  return {
    kind: "assign-project-section",
    activeId: args.activeId,
    toParentKey: args.toParentKey,
    projectId: args.target.projectId,
    projectSectionId: args.target.sectionId,
    threadIds: changing,
  };
}

export function assembleProjectSectionReorder(args: {
  activeSectionId: string;
  overSectionId: string;
  projectId: string;
  storedSectionIds: readonly string[];
  visibleSectionIds: readonly string[];
}): string[] | null {
  if (args.visibleSectionIds.length === 0) return null;
  return reorderStoredOrder({
    order: args.storedSectionIds,
    visibleIds: args.visibleSectionIds,
    activeId: args.activeSectionId,
    overId: args.overSectionId,
  });
}

export function sameProjectSectionHeader(
  activeId: string,
  overId: string | null,
): { projectId: string; activeSectionId: string; overSectionId: string } | null {
  const active = parseProjectSectionDropKey(activeId);
  const over = overId === null ? null : parseProjectSectionDropKey(overId);
  if (!active?.sectionId || !over?.sectionId || active.projectId !== over.projectId) return null;
  return {
    projectId: active.projectId,
    activeSectionId: active.sectionId,
    overSectionId: over.sectionId,
  };
}
