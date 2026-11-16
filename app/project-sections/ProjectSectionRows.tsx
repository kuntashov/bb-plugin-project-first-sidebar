import { useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useAtomValue, useSetAtom } from "jotai";
import { experimental_NewThreadComposer as NewThreadComposer, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { ActionMenuItem } from "@/components/ui/action-menu-items";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RenameDialog, useNameValidation } from "@/components/ui/rename-dialog";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/ui/confirm-delete-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { SIDEBAR_CONTROL_BUTTON_CLASS } from "@/components/ui/sidebar-row-classes";
import {
  SIDEBAR_GROUP_TEXT_CLASS,
  SIDEBAR_ROW_BASE_CLASS,
  getSidebarThreadRowPaddingLeft,
} from "@/components/ui/sidebar-row-classes";
import { cn } from "@/lib/utils";
import { useSidebarSortable, type SidebarSortableDragBindings } from "@/components/ui/sortable-motion";
import { useChronologicalSectionThreadDnd } from "../dnd/SectionThreadDndContext.js";
import {
  SectionDropTargetOverlay,
  useSectionDropTargetState,
} from "../dnd/useSectionDropTargetState.js";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import {
  PROJECT_SECTION_NAME_MAX_LENGTH,
  projectSectionCollapseKey,
  type ProjectSectionDefinition,
} from "../../shared/project-sections.js";
import { sidebarCollapsedThreadSectionsAtom } from "../preferences/atoms.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { getCollapsedChildActivity } from "../model/thread-activity.js";
import { NO_THREAD_IDS, useThreadsHaveDraft } from "../list/sidebarDraftPresence.js";
import {
  usePluginThreadRowStatusForThreads,
  useThreadGroupSplitIndicator,
} from "../list/groupRollups.js";
import { CollapsedThreadStatusGlyph } from "../rows/ThreadRow.js";
import { SplitPaneMiniMap } from "../rows/SplitPaneMiniMap.js";
import { SidebarChildToggleChevron } from "../rows/SidebarChildToggleChevron.js";
import { useSidebarRename } from "../rows/SidebarInlineRename.js";
import type { ProjectActionsMenuSurface } from "../list/ProjectActionsMenu.js";
import {
  useProjectSectionSnapshot,
  useProjectSectionStore,
} from "./ProjectSectionSync.js";

const DELETE_DESCRIPTION = "Треды снова показываются непосредственно под проектом. Сами треды, родители, закрепление, архив и штатная секция не изменяются.";
const NO_SECTION_THREADS: readonly SidebarThread[] = [];

function projectSectionDraftKey(sectionId: string): string {
  return `project-section:${sectionId}`;
}

function createThreadErrorMessage(code: string): string {
  switch (code) {
    case "project_mismatch":
      return "Выбран другой проект. Тред не создан, черновик сохранён.";
    case "section_unavailable":
      return "Секция уже удалена. Тред не создан, черновик сохранён.";
    default:
      return "Не удалось создать тред. Черновик сохранён.";
  }
}

export function CreateProjectSectionMenuItem({
  surface,
  onSelect,
}: {
  surface: ProjectActionsMenuSurface;
  onSelect: () => void;
}) {
  const store = useProjectSectionStore();
  if (store === null) return null;
  return (
    <ActionMenuItem surface={surface} icon="Plus" onSelect={onSelect}>
      Создать секцию
    </ActionMenuItem>
  );
}

