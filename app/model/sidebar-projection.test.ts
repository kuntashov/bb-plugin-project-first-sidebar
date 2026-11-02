import { describe, expect, it } from "vitest";
import { defaultFilterDocument } from "../../shared/filters.js";
import { makePluginProject, makeSidebarThread } from "./fixtures.js";
import {
  matchesProjectNameGlob,
  projectSidebarSnapshot,
} from "./sidebar-projection.js";

function documentWith(
  rule: { kind: "projectIds"; projectIds: string[] } | { kind: "nameGlobs"; globs: string[] },
  pinnedMode: "filter" | "always-show" = "filter",
) {
  return {
    ...defaultFilterDocument(),
    revision: 7,
    pinnedMode,
    filters: [{ id: "custom", name: "Custom", rule }],
  };
}

describe("projectSidebarSnapshot", () => {
  it("filters by the effective project resolved from the full thread tree", () => {
    const parent = makeSidebarThread({ id: "parent-b", projectId: "B" });
    const rawAChild = makeSidebarThread({
      id: "raw-a-child",
      projectId: "A",
      parentThreadId: parent.id,
    });
    const rootA = makeSidebarThread({ id: "root-a", projectId: "A" });

    const projection = projectSidebarSnapshot({
      activeFilterId: "filter-a",
      document: {
        ...defaultFilterDocument(),
        revision: 7,
        filters: [
          {
            id: "filter-a",
            name: "A only",
            rule: { kind: "projectIds", projectIds: ["A"] },
          },
        ],
      },
      snapshot: {
        projects: [
          makePluginProject({ id: "A", name: "A" }),
          makePluginProject({ id: "B", name: "B" }),
        ],
        threads: [parent, rawAChild, rootA],
      },
    });

    expect(projection.full.threadById.get(rawAChild.id)).toBe(rawAChild);
    expect(projection.visible.projects.map((project) => project.id)).toEqual([
      "A",
    ]);
    expect(projection.visible.threads.map((thread) => thread.id)).toEqual([
      "root-a",
    ]);
  });

  it("re-resolves a child when its previously missing parent is loaded", () => {
    const child = makeSidebarThread({
      id: "child",
      projectId: "A",
      parentThreadId: "parent",
    });
    const input = {
      activeFilterId: "custom",
      document: documentWith({ kind: "projectIds", projectIds: ["A"] }),
      snapshot: {
        projects: [
          makePluginProject({ id: "A", name: "A" }),
          makePluginProject({ id: "B", name: "B" }),
        ],
        threads: [child],
      },
    };

    expect(
      projectSidebarSnapshot(input).visible.threads.map((thread) => thread.id),
    ).toEqual(["child"]);

    const parent = makeSidebarThread({ id: "parent", projectId: "B" });
    expect(
      projectSidebarSnapshot({
        ...input,
        snapshot: { ...input.snapshot, threads: [parent, child] },
      }).visible.threads,
    ).toEqual([]);
  });

  it("retains matching empty projects and excludes personal projects from custom rules", () => {
    const personal = makePluginProject({
      id: "personal",
      name: "Personal",
      isPersonal: true,
    });
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({
        kind: "projectIds",
        projectIds: ["empty", personal.id],
      }),
      snapshot: {
        projects: [makePluginProject({ id: "empty", name: "Empty" }), personal],
        threads: [makeSidebarThread({ id: "mine", projectId: personal.id })],
      },
    });

    expect(projection.visible.projects.map((project) => project.id)).toEqual([
      "empty",
    ]);
    expect(projection.visible.threads).toEqual([]);
  });

  it("applies the full pinned subtree exception without duplicates or invented ancestors", () => {
    const pinnedB = makeSidebarThread({
      id: "pinned-b",
      projectId: "B",
      pinnedAt: 10,
    });
    const rawAChild = makeSidebarThread({
      id: "raw-a-child",
      projectId: "A",
      parentThreadId: pinnedB.id,
    });
    const rootA = makeSidebarThread({ id: "root-a", projectId: "A" });
    const projects = [
      makePluginProject({ id: "A", name: "A" }),
      makePluginProject({ id: "B", name: "B" }),
    ];
    const snapshot = { projects, threads: [pinnedB, rawAChild, rootA] };

    const filtered = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({ kind: "projectIds", projectIds: ["A"] }),
      snapshot,
    });
    expect(filtered.visible.threads.map((thread) => thread.id)).toEqual([
      "root-a",
    ]);

    const alwaysShown = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith(
        { kind: "projectIds", projectIds: ["A"] },
        "always-show",
      ),
      snapshot,
    });
    expect(alwaysShown.visible.threads.map((thread) => thread.id)).toEqual([
      "pinned-b",
      "raw-a-child",
      "root-a",
    ]);
    expect(alwaysShown.visible.pinned.rootNodes.map((node) => node.thread.id)).toEqual([
      "pinned-b",
    ]);
    expect(new Set(alwaysShown.visible.threads.map((thread) => thread.id)).size).toBe(3);
  });

  it("allows only the pinned personal subtree as an always-show exception", () => {
    const personal = makePluginProject({
      id: "personal",
      name: "Personal",
      isPersonal: true,
    });
    const pinned = makeSidebarThread({
      id: "pinned-personal",
      projectId: personal.id,
      pinnedAt: 10,
    });
    const child = makeSidebarThread({
      id: "personal-child",
      projectId: personal.id,
      parentThreadId: pinned.id,
    });
    const loose = makeSidebarThread({ id: "personal-loose", projectId: personal.id });
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith(
        { kind: "projectIds", projectIds: [personal.id] },
        "always-show",
      ),
      snapshot: { projects: [personal], threads: [pinned, child, loose] },
    });

    expect(projection.visible.projects).toEqual([]);
    expect(projection.visible.threads.map((thread) => thread.id)).toEqual([
      "pinned-personal",
      "personal-child",
    ]);
  });

  it("retains full threads even when the raw project bucket has no catalog entry", () => {
    const orphan = makeSidebarThread({ id: "orphan", projectId: "missing" });
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({ kind: "projectIds", projectIds: ["missing"] }),
      snapshot: { projects: [], threads: [orphan] },
    });

    expect(projection.full.threads).toEqual([orphan]);
    expect(projection.visible.threads).toEqual([orphan]);
    expect(
      projectSidebarSnapshot({
        activeFilterId: "all",
        document: defaultFilterDocument(),
        snapshot: { projects: [], threads: [orphan] },
      }).visible.threads,
    ).toEqual([orphan]);
  });

  it("changes the gesture key for structural visibility, but not transient status", () => {
    const project = makePluginProject({ id: "A", name: "A" });
    const thread = makeSidebarThread({ id: "thread", projectId: project.id });
    const input = {
      activeFilterId: "all",
      document: defaultFilterDocument(),
      snapshot: { projects: [project], threads: [thread] },
    };
    const baseline = projectSidebarSnapshot(input).projectionKey;

    expect(
      projectSidebarSnapshot({
        ...input,
        snapshot: {
          ...input.snapshot,
          threads: [
            {
              ...thread,
              status: "active",
              runtimeStatus: "active",
              activity: { ...thread.activity, workflows: 1 },
            },
          ],
        },
      }).projectionKey,
    ).toBe(baseline);
    expect(
      projectSidebarSnapshot({
        ...input,
        snapshot: {
          ...input.snapshot,
          threads: [{ ...thread, isHidden: true }],
        },
      }).projectionKey,
    ).not.toBe(baseline);
  });
});

