import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import { defaultPreferences } from "../../shared/preferences.js";
import { planThreadReveal } from "./reveal-plan.js";
const root = makeSidebarThread({ id: "root", projectId: "app", sectionId: "later" });
const child = makeSidebarThread({ id: "child", projectId: "web", parentThreadId: "root" });
describe("reveal visibility decisions", () => {
  it.each([
    ["project", "project:app"], ["chronological", "section:later"], ["machine", "machine:no-machine"],
  ] as const)("uses the actual tree group in %s mode", (organizationMode, groupId) => {
    const result = planThreadReveal([child, root], { ...defaultPreferences(), organizationMode, hiddenGroups: [groupId] }, "personal");
    expect(result.projectId).toBe("app");
    expect(result.hiddenGroupId).toBe(groupId);
    expect(result.reasons).toHaveLength(1);
  });
  it("does not restore an unrelated hidden project for an inherited pinned subtree", () => {
    const result = planThreadReveal([child, { ...root, isPinned: true }], { ...defaultPreferences(), hiddenGroups: ["project:app"] }, "personal");
    expect(result.reasons).toEqual([]);
  });
  it("collects archive, hidden group and hidden ancestors in one decision", () => {
    const result = planThreadReveal([{ ...child, isArchived: true, isHidden: true }, { ...root, isHidden: true }],
      { ...defaultPreferences(), hiddenGroups: ["project:app"] }, "personal");
    expect(result.reasons).toHaveLength(3);
    expect(result.hiddenThreadIds).toEqual(["child", "root"]);
    expect(result.missingLifecycle).toBe("archived");
  });
  it("also asks before enabling active threads in an archive-only list", () => {
    expect(planThreadReveal([root], { ...defaultPreferences(), threadLifecycles: ["archived"] }, "personal").missingLifecycle).toBe("active");
  });
});
