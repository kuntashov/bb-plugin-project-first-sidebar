import { useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { useAtomValue } from "jotai";
import { layoutVisibleProjectSections } from "../model/project-section-layout.js";
import {
  getProjectThreadItemDescendants,
  type ThreadComparator,
} from "../model/project-thread-groups.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { ProjectThreadTree } from "../list/ProjectRow.js";
import { sidebarGroupThreadsByEnvironmentAtom } from "../preferences/atoms.js";
import { useChronologicalSectionThreadDnd } from "../dnd/SectionThreadDndContext.js";
import { projectSectionCollapseKey, projectSectionLooseDropKey } from "../../shared/project-sections.js";
import { useAssignmentSnapshot } from "./assignment-store.js";
import { ProjectSectionList } from "./ProjectSectionRows.js";
import { useProjectSectionSnapshot } from "./ProjectSectionSync.js";
import type { ReactNode } from "react";

interface ProjectSectionPlacementProps {
  projectId: string;
  threads: readonly SidebarThread[];
  threadListStatus: "loading" | "ready" | "unavailable";
  compareThreads: ThreadComparator;
  selectedThreadId?: string;
  collapsedThreadIds: Set<string>;
  collapsedEnvironmentIds: Set<string>;
  onProjectSelect?: () => void;
  onToggleThreadCollapsed: (threadId: string) => void;
  onToggleEnvironmentCollapsed: (environmentId: string) => void;
}

function ProjectLooseDrop({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const sectionDnd = useChronologicalSectionThreadDnd();
  if (!sectionDnd) {
    return <div data-project-section-loose={projectId}>{children}</div>;
  }
  return (
    <ProjectLooseDroppable projectId={projectId}>{children}</ProjectLooseDroppable>
  );
}

function ProjectLooseDroppable({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: projectSectionLooseDropKey(projectId) });
  return (
    <div ref={setNodeRef} data-project-section-loose={projectId}>
      {children}
    </div>
  );
}

export function ProjectSectionPlacement({
  projectId,
  threads,
  threadListStatus,
  compareThreads,
  selectedThreadId,
  collapsedThreadIds,
  collapsedEnvironmentIds,
  onProjectSelect,
  onToggleThreadCollapsed,
  onToggleEnvironmentCollapsed,
}: ProjectSectionPlacementProps) {
  const sectionSnapshot = useProjectSectionSnapshot();
  const assignments = useAssignmentSnapshot();
  const sectionDnd = useChronologicalSectionThreadDnd();
  const groupEnvironmentThreads = useAtomValue(sidebarGroupThreadsByEnvironmentAtom);
  const document = sectionSnapshot.status === "ready" ? sectionSnapshot.document : null;
  const previewAssignments = sectionDnd?.projectSectionPreview?.assignments ?? null;
  const placement = useMemo(() => {
    if (threadListStatus !== "ready" || document === null) return null;
    const orderedIds = document.order.find((entry) => entry.projectId === projectId)?.sectionIds ?? [];
    const byId = new Map(
      document.sections
        .filter((section) => section.projectId === projectId)
        .map((section) => [section.id, section]),
    );
    const sections = orderedIds.flatMap((id) => {
      const section = byId.get(id);
      return section === undefined ? [] : [{ id: section.id, name: section.name }];
    });
    return layoutVisibleProjectSections({
      assignmentReads: assignments.reads,
      compareThreads,
      groupEnvironmentThreads,
      preview: previewAssignments,
      projectId,
      sections,
      threads,
    });
  }, [
    assignments.reads,
    compareThreads,
    document,
    groupEnvironmentThreads,
    previewAssignments,
    projectId,
    threadListStatus,
    threads,
  ]);
  const layout = placement !== null && placement.blocked === null ? placement.layout : null;
  const treeProps = {
    projectId,
    threadListState: { status: threadListStatus, threads: [...threads] },
    compareThreads,
    selectedThreadId,
    collapsedThreadIds,
    collapsedEnvironmentIds,
    onProjectSelect,
    onToggleThreadCollapsed,
    onToggleEnvironmentCollapsed,
  };
  if (threadListStatus !== "ready") {
    return (
      <>
        <ProjectSectionList projectId={projectId} />
        <ProjectThreadTree {...treeProps} />
      </>
    );
  }
  if (document === null) {
    const status = sectionSnapshot.status === "error" ? "error" : "loading";
    return (
      <>
        <ProjectSectionList projectId={projectId} />
        <div data-project-thread-placement={status} />
      </>
    );
  }
  if (threads.length === 0) {
    return (
      <>
        <ProjectSectionList projectId={projectId} />
        <ProjectThreadTree {...treeProps} rootItems={[]} />
      </>
    );
  }
  if (placement?.blocked) {
    return (
      <>
        <ProjectSectionList projectId={projectId} />
        <div data-project-thread-placement={placement.blocked} />
      </>
    );
  }
  if (layout === null || layout === undefined) return null;
  return (
    <>
      <ProjectSectionList
        projectId={projectId}
        sectionThreads={(section) => getProjectThreadItemDescendants(
          layout.sections.find((item) => item.id === section.id)?.items ?? [],
        )}
        renderSectionBody={(section) => {
          const items = layout.sections.find((item) => item.id === section.id)?.items ?? [];
          if (items.length === 0) return null;
          return (
            <ProjectThreadTree
              {...treeProps}
              dndParentKey={projectSectionCollapseKey(projectId, section.id)}
              depthOffset={1}
              rootItems={items}
            />
          );
        }}
      />
      <ProjectLooseDrop projectId={projectId}>
        {layout.looseItems.length > 0 ? (
          <ProjectThreadTree
            {...treeProps}
            dndParentKey={projectSectionLooseDropKey(projectId)}
            rootItems={layout.looseItems}
          />
        ) : null}
      </ProjectLooseDrop>
    </>
  );
}