export function ProjectSectionCreateDialog({
  open,
  projectId,
  onOpenChange,
}: {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <RenameDialog open={open} onOpenChange={onOpenChange}>
      {(inputRef) => open ? (
        <ProjectSectionCreateForm
          projectId={projectId}
          inputRef={inputRef}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
    </RenameDialog>
  );
}

function ProjectSectionCreateForm({
  projectId,
  inputRef,
  onClose,
}: {
  projectId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: () => void;
}) {
  const store = useProjectSectionStore();
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const [name, setName] = useState("");
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { validationMessage, validate, clearMessage } = useNameValidation({
    emptyMessage: "Имя секции не может быть пустым.",
    maxLength: {
      limit: PROJECT_SECTION_NAME_MAX_LENGTH,
      message: "Имя секции не длиннее 200 символов.",
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || store === null) return;
    const trimmed = validate(name);
    if (trimmed === null) return;
    setPending(true);
    setServerMessage(null);
    const expectedRevision = store.getSnapshot().document?.revision ?? 0;
    void rpc.call("createProjectSection", { expectedRevision, projectId, name: trimmed }).then(
      (result) => {
        if (result.status === "success") {
          store.apply(result.document);
          onClose();
          return;
        }
        if (result.status === "conflict") {
          store.invalidate();
          setServerMessage("Секция изменилась в другом окне. Проверьте список и повторите.");
          return;
        }
        setServerMessage(result.issues[0]?.message ?? "Не удалось создать секцию");
      },
      () => setServerMessage("Не удалось создать секцию"),
    ).finally(() => setPending(false));
  };

  const message = validationMessage ?? serverMessage;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Создать секцию</DialogTitle>
        <DialogDescription>Пустая секция в конце этого проекта.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Input
            ref={inputRef}
            aria-label="Имя секции"
            value={name}
            disabled={pending}
            autoCapitalize="sentences"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setName(event.target.value);
              setServerMessage(null);
              clearMessage();
            }}
          />
          {message ? <p className="text-sm text-destructive">{message}</p> : null}
        </div>
        <DialogFooter>
          <Button type="submit" disabled={pending}>Создать секцию</Button>
        </DialogFooter>
      </form>
    </>
  );
}

export function ProjectSectionList({
  projectId,
  renderSectionBody,
  sectionThreads,
}: {
  projectId: string;
  renderSectionBody?: (section: ProjectSectionDefinition) => ReactNode;
  sectionThreads?: (section: ProjectSectionDefinition) => readonly SidebarThread[];
}) {
  const snapshot = useProjectSectionSnapshot();
  const sectionDnd = useChronologicalSectionThreadDnd();
  const document = snapshot.status === "error" ? null : snapshot.document;
  const error = snapshot.status === "error" ? snapshot.errorMessage : null;
  const dragError = sectionDnd?.projectSectionError?.projectId === projectId
    ? sectionDnd.projectSectionError.message
    : null;
  const previewOrder = sectionDnd?.projectSectionPreview?.order?.projectId === projectId
    ? sectionDnd.projectSectionPreview.order.sectionIds
    : null;
  const ids = previewOrder ?? document?.order.find((entry) => entry.projectId === projectId)?.sectionIds ?? [];
  const byId = new Map(
    (document?.sections ?? [])
      .filter((section) => section.projectId === projectId)
      .map((section) => [section.id, section]),
  );
  const sections = ids.flatMap((id) => {
    const section = byId.get(id);
    return section === undefined ? [] : [section];
  });
  if (error === null && sections.length === 0) return null;
  return (
    <div
      data-project-section-list={projectId}
      data-project-section-read-error={error === null ? undefined : ""}
    >
      {error ? (
        <p role="alert" className="px-2 text-sm text-destructive">{error}</p>
      ) : null}
      {dragError ? (
        <p role="alert" className="px-2 text-sm text-destructive">{dragError}</p>
      ) : null}
      <ProjectSectionRows
        projectId={projectId}
        sections={sections}
        renderSectionBody={renderSectionBody}
        sectionThreads={sectionThreads}
      />
    </div>
  );
}

