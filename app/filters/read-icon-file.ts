import { CUSTOM_ICON_MAX_BYTES, inspectPng, pngIconSrc, type FilterIcon } from "../../shared/filter-icons.js";

export async function readIconFile(file: File): Promise<FilterIcon> {
  if (file.size > CUSTOM_ICON_MAX_BYTES) throw new Error("PNG: максимум 64 КиБ.");
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать PNG."));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) reject(new Error("Не удалось прочитать PNG."));
      else resolve(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(file);
  });
  const dimensions = inspectPng(bytes);
  const data = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("Браузер не смог декодировать PNG."));
    image.onload = () => {
      if (image.naturalWidth !== dimensions.width || image.naturalHeight !== dimensions.height) reject(new Error("Некорректный размер PNG."));
      else resolve();
    };
    image.src = pngIconSrc(data);
  });
  return { kind: "png", data };
}
