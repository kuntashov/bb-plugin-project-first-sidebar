// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { TINY_PNG } from "../../checks/filter-appearance/png-fixture.js";
import { readIconFile } from "./read-icon-file.js";
import { createWindowFilterStore } from "./filter-store.js";

installTestPluginRuntime();
const { ProjectFilterEditor } = await import("./ProjectFilterEditor.js");
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function pngFile() { return new File([Uint8Array.from(atob(TINY_PNG), (char) => char.charCodeAt(0))], "custom.png", { type: "image/png" }); }
function imageDriver() {
  const images: FakeImage[] = [];
  class FakeImage {
    naturalWidth = 2;
    naturalHeight = 1;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() { images.push(this); }
  }
  vi.stubGlobal("Image", FakeImage);
  return images;
}
describe("custom file browser decode boundary", () => {
  it("checks bytes independently of MIME/extension and requires successful browser decoding", async () => {
    const images = imageDriver();
    await expect(readIconFile(new File(["<svg onload=evil() />"], "fake.png", { type: "image/png" }))).rejects.toThrow(/PNG/);
    await expect(readIconFile(new File([new Uint8Array(65537)], "large.png"))).rejects.toThrow(/64/);
    expect(images).toHaveLength(0);
    const pending = readIconFile(pngFile());
    await waitFor(() => expect(images).toHaveLength(1));
    expect(images[0]!.src).toBe(`data:image/png;base64,${TINY_PNG}`);
    images[0]!.onerror?.();
    await expect(pending).rejects.toThrow(/декодировать/);
    const valid = readIconFile(pngFile());
    await waitFor(() => expect(images).toHaveLength(2));
    images[1]!.onload?.();
    await expect(valid).resolves.toEqual({ kind: "png", data: TINY_PNG });
  });
  it("does not apply late upload to a cancelled draft and saves a decoded icon atomically", async () => {
    const images = imageDriver();
    const document = { schemaVersion: 1, revision: 5, pinnedMode: "filter", filters: [{ id: "f", name: "Фильтр", rule: { kind: "projectIds", projectIds: [] } }] };
    const update = vi.fn(() => ({ status: "conflict", currentRevision: 6 }));
    const slot = renderSlot({ component: ProjectFilterEditor }, { store: createWindowFilterStore() }, { rpc: { listFilters: () => ({ status: "success", document }), updateFilter: update } });
    fireEvent.click(await slot.findByRole("button", { name: "Редактировать Фильтр" }));
    fireEvent.change(slot.getByLabelText("Загрузить PNG"), { target: { files: [pngFile()] } });
    await waitFor(() => expect(images).toHaveLength(1));
    expect(slot.getByRole("button", { name: "Сохранить фильтр" }).hasAttribute("disabled")).toBe(true);
    expect(slot.queryByText("Свой PNG")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Отменить" }));
    fireEvent.click(slot.getByRole("button", { name: "Редактировать Фильтр" }));
    images[0]!.onload?.();
    await Promise.resolve(); await Promise.resolve();
    expect(slot.queryByText("Свой PNG")).toBeNull(); expect(update).not.toHaveBeenCalled();
    fireEvent.change(slot.getByLabelText("Загрузить PNG"), { target: { files: [pngFile()] } });
    await waitFor(() => expect(images).toHaveLength(2)); images[1]!.onerror?.();
    expect((await slot.findByRole("alert")).textContent).toContain("декодировать");
    expect(slot.queryByText("Свой PNG")).toBeNull();
    fireEvent.change(slot.getByLabelText("Загрузить PNG"), { target: { files: [pngFile()] } });
    await waitFor(() => expect(images).toHaveLength(3)); images[2]!.onload?.();
    await slot.findByText("Свой PNG");
    fireEvent.click(slot.getByRole("button", { name: "Сохранить фильтр" }));
    await slot.findByRole("button", { name: "Перечитать" });
    expect(update).toHaveBeenCalledWith({ expectedRevision: 5, filterId: "f", name: "Фильтр", rule: document.filters[0]!.rule, icon: { kind: "png", data: TINY_PNG } });
    expect(slot.getByText("Свой PNG")).not.toBeNull();
  });
});
