import { useAtomValue } from "jotai";
import { toast } from "sonner";
import {
  experimental_THREAD_ACTION_GROUPS,
  useRpc,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { PROJECT_SECTION_LOOSE_CHOICE } from "../../shared/project-section-assignment.js";
import {
  projectSectionAssignmentStore,
  useAssignmentSnapshot,
} from "../project-sections/assignment-store.js";
import { useProjectSectionSnapshot } from "../project-sections/ProjectSectionSync.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";
import { usePreferencesSync } from "../preferences/PreferencesSync.js";

interface AssignmentMenuSection {
  id: string;
  name: string;
}

interface AssignmentMenuData {
  mode: string;
  rpc: ReturnType<typeof useRpc<typeof projectFirstSidebarRpcContract>>;
  sectionsByProject: ReadonlyMap<string, readonly AssignmentMenuSection[]>;
  roots: ReturnType<typeof useAssignmentSnapshot>["roots"];
}

function sectionsForProject(
  document: { sections: readonly { id: string; projectId: string; name: string }[]; order: readonly { projectId: string; sectionIds: readonly string[] }[] } | null,
): Map<string, AssignmentMenuSection[]> {
  const sections = new Map<string, AssignmentMenuSection[]>();
  if (document === null) return sections;
  const byId = new Map(document.sections.map((section) => [section.id, section]));
  for (const entry of document.order) {
    sections.set(entry.projectId, entry.sectionIds.flatMap((id) => {
      const section = byId.get(id);
      return section === undefined || section.projectId !== entry.projectId ? [] : [{ id: section.id, name: section.name }];
    }));
  }
  return sections;
}

function useAssignmentMenuData(): AssignmentMenuData {
  usePreferencesSync();
  const mode = useAtomValue(sidebarOrganizationModeAtom);
  const snapshot = useProjectSectionSnapshot();
  const assignments = useAssignmentSnapshot();
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const document = snapshot.status === "ready" ? snapshot.document : null;
  return {
    mode,
    rpc,
    sectionsByProject: sectionsForProject(document),
    roots: assignments.roots,
  };
}

export const assignProjectSectionAction: PluginThreadActionRegistration<AssignmentMenuData> = {
  id: "project-section",
  title: "Секция проекта",
  icon: "SectionMove",
  group: experimental_THREAD_ACTION_GROUPS.organize,
  order: 60,
  useData: useAssignmentMenuData,
  item: ({ thread, data }) => {
    if (data.mode !== "project") return null;
    const root = data.roots.get(thread.id);
    if (root === undefined) return null;
    const sections = data.sectionsByProject.get(root.projectId) ?? [];
    const current = root.shownSectionId;
    const choices = [
      ...sections.map((section) => ({
        id: section.id,
        label: section.name,
        selected: section.id === current,
        disabled: section.id === current,
      })),
      {
        id: PROJECT_SECTION_LOOSE_CHOICE,
        label: "Без секции",
        selected: current === null,
        disabled: current === null,
      },
    ];
    return {
      label: "Секция проекта",
      icon: "SectionMove" as const,
      choices: { items: choices },
      run: ({ value }) => {
        if (typeof value !== "string") return;
        if (value === current || (value === PROJECT_SECTION_LOOSE_CHOICE && current === null)) return;
        const finish = (result: { status: string }) => {
          if (result.status === "success") {
            projectSectionAssignmentStore.invalidate([thread.id]);
            return;
          }
          toast.error("Не удалось изменить секцию проекта");
        };
        if (value === PROJECT_SECTION_LOOSE_CHOICE) {
          void data.rpc.call("clearProjectSectionAssignment", { threadId: thread.id }).then(finish, () => {
            toast.error("Не удалось изменить секцию проекта");
          });
          return;
        }
        void data.rpc.call("assignProjectSection", {
          threadId: thread.id,
          projectId: root.projectId,
          projectSectionId: value,
        }).then(finish, () => {
          toast.error("Не удалось изменить секцию проекта");
        });
      },
    };
  },
};
