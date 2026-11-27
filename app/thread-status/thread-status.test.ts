import { describe, expect, it } from "vitest";
import { makeSidebarThread as thread } from "../model/fixtures.js";
import { parseConfiguredSnoozePresets, resolveConfiguredSnoozePreset } from "./snooze-presets.js";
import { threadStatuses } from "./thread-status.js";
import type { LifecycleRow } from "./sidebar-rpc.js";

const now = 10 * 3_600_000;
const settings = { inactiveThreadsEnabled: true, inactiveAfterHours: 6, snoozePresets: "1h" };
const row = (threadId: string, values: Partial<LifecycleRow>): LifecycleRow =>
  ({ threadId, settledAt: null, snoozedAt: null, snoozedUntil: null, ...values });

describe("thread status", () => {
  it("includes background work and ancestors, and gives requests for input precedence", () => {
    const threads = [
      thread({ id: "parent" }), thread({ id: "child", parentThreadId: "parent", activity: { goals: 1 } }),
      thread({ id: "monitor", indicator: "runtime", indicatorLabel: "Monitoring" }),
      thread({ id: "drafting", indicator: "working-draft" }),
      thread({ id: "ask", parentThreadId: "blocked", hasPendingInteraction: true }),
      thread({ id: "blocked", status: "active" }), thread({ id: "hidden", isHidden: true }),
      thread({ id: "archived", archivedAt: 1 }), thread({ id: "failed", status: "active", indicator: "unread-error" }),
    ];
    const result = threadStatuses(threads, new Map(), settings, now);
    expect(result.get("parent")?.group).toBe("Working");
    expect(result.get("child")?.canPark).toBe(false);
    expect(result.get("monitor")?.label).toBe("Monitoring");
    expect(result.get("drafting")).toMatchObject({ group: "Working", label: "Drafting", canPark: false });
    expect(result.get("ask")?.label).toBe("Needs you");
    expect(result.get("blocked")).toMatchObject({ group: "Active", canPark: false });
    expect(result.get("failed")?.label).toBe("Failed");
    expect(result.has("hidden")).toBe(false);
    expect(result.has("archived")).toBe(false);
  });

  it("honours the inactivity boundary, pins and fresh attention on persisted statuses", () => {
    const settled = row("settled", { settledAt: now - 1, settledOverride: "settled" });
    const snoozed = row("snoozed", { snoozedAt: now - 5, snoozedUntil: now + 10 });
    const parked = row("parked", { parkedAt: now - 1 });
    const rows = new Map([settled, snoozed, parked].map(r => [r.threadId, r]));
    const threads = [thread({ id: "settled", pinnedAt: 5 }), thread({ id: "snoozed" }), thread({ id: "parked" }),
      thread({ id: "pinned", pinnedAt: 5 }), thread({ id: "old", updatedAt: now - 6 * 3_600_000 }),
      thread({ id: "recent", updatedAt: now - 6 * 3_600_000 + 1 })];
    const result = threadStatuses(threads, rows, settings, now);
    expect(threads.map(t => result.get(t.id)?.group)).toEqual(["Settled", "Snoozed", "Parked", "Active", "Inactive", "Active"]);
    expect(threadStatuses(threads, rows, settings, now + 10).get("snoozed")).toMatchObject({ group: "Active", woke: true });
    const afterAttention = threads.map(t => ({ ...t, latestAttentionAt: now }));
    expect(threadStatuses(afterAttention, rows, settings, now).get("snoozed")?.woke).toBe(true);
    expect(threadStatuses(afterAttention, rows, settings, now).get("parked")?.group).toBe("Active");
    expect(threadStatuses(threads, rows, { ...settings, inactiveThreadsEnabled: false }, now).get("old")?.group).toBe("Active");
  });

  it("resolves configured durations and local calendar dates when selected", () => {
    const presets = parseConfiguredSnoozePresets("Tea=1.5h, evening@18:00, tomorrow@09:15, next-week, impossible, 400d");
    const monday = new Date(2026, 1, 2, 19, 0);
    expect(presets.map(p => p.label)).toEqual(["Tea", "This evening", "Tomorrow morning", "Next week"]);
    expect(presets.map(p => resolveConfiguredSnoozePreset(p, monday))).toEqual([
      monday.getTime() + 90 * 60_000, null, new Date(2026, 1, 3, 9, 15).getTime(), new Date(2026, 1, 9, 9).getTime(),
    ]);
  });
});
