import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { FilterDocumentV1 } from "../../shared/filters.js";
import { matchesProjectNameGlob } from "../model/sidebar-projection.js";
import { ALL_FILTER_ID, PROJECTLESS_FILTER_ID } from "../filters/filter-store.js";

type Entry = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["list"]>>[number];
export type SearchThread = Pick<Entry, "id" | "projectId" | "parentThreadId" | "title" | "titleFallback" | "updatedAt" | "archivedAt" | "deletedAt" | "visibility" | "sectionId" | "pinnedAt" | "environmentId">;
export interface SearchProject { id: string; name: string; isPersonal: boolean }
export interface MatchRange { start: number; end: number }

export function rawTitle(thread: SearchThread): string {
  if (thread.title?.trim()) return thread.title;
  if (thread.titleFallback?.trim()) return thread.titleFallback;
  return `Thread ${thread.id.slice(0, 8)}`;
}

// Map folded offsets back to entire original code points (İ and emoji included).
export function matchTitle(title: string, query: string): MatchRange[] | null {
  let folded = "";
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const point of title) {
    const lower = point.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset); ends.push(offset + point.length);
    }
    folded += lower;
    offset += point.length;
  }
  folded = title.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const part of query.split("/").filter((part) => part.length !== 0)) {
    const term = part.toLowerCase();
    let found = false;
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      found = true;
      ranges.push({ start: starts[at], end: ends[at + term.length - 1] });
    }
    if (!found) return null;
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function filterProjectIds(filterId: string, document: FilterDocumentV1, projects: readonly SearchProject[]): Set<string> {
  if (filterId === ALL_FILTER_ID) return new Set(projects.map((p) => p.id));
  if (filterId === PROJECTLESS_FILTER_ID) return new Set(projects.filter((p) => p.isPersonal).map((p) => p.id));
  const filter = document.filters.find((filter) => filter.id === filterId);
  if (!filter) throw new Error("Выбранный фильтр удалён. Выберите фильтр заново.");
  const rule = filter.rule;
  return new Set(projects.filter((p) => !p.isPersonal && (rule.kind === "projectIds"
    ? rule.projectIds.includes(p.id) : rule.globs.some((glob) => glob !== "" && matchesProjectNameGlob(p.name, glob)))).map((p) => p.id));
}

export function threadChain(thread: SearchThread, byId: ReadonlyMap<string, SearchThread>): SearchThread[] {
  const chain: SearchThread[] = [];
  const seen = new Set<string>();
  let current: SearchThread | undefined = thread;
  while (current && current.deletedAt === null) {
    if (seen.has(current.id)) throw new Error("Обнаружен цикл в родительских тредах.");
    seen.add(current.id); chain.push(current);
    current = current.parentThreadId ? byId.get(current.parentThreadId) : undefined;
  }
  return chain;
}
export function effectiveProject(thread: SearchThread, byId: ReadonlyMap<string, SearchThread>): string {
  return threadChain(thread, byId).at(-1)!.projectId;
}

export async function listSearchThreads(sdk: { threads: Pick<PluginBrowserBbSdk["threads"], "list"> }, archived: boolean, signal: AbortSignal): Promise<SearchThread[]> {
  const rows = new Map<string, SearchThread>();
  let offset = 0;
  while (true) {
    signal.throwIfAborted();
    const page = await sdk.threads.list({ archived, includeHidden: true, limit: 200, offset, signal });
    signal.throwIfAborted();
    if (!page.length) return [...rows.values()];
    offset += page.length;
    for (const thread of page) if (thread.deletedAt === null) rows.set(thread.id, thread);
  }
}
function unavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error.status === 403 || error.status === 404);
}

export async function completeAncestors(sdk: { threads: Pick<PluginBrowserBbSdk["threads"], "get"> }, threads: readonly SearchThread[], signal: AbortSignal): Promise<Map<string, SearchThread>> {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const missing = new Set<string>();
  for (const thread of threads) {
    let current: SearchThread | undefined = thread;
    const seen = new Set<string>();
    while (current) {
      signal.throwIfAborted();
      if (seen.has(current.id)) throw new Error("Обнаружен цикл в родительских тредах.");
      seen.add(current.id);
      const parentId: string | null = current.parentThreadId;
      if (!parentId || missing.has(parentId)) break;
      if (!byId.has(parentId)) {
        try {
          const parent = await sdk.threads.get({ threadId: parentId, signal });
          signal.throwIfAborted();
          if (parent.deletedAt !== null) { missing.add(parentId); break; }
          byId.set(parentId, parent);
        } catch (error) {
          signal.throwIfAborted();
          if (!unavailable(error)) throw error;
          missing.add(parentId); break;
        }
      }
      current = byId.get(parentId);
    }
  }
  return byId;
}

const searchMetadataChanges = new Set<string>(["archived-changed", "environment-changed", "parent-changed", "pin-state-changed", "thread-created", "thread-deleted", "title-changed"]);
export function changesSearchMetadata(changes: readonly string[]): boolean {
  return !changes.length || changes.some((change) => searchMetadataChanges.has(change));
}
