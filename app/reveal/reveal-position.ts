export const REVEAL_ROOT_SELECTOR = "[data-project-first-sidebar]";

// Waits are cancellable, including between archive pages and React commits.
export function waitForReveal<T>(read: () => T | null | undefined | false, signal: AbortSignal, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + timeout;
    const dispose = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { dispose(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    const check = () => {
      if (signal.aborted) return abort();
      let value: T | null | undefined | false;
      try { value = read(); }
      catch (error) { dispose(); reject(error); return; }
      if (value) { dispose(); resolve(value); }
      else if (Date.now() >= deadline) { dispose(); reject(new Error("Не удалось найти элемент в текущем дереве.")); }
      else timer = setTimeout(check, 40);
    };
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

export async function openRevealSidebar(signal: AbortSignal): Promise<HTMLElement> {
  const trigger = document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]');
  if (trigger?.getAttribute("aria-expanded") === "false") trigger.click();
  return waitForReveal(() => {
    const root = document.querySelector<HTMLElement>(REVEAL_ROOT_SELECTOR);
    return root && !root.closest('[inert], [data-sidebar="panel"][data-state="closed"]') && root;
  }, signal).catch((error: unknown) => {
    if (signal.aborted) throw error;
    throw new Error("Откройте Project-first sidebar: выберите его поставщиком списка в настройках BB.");
  });
}

export function findThreadRow(root: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("a[data-sidebar-thread-id]"))
    .find((row) => row.dataset.sidebarThreadId === id && !row.closest('[inert], [data-sidebar-overflow]'));
}

export async function positionRevealThread(root: HTMLElement, threadId: string, signal: AbortSignal): Promise<HTMLElement> {
  const row = await waitForReveal(() => {
    const target = findThreadRow(root, threadId);
    if (target) return target;
    // Placeholders carry the same navigation entries as keyboard traversal.
    const placeholder = Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-windowed-nav]"))
      .find((item) => item.dataset.sidebarWindowedNav?.split(" ").some((entry) => entry.split(":")[0] === threadId));
    placeholder?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    return null;
  }, signal);
  signal.throwIfAborted();
  row.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  row.focus({ preventScroll: true });
  return row;
}

export function positionRevealProject(
  root: HTMLElement,
  projectId: string,
  destination: "project" | "personal-filter" | "personal-section",
  signal: AbortSignal,
): Promise<HTMLElement> {
  return waitForReveal(() => {
    const groupId = destination === "personal-section" ? "threads" : `project:${projectId}`;
    const group = Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-visibility-group]"))
      .find((item) => item.dataset.sidebarVisibilityGroup === groupId && !item.closest('[inert], [data-sidebar-overflow]'));
    const target = destination === "personal-filter"
      ? root.querySelector<HTMLElement>('[data-filter-id="projectless"]')
      : group?.querySelector<HTMLElement>('[data-sidebar-sticky-tier="label"] button[aria-expanded]');
    if (!target) return null;
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    target.focus({ preventScroll: true });
    return target;
  }, signal);
}
