import { describe, expect, it } from "vitest";
import { UNREAD_FILTER_ID, WAITING_FOR_ACTION_FILTER_ID } from "../filters/dynamic-filter-ids.js";
import { projectDynamicSidebar } from "./dynamic-sidebar-projection.js";
import { makePluginProject, makeSidebarThread } from "./fixtures.js";

describe("projectDynamicSidebar", () => {
  it("uses each thread's own unread and pending flags independently", () => {
    const project = makePluginProject();
    const threads = [
      makeSidebarThread({ id: "both", isUnread: true, hasPendingInteraction: true }),
      makeSidebarThread({ id: "unread", isUnread: true, status: "idle", indicator: "none" }),
      makeSidebarThread({ id: "pending", isUnread: false, hasPendingInteraction: true }),
      makeSidebarThread({ id: "neither", isUnread: false, parentThreadId: "both" }),
      makeSidebarThread({ id: "parent", isUnread: false }),
      makeSidebarThread({ id: "child", parentThreadId: "parent", isUnread: false, hasPendingInteraction: true }),
    ];
    const snapshot = { projects: [project], threads };

    expect([...projectDynamicSidebar(snapshot, UNREAD_FILTER_ID).threadIds]).toEqual([
      "both", "unread",
    ]);
    expect([...projectDynamicSidebar(snapshot, WAITING_FOR_ACTION_FILTER_ID).threadIds]).toEqual([
      "both", "child", "pending",
    ]);
  });

  it("groups flat matches by the full active ancestry and shows a matching pin once", () => {
    const projects = [
      makePluginProject({ id: "b" }),
      makePluginProject({ id: "a" }),
      makePluginProject({ id: "personal", isPersonal: true }),
      makePluginProject({ id: "empty" }),
    ];
    const pinned = makeSidebarThread({
      id: "pinned", projectId: "b", parentThreadId: "read", pinnedAt: 1,
      isUnread: true, hasPendingInteraction: true,
    });
    const threads = [
      pinned,
      makeSidebarThread({ id: "read", projectId: "b", parentThreadId: "hidden", isUnread: false }),
      makeSidebarThread({ id: "hidden", projectId: "a", isHidden: true, hasPendingInteraction: true }),
      makeSidebarThread({ id: "archive", projectId: "a", archivedAt: 1, hasPendingInteraction: true }),
      makeSidebarThread({ id: "missing-parent", projectId: "b", parentThreadId: "absent", isUnread: true }),
      makeSidebarThread({ id: "archived-parent", projectId: "b", parentThreadId: "archive", isUnread: true }),
      makeSidebarThread({ id: "mine", projectId: "personal", isUnread: true }),
      makeSidebarThread({ id: "read-pinned", projectId: "personal", isUnread: false, pinnedAt: 1 }),
      makeSidebarThread({ id: "pending-pinned", projectId: "personal", isUnread: false, pinnedAt: 1, hasPendingInteraction: true }),
      pinned,
    ];
    const snapshot = { projects, threads };

    expect(projectDynamicSidebar(snapshot, UNREAD_FILTER_ID).groups.map(
      (group) => [group.project.id, group.threads.map((thread) => thread.id)],
    )).toEqual([
      ["b", ["archived-parent", "missing-parent"]],
      ["a", ["pinned"]],
      ["personal", ["mine"]],
    ]);
    expect([...projectDynamicSidebar(snapshot, WAITING_FOR_ACTION_FILTER_ID).threadIds]).toEqual([
      "pinned", "pending-pinned",
    ]);
  });
});
