import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { experimental_useThreadTitleDisplayText, useSdk } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FilterIcon } from "../filters/FilterIcon.js";
import { ClearFilterIcon } from "../filters/ClearFilterIcon.js";
import { ALL_FILTER_ID, PROJECTLESS_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { useWindowFilterSnapshot } from "../filters/use-filter-snapshot.js";
import { useFilterDocumentSync } from "../filters/use-filter-document-sync.js";
import { usePreferencesSync } from "../preferences/PreferencesSync.js";
import type { FilterIcon as IconDefinition } from "../../shared/filter-icons.js";
import { changesSearchMetadata, effectiveProject, filterProjectIds, matchThreadQuery, matchTitle, rawTitle, type MatchRange, type SearchThread } from "./search-model.js";
import { useSearchData } from "./use-search-data.js";
import { useSearchNavigation, type PreparedSelection } from "./use-search-navigation.js";
import "./search.css";

const OPEN_EVENT = "project-first-sidebar:quick-thread-search";
export function requestQuickThreadSearch() { window.dispatchEvent(new Event(OPEN_EVENT)); }

const TitleResolver = memo(function TitleResolver({ raw, publish }: { raw: string; publish(raw: string, display: string): void }) {
  const display = experimental_useThreadTitleDisplayText(raw);
  useLayoutEffect(() => { publish(raw, display); }, [raw, display, publish]);
  return null;
});
function Highlight({ text, ranges }: { text: string; ranges: readonly MatchRange[] }) {
  let offset = 0;
  return <>{ranges.map((range) => {
    const prefix = text.slice(offset, range.start);
    offset = range.end;
    return <span key={range.start}>{prefix}<mark>{text.slice(range.start, range.end)}</mark></span>;
  })}{text.slice(offset)}</>;
}
interface Option { id: string; name: string; icon?: IconDefinition; thread?: SearchThread; detail?: string; detailRanges?: MatchRange[]; ranges: MatchRange[] }
const FILTER_ROW_HEIGHT = 32;
const THREAD_ROW_HEIGHT = 44;
const LIST_HEIGHT = 308;

function SearchSession({ prepare, accept, close }: {
  prepare: ReturnType<typeof useSearchNavigation>["prepare"];
  accept(prepared: PreparedSelection): void;
  close(): void;
}) {
  const snapshot = useWindowFilterSnapshot();
  const [filterId, setFilterId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const listId = useId();
  const source = useSearchData(includeArchived);
  const { document } = snapshot;
  const filters = useMemo<Array<{ id: string; name: string; icon?: IconDefinition }>>(() => [
    { id: ALL_FILTER_ID, name: "Все" },
    { id: PROJECTLESS_FILTER_ID, name: "Без проектов", icon: { kind: "builtin" as const, name: "Folder" as const } },
    ...(document?.filters ?? []).map((filter) => ({ id: filter.id, name: filter.name, icon: filter.icon })),
  ], [document]);
  const chosenFilter = filters.find((filter) => filter.id === filterId);
  const candidates = useMemo(() => includeArchived ? [...source.active, ...source.archived] : source.active, [includeArchived, source.active, source.archived]);
  const rawTitles = useMemo(() => [...new Set(candidates.map(rawTitle))], [candidates]);
  const pendingTitles = useRef(new Map<string, string>());
  const titleFlushScheduled = useRef(false);
  const publishTitle = useCallback((raw: string, display: string) => {
    pendingTitles.current.set(raw, display);
    if (titleFlushScheduled.current) return;
    titleFlushScheduled.current = true;
    queueMicrotask(() => {
      titleFlushScheduled.current = false;
      const batch = pendingTitles.current; pendingTitles.current = new Map();
      setTitles((previous) => {
        const changed = [...batch].some(([raw, display]) => previous.get(raw) !== display);
        if (!changed) return previous;
        const next = new Map(previous);
        for (const [raw, display] of batch) next.set(raw, display);
        return next;
      });
    });
  }, []);
  const titlesReady = rawTitles.every((raw) => titles.has(raw));
  let modelError: string | null = null;
  let options: Option[] = [];
  try {
    if (filterId === null) {
      options = filters.flatMap((filter) => {
        const ranges = matchTitle(filter.name, query);
        return ranges === null ? [] : [{ ...filter, ranges }];
      });
    } else if (document && source.activeReady) {
      const projectIds = filterProjectIds(filterId, document, source.projects);
      const projectNames = new Map(source.projects.map((project) => [project.id, project.isPersonal ? "Без проектов" : project.name]));
      options = candidates.flatMap((thread) => {
        const projectId = effectiveProject(thread, source.byId);
        if (!projectIds.has(projectId)) return [];
        const name = titles.get(rawTitle(thread));
        if (name === undefined) return [];
        const projectName = projectNames.get(projectId) ?? projectId;
        const match = matchThreadQuery(name, projectName, query);
        if (match === null) return [];
        return [{ id: thread.id, name, thread, detail: `${projectName}${thread.archivedAt !== null ? " · Архив" : ""}`, ranges: match.titleRanges, detailRanges: match.projectRanges }];
      }).sort((a, b) => b.thread!.updatedAt - a.thread!.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const collisions = new Map<string, number>();
      for (const option of options) { const key = JSON.stringify([option.name, option.detail]); collisions.set(key, (collisions.get(key) ?? 0) + 1); }
      options = options.map((option) => (collisions.get(JSON.stringify([option.name, option.detail])) ?? 0) > 1
        ? { ...option, detail: `${option.detail} · ${option.id.slice(-8)}` } : option);
    }
  } catch (failure) { modelError = failure instanceof Error ? failure.message : "Не удалось отобрать треды."; }
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === selectedId));
  const selected = options[selectedIndex];
  const selectionKey = selected?.id;
  useLayoutEffect(() => {
    if (filterId !== null && (!source.activeReady || (!options.length && !titlesReady))) return;
    setSelectedId(selectionKey ?? null);
  }, [selectionKey, filterId, source.activeReady, titlesReady, options.length]);
  const latest = useRef({ options, selectedIndex });
  latest.current = { options, selectedIndex };
  useEffect(() => {
    const element = list.current;
    if (!element || !selectionKey) return;
    if (filterId === null) {
      // Filter names can wrap to variable height.
      element.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
      return;
    }
    const top = selectedIndex * THREAD_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + THREAD_ROW_HEIGHT > element.scrollTop + LIST_HEIGHT) element.scrollTop = top + THREAD_ROW_HEIGHT - LIST_HEIGHT;
    setScrollTop(element.scrollTop);
  }, [selectionKey, selectedIndex, options.length, query, filterId]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => () => operation.current?.abort(), []);
  // A data/filter invalidation cannot complete an old Enter operation later.
  useEffect(() => {
    operation.current?.abort(); operation.current = null; setSubmitting(false);
  }, [document?.revision, source.activeReady, includeArchived]);

  const select = async (option: Option) => {
    if (operation.current || submitting) return;
    if (filterId === null) {
      setFilterId(option.id); setQuery(""); setSelectedId(null); setError(null); setScrollTop(0);
      if (list.current) list.current.scrollTop = 0;
      input.current?.focus(); return;
    }
    if (!option.thread || !document || !source.activeReady || snapshot.isRefreshing || modelError) return;
    const controller = new AbortController(); operation.current = controller;
    setSubmitting(true); setError(null);
    try {
      const prepared = await prepare({ threadId: option.id, expectedTitle: rawTitle(option.thread), filterId, revision: document.revision, includeArchived }, controller.signal);
      controller.signal.throwIfAborted();
      operation.current = null; // Accepted preparation survives the closing animation.
      accept(prepared);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Не удалось открыть тред.");
    } finally {
      if (operation.current === controller) { operation.current = null; setSubmitting(false); }
    }
  };
  const toggleArchive = () => { setIncludeArchived((value) => !value); setError(null); input.current?.focus(); };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (filterId !== null && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyA") {
      event.preventDefault(); event.stopPropagation(); if (!event.repeat && !submitting) toggleArchive(); return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.target instanceof HTMLElement && event.target.tagName === "BUTTON") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      // Home/End remain normal text editing keys while typing.
      if (event.key === "Home" || event.key === "End") return;
      event.preventDefault();
      const { options: current, selectedIndex: index } = latest.current;
      if (current.length) setSelectedId(current[(index + (event.key === "ArrowDown" ? 1 : -1) + current.length) % current.length].id);
    } else if (event.key === "Enter") {
      event.preventDefault(); if (!event.repeat && selected) void select(selected);
    } else if (event.key === "Backspace" && query === "" && filterId !== null && event.target === input.current) {
      event.preventDefault(); operation.current?.abort(); setFilterId(null); setSelectedId(null); setError(null);
    }
  };
  const loading = filterId !== null && !source.error && (!source.activeReady || !titlesReady);
  const start = Math.max(0, Math.floor(scrollTop / THREAD_ROW_HEIGHT) - 2);
  const indices = new Set(Array.from({ length: Math.min(options.length - start, Math.ceil(LIST_HEIGHT / THREAD_ROW_HEIGHT) + 4) }, (_, index) => start + index));
  if (filterId === null) options.forEach((_, index) => indices.add(index));
  if (selected) indices.add(selectedIndex); // aria-activedescendant always references a mounted option.
  const failure = error ?? modelError ?? (filterId !== null ? source.error : null) ?? snapshot.errorMessage;
  return <div data-thread-quick-search="" onKeyDown={onKeyDown}>
    {rawTitles.map((raw) => <TitleResolver key={raw} raw={raw} publish={publishTitle} />)}
    <div className="flex items-center gap-2">
      {chosenFilter ? <span title={chosenFilter.name} aria-label={`Фильтр: ${chosenFilter.name}`} className="inline-flex shrink-0 rounded border p-2">
        {filterId === ALL_FILTER_ID ? <ClearFilterIcon /> : <FilterIcon icon={chosenFilter.icon} />}
      </span> : null}
      <Input ref={input} role="combobox" aria-label={filterId === null ? "Выбрать фильтр" : "Найти тред"}
        aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={selected ? `${listId}-${selectedIndex}` : undefined}
        placeholder={filterId === null ? "Название фильтра…" : "Тред или проект:тред, части через /…"}
        value={query} onChange={(event) => { setQuery(event.target.value); setSelectedId(null); setError(null); }} disabled={submitting} autoComplete="off" />
      {filterId !== null ? <button type="button" aria-label="Включать архивные" aria-pressed={includeArchived}
        title="Включать архивные (Alt+A)" disabled={submitting}
        className={`shrink-0 rounded border px-2 py-2 text-xs ${includeArchived ? "bg-accent text-accent-foreground ring-1 ring-ring" : "text-muted-foreground"}`}
        onMouseDown={(event) => event.preventDefault()} onClick={toggleArchive}>Архив <kbd>Alt+A</kbd></button> : null}
    </div>
    <div role="status" className="min-h-6 pt-1 text-xs text-muted-foreground" aria-live="polite">
      {submitting ? "Открытие треда…" : snapshot.status === "loading" ? "Загрузка фильтров…" : loading ? "Загрузка тредов…"
        : includeArchived && filterId !== null && !source.archiveReady && !source.archiveError ? "Загрузка архивных…" : `${options.length} ${filterId === null ? "фильтров" : "тредов"}`}
    </div>
    {failure ? <div role="alert" className="text-sm text-destructive">{failure}</div> : null}
    {filterId !== null && includeArchived && source.archiveError ? <div role="alert" className="text-sm text-destructive">Не удалось добавить архив: {source.archiveError}</div> : null}
    <div id={listId} ref={list} role="listbox" aria-label={filterId === null ? "Фильтры" : "Треды"} aria-busy={loading}
      className="relative mt-2 overflow-y-auto" style={{ maxHeight: LIST_HEIGHT, height: filterId === null ? undefined : LIST_HEIGHT }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div style={{ height: filterId === null ? undefined : options.length * THREAD_ROW_HEIGHT, position: "relative" }}>
        {[...indices].sort((a, b) => a - b).map((index) => {
          const option = options[index];
          if (!option) return null;
          return <div key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === selectedIndex}
            aria-posinset={index + 1} aria-setsize={options.length} title={option.name}
            style={filterId === null ? { minHeight: FILTER_ROW_HEIGHT, width: "100%" } : { position: "absolute", top: index * THREAD_ROW_HEIGHT, height: THREAD_ROW_HEIGHT, width: "100%" }}
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm"
            onMouseDown={(event) => event.preventDefault()} onClick={() => { void select(option); }}>
            {!option.thread ? option.id === ALL_FILTER_ID ? <ClearFilterIcon /> : <FilterIcon icon={option.icon} /> : null}
            <span className="min-w-0 flex-1"><span className={filterId === null ? "block break-words whitespace-pre-wrap leading-5" : "block truncate whitespace-pre leading-5"}><Highlight text={option.name} ranges={option.ranges} /></span>
              {option.detail ? <span title={option.detail} className="block truncate text-xs text-muted-foreground"><Highlight text={option.detail} ranges={option.detailRanges ?? []} /></span> : null}</span>
          </div>;
        })}
      </div>
      {!loading && !failure && options.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{includeArchived && !source.archiveReady && filterId !== null ? "В неархивных совпадений нет; архив ещё не загружен." : "Совпадений нет"}</p> : null}
    </div>
  </div>;
}

