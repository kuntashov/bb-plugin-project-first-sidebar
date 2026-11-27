import { z } from "zod";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

const lifecycle = z.object({
  threadId: z.string(),
  parkedAt: z.number().nullable().optional(),
  snoozedAt: z.number().nullable(),
  snoozedUntil: z.number().nullable(),
  settledAt: z.number().nullable(),
  settledOverride: z.enum(["active", "settled"]).nullable().optional(),
});
const settings = z.object({
  inactiveThreadsEnabled: z.boolean(),
  inactiveAfterHours: z.number().int().min(1).max(720),
  snoozePresets: z.string(),
});
const ok = z.object({ ok: z.literal(true) });
const reclaimed = ok.extend({
  reclaim: z.object({
    closedTerminals: z.number().int().nonnegative(),
    keptTerminals: z.number().int().nonnegative(),
    stoppedRuntime: z.boolean(),
  }),
});
const issue = z.object({
  threadId: z.string(),
  resource: z.enum(["thread", "terminal", "port"]),
  message: z.string(),
});
const port = z.object({ threadId: z.string(), port: z.number().int() });
const preview = z.object({
  token: z.string().uuid(),
  threads: z.array(z.object({
    threadId: z.string(), title: z.string(), terminalCount: z.number().int(), ports: z.array(z.number().int()),
  })),
  skipped: z.array(issue),
});
const cleaned = z.object({
  closedTerminals: z.number().int(), signalledPorts: z.array(port), remainingPorts: z.array(port),
  skipped: z.array(issue), failed: z.array(issue),
});

export type LifecycleRow = z.infer<typeof lifecycle>;
export type SidebarSettings = z.infer<typeof settings>;
export type CleanupPreview = z.infer<typeof preview>;
export type CleanupResult = z.infer<typeof cleaned>;
export type CleanupIssue = z.infer<typeof issue>;

export function sidebarRpc(sdk: PluginBrowserBbSdk) {
  function call<T>(method: string, input: Record<string, string | number | string[]>, outputSchema: z.ZodType<T>) {
    return sdk.plugins.callRpc({ pluginId: "bb-sidebar", method, input, outputSchema });
  }
  return {
    async read() {
      const [{ rows }, preferences] = await Promise.all([
        call("listLifecycle", {}, z.object({ rows: z.array(lifecycle) })),
        call("getSidebarSettings", {}, settings),
      ]);
      return { rows: new Map(rows.map(row => [row.threadId, row])), preferences };
    },
    park: (threadId: string) => call("park", { threadId }, reclaimed),
    settle: (threadId: string) => call("settle", { threadId }, reclaimed.extend({ undoToken: z.string().uuid() })),
    snooze: (threadId: string, snoozedUntil: number) => call("snooze", { threadId, snoozedUntil }, reclaimed),
    resume: (threadId: string) => call("resume", { threadId }, ok),
    unsettle: (threadId: string, undoToken?: string) =>
      call("unsettle", undoToken ? { threadId, undoToken } : { threadId }, ok),
    unsnooze: (threadId: string) => call("unsnooze", { threadId }, ok),
    acknowledgeWake: (threadId: string) => call("acknowledgeWake", { threadId }, ok),
    preview: (threadIds: string[]) => call("previewSettledCleanup", { threadIds }, preview),
    clean: (token: string) => call("cleanSettled", { token }, cleaned),
  };
}

export type SidebarRpc = ReturnType<typeof sidebarRpc>;
