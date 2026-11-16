import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { PreferenceValues } from "../../shared/preferences.js";
import { NO_MACHINE_GROUP_KEY } from "../model/machine-thread-groups.js";

export type RevealThread = Pick<PluginSidebarThread,
  "id" | "projectId" | "parentThreadId" | "sectionId" | "isPinned" | "isArchived" | "isHidden"
> & { environment: { id: string | null } | null; host: { id: string } | null };

export function planThreadReveal(
  chain: readonly RevealThread[],
  preferences: Pick<PreferenceValues, "organizationMode" | "threadLifecycles" | "hiddenGroups">,
  personalProjectId: string | null,
) {
  const target = chain[0];
  const root = chain.at(-1);
  if (!target || !root) throw new Error("Не удалось определить тред.");
  const pinned = chain.some((thread) => thread.isPinned);
  const groupId = pinned ? null
    : preferences.organizationMode === "machine" ? `machine:${target.host?.id ?? NO_MACHINE_GROUP_KEY}`
    : preferences.organizationMode === "project" && root.projectId !== personalProjectId ? `project:${root.projectId}`
    : preferences.organizationMode === "chronological" && root.sectionId ? `section:${root.sectionId}`
    : "threads";
  const lifecycle: "active" | "archived" = target.isArchived ? "archived" : "active";
  const missingLifecycle = preferences.threadLifecycles.includes(lifecycle) ? null : lifecycle;
  const hiddenGroupId = groupId && preferences.hiddenGroups.includes(groupId) ? groupId : null;
  const hiddenThreadIds = chain.filter((thread) => thread.isHidden).map((thread) => thread.id);
  const reasons = [
    ...(missingLifecycle === "archived" ? ["Тред находится в архиве. Будет включён показ архивных тредов; тред останется архивированным."] : []),
    ...(missingLifecycle === "active" ? ["В списке показан только архив. Будет включён показ активных тредов."] : []),
    ...(hiddenGroupId ? ["Группа скрыта в сайдбаре. Она будет добавлена в видимый список."] : []),
    ...(hiddenThreadIds.length ? ["Тред или его предки имеют статус «скрытый». Для показа их статус будет изменён на «видимый»."] : []),
  ];
  return { projectId: root.projectId, groupId, missingLifecycle, hiddenGroupId, hiddenThreadIds, reasons };
}
