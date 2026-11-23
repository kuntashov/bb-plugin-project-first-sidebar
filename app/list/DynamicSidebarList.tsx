import { useMemo } from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { DYNAMIC_FILTERS, type DynamicFilterId } from "../filters/dynamic-filter-ids.js";
import type { DynamicSidebarProjection } from "../model/dynamic-sidebar-projection.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { useDynamicSidebar } from "../model/use-dynamic-sidebar.js";
import { useSidebarRenameState } from "../rows/SidebarInlineRename.js";
import { ThreadRow, type ThreadRowOptions } from "../rows/ThreadRow.js";
import { SidebarMenuSkeleton } from "../ui/sidebar.js";
import { SidebarWindowedItems } from "./SidebarWindowedItems.js";

type DynamicSidebarItem =
  | { kind: "heading"; key: string; name: string }
  | { kind: "thread"; key: string; projectId: string; thread: SidebarThread };

function threadItemKey(threadId: string): string {
  return `thread:${threadId}`;
}

function buildItems(projection: DynamicSidebarProjection | null): DynamicSidebarItem[] {
  const items: DynamicSidebarItem[] = [];
  for (const { project, threads } of projection?.groups ?? []) {
    items.push({
      kind: "heading",
      key: `project:${project.id}`,
      name: project.isPersonal ? "Без проектов" : project.name,
    });
    for (const thread of threads) {
      items.push({ kind: "thread", key: threadItemKey(thread.id), projectId: project.id, thread });
    }
  }
  return items;
}

export function DynamicSidebarList({ filterId, activeThreadId, onProjectSelect }: {
  filterId: DynamicFilterId;
  activeThreadId?: string | null;
  onProjectSelect?: () => void;
}) {
  const { status, projection } = useDynamicSidebar(filterId);
  const rename = useSidebarRenameState();
  const renamingThreadId = rename?.kind === "thread" ? rename.id : null;
  const isCompact = useIsCompactViewport();
  const options = useMemo<ThreadRowOptions>(() => ({ kind: "default", depth: 0, isCompact }), [isCompact]);
  const items = useMemo(() => buildItems(projection), [projection]);
  const itemKeys = useMemo(() => items.map((item) => item.key), [items]);
  const alwaysMountedKeys = useMemo(
    () => renamingThreadId === null ? undefined : new Set([threadItemKey(renamingThreadId)]),
    [renamingThreadId],
  );
  const filter = DYNAMIC_FILTERS[filterId];

  return (
    <div data-sidebar-dynamic-filter={filter.key} className="min-w-0 px-2">
      {status === "loading" ? (
        <div aria-label="Загрузка тредов" role="status">
          <SidebarMenuSkeleton />
          <SidebarMenuSkeleton />
        </div>
      ) : status === "error" ? (
        <p className="p-2 text-sm text-muted-foreground" role="alert">Не удалось загрузить активные треды</p>
      ) : items.length === 0 ? (
        <p className="p-2 text-sm text-muted-foreground" role="status">{filter.emptyMessage}</p>
      ) : (
        <SidebarWindowedItems
          itemKeys={itemKeys}
          alwaysMountedKeys={alwaysMountedKeys}
          estimateRows={() => 1}
          getNavigationEntries={(index) => {
            const item = items[index]!;
            return item.kind === "thread" ? [{ threadId: item.thread.id, projectId: item.thread.projectId }] : [];
          }}
          renderItem={(index) => {
            const item = items[index]!;
            if (item.kind === "heading") {
              return <h2 className="flex h-7 items-center truncate px-1 text-xs font-medium text-sidebar-foreground/75">{item.name}</h2>;
            }
            const { thread, projectId } = item;
            return (
              <ThreadRow
                thread={thread}
                crossProjectId={thread.projectId === projectId ? null : thread.projectId}
                isActive={activeThreadId === thread.id}
                onProjectSelect={onProjectSelect}
                options={options}
              />
            );
          }}
        />
      )}
    </div>
  );
}