export function QuickThreadSearch() {
  usePreferencesSync();
  useFilterDocumentSync(windowFilterStore);
  const sdk = useSdk();
  const navigation = useSearchNavigation();
  const latestNavigation = useRef(navigation); latestNavigation.current = navigation;
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const isOpen = useRef(false);
  const committing = useRef(false);
  const pending = useRef<PreparedSelection | null>(null);
  // One cancellation lifetime spans reads, the closing animation and commit.
  const operation = useRef<AbortController | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const cancel = () => {
    operation.current?.abort(); pending.current = null;
    isOpen.current = false; setOpen(false);
  };
  useEffect(() => {
    const invalidate = () => {
      if (committing.current) return; // Our own reveal writes are already committed.
      const wasPending = pending.current !== null;
      operation.current?.abort(); pending.current = null;
      if (wasPending) toast.info("Данные обновились. Повторите поиск.");
    };
    const stopFilters = windowFilterStore.subscribe(() => {
      const snapshot = windowFilterStore.getSnapshot();
      if (snapshot.status !== "ready" || snapshot.isRefreshing || (pending.current && snapshot.document?.revision !== pending.current.selection.revision)) invalidate();
    });
    const disposers = [
      sdk.subscribe({ event: "thread:changed", callback: (event) => { if (changesSearchMetadata(event.changes)) invalidate(); } }),
      sdk.subscribe({ event: "project:changed", callback: invalidate }),
      sdk.subscribe({ event: "system:changed", callback: (event) => { if (event.changes.includes("ui-preferences-changed")) invalidate(); } }),
      sdk.subscribe({ event: "realtime:connection", callback: (event) => { if (event.reconnected) invalidate(); } }),
    ];
    const onOpen = () => {
      operation.current?.abort(); pending.current = null; committing.current = false;
      if (!isOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      isOpen.current = true; setSession((value) => value + 1); setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOpen); operation.current?.abort();
      stopFilters(); disposers.forEach((dispose) => dispose());
    };
  }, [sdk]);
  const afterClose = () => {
    if (isOpen.current) return; // An older dialog must not steal a new session's focus.
    const prepared = pending.current; pending.current = null;
    if (!prepared || prepared.signal.aborted) { returnFocus.current?.focus(); return; }
    committing.current = true;
    const commitOperation = operation.current;
    void latestNavigation.current.commit(prepared, prepared.signal).catch((failure: unknown) => {
      if (!prepared.signal.aborted) toast.error(failure instanceof Error ? failure.message : "Не удалось показать открытый тред в сайдбаре.");
    }).finally(() => { if (operation.current === commitOperation) committing.current = false; });
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!next) cancel(); }}>
    <DialogContent className="sm:max-w-xl" onCloseAutoFocus={(event) => event.preventDefault()} onAfterCloseAutoFocus={afterClose}>
      <DialogHeader><DialogTitle>Найти тред по фильтру</DialogTitle><DialogDescription className="sr-only">Выберите фильтр, затем тред. Enter — выбрать, Escape — закрыть.</DialogDescription></DialogHeader>
      {open ? <SearchSession key={session} prepare={(selection, signal) => {
        operation.current?.abort();
        const controller = new AbortController(); operation.current = controller;
        return latestNavigation.current.prepare(selection, AbortSignal.any([signal, controller.signal]));
      }} accept={(prepared) => {
        if (!isOpen.current || prepared.signal.aborted) return;
        pending.current = prepared; isOpen.current = false; setOpen(false);
      }} close={cancel} /> : null}
    </DialogContent>
  </Dialog>;
}