describe("matchesProjectNameGlob", () => {
  it("uses full lowercase code-point matching with literal punctuation", () => {
    expect(matchesProjectNameGlob("WORK-", "work-*")).toBe(true);
    expect(matchesProjectNameGlob("work-api", "work-*")).toBe(true);
    expect(matchesProjectNameGlob("my-work-api", "work-*")).toBe(false);
    expect(matchesProjectNameGlob("client-😀", "client-?")).toBe(true);
    expect(matchesProjectNameGlob("client-ab", "client-?")).toBe(false);
    expect(matchesProjectNameGlob("[] .", "[] .")).toBe(true);
    expect(matchesProjectNameGlob("client-👨‍👩‍👧‍👦", "client-?")).toBe(false);
  });

  it("preserves significant spaces and treats multiple globs as OR", () => {
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({ kind: "nameGlobs", globs: ["", " Team-*", "ops"] }),
      snapshot: {
        projects: [
          makePluginProject({ id: "space", name: " Team-One" }),
          makePluginProject({ id: "ops", name: "OPS" }),
          makePluginProject({ id: "trimmed", name: "Team-One" }),
        ],
        threads: [],
      },
    });

    expect(projection.visible.projects.map((project) => project.id)).toEqual([
      "space",
      "ops",
    ]);
  });

  it("matches every ordinary project with star without admitting personal projects or threads", () => {
    const ordinary = makePluginProject({ id: "ordinary", name: "Anything" });
    const personal = makePluginProject({
      id: "personal",
      name: "Personal",
      isPersonal: true,
    });
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({ kind: "nameGlobs", globs: ["*"] }),
      snapshot: {
        projects: [ordinary, personal],
        threads: [
          makeSidebarThread({ id: "ordinary-thread", projectId: ordinary.id }),
          makeSidebarThread({ id: "personal-thread", projectId: personal.id }),
        ],
      },
    });

    expect(projection.visible.projects.map((project) => project.id)).toEqual([
      "ordinary",
    ]);
    expect(projection.visible.threads.map((thread) => thread.id)).toEqual([
      "ordinary-thread",
    ]);
  });

  it("keeps a whitespace-only mask exact while ignoring only the empty mask", () => {
    const projection = projectSidebarSnapshot({
      activeFilterId: "custom",
      document: documentWith({ kind: "nameGlobs", globs: ["", "   "] }),
      snapshot: {
        projects: [
          makePluginProject({ id: "three-spaces", name: "   " }),
          makePluginProject({ id: "two-spaces", name: "  " }),
          makePluginProject({ id: "named", name: "Named" }),
        ],
        threads: [],
      },
    });

    expect(projection.visible.projects.map((project) => project.id)).toEqual([
      "three-spaces",
    ]);
  });

  it("keeps static membership independent when a rename changes glob membership", () => {
    const document = {
      ...defaultFilterDocument(),
      revision: 11,
      filters: [
        {
          id: "static",
          name: "Static",
          rule: { kind: "projectIds" as const, projectIds: ["shared"] },
        },
        {
          id: "glob",
          name: "Glob",
          rule: { kind: "nameGlobs" as const, globs: ["work-*"] },
        },
      ],
    };
    const beforeRename = [
      makePluginProject({ id: "shared", name: "Other" }),
      makePluginProject({ id: "dynamic", name: "Work-Dynamic" }),
    ];
    const afterRename = [
      { ...beforeRename[0]!, name: "Work-Shared" },
      beforeRename[1]!,
    ];

    expect(projectSidebarSnapshot({
      activeFilterId: "static",
      document,
      snapshot: { projects: beforeRename, threads: [] },
    }).visible.projects.map((project) => project.id)).toEqual(["shared"]);
    expect(projectSidebarSnapshot({
      activeFilterId: "glob",
      document,
      snapshot: { projects: beforeRename, threads: [] },
    }).visible.projects.map((project) => project.id)).toEqual(["dynamic"]);
    expect(projectSidebarSnapshot({
      activeFilterId: "glob",
      document,
      snapshot: { projects: afterRename, threads: [] },
    }).visible.projects.map((project) => project.id)).toEqual([
      "shared",
      "dynamic",
    ]);
    expect(projectSidebarSnapshot({
      activeFilterId: "static",
      document,
      snapshot: { projects: afterRename, threads: [] },
    }).visible.projects.map((project) => project.id)).toEqual(["shared"]);
    expect(document.revision).toBe(11);
    expect(document.filters.map((filter) => filter.id)).toEqual(["static", "glob"]);
  });
});
