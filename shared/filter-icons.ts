import { z } from "zod";
import { BUILTIN_ICON_NAMES } from "./builtin-icon-names.js";

export const CUSTOM_ICON_MAX_BYTES = 64 * 1024;
export const CUSTOM_ICON_MAX_DIMENSION = 512;
export const CUSTOM_ICON_MAX_PIXELS = 512 * 512;
export const DEFAULT_FILTER_ICON = { kind: "builtin", name: "FilterHorizontal" } as const;
export const displayModeSchema = z.enum(["text", "icon", "icon-text"]);
export type FilterDisplayMode = z.infer<typeof displayModeSchema>;

/** Bounded container/header checks, not a PNG decoder or CRC/deflate validator. */
export function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > CUSTOM_ICON_MAX_BYTES || bytes.length < 45) throw new Error("PNG: максимум 64 КиБ.");
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) throw new Error("Выберите файл PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkName = (offset: number) => String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
  if (view.getUint32(8) !== 13 || chunkName(8) !== "IHDR") throw new Error("Некорректный заголовок PNG.");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 1 || height < 1 || width > CUSTOM_ICON_MAX_DIMENSION || height > CUSTOM_ICON_MAX_DIMENSION || width * height > CUSTOM_ICON_MAX_PIXELS) {
    throw new Error("PNG: размер от 1 до 512 пикселей по каждой стороне.");
  }
  const depths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
  };
  if (!depths[bytes[25]!]?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) {
    throw new Error("Некорректный заголовок PNG.");
  }
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const name = chunkName(offset);
    if (length > bytes.length - offset - 12) throw new Error("Повреждённый PNG.");
    if (["acTL", "fcTL", "fdAT"].includes(name)) throw new Error("Анимированные PNG не поддерживаются.");
    if (offset !== 8 && name === "IHDR") throw new Error("Повреждённый PNG.");
    if (name === "IDAT") hasImageData = true;
    offset += length + 12;
    if (name === "IEND") {
      if (length !== 0 || offset !== bytes.length || !hasImageData) throw new Error("Повреждённый PNG.");
      return { width, height };
    }
  }
  throw new Error("Повреждённый PNG.");
}

export function decodePngData(data: string): Uint8Array {
  if (data.length === 0 || data.length > Math.ceil(CUSTOM_ICON_MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("Некорректные данные PNG (base64, максимум 64 КиБ).");
  }
  const binary = atob(data);
  if (btoa(binary) !== data) throw new Error("Неканонические данные PNG.");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  inspectPng(bytes);
  return bytes;
}
const pngDataSchema = z.string().max(Math.ceil(CUSTOM_ICON_MAX_BYTES / 3) * 4).superRefine((data, context) => {
  try { decodePngData(data); } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Некорректный PNG." });
  }
});
export const filterIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), name: z.enum(BUILTIN_ICON_NAMES) }).strict(),
  z.object({ kind: z.literal("png"), data: pngDataSchema }).strict(),
]);
export type FilterIcon = z.infer<typeof filterIconSchema>;
export function pngIconSrc(data: string): string { return `data:image/png;base64,${data}`; }