function ProjectSectionNewThreadDialog({
  open,
  projectId,
  sectionId,
  onOpenChange,
}: {
  open: boolean;
  projectId: string;
  sectionId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const navigate = useBbNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submit = (request: { projectId: string }) => {
    const pending = (async () => {
      setErrorMessage(null);
      let result: Awaited<ReturnType<typeof rpc.call<"createProjectSectionThread">>>;
      try {
        result = await rpc.call("createProjectSectionThread", { projectSectionId: sectionId, request });
      } catch (error) {
        setErrorMessage(createThreadErrorMessage("spawn_failed"));
        throw error;
      }
      if (result.status !== "success") {
        setErrorMessage(createThreadErrorMessage(result.code));
        throw new Error(result.code);
      }
      navigate.toThread(result.threadId);
      onOpenChange(false);
    })();
    // The hosted composer keeps the draft only when this promise rejects.
    // The handler keeps that rejection from going unhandled if the caller discards it.
    void pending.catch(() => undefined);
    return pending;
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый тред</DialogTitle>
          <DialogDescription>
            Исходный проект — проект этой секции. Выбор можно сменить.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <div className="min-h-64">
            <NewThreadComposer
              defaultProjectId={projectId}
              draftKey={projectSectionDraftKey(sectionId)}
              onSubmit={submit}
            />
          </div>
        ) : null}
        {errorMessage ? <p role="alert">{errorMessage}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Отмена</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSectionRows({
  projectId,
  sections,
  renderSectionBody,
  sectionThreads,
}: {
  projectId: string;
  sections: ProjectSectionDefinition[];
  renderSectionBody?: (section: ProjectSectionDefinition) => ReactNode;
  sectionThreads?: (section: ProjectSectionDefinition) => readonly SidebarThread[];
}) {
  const threadsFor = (section: ProjectSectionDefinition) =>
    sectionThreads?.(section) ?? NO_SECTION_THREADS;
  const rows = sections.map((section) => (
    <ProjectSectionRow
      key={section.id}
      projectId={projectId}
      section={section}
      body={renderSectionBody?.(section) ?? null}
      descendantThreads={threadsFor(section)}
    />
  ));
  const sectionDnd = useChronologicalSectionThreadDnd();
  if (!sectionDnd) return <>{rows}</>;
  return (
    <SortableContext
      items={sections.map((section) => projectSectionCollapseKey(projectId, section.id))}
      strategy={verticalListSortingStrategy}
    >
      {sections.map((section) => (
        <SortableProjectSectionRow
          key={section.id}
          projectId={projectId}
          section={section}
          body={renderSectionBody?.(section) ?? null}
          descendantThreads={threadsFor(section)}
        />
      ))}
    </SortableContext>
  );
}

function SortableProjectSectionRow(props: {
  projectId: string;
  section: ProjectSectionDefinition;
  body: ReactNode;
  descendantThreads: readonly SidebarThread[];
}) {
  const sortable = useSidebarSortable({
    id: projectSectionCollapseKey(props.projectId, props.section.id),
    disabled: false,
    displace: false,
  });
  return (
    <ProjectSectionRow
      {...props}
      dragBindings={sortable.dragBindings}
      rowRef={sortable.setNodeRef}
      rowStyle={sortable.style}
    />
  );
}

function ProjectSectionRow({
  projectId,
  section,
  body,
  descendantThreads,
  dragBindings,
  rowRef,
  rowStyle,
}: {
  projectId: string;
  section: ProjectSectionDefinition;
  body: ReactNode;
  descendantThreads: readonly SidebarThread[];
  dragBindings?: SidebarSortableDragBindings;
  rowRef?: (element: HTMLElement | null) => void;
  rowStyle?: CSSProperties;
}) {
  const store = useProjectSectionStore();
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const collapsed = useAtomValue(sidebarCollapsedThreadSectionsAtom);
  const setCollapsed = useSetAtom(sidebarCollapsedThreadSectionsAtom);
  const collapseKey = projectSectionCollapseKey(projectId, section.id);
  const dropState = useSectionDropTargetState(collapseKey);
  const isCollapsed = collapsed.includes(collapseKey);
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const activity = getCollapsedChildActivity(descendantThreads);
  const collapsedSplitIndicator = useThreadGroupSplitIndicator(descendantThreads, isCollapsed);
  const pluginStatus = usePluginThreadRowStatusForThreads(descendantThreads);
  const hiddenThreadsHaveDraft = useThreadsHaveDraft(
    isCollapsed ? activity.threadIds : NO_THREAD_IDS,
  );
  const showRollup = isCollapsed && (
    collapsedSplitIndicator.miniMap !== null
    || activity.pending
    || activity.working
    || hiddenThreadsHaveDraft
    || activity.unread
    || activity.unreadError
    || pluginStatus !== null
  );
  const rename = useSidebarRename({
    kind: "project-section",
    id: section.id,
    ownerKey: `project-section:${section.id}`,
    name: section.name,
    label: "Имя секции",
    maxLength: PROJECT_SECTION_NAME_MAX_LENGTH,
    onSave: async (name) => {
      const expectedRevision = store?.getSnapshot().document?.revision ?? 0;
      const result = await rpc.call("renameProjectSection", {
        expectedRevision,
        projectId,
        sectionId: section.id,
        name,
      });
      if (result.status === "success") {
        store?.apply(result.document);
        return;
      }
      if (result.status === "conflict") {
        store?.invalidate();
        throw new Error("revision conflict");
      }
      if (result.code === "not_found") {
        store?.invalidate();
        const error = new Error(result.issues[0]?.message ?? "project section was not found");
        Object.assign(error, { status: 404 });
        throw error;
      }
      throw new Error(result.issues[0]?.message ?? "Не удалось переименовать секцию");
    },
  });
  const toggleCollapsed = () => {
    setCollapsed(isCollapsed
      ? collapsed.filter((key) => key !== collapseKey)
      : [...collapsed, collapseKey]);
  };
  const confirmDelete = () => {
    if (store === null || deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    const expectedRevision = store.getSnapshot().document?.revision ?? 0;
    void rpc.call("deleteProjectSection", {
      expectedRevision,
      projectId,
      sectionId: section.id,
    }).then(
      (result) => {
        if (result.status === "success") {
          store.apply(result.document);
          setDeleteOpen(false);
          return;
        }
        if (result.status === "conflict") store.invalidate();
        setDeleteError(result.status === "conflict"
          ? "Секция изменилась в другом окне. Проверьте список и повторите."
          : result.issues[0]?.message ?? "Не удалось удалить секцию");
      },
      () => setDeleteError("Не удалось удалить секцию"),
    ).finally(() => setDeletePending(false));
  };

  return (
    <div
      data-project-section-id={section.id}
      data-project-section-collapsed={isCollapsed ? "true" : "false"}
    >
    <div
      ref={(element) => {
        rowRef?.(element);
        dragBindings?.setActivatorNodeRef(element);
      }}
      data-sidebar-rename-row=""
      data-sidebar-drop-target={dropState ?? undefined}
      className={cn(SIDEBAR_ROW_BASE_CLASS, SIDEBAR_GROUP_TEXT_CLASS, "relative flex min-w-0 items-center")}
      style={{ paddingLeft: getSidebarThreadRowPaddingLeft(1), ...rowStyle }}
      {...(rename.editor ? {} : dragBindings?.attributes)}
      {...(rename.editor ? {} : dragBindings?.listeners)}
    >
      {dropState ? <SectionDropTargetOverlay state={dropState} /> : null}
      <span className="relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left">
        {rename.editor ?? <span className="min-w-0 truncate">{section.name}</span>}
        <SidebarChildToggleChevron
          disabled={Boolean(rename.editor)}
          className={rename.editor ? "hidden" : undefined}
          isCollapsed={isCollapsed}
          expandLabel={`Развернуть ${section.name}`}
          collapseLabel={`Свернуть ${section.name}`}
          onToggle={toggleCollapsed}
        />
      </span>
      {showRollup ? (
        <span data-sidebar-collapsed-activity-edge="">
          {collapsedSplitIndicator.miniMap ? (
            <SplitPaneMiniMap
              slots={collapsedSplitIndicator.miniMap}
              label={`${section.name} — contains a thread open in split`}
              isWorking={activity.working || pluginStatus?.tone === "running"}
            />
          ) : (
            <CollapsedThreadStatusGlyph activity={activity} pluginStatus={pluginStatus} />
          )}
        </span>
      ) : null}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${section.name}: действия`}
            className={cn(SIDEBAR_CONTROL_BUTTON_CLASS, rename.editor && "hidden")}
          >
            <Icon name="MoreHorizontal" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={rename.onCloseAutoFocus}>
          <ActionMenuItem surface="dropdown" icon="MessageSquarePlus" onSelect={() => setComposerOpen(true)}>
            Новый тред
          </ActionMenuItem>
          <ActionMenuItem surface="dropdown" icon="Edit" onSelect={rename.startEditingFromMenu}>
            Переименовать
          </ActionMenuItem>
          <ActionMenuItem surface="dropdown" icon="Trash2" variant="destructive" onSelect={() => setDeleteOpen(true)}>
            Удалить секцию
          </ActionMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectSectionNewThreadDialog
        open={composerOpen}
        projectId={section.projectId}
        sectionId={section.id}
        onOpenChange={setComposerOpen}
      />
      <ConfirmDeleteDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <ConfirmDeleteDialogContent
          title="Удалить секцию?"
          description={deleteError === null ? DELETE_DESCRIPTION : `${DELETE_DESCRIPTION} ${deleteError}`}
          confirmLabel="Удалить секцию"
          pending={deletePending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteOpen(false)}
        />
      </ConfirmDeleteDialog>
    </div>
      {isCollapsed ? null : body}
    </div>
  );
}
