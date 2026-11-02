import { useSyncExternalStore } from "react";
import {
  windowFilterStore,
  type WindowFilterSnapshot,
  type WindowFilterStore,
} from "./filter-store.js";

export function useWindowFilterSnapshot(
  store: WindowFilterStore = windowFilterStore,
): WindowFilterSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
