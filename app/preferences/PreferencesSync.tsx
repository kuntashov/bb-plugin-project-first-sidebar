import { useEffect } from "react";
import { getDefaultStore, useAtomValue, useStore } from "jotai";
import {
  experimental_usePluginId,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { PROJECTLESS_FILTER_ID, windowFilterStore } from "../filters/filter-store.js";
import { sidebarShowProjectlessFilterAtom } from "./atoms.js";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { PREFERENCES_CHANGED_CHANNEL } from "../../shared/preferences.js";
import {
  applyRemotePreferenceSignal,
  attachPreferencesStore,
  hydratePreferences,
  hydratePreferencesFromMirror,
  preferencesReadyAtom,
} from "./preferences-sync.js";

export const sidebarPreferencesStore = getDefaultStore();

export function usePreferencesReady(): boolean {
  return useAtomValue(preferencesReadyAtom());
}

let syncOwnerCount = 0;
let unsubscribeVisibility: (() => void) | undefined;

export function usePreferencesSync(storeOverride?: ReturnType<typeof useStore>): void {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const store = useStore({ store: storeOverride });
  const pluginId = experimental_usePluginId();
  useEffect(() => {
    syncOwnerCount += 1;
    if (syncOwnerCount === 1) {
      attachPreferencesStore(store, pluginId);
      const updateFilterVisibility = () => {
        windowFilterStore.setBuiltInFilterVisible(PROJECTLESS_FILTER_ID, store.get(sidebarShowProjectlessFilterAtom));
      };
      const readyAtom = preferencesReadyAtom();
      const updateVisibilityReadiness = () => {
        windowFilterStore.setBuiltInVisibilityReady(store.get(readyAtom));
      };
      const stopVisibility = store.sub(sidebarShowProjectlessFilterAtom, updateFilterVisibility);
      const stopReadiness = store.sub(readyAtom, updateVisibilityReadiness);
      unsubscribeVisibility = () => { stopVisibility(); stopReadiness(); };
      updateFilterVisibility();
      updateVisibilityReadiness();
      hydratePreferencesFromMirror();
      void hydratePreferences(rpc).catch((error: unknown) => {
        console.warn(
          `${pluginId}: loading preferences failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }
    return () => {
      syncOwnerCount -= 1;
      if (syncOwnerCount === 0) {
        unsubscribeVisibility?.();
        unsubscribeVisibility = undefined;
      }
    };
  }, [pluginId, rpc, store]);
  useRealtime(PREFERENCES_CHANGED_CHANNEL, applyRemotePreferenceSignal);
}

export function PreferencesSync() {
  usePreferencesSync();
  return null;
}
