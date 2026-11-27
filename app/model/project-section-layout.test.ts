import { describe, expect, it } from "vitest";
import type { ProjectSectionAssignment } from "../../shared/project-section-assignment.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
} from "./fixtures.js";
import { compareByCreatedAtDescending, compareStandardThreads } from "./project-thread-groups.js";
import { layoutProjectSectionThreads } from "./project-section-layout.js";
import type { SidebarThread } from "./sidebar-thread.js";

function thread(id: string, overrides: Parameters<typeof makeSidebarThread>[0] = {}): SidebarThread {
  return makeSidebarThread({
    id,
    projectId: "proj_app",
    title: id,
    createdAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  });
}

function assignment(projectSectionId: string, projectId = "proj_app"): ProjectSectionAssignment {
  return { projectId, projectSectionId };
}

function place(
  threads: SidebarThread[],
  assignments: Record<string, ProjectSectionAssignment | null>,
  sections = [
    { id: "sec_alpha", name: "Alpha" },
    { id: "sec_beta", name: "Beta" },
  ],
  groupEnvironmentThreads = true,
) {
  return layoutProjectSectionThreads({
    assignments: new Map(Object.entries(assignments)),
    compareThreads: compareStandardThreads,
    groupEnvironmentThreads,
    projectId: "proj_app",
    sections,
    threads,
  });
}

function ids(items: ReturnType<typeof place>["looseItems"]): unknown[] {
  return items.map((item) => {
    if (item.kind === "thread") {
      return item.node.children.length === 0
        ? item.node.thread.id
        : { id: item.node.thread.id, children: ids(item.node.children) };
    }
    if (item.kind === "environment") {
      return { env: item.group.environmentId, threads: ids(item.group.nodes.map((node) => ({ kind: "thread" as const, node }))) };
    }
    return { section: item.group.name };
  });
}

describe("project section placement", () => {
  it("shows an assigned root once with its children and ignores the child's record", () => {
    const placed = place(
      [
        thread("thr_root", { createdAt: 10 }),
        thread("thr_child", { parentThreadId: "thr_root", createdAt: 20 }),
      ],
      {
        thr_root: assignment("sec_beta"),
        thr_child: assignment("sec_alpha"),
      },
    );
    expect(placed.sections.map((section) => [section.name, ids(section.items)])).toEqual([
      ["Alpha", []],
      ["Beta", [{ id: "thr_root", children: ["thr_child"] }]],
    ]);
    expect(ids(placed.looseItems)).toEqual([]);
  });

  it("leaves an inactive record in the loose list after a successful read", () => {
    const placed = place(
      [
        thread("thr_other", { createdAt: 10 }),
        thread("thr_deleted", { createdAt: 20 }),
        thread("thr_none", { createdAt: 30 }),
      ],
      {
        thr_other: assignment("sec_alpha", "proj_other"),
        thr_deleted: assignment("sec_gone"),
        thr_none: null,
      },
    );
    expect(ids(placed.looseItems)).toEqual(["thr_none", "thr_deleted", "thr_other"]);
    expect(placed.sections.every((section) => section.items.length === 0)).toBe(true);
  });

  it("keeps section headers in saved order ahead of the loose list", () => {
    const placed = layoutProjectSectionThreads({
      assignments: new Map([["thr_loose", null], ["thr_beta", assignment("sec_beta")]]),
      compareThreads: compareByCreatedAtDescending,
      groupEnvironmentThreads: false,
      projectId: "proj_app",
      sections: [
        { id: "sec_zeta", name: "Zeta" },
        { id: "sec_beta", name: "Beta" },
      ],
      threads: [
        thread("thr_loose", { title: "Aaa", createdAt: 50, sectionId: "sec_standard" }),
        thread("thr_beta", { title: "Zzz", createdAt: 10, sectionId: "sec_standard" }),
      ],
    });
    expect(placed.sections.map((section) => section.name)).toEqual(["Zeta", "Beta"]);
    expect(ids(placed.sections[1]?.items ?? [])).toEqual(["thr_beta"]);
    expect(ids(placed.looseItems)).toEqual(["thr_loose"]);
  });

  it("groups a linked worktree inside one section and leaves a single checkout alone", () => {
    const worktree = (id: string, createdAt: number, section: string | null) => thread(id, {
      createdAt,
      environment: makeSidebarEnvironment({ id: "env_linked", isWorktree: true, name: "linked" }),
      ...(section === null ? {} : {}),
    });
    const placed = place(
      [
        worktree("thr_a", 10, "sec_alpha"),
        worktree("thr_b", 20, "sec_alpha"),
        thread("thr_child", { parentThreadId: "thr_a", createdAt: 15 }),
        worktree("thr_c", 30, "sec_beta"),
        thread("thr_solo", {
          createdAt: 40,
          environment: makeSidebarEnvironment({ id: "env_solo", isWorktree: true }),
        }),
        thread("thr_checkout", {
          createdAt: 50,
          environment: makeSidebarEnvironment({ id: "env_checkout", isWorktree: false }),
        }),
        thread("thr_checkout_b", {
          createdAt: 60,
          environment: makeSidebarEnvironment({ id: "env_checkout", isWorktree: false }),
        }),
      ],
      {
        thr_a: assignment("sec_alpha"),
        thr_b: assignment("sec_alpha"),
        thr_c: assignment("sec_beta"),
        thr_child: assignment("sec_beta"),
        thr_solo: null,
        thr_checkout: null,
        thr_checkout_b: null,
      },
    );
    expect(ids(placed.sections[0]?.items ?? [])).toEqual([
      { env: "env_linked", threads: ["thr_b", { id: "thr_a", children: ["thr_child"] }] },
    ]);
    expect(ids(placed.sections[1]?.items ?? [])).toEqual(["thr_c"]);
    expect(ids(placed.looseItems)).toEqual(["thr_checkout_b", "thr_checkout", "thr_solo"]);
  });
});
