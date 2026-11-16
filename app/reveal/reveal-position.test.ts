// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { positionRevealThread, openRevealSidebar, waitForReveal } from "./reveal-position.js";
afterEach(() => { document.body.replaceChildren(); });

describe("reveal positioning", () => {
  it("realizes a windowed thread and focuses only the sidebar row", async () => {
    document.body.innerHTML = '<a data-sidebar-thread-id="child" href="#">Other surface</a><div data-project-first-sidebar><div data-sidebar-windowed-nav="child:app"></div></div>';
    const root = document.querySelector<HTMLElement>("[data-project-first-sidebar]")!;
    const placeholder = root.firstElementChild!;
    placeholder.scrollIntoView = vi.fn(() => {
      root.innerHTML = '<a data-sidebar-thread-id="child" href="#">Child</a>';
      root.firstElementChild!.scrollIntoView = vi.fn();
    });
    const row = await positionRevealThread(root, "child", new AbortController().signal);
    expect(placeholder.scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(row);
    expect(root.contains(row)).toBe(true);
  });

  it("opens the closed drawer before waiting for the provider", async () => {
    const trigger = document.createElement("button");
    trigger.dataset.sidebar = "trigger";
    trigger.setAttribute("aria-expanded", "false");
    trigger.onclick = () => {
      trigger.setAttribute("aria-expanded", "true");
      const root = document.createElement("div");
      root.dataset.projectFirstSidebar = "";
      document.body.append(root);
    };
    document.body.append(trigger);
    const root = await openRevealSidebar(new AbortController().signal);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(root.dataset.projectFirstSidebar).toBe("");
  });

  it("cancels pending virtualization work immediately", async () => {
    const controller = new AbortController();
    const root = document.createElement("div");
    const position = positionRevealThread(root, "missing", controller.signal);
    controller.abort();
    await expect(position).rejects.toMatchObject({ name: "AbortError" });
    root.innerHTML = '<a data-sidebar-thread-id="missing" href="#">Missing</a>';
    expect(document.activeElement).not.toBe(root.firstElementChild);
  });

  it("propagates failures from a later asynchronous readiness check", async () => {
    let reads = 0;
    await expect(waitForReveal(() => {
      if (++reads > 1) throw new Error("Archive query failed");
      return null;
    }, new AbortController().signal)).rejects.toThrow("Archive query failed");
  });
});
