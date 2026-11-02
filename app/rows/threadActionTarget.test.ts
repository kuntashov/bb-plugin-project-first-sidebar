import { describe, expect, it } from "vitest";
import { makeSidebarThread } from "../model/fixtures.js";
import { toThreadActionTarget } from "./threadActionTarget.js";

describe("thread action target", () => {
  it.each(["auto", "stuck", "off"] as const)(
    "preserves %s parent notifications for host actions",
    (parentNotifications) => {
      const thread = makeSidebarThread({
        parentThreadId: "thr_parent",
        parentNotifications,
      });
      expect(toThreadActionTarget(thread).parentNotifications).toBe(
        parentNotifications,
      );
    },
  );
});
