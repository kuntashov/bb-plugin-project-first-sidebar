import { useEffect, useRef, useState } from "react";
import { BUILTIN_ICON_NAMES } from "../../shared/builtin-icon-names.js";
import { DEFAULT_FILTER_ICON, type FilterIcon as IconDefinition } from "../../shared/filter-icons.js";
import { FilterIcon } from "./FilterIcon.js";
import { readIconFile } from "./read-icon-file.js";

export function FilterIconPicker({ value, disabled, onChange, onLoading }: {
  value: IconDefinition;
  disabled: boolean;
  onChange: (value: IconDefinition) => void;
  onLoading: (loading: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current += 1; }, []);
  async function upload(file: File) {
    const sequence = ++request.current;
    setError(null);
    setLoading(true);
    onLoading(true);
    try {
      const icon = await readIconFile(file);
      if (request.current === sequence) onChange(icon);
    } catch (reason) {
      if (request.current === sequence) setError(reason instanceof Error ? reason.message : "Не удалось загрузить PNG.");
    } finally {
      if (request.current === sequence) { setLoading(false); onLoading(false); }
    }
  }
  return (
    <fieldset disabled={disabled || loading} className="flex min-w-0 flex-col gap-2">
      <legend className="text-sm">Иконка фильтра</legend>
      <div className="flex items-center gap-2"><FilterIcon icon={value} /><span className="text-xs">{value.kind === "builtin" ? value.name : "Свой PNG"}</span></div>
      <label className="flex flex-col gap-1 text-sm">Поиск иконок BB
        <input className="rounded-md border p-2" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div role="group" aria-label="Иконки BB" className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
        {BUILTIN_ICON_NAMES.filter((name) => name.toLowerCase().includes(search.toLowerCase())).map((name) => (
          <button key={name} type="button" title={name} aria-label={name} aria-pressed={value.kind === "builtin" && value.name === name}
            className="rounded border p-2 aria-pressed:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            onClick={() => { setError(null); onChange({ kind: "builtin", name }); }}><FilterIcon icon={{ kind: "builtin", name }} /></button>
        ))}
      </div>
      <button type="button" className="self-start text-sm underline" onClick={() => { setError(null); onChange(DEFAULT_FILTER_ICON); }}>Значок по умолчанию</button>
      <label className="flex flex-col gap-1 text-sm">Загрузить PNG
        <input type="file" accept="image/png,.png" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      </label>
      <p className="text-xs text-muted-foreground">Статический PNG, до 64 КиБ, от 1 до 512 пикселей по каждой стороне. Отображение 16 × 16 с сохранением пропорций.</p>
      {loading ? <p role="status">Проверка PNG…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </fieldset>
  );
}
