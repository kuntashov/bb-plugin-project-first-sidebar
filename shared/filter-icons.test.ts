import { describe, expect, it } from "vitest";
import { BUILTIN_ICON_NAMES } from "./builtin-icon-names.js";
import { decodePngData, filterIconSchema, inspectPng } from "./filter-icons.js";
import { defaultFilterDocument, parseFilterDocument, validateFilterDocumentSize } from "./filters.js";
import { TINY_PNG } from "../checks/filter-appearance/png-fixture.js";

function png() { return Uint8Array.from(Buffer.from(TINY_PNG, "base64")); }
describe("bounded PNG icon input", () => {
  it("accepts a real tiny non-square PNG and the complete names-only catalogue", () => {
    expect(inspectPng(png())).toEqual({ width: 2, height: 1 });
    expect(decodePngData(TINY_PNG)).toEqual(png());
    expect(new Set(BUILTIN_ICON_NAMES).size).toBe(180);
    for (const name of BUILTIN_ICON_NAMES) expect(filterIconSchema.safeParse({ kind: "builtin", name }).success).toBe(true);
    expect(filterIconSchema.safeParse({ kind: "builtin", name: "private/not-builtin" }).success).toBe(false);
  });
  it.each(["<svg onload=alert(1) />", "<html></html>", "javascript:alert(1)", "https://example.org/icon.png"])("rejects non-PNG input %s", (text) => {
    expect(filterIconSchema.safeParse({ kind: "png", data: Buffer.from(text).toString("base64") }).success).toBe(false);
  });
  it.each(["", "!!!!", TINY_PNG + "\n", "data:image/png;base64," + TINY_PNG, "A".repeat(90000)])("rejects invalid/oversize base64", (data) => {
    expect(() => decodePngData(data)).toThrow();
  });
  it.each([0, 513, 0xffffffff])("rejects dimension %s before browser decode", (width) => {
    const bytes = png(); new DataView(bytes.buffer).setUint32(16, width);
    expect(() => inspectPng(bytes)).toThrow(/512/);
  });
  it("accepts the explicit maximum dimensions and rejects invalid IHDR/container/APNG", () => {
    const bytes = png(); const view = new DataView(bytes.buffer);
    view.setUint32(16, 512); view.setUint32(20, 512);
    expect(inspectPng(bytes)).toEqual({ width: 512, height: 512 });
    bytes[24] = 3; expect(() => inspectPng(bytes)).toThrow(/заголовок/);
    const apng = png(); apng.set(new TextEncoder().encode("acTL"), 37);
    expect(() => inspectPng(apng)).toThrow(/Анимированные/);
    const badLength = png(); new DataView(badLength.buffer).setUint32(33, 0xffffffff);
    expect(() => inspectPng(badLength)).toThrow();
    expect(() => inspectPng(png().slice(0, -1))).toThrow();
    expect(() => inspectPng(new Uint8Array([...png(), 0]))).toThrow();
    expect(() => inspectPng(new Uint8Array(65537))).toThrow();
  });
  it("documents the deliberate header-only server boundary for corrupted compressed bytes", () => {
    const bytes = png(); bytes[41] ^= 255;
    expect(inspectPng(bytes)).toEqual({ width: 2, height: 1 });
  });
});

it("retains the aggregate document cap independently of the per-file cap", () => {
  const tiny = Uint8Array.from(Buffer.from(TINY_PNG, "base64"));
  const chunk = new Uint8Array(60_012);
  new DataView(chunk.buffer).setUint32(0, 60_000);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  const padded = new Uint8Array(tiny.length + chunk.length);
  padded.set(tiny.subarray(0, 33)); padded.set(chunk, 33); padded.set(tiny.subarray(33), 33 + chunk.length);
  const icon = { kind: "png" as const, data: Buffer.from(padded).toString("base64") };
  expect(filterIconSchema.safeParse(icon).success).toBe(true);
  const document = { ...defaultFilterDocument(), filters: Array.from({ length: 4 }, (_, index) => ({ id: String(index), name: `Filter ${index}`, rule: { kind: "projectIds" as const, projectIds: [] }, icon })) };
  expect(parseFilterDocument(document).success).toBe(true);
  expect(validateFilterDocumentSize(document)).toMatchObject({ success: false, code: "filter_document_too_large" });
});
