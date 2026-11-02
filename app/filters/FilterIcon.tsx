import { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { DEFAULT_FILTER_ICON, pngIconSrc, type FilterIcon as IconDefinition } from "../../shared/filter-icons.js";

export function FilterIcon({ icon = DEFAULT_FILTER_ICON }: { icon?: IconDefinition }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const src = icon.kind === "png" ? pngIconSrc(icon.data) : null;
  const failed = src !== null && failedSource === src;
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 align-middle" style={{ width: 16, height: 16 }} title={failed ? "Не удалось отобразить PNG" : undefined} data-filter-icon-error={failed || undefined}>
      {icon.kind === "builtin" ? (
        <Icon name={icon.name} className="size-4" style={{ width: 16, height: 16 }} aria-hidden="true" />
      ) : failed ? (
        <span className="text-destructive">!</span>
      ) : (
        <img src={src!} alt="" width={16} height={16} style={{ width: 16, height: 16, objectFit: "contain" }} onError={() => setFailedSource(src)} />
      )}
    </span>
  );
}
