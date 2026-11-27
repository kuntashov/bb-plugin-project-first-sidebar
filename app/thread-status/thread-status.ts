import type { SidebarThread } from "../model/sidebar-thread.js";
import type { LifecycleRow, SidebarSettings } from "./sidebar-rpc.js";

export const statusGroups = ["Working", "Inactive", "Snoozed", "Parked", "Settled"] as const;
export type StatusGroup = typeof statusGroups[number];
export interface ThreadStatus {
  group: StatusGroup | "Active";
  label: string;
  canPark: boolean;
  woke: boolean;
  until?: number;
}

const workingIndicators = new Set<SidebarThread["indicator"]>([
  "runtime", "workflow", "background-agent", "background-command", "plan-mode", "goal", "working-draft",
]);

function isWorking(thread: SidebarThread) {
  const activity = thread.activity;
  return ["pending", "starting", "active", "stopping"].includes(thread.status)
    || workingIndicators.has(thread.indicator) || activity.workflows > 0 || activity.backgroundAgents > 0
    || activity.backgroundCommands > 0 || activity.planMode > 0 || activity.goals > 0;
}

function needsInput(thread: SidebarThread) {
  return thread.hasPendingInteraction || thread.indicator === "waiting-for-input";
}

// Shared branches are visited once per signal, including in malformed parent cycles.
function ancestorIds(threads: readonly SidebarThread[], byId: ReadonlyMap<string, SidebarThread>,
  predicate: (thread: SidebarThread) => boolean) {
  const ids = new Set<string>();
  for (const thread of threads) {
    if (thread.isArchived || !predicate(thread)) continue;
    let id = thread.parentThreadId;
    while (id && !ids.has(id)) {
      const parent = byId.get(id);
      if (!parent || parent.isArchived) break;
      ids.add(id);
      id = parent.parentThreadId;
    }
  }
  return ids;
}

const indicatorLabels: Partial<Record<SidebarThread["indicator"], string>> = {
  "unread-error": "Failed", "waiting-for-input": "Needs you", "unread-success": "Unread",
  workflow: "Workflow", "background-agent": "Agent", "background-command": "Command",
  "plan-mode": "Planning", goal: "Goal", draft: "Draft", "working-draft": "Drafting",
};

function activityLabel(thread: SidebarThread) {
  if (needsInput(thread)) return "Needs you";
  if (thread.queuedWork === "failed") return "Send failed";
  if (thread.indicator === "runtime")
    return thread.indicatorLabel?.toLowerCase().includes("monitoring") ? "Monitoring" : "Working";
  return indicatorLabels[thread.indicator] ?? (thread.queuedWork === "waiting" ? "Queued" : null);
}

export function threadStatuses(threads: readonly SidebarThread[], rows: ReadonlyMap<string, LifecycleRow>,
  settings: SidebarSettings | undefined, now: number): Map<string, ThreadStatus> {
  const byId = new Map(threads.map(t => [t.id, t]));
  const asking = ancestorIds(threads, byId, needsInput);
  const working = ancestorIds(threads, byId, t => isWorking(t) && t.indicator !== "unread-error" && t.queuedWork !== "failed");
  const result = new Map<string, ThreadStatus>();
  for (const thread of threads) {
    if (thread.isHidden || thread.isArchived || thread.archivedAt !== null) continue;
    const row = rows.get(thread.id);
    const attention = needsInput(thread) || asking.has(thread.id);
    const busy = isWorking(thread);
    const canPark = !attention && !busy && thread.queuedWork === "none";
    const latest = thread.latestAttentionAt;
    const woke = row?.snoozedUntil != null && (row.snoozedUntil <= now || attention
      || (row.snoozedAt !== null && latest > row.snoozedAt));
    let group: ThreadStatus["group"] = "Active";
    if (canPark && row?.parkedAt != null && latest <= row.parkedAt) group = "Parked";
    else if (canPark && row?.snoozedUntil != null && !woke) group = "Snoozed";
    else if (canPark && row?.settledAt != null && latest <= row.settledAt
      && (!thread.isPinned || row.settledOverride === "settled")) group = "Settled";
    else if (!attention && !woke && thread.indicator !== "unread-error" && thread.queuedWork !== "failed"
      && (busy || working.has(thread.id))) group = "Working";
    else if (canPark && !woke && !thread.isPinned && settings?.inactiveThreadsEnabled
      && now - Math.max(thread.createdAt, thread.updatedAt, latest) >= settings.inactiveAfterHours * 3_600_000) group = "Inactive";
    const label = group === "Active" || group === "Working" ? activityLabel(thread) ?? group : group;
    result.set(thread.id, { group, label, canPark, woke, until: row?.snoozedUntil ?? undefined });
  }
  return result;
}
