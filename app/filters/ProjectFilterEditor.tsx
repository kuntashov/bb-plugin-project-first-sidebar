import { DEFAULT_FILTER_ICON, type FilterIcon } from "../../shared/filter-icons.js";
import { FilterIconPicker } from "./FilterIconPicker.js";
import { FilterIcon as FilterIconView } from "./FilterIcon.js";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  experimental_useSidebarThreads,
  useRpc,
  type PluginSidebarProject,
  type PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/ui/confirm-delete-dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import {
  filterNameKey,
  normalizeFilterDefinition,
  type FilterDocumentV1,
  type FilterMutationResult,
  type PinnedMode,
  type ProjectFilterDefinition,
  type ProjectFilterRule,
} from "../../shared/filters.js";
import { matchesProjectNameGlob } from "../model/sidebar-projection.js";
import {
  windowFilterStore,
  type WindowFilterStore,
} from "./filter-store.js";
import { createFilterEditorService } from "./filter-editor-service.js";
import { useFilterDocumentSync } from "./use-filter-document-sync.js";
import { useWindowFilterSnapshot } from "./use-filter-snapshot.js";

export interface ProjectFilterEditorProps {
  store?: WindowFilterStore;
  projects?: readonly PluginSidebarProject[];
  catalogStatus?: PluginSidebarThreadsState["status"];
}

interface FilterDraft {
  sessionId: number;
  kind: "create" | "edit";
  filterId: string | null;
  baseRevision: number;
  name: string;
  icon: FilterIcon;
  ruleKind: ProjectFilterRule["kind"];
  projectIds: string[];
  globsText: string;
  conflictRevision: number | null;
}

interface PendingDelete {
  definition: ProjectFilterDefinition;
  expectedRevision: number;
}

interface DeleteConflict {
  filterId: string;
  minimumRevision: number;
}

function createDraft(revision: number, sessionId: number): FilterDraft {
  return {
    sessionId,
    kind: "create",
    filterId: null,
    baseRevision: revision,
    name: "",
    icon: DEFAULT_FILTER_ICON,
    ruleKind: "nameGlobs",
    projectIds: [],
    globsText: "",
    conflictRevision: null,
  };
}

function editDraft(
  definition: ProjectFilterDefinition,
  revision: number,
  sessionId: number,
): FilterDraft {
  return {
    sessionId,
    kind: "edit",
    filterId: definition.id,
    baseRevision: revision,
    name: definition.name,
    icon: definition.icon ?? DEFAULT_FILTER_ICON,
    ruleKind: definition.rule.kind,
    projectIds: definition.rule.kind === "projectIds" ? [...definition.rule.projectIds] : [],
    globsText: definition.rule.kind === "nameGlobs" ? definition.rule.globs.join("\n") : "",
    conflictRevision: null,
  };
}

function draftRule(draft: FilterDraft): ProjectFilterRule {
  return draft.ruleKind === "projectIds"
    ? { kind: "projectIds", projectIds: draft.projectIds }
    : {
        kind: "nameGlobs",
        globs: draft.globsText.split("\n").filter((glob) => glob !== ""),
      };
}

function mutationError(result: Extract<FilterMutationResult, { status: "error" }>): string {
  switch (result.code) {
    case "filter_validation_failed":
      return "Проверьте имя и правило фильтра.";
    case "filter_document_too_large":
      return "В фильтрах слишком много данных для сохранения.";
    case "filter_not_found":
      return "Фильтр больше не существует.";
    case "filter_document_invalid":
      return "Сохранённые фильтры повреждены и не могут быть изменены.";
  }
}

function validateDraft(
  draft: FilterDraft,
  document: FilterDocumentV1,
): { name: string; rule: ProjectFilterRule; icon: FilterIcon } | string {
  const rule = draftRule(draft);
  const normalized = normalizeFilterDefinition({
    id: draft.filterId ?? "new-filter",
    name: draft.name,
    icon: draft.icon,
    rule,
  });
  if (!normalized.success) {
    if (draft.name.trim() === "") return "Введите имя фильтра.";
    if (rule.kind === "nameGlobs" && rule.globs.length === 0) {
      return "Добавьте хотя бы одну непустую маску.";
    }
    return "Это имя нельзя использовать для фильтра.";
  }
  const duplicate = document.filters.some(
    (definition) =>
      definition.id !== draft.filterId
      && filterNameKey(definition.name) === filterNameKey(normalized.value.name),
  );
  if (duplicate) return "Фильтр с таким именем уже существует.";
  return { name: normalized.value.name, rule: normalized.value.rule, icon: normalized.value.icon! };
}

