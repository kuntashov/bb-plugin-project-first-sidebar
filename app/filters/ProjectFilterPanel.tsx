import {
  useLayoutEffect,
  useState,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "@/components/ui/sidebar-row-classes";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { ClearFilterIcon } from "./ClearFilterIcon.js";
import { FilterIcon } from "./FilterIcon.js";
import { DEFAULT_FILTER_ICON, type FilterIcon as IconDefinition } from "../../shared/filter-icons.js";
import { cn } from "@/lib/utils";
import {
  ALL_FILTER_ID,
  PROJECTLESS_FILTER_ID,
  windowFilterStore,
  type ActiveFilterId,
  type WindowFilterStore,
} from "./filter-store.js";
import { useFilterDocumentSync } from "./use-filter-document-sync.js";
import { useWindowFilterSnapshot } from "./use-filter-snapshot.js";

export interface ProjectFilterPanelProps {
  store?: WindowFilterStore;
  onManageFilters?: (trigger: HTMLButtonElement) => void;
}

interface FilterOption {
  id: ActiveFilterId;
  name: string;
  icon?: IconDefinition;
}

const BUILT_IN_FILTERS: readonly FilterOption[] = [
  { id: ALL_FILTER_ID, name: "Все" },
  { id: PROJECTLESS_FILTER_ID, name: "Без проектов", icon: { kind: "builtin", name: "Folder" } },
];

export function ProjectFilterPanel({
  store = windowFilterStore,
  onManageFilters,
}: ProjectFilterPanelProps) {
  useFilterDocumentSync(store);
  const snapshot = useWindowFilterSnapshot(store);
  const options: FilterOption[] = [
    ...BUILT_IN_FILTERS,
    ...(snapshot.document?.filters.map((filter) => ({
      id: filter.id,
      name: filter.name,
      icon: filter.icon ?? DEFAULT_FILTER_ICON,
    })) ?? []),
  ];
  const displayMode = snapshot.document?.displayMode ?? "text";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const manageAfterClose = useRef(false);
  const radioRefs = useRef(new Map<ActiveFilterId, HTMLButtonElement>());
  const groupRef = useRef<HTMLDivElement>(null);
  const focusedFilterId = useRef<ActiveFilterId | null>(null);
  const handledRemovalVersion = useRef(snapshot.removalVersion);

  useLayoutEffect(() => {
    if (snapshot.removalVersion === handledRemovalVersion.current) return;
    handledRemovalVersion.current = snapshot.removalVersion;
    if (focusedFilterId.current === snapshot.removedActiveFilterId) {
      focusedFilterId.current = ALL_FILTER_ID;
      radioRefs.current.get(ALL_FILTER_ID)?.focus();
    }
  }, [snapshot.removalVersion, snapshot.removedActiveFilterId]);

  const selectAndFocus = (option: FilterOption) => {
    store.setActiveFilterId(option.id);
    radioRefs.current.get(option.id)?.focus();
  };
  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + options.length) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectAndFocus(options[nextIndex]!);
  };
  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (!groupRef.current?.contains(event.relatedTarget as Node | null)) {
      focusedFilterId.current = null;
    }
  };

  return (
    <div
      data-sidebar="project-filter-panel"
      className="min-w-0 border-b border-sidebar-border bg-sidebar px-2 py-1.5"
    >
      <div className="group/filter-actions flex min-w-0 items-start gap-1">
        <div
          ref={groupRef}
          role="radiogroup"
          aria-label="Фильтры проектов"
          className="flex min-w-0 flex-1 flex-wrap gap-1"
        >
          {options.map((option, index) => {
            const checked = option.id === snapshot.activeFilterId;
            return (
              <button
                key={option.id}
                ref={(element) => {
                  if (element) radioRefs.current.set(option.id, element);
                  else radioRefs.current.delete(option.id);
                }}
                type="button"
                role="radio"
                aria-label={option.name}
                title={option.name}
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                data-filter-id={option.id}
                className={cn(
                  "inline-flex items-center max-w-full min-w-0 rounded-md border px-2 py-1 text-left text-xs leading-tight outline-none",
                  "whitespace-normal break-words [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  checked
                    ? "border-sidebar-ring bg-sidebar-accent text-sidebar-accent-foreground"
                    : "border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent/60",
                )}
                onClick={() => store.setActiveFilterId(option.id)}
                onFocus={() => {
                  focusedFilterId.current = option.id;
                }}
                onBlur={handleBlur}
                onKeyDown={(event) => handleKeyDown(event, index)}
              >
                {displayMode !== "text" ? (option.id === ALL_FILTER_ID ? <ClearFilterIcon /> : <FilterIcon icon={option.icon} />) : null}
                {displayMode !== "icon" ? <span className={displayMode === "icon-text" ? "ml-1" : undefined}>{option.name}</span> : null}
              </button>
            );
          })}
        </div>
        {onManageFilters ? (
          <DropdownMenu open={menuOpen} onOpenChange={(open) => {
            setMenuOpen(open);
            if (open) {
              manageAfterClose.current = false;
              // The compact drawer captures its return focus while opening.
              menuTriggerRef.current?.focus({ preventScroll: true });
            }
          }}>
            <DropdownMenuTrigger asChild>
              <Button ref={menuTriggerRef} type="button" variant="ghost" size="icon" aria-label="Меню фильтров"
                className={cn(SIDEBAR_CONTROL_BUTTON_CLASS, "opacity-0 group-[:hover]/filter-actions:opacity-100 group-focus-within/filter-actions:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100")}>
                <Icon name="MoreHorizontal" className={COARSE_POINTER_ICON_SIZE_CLASS} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="data-[state=open]:animate-none" onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!manageAfterClose.current) menuTriggerRef.current?.focus({ preventScroll: true });
              manageAfterClose.current = false;
            }}>
              <DropdownMenuItem onSelect={() => { manageAfterClose.current = true; if (menuTriggerRef.current) onManageFilters(menuTriggerRef.current); }}>Настроить</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {snapshot.document === null && snapshot.status === "loading" ? (
        <div role="status" className="pt-1 text-xs text-muted-foreground">
          Загрузка фильтров…
        </div>
      ) : null}
      {snapshot.isRefreshing ? (
        <div role="status" className="sr-only">
          Обновление фильтров…
        </div>
      ) : null}
      {snapshot.errorMessage ? (
        <div role="alert" className="pt-1 text-xs text-destructive">
          {snapshot.errorMessage}
        </div>
      ) : null}
    </div>
  );
}
