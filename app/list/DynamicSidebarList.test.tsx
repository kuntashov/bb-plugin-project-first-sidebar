// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNREAD_FILTER_ID, type DynamicFilterId } from "../filters/dynamic-filter-ids.js";
import { makePluginProject, makeSidebarThread } from "../model/fixtures.js";
import { positionRevealThread } from "../reveal/reveal-position.js";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import { ProjectListShell } from "./ProjectList.js";

installTestPluginRuntime();
const { DynamicSidebarList } = await import("./DynamicSidebarList.js");

function Harness({ filterId, onNavigate, windowed }: {
  filterId: DynamicFilterId;
  onNavigate?: () => void;
  windowed?: boolean;
}) {
  const sidebar = (
    <TooltipProvider>
      <SidebarRenameProvider>
        <ProjectListShell>
          <DynamicSidebarList filterId={filterId} onProjectSelect={onNavigate} />
        </ProjectListShell>
      </SidebarRenameProvider>
    </TooltipProvider>
  );
  return windowed ? (
    <div data-sidebar="content" ref={(node) => {
      if (node) Object.defineProperty(node, "clientHeight", { configurable: true, value: 500 });
    }}>
      {sidebar}
    </div>
  ) : sidebar;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders personal matches with the ordinary thread link and split navigation", () => {
  const project = makePluginProject({ id: "personal", isPersonal: true });
  const thread = makeSidebarThread({ id: "matched", title: "Matched", projectId: project.id, isUnread: true });
  const onNavigate = vi.fn();
  const slot = renderSlot({ component: Harness }, { filterId: UNREAD_FILTER_ID, onNavigate }, {
    sidebarThreads: { projects: [project], threads: [thread] },
  });

  expect(screen.getByRole("heading", { name: "Без проектов" })).toBeTruthy();
  const link = screen.getByRole("link", { name: /Matched/ });
  expect(link.getAttribute("href")).toBe(thread.href);
  const hostNavigation = vi.fn((event: MouseEvent) => {
    expect(event.defaultPrevented).toBe(false);
    event.preventDefault();
  });
  document.addEventListener("click", hostNavigation, { once: true });
  fireEvent.click(link);
  expect(hostNavigation).toHaveBeenCalledOnce();
  expect(onNavigate).toHaveBeenCalledOnce();
  expect(fireEvent.click(link, { ctrlKey: true })).toBe(false);
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "toThread", threadId: thread.id, options: { split: true } },
  ]);
});

it("positions and focuses the matching row when its offscreen placeholder is scrolled into view", async () => {
  const project = makePluginProject();
  const thread = makeSidebarThread({ id: "offscreen", title: "Offscreen", isUnread: true });
  let observer: IntersectionObserverCallback | undefined;
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observer = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const offscreen = new DOMRect(0, 1_000, 300, 30);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.sidebar === "content" ? new DOMRect(0, 0, 300, 500) : offscreen;
    },
  );
  const original = Element.prototype.scrollIntoView;
  const scroll = vi.fn(function (this: HTMLElement) {
    if (!this.hasAttribute("data-sidebar-windowed-nav")) return;
    const entry: IntersectionObserverEntry = {
      target: this,
      isIntersecting: true,
      boundingClientRect: offscreen,
      intersectionRatio: 1,
      intersectionRect: offscreen,
      rootBounds: null,
      time: 0,
    };
    act(() => observer?.([entry], {} as IntersectionObserver));
  });
  Element.prototype.scrollIntoView = scroll;
  try {
    const slot = renderSlot({ component: Harness }, { filterId: UNREAD_FILTER_ID, windowed: true }, {
      sidebarThreads: { projects: [project], threads: [thread] },
    });
    const placeholder = slot.container.querySelector('[data-sidebar-windowed-nav="offscreen:proj_test"]');
    expect(placeholder).not.toBeNull();
    expect(screen.queryByRole("link", { name: /Offscreen/ })).toBeNull();

    const positioning = positionRevealThread(slot.container, thread.id, new AbortController().signal);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: /Offscreen/ })));
    expect(await positioning).toBe(document.activeElement);
    expect(scroll.mock.contexts).toEqual([placeholder, document.activeElement]);
  } finally {
    Element.prototype.scrollIntoView = original;
  }
});
