import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { useSidebarData } from "../model/use-sidebar-data.js";
import type { RevealThread } from "./reveal-plan.js";
import { waitForReveal } from "./reveal-position.js";

type SidebarData = ReturnType<typeof useSidebarData>;

export async function loadRevealChain(
  threadId: string,
  threads: readonly RevealThread[],
  lifecycles: readonly ("active" | "archived")[],
  sdk: Pick<PluginBrowserBbSdk, "threads">,
  signal: AbortSignal,
): Promise<RevealThread[]> {
  const cached = new Map(threads.map((thread) => [thread.id, thread]));
  const chain: RevealThread[] = [];
  const seen = new Set<string>();
  let id: string | null = threadId;
  while (id) {
    signal.throwIfAborted();
    if (seen.has(id)) throw new Error("Обнаружен цикл в родительских тредах.");
    seen.add(id);
    let thread: RevealThread | undefined = cached.get(id);
    if (!thread) {
      const value = await sdk.threads.get({ threadId: id, include: "environment", signal });
      const environment = "environment" in value ? value.environment : null;
      thread = {
        id: value.id, projectId: value.projectId, parentThreadId: value.parentThreadId,
        sectionId: value.sectionId, environment: { id: value.environmentId },
        host: environment?.hostId ? { id: environment.hostId } : null,
        isPinned: value.pinnedAt !== null, isArchived: value.archivedAt !== null,
        isHidden: value.visibility === "hidden",
      };
    }
    // A parent excluded by lifecycle does not participate in sidebar placement.
    const lifecycle = thread.isArchived ? "archived" : "active";
    const targetLifecycle = chain[0]?.isArchived ? "archived" : "active";
    if (chain.length && lifecycle !== targetLifecycle && !lifecycles.includes(lifecycle)) break;
    chain.push(thread);
    id = thread.parentThreadId;
  }
  return chain;
}

// Only explicit reveal calls this. Stop paging as soon as the requested path
// exists; loading an archive page never changes the lifecycle of a thread.
export async function loadRevealTarget(
  chain: readonly RevealThread[],
  read: () => SidebarData,
  signal: AbortSignal,
) {
  const threadId = chain[0]!.id;
  const needsArchive = chain.some((item) => item.isArchived);
  while (true) {
    const current = await waitForReveal(() => {
      const value = read();
      if (value.status === "error" || value.archived?.status === "error") {
        throw new Error("Не удалось загрузить список тредов.");
      }
      return value.status === "ready" && (!needsArchive || value.archived?.status === "ready") && value;
    }, signal);
    const target = current.threads.find((item) => item.id === threadId);
    const missingArchiveAncestors = chain.some((item) => item.isArchived && !current.threads.some((loaded) => loaded.id === item.id));
    if (target && !missingArchiveAncestors) {
      return waitForReveal(() => {
        const threads = read().threads;
        const allUnhidden = chain.filter((item) => item.isHidden)
          .every((item) => threads.some((loaded) => loaded.id === item.id && !loaded.isHidden));
        return allUnhidden && threads.find((item) => item.id === threadId && !item.isHidden);
      }, signal);
    }
    const archive = current.archived;
    if (!needsArchive || !archive?.hasNextPage) {
      throw new Error("Тред отсутствует в доступном списке. Его состояние могло измениться; повторите команду.");
    }
    await archive.fetchNextPage();
    signal.throwIfAborted();
    await waitForReveal(() => {
      const next = read();
      if (next.archived?.isFetchNextPageError) throw new Error("Не удалось загрузить страницу архива.");
      return (next.threads !== current.threads || next.archived !== current.archived) && !next.archived?.isFetchingNextPage;
    }, signal);
  }
}
