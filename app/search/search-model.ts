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

// Standard Russian/US key positions; delimiters are parsed before layout alternatives.
const englishKeys = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const russianKeys = "ёйцукенгшщзхъфывапролджэячсмитьбю";
const otherLayout = new Map<string, string>();
for (let index = 0; index < englishKeys.length; index++) {
  otherLayout.set(englishKeys[index], russianKeys[index]);
  otherLayout.set(russianKeys[index], englishKeys[index]);
}
function queryAlternatives(part: string): string[] {
  const lower = part.toLowerCase();
  return [...new Set([lower, [...lower].map((point) => otherLayout.get(point) ?? point).join("")])];
}

function differsByAtMostOneEdit(word: string[], query: string[]): boolean {
  const [shorter, longer] = word.length <= query.length ? [word, query] : [query, word];
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index++;
  if (index === shorter.length) return true;
  if (shorter.length < longer.length) {
    return shorter.slice(index).every((letter, offset) => letter === longer[index + offset + 1]);
  }
  const sameTail = (start: number) => shorter.slice(start).every((letter, offset) => letter === longer[start + offset]);
  return sameTail(index + 1) || (
    shorter[index] === longer[index + 1] && shorter[index + 1] === longer[index] && sameTail(index + 2)
  );
}

function approximateTitleRanges(title: string, terms: string[]): MatchRange[] {
  const queries = terms.filter((term) => /^(?:[\p{L}\p{N}]\p{M}*){4,}$/u.test(term)).map((term) => [...term]);
  if (!queries.length) return [];
  const ranges: MatchRange[] = [];
  for (const word of title.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const letters = [...word[0]];
    for (const query of queries) {
      // Try the same length before shorter or longer prefixes. Exact fragments are handled separately.
      const lengths = [query.length, query.length + 1, query.length - 1];
      const length = lengths.find((size) => size <= letters.length && differsByAtMostOneEdit(letters.slice(0, size), query));
      if (length === undefined) continue;
      ranges.push({ start: word.index, end: word.index + letters.slice(0, length).join("").length });
      break;
    }
  }
  return ranges;
}

// Map folded offsets back to entire original code points (İ and emoji included).
function matchParts(title: string, query: string, approximate = false): { ranges: MatchRange[]; fuzzyParts: number } | null {
  const parts = query.split("/").filter((part) => part.length !== 0);
  if (!parts.length) return { ranges: [], fuzzyParts: 0 };
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const point of title) {
    const lower = point.toLowerCase();
    for (let i = 0; i < lower.length; i++) {
      starts.push(offset); ends.push(offset + point.length);
    }
    offset += point.length;
  }
  const folded = title.toLowerCase();
  const ranges: MatchRange[] = [];
  let fuzzyParts = 0;
  for (const part of parts) {
    const alternatives = queryAlternatives(part);
    let found = false;
    for (const term of alternatives) {
      for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
        found = true;
        ranges.push({ start: starts[at], end: ends[at + term.length - 1] });
      }
    }
    if (found) continue;
    if (!approximate) return null;
    const matches = approximateTitleRanges(folded, alternatives);
    if (!matches.length) return null;
    fuzzyParts++;
    for (const match of matches) ranges.push({ start: starts[match.start], end: ends[match.end - 1] });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MatchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return { ranges: merged, fuzzyParts };
}

export function matchTitle(title: string, query: string): MatchRange[] | null {
  return matchParts(title, query)?.ranges ?? null;
}

export function matchThreadQuery(title: string, projectName: string, query: string): { titleRanges: MatchRange[]; projectRanges: MatchRange[]; fuzzyParts?: number } | null {
  const colon = query.indexOf(":");
  const projectRanges = colon < 0 ? [] : matchTitle(projectName, query.slice(0, colon));
  if (projectRanges === null) return null;
  const titleMatch = matchParts(title, colon < 0 ? query : query.slice(colon + 1), true);
  if (!titleMatch) return null;
  const { ranges: titleRanges, fuzzyParts } = titleMatch;
  return fuzzyParts === 0 ? { titleRanges, projectRanges } : { titleRanges, projectRanges, fuzzyParts };
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
