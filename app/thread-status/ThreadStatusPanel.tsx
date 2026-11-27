import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { sidebarRpc, type LifecycleRow, type SidebarRpc } from "./sidebar-rpc.js";
import { statusGroups, threadStatuses, type StatusGroup, type ThreadStatus } from "./thread-status.js";
import { ThreadStatusDialog, type StatusTarget } from "./ThreadStatusDialog.js";

const noRows: ReadonlyMap<string, LifecycleRow> = new Map();
type Snapshot = Awaited<ReturnType<SidebarRpc["read"]>>;
const StatusContext = createContext<{
  statuses: ReadonlyMap<string, ThreadStatus>;
  open: (target: StatusTarget) => void;
  available: boolean;
} | null>(null);

export function useThreadStatus() {
  return useContext(StatusContext);
}

export function ThreadStatusProvider({ threads, children }: { threads: readonly SidebarThread[]; children: ReactNode }) {
  const sdk = useSdk();
  const rpc = useMemo(() => sidebarRpc(sdk), [sdk]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [now, setNow] = useState(Date.now);
  const [target, setTarget] = useState<StatusTarget | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await rpc.read();
      if (request === generation.current) setSnapshot(next);
    } catch {
      if (request === generation.current) setSnapshot(undefined);
    }
    if (request === generation.current) setNow(Date.now());
  }, [rpc]);
  useEffect(() => {
    // BB scopes realtime channels to their owning plugin. Re-read changes made
    // in other clients when this window returns and while it remains visible.
    const sync = () => { if (!document.hidden) void refresh(); };
    void refresh();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    const interval = window.setInterval(sync, 30_000);
    return () => {
      ++generation.current;
      window.clearInterval(interval);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [refresh]);
  useEffect(() => {
    let nextWake = Infinity;
    for (const row of snapshot?.rows.values() ?? []) {
      if (row.snoozedUntil != null && row.snoozedUntil > now) nextWake = Math.min(nextWake, row.snoozedUntil);
    }
    if (!Number.isFinite(nextWake)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, nextWake - Date.now())));
    return () => window.clearTimeout(timer);
  }, [snapshot, now]);
  const statuses = useMemo(() => threadStatuses(threads, snapshot?.rows ?? noRows, snapshot?.preferences, now), [threads, snapshot, now]);
  const open = useCallback((next: StatusTarget) => {
    setTarget(next);
    void refresh();
  }, [refresh]);
  const context = useMemo(() => ({ statuses, open, available: snapshot !== undefined }), [statuses, open, snapshot]);
  const thread = target && "threadId" in target ? threads.find(t => t.id === target.threadId) : undefined;
  return <StatusContext.Provider value={context}>
    {children}
    {target && <ThreadStatusDialog target={target} thread={thread} status={thread && statuses.get(thread.id)} rpc={rpc}
      available={context.available} presets={snapshot?.preferences.snoozePresets} refresh={refresh} close={() => setTarget(null)} />}
  </StatusContext.Provider>;
}

export function ThreadStatusPanel({ threads, onNavigate }: { threads: readonly SidebarThread[]; onNavigate?: () => void }) {
  const context = useThreadStatus();
  const [expanded, setExpanded] = useState(false);
  const [group, setGroup] = useState<StatusGroup>("Working");
  const id = useId();
  const groups = useMemo(() => {
    const grouped = new Map<StatusGroup, SidebarThread[]>(statusGroups.map(g => [g, []]));
    if (!expanded || !context) return grouped;
    for (const thread of threads) {
      const status = context.statuses.get(thread.id);
      if (status && status.group !== "Active") grouped.get(status.group)!.push(thread);
    }
    if (group === "Snoozed") grouped.get(group)!.sort((a, b) => context.statuses.get(a.id)!.until! - context.statuses.get(b.id)!.until!);
    return grouped;
  }, [threads, context, expanded, group]);
  if (!context) return null;
  const matches = groups.get(group)!;
  return <section aria-label="Статусы тредов" className="px-2 py-1 text-xs">
    <button type="button" className="flex w-full items-center gap-1 rounded px-1 py-1 text-muted-foreground hover:bg-sidebar-accent"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3" />Статус треда
    </button>
    {expanded && <div id={id} className="space-y-1 rounded border border-sidebar-border p-2">
      <label className="flex items-center gap-2">Статус
        <select className="min-w-0 flex-1 rounded bg-sidebar p-1" value={group}
          onChange={e => setGroup(e.target.value as StatusGroup)}>
          {statusGroups.map(g => <option key={g} value={g}>{g} ({groups.get(g)!.length})</option>)}
        </select>
      </label>
      {!context.available && <p className="text-muted-foreground">Для сохранённых статусов нужен включённый BB Sidebar.</p>}
      {matches.length === 0 ? <p className="text-muted-foreground">Нет тредов с этим статусом.</p> :
        <ul className="max-h-52 overflow-y-auto">{matches.map(t => <li key={t.id} className="flex items-center gap-1">
          <a className="min-w-0 flex-1 truncate rounded px-1 py-1 hover:bg-sidebar-accent" href={t.href} onClick={onNavigate}>{t.displayTitle}</a>
          <button className="shrink-0 rounded p-1 hover:bg-sidebar-accent" aria-label={"Статус треда «" + t.displayTitle + "»"}
            onClick={() => context.open({ threadId: t.id })}><Icon name="MoreHorizontal" className="size-3.5" /></button>
        </li>)}</ul>}
      {group === "Settled" && matches.length > 0 && <Button size="sm" variant="outline" disabled={!context.available}
        onClick={() => context.open({ cleanIds: matches.map(t => t.id) })}>Clean · {matches.length}</Button>}
    </div>}
  </section>;
}
