import { useMemo } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { DynamicFilterId } from "../filters/dynamic-filter-ids.js";
import { projectDynamicSidebar } from "./dynamic-sidebar-projection.js";

const ACTIVE_LIFECYCLES = ["active"] as const;

export function useDynamicSidebar(filterId: DynamicFilterId | null) {
  const { projects, threads, status } = experimental_useSidebarThreads({
    experimental_lifecycles: ACTIVE_LIFECYCLES,
  });
  const projection = useMemo(
    () => filterId !== null && status === "ready"
      ? projectDynamicSidebar({ projects, threads }, filterId)
      : null,
    [filterId, projects, threads, status],
  );
  return { status, projection };
}