export function ProjectFilterEditor({
  store = windowFilterStore,
  projects: projectOverride,
  catalogStatus: catalogStatusOverride,
}: ProjectFilterEditorProps) {
  const instanceId = useId();
  const listHeadingId = `${instanceId}-filter-list-heading`;
  const previewHeadingId = `${instanceId}-filter-preview-heading`;
  const pinnedModeName = `${instanceId}-pinned-mode`;
  const pinnedFilterId = `${instanceId}-pinned-filter`;
  const pinnedAlwaysId = `${instanceId}-pinned-always`;
  const ruleKindName = `${instanceId}-rule-kind`;
  const globRuleId = `${instanceId}-rule-globs`;
  const staticRuleId = `${instanceId}-rule-static`;
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const projects = projectOverride ?? sidebar.projects;
  const catalogStatus = projectOverride === undefined
    ? sidebar.status
    : catalogStatusOverride ?? "ready";
  const catalogReady = catalogStatus === "ready";
  const ordinaryProjects = useMemo(
    () => catalogReady
      ? projects.filter((project) => !project.isPersonal)
      : [],
    [catalogReady, projects],
  );
  const service = useMemo(() => createFilterEditorService(rpc, store), [rpc, store]);
  useFilterDocumentSync(store);
  const snapshot = useWindowFilterSnapshot(store);
  const [localDocument, setLocalDocument] = useState<FilterDocumentV1 | null>(null);
  const snapshotRevision = snapshot.document?.revision ?? -1;
  const document =
    localDocument !== null && localDocument.revision >= snapshotRevision
      ? localDocument
      : snapshot.document;
  const [draft, setDraft] = useState<FilterDraft | null>(null);
  const draftSequence = useRef(0);
  const draftSession = useRef<number | null>(null);
  draftSession.current = draft?.sessionId ?? null;
  const [search, setSearch] = useState("");
  const [iconLoading, setIconLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteConflict, setDeleteConflict] = useState<DeleteConflict | null>(null);
  const [rereadRequest, setRereadRequest] = useState<{
    draftSessionId: number;
    minimumRevision: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const acceptMutation = (result: FilterMutationResult): boolean => {
    if (result.status === "success") {
      setLocalDocument(result.document);
      setError(null);
      return true;
    }
    if (result.status === "error") {
      setError(mutationError(result));
      return false;
    }
    setError(`Документ изменён на сервере (ревизия ${result.currentRevision}).`);
    return false;
  };

  const replaceDraftFromDocument = useCallback((current: FilterDocumentV1) => {
    if (draft === null) return;
    if (draft.kind === "create") {
      setDraft(createDraft(current.revision, draft.sessionId));
      setError(null);
      return;
    }
    const definition = current.filters.find((filter) => filter.id === draft.filterId);
    if (definition === undefined) {
      setRereadRequest(null);
      setDraft(null);
      setError("Редактируемый фильтр был удалён.");
      return;
    }
    setDraft(editDraft(definition, current.revision, draft.sessionId));
    setError(null);
  }, [draft]);

  function beginCreateDraft() {
    setRereadRequest(null);
    setSearch("");
    setError(null);
    setIconLoading(false);
    setDraft(createDraft(document!.revision, ++draftSequence.current));
  }

  function beginEditDraft(definition: ProjectFilterDefinition) {
    setRereadRequest(null);
    setSearch("");
    setError(null);
    setIconLoading(false);
    setDraft(editDraft(definition, document!.revision, ++draftSequence.current));
  }

  function cancelDraft() {
    setIconLoading(false);
    setRereadRequest(null);
    setError(null);
    setDraft(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft === null || document === null || iconLoading) return;
    const valid = validateDraft(draft, document);
    if (typeof valid === "string") {
      setError(valid);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = draft.kind === "create"
        ? await service.create({
            expectedRevision: draft.baseRevision,
            name: valid.name,
            icon: valid.icon,
            rule: valid.rule,
          })
        : await service.update({
            expectedRevision: draft.baseRevision,
            filterId: draft.filterId!,
            name: valid.name,
            icon: valid.icon,
            rule: valid.rule,
          });
      if (result.status === "conflict") {
        setDraft({ ...draft, conflictRevision: result.currentRevision });
        setError(null);
      } else if (acceptMutation(result)) {
        setRereadRequest(null);
        setDraft(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function runImmediate(action: () => Promise<FilterMutationResult>): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.status === "conflict") {
        setError(`Документ изменён на сервере (ревизия ${result.currentRevision}). Повторите действие после обновления.`);
        return false;
      }
      return acceptMutation(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setPending(false);
    }
  }

  function requestDelete(definition: ProjectFilterDefinition) {
    setError(null);
    setPendingDelete({ definition, expectedRevision: document!.revision });
  }

  function closeDeleteConfirmation() {
    if (pending) return;
    setError(null);
    setPendingDelete(null);
  }

  async function confirmDelete() {
    if (pendingDelete === null) return;
    const request = pendingDelete;
    setPending(true);
    setError(null);
    try {
      const result = await service.delete({
        expectedRevision: request.expectedRevision,
        filterId: request.definition.id,
      });
      if (result.status === "conflict") {
        setPendingDelete(null);
        setDeleteConflict({
          filterId: request.definition.id,
          minimumRevision: result.currentRevision,
        });
        setError(`Документ изменён на сервере (ревизия ${result.currentRevision}). Перечитайте фильтры перед повторным удалением.`);
      } else if (acceptMutation(result)) {
        setPendingDelete(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }

  async function rereadAfterDeleteConflict() {
    if (deleteConflict === null || pending) return;
    const conflict = deleteConflict;
    setPending(true);
    setError(null);
    try {
      const result = await service.read();
      if (result.status === "error") {
        setError("Не удалось перечитать фильтры: ошибка чтения.");
        return;
      }
      if (result.document.revision < conflict.minimumRevision) {
        setError("Текущая версия фильтров ещё не загружена. Повторите попытку.");
        return;
      }
      setLocalDocument(result.document);
      setDeleteConflict(null);
      setError(
        result.document.filters.some((filter) => filter.id === conflict.filterId)
          ? null
          : "Фильтр больше не существует.",
      );
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`Не удалось перечитать фильтры: ${detail}`);
    } finally {
      setPending(false);
    }
  }

  async function rereadDraft() {
    if (draft === null || document === null || draft.conflictRevision === null) return;
    if (document.revision >= draft.conflictRevision) {
      replaceDraftFromDocument(document);
      return;
    }
    const ownerSessionId = draft.sessionId;
    const minimumRevision = draft.conflictRevision;
    setError(null);
    setRereadRequest({
      draftSessionId: ownerSessionId,
      minimumRevision,
    });
    try {
      const result = await service.read();
      if (draftSession.current !== ownerSessionId) return;
      if (result.status === "error") {
        setError("Не удалось перечитать фильтр: ошибка чтения.");
        return;
      }
      if (result.document.revision < minimumRevision) {
        setError("Текущая версия фильтров ещё не загружена. Повторите попытку.");
        return;
      }
      setLocalDocument(result.document);
      replaceDraftFromDocument(result.document);
    } catch (reason) {
      if (draftSession.current !== ownerSessionId) return;
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`Не удалось перечитать фильтр: ${detail}`);
    } finally {
      if (draftSession.current === ownerSessionId) setRereadRequest(null);
    }
  }

  if (document === null) {
    return (
      <p role={snapshot.status === "error" ? "alert" : "status"}>
        {snapshot.errorMessage ?? "Загрузка фильтров…"}
      </p>
    );
  }

  const actionsDisabled =
    pending || draft !== null || pendingDelete !== null || deleteConflict !== null;
  const rereadInFlight =
    rereadRequest !== null
    && draft !== null
    && rereadRequest.draftSessionId === draft.sessionId;
  const catalogById = new Map(ordinaryProjects.map((project) => [project.id, project]));
  const unavailableIds = catalogReady && draft?.ruleKind === "projectIds"
    ? draft.projectIds.filter((id) => !catalogById.has(id))
    : [];
  const searchKey = search.toLowerCase();
  const filteredProjects = ordinaryProjects.filter(
    (project) =>
      project.name.toLowerCase().includes(searchKey)
      || project.id.toLowerCase().includes(searchKey),
  );
  const rule = draft === null ? null : draftRule(draft);
  const preview = rule === null
    ? []
    : ordinaryProjects.filter((project) =>
        rule.kind === "projectIds"
          ? rule.projectIds.includes(project.id)
          : rule.globs.some((glob) => matchesProjectNameGlob(project.name, glob)),
      );
  const catalogMessage = catalogStatus === "loading"
    ? "Загрузка каталога проектов…"
    : catalogStatus === "error"
      ? "Не удалось загрузить каталог проектов."
      : null;

  const move = (filterId: string, offset: -1 | 1) => {
    const index = document.filters.findIndex((filter) => filter.id === filterId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= document.filters.length) return;
    const ids = document.filters.map((filter) => filter.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void runImmediate(() => service.reorder({
      expectedRevision: document.revision,
      filterIds: ids,
    }));
  };

  const setPinnedMode = (pinnedMode: PinnedMode) => {
    if (pinnedMode === document.pinnedMode) return;
    void runImmediate(() => service.setPinnedMode({
      expectedRevision: document.revision,
      pinnedMode,
    }));
  };

  return (
    <div className="flex flex-col gap-4 text-sm font-normal">
      <section aria-labelledby={listHeadingId} className="flex flex-col gap-2">
        <h3 id={listHeadingId} className="text-sm font-semibold">Фильтры проектов</h3>
        {document.filters.length === 0 ? (
          <p className="text-sm text-muted-foreground">Пользовательских фильтров пока нет.</p>
        ) : (
          <TooltipProvider>
            <ul className="min-w-0 flex flex-col gap-2">
              {document.filters.map((definition, index) => (
                <li key={definition.id} className="min-w-0 flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="min-w-0 flex flex-1 items-center gap-2">
                    {definition.icon && <FilterIconView icon={definition.icon} />}
                    <span className="min-w-0 break-words">{definition.name}</span>
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" size="icon" className="size-8 shrink-0" variant="outline" aria-label={`Редактировать ${definition.name}`} disabled={actionsDisabled} onClick={() => beginEditDraft(definition)}>
                        <Icon name="Edit" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Редактировать</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" size="icon" className="size-8 shrink-0" variant="outline" aria-label={`Переместить ${definition.name} вверх`} disabled={actionsDisabled || index === 0} onClick={() => move(definition.id, -1)}>
                        <Icon name="ArrowUp" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Переместить вверх</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" size="icon" className="size-8 shrink-0" variant="outline" aria-label={`Переместить ${definition.name} вниз`} disabled={actionsDisabled || index === document.filters.length - 1} onClick={() => move(definition.id, 1)}>
                        <Icon name="ArrowDown" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Переместить вниз</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button type="button" size="icon" className="size-8 shrink-0" variant="destructive" aria-label={`Удалить ${definition.name}`} disabled={actionsDisabled} onClick={() => requestDelete(definition)}>
                        <Icon name="Trash2" aria-hidden="true" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Удалить</TooltipContent>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </TooltipProvider>
        )}
        <Button type="button" disabled={actionsDisabled} onClick={beginCreateDraft}>
          Создать фильтр
        </Button>
      </section>

      <fieldset disabled={actionsDisabled} className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Режим отображения</legend>
        {([["text", "Текст"], ["icon", "Иконка"], ["icon-text", "Иконка и текст"]] as const).map(([mode, label]) => (
          <label key={mode} htmlFor={`${instanceId}-display-${mode}`} className="flex min-h-6 items-center gap-2">
            <input id={`${instanceId}-display-${mode}`} type="radio" name={`${instanceId}-display-mode`} checked={(document.displayMode ?? "text") === mode} onChange={() => {
              if ((document.displayMode ?? "text") !== mode) void runImmediate(() => service.setDisplayMode({ expectedRevision: document.revision, displayMode: mode }));
            }} />{label}
          </label>
        ))}
      </fieldset>

      <fieldset disabled={actionsDisabled} className="flex flex-col gap-2">
        <legend className="text-sm font-semibold">Закреплённые треды</legend>
        <label htmlFor={pinnedFilterId} className="flex min-h-6 items-center gap-2">
          <input id={pinnedFilterId} type="radio" name={pinnedModeName} checked={document.pinnedMode === "filter"} onChange={() => setPinnedMode("filter")} />
          Фильтровать
        </label>
        <label htmlFor={pinnedAlwaysId} className="flex min-h-6 items-center gap-2">
          <input id={pinnedAlwaysId} type="radio" name={pinnedModeName} checked={document.pinnedMode === "always-show"} onChange={() => setPinnedMode("always-show")} />
          Не фильтровать
        </label>
      </fieldset>

      {draft === null && pendingDelete === null && error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert">{error}</p>
          {deleteConflict !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void rereadAfterDeleteConflict()}
            >
              Перечитать фильтры
            </Button>
          ) : null}
        </div>
      ) : null}

      {draft !== null ? (
        <form className="flex flex-col gap-3 rounded-md border p-3" onSubmit={(event) => void save(event)}>
          <h3 className="text-sm font-semibold">{draft.kind === "create" ? "Новый фильтр" : "Редактировать фильтр"}</h3>
          <label className="flex flex-col gap-1 text-sm">
            Имя фильтра
            <Input aria-label="Имя фильтра" value={draft.name} disabled={pending} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <FilterIconPicker key={draft.sessionId} value={draft.icon} disabled={pending || draft.conflictRevision !== null || rereadInFlight}
            onLoading={setIconLoading}
            onChange={(icon) => setDraft((current) => current?.sessionId === draft.sessionId ? { ...current, icon } : current)} />
          <fieldset disabled={pending} className="flex flex-col gap-2">
            <legend className="text-sm">Правило</legend>
            <label htmlFor={globRuleId} className="flex min-h-6 items-center gap-2">
              <input id={globRuleId} type="radio" name={ruleKindName} checked={draft.ruleKind === "nameGlobs"} onChange={() => setDraft({ ...draft, ruleKind: "nameGlobs" })} />
              Маски имён
            </label>
            <label htmlFor={staticRuleId} className="flex min-h-6 items-center gap-2">
              <input id={staticRuleId} type="radio" name={ruleKindName} checked={draft.ruleKind === "projectIds"} onChange={() => setDraft({ ...draft, ruleKind: "projectIds" })} />
              Выбранные проекты
            </label>
          </fieldset>

          {catalogMessage ? (
            <p role={catalogStatus === "error" ? "alert" : "status"}>
              {catalogMessage}
            </p>
          ) : null}

          {draft.ruleKind === "nameGlobs" ? (
            <label className="flex flex-col gap-1 text-sm">
              Маски проектов
              <textarea aria-label="Маски проектов" className="min-h-24 rounded-md border border-input bg-transparent p-2" disabled={pending} value={draft.globsText} onChange={(event) => setDraft({ ...draft, globsText: event.target.value })} />
              <span className="text-xs text-muted-foreground">Одна маска на строку. * — любое число символов, ? — один символ.</span>
            </label>
          ) : catalogReady ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                Поиск проектов
                <Input aria-label="Поиск проектов" value={search} disabled={pending} onChange={(event) => setSearch(event.target.value)} />
              </label>
              <div role="group" aria-label="Выбранные проекты" className="flex max-h-64 flex-col gap-2 overflow-y-auto">
                {unavailableIds.map((projectId) => (
                  <label key={projectId} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked disabled={pending} onChange={(event) => {
                      if (!event.target.checked) setDraft({ ...draft, projectIds: draft.projectIds.filter((id) => id !== projectId) });
                    }} />
                    Недоступный проект: {projectId}
                  </label>
                ))}
                {filteredProjects.map((project) => {
                  const checked = draft.projectIds.includes(project.id);
                  return (
                    <label key={project.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={checked} disabled={pending} onChange={(event) => setDraft({
                        ...draft,
                        projectIds: event.target.checked ? [...draft.projectIds, project.id] : draft.projectIds.filter((id) => id !== project.id),
                      })} />
                      {project.name}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          <section aria-labelledby={previewHeadingId} className="flex flex-col gap-1">
            <h4 id={previewHeadingId} className="text-sm font-medium">Предпросмотр</h4>
            {!catalogReady ? null : preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет подходящих проектов.</p>
            ) : (
              <ul aria-label="Подходящие проекты" className="list-disc pl-5 text-sm">
                {preview.map((project) => <li key={project.id}>{project.name}</li>)}
              </ul>
            )}
          </section>

          {draft.conflictRevision !== null ? (
            <div role="status" className="flex flex-col gap-2">
              <p>Документ изменён на сервере. Текущая ревизия: {draft.conflictRevision}.</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={pending || rereadInFlight} onClick={() => void rereadDraft()}>Перечитать</Button>
                <Button type="button" variant="outline" disabled={pending} onClick={cancelDraft}>Отменить редактирование</Button>
              </div>
            </div>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending || iconLoading || draft.conflictRevision !== null}>Сохранить фильтр</Button>
            <Button type="button" variant="outline" disabled={pending} onClick={cancelDraft}>Отменить</Button>
          </div>
        </form>
      ) : null}
      <ConfirmDeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) closeDeleteConfirmation();
        }}
      >
        {pendingDelete !== null ? (
          <ConfirmDeleteDialogContent
            title={`Удалить фильтр «${pendingDelete.definition.name}»?`}
            description={(
              <span className="flex flex-col gap-2">
                <span>Фильтр будет удалён из общего списка.</span>
                {error ? <span role="alert" className="text-destructive">{error}</span> : null}
              </span>
            )}
            confirmLabel="Удалить фильтр"
            pending={pending}
            onConfirm={() => void confirmDelete()}
            onCancel={closeDeleteConfirmation}
          />
        ) : null}
      </ConfirmDeleteDialog>
    </div>
  );
}
