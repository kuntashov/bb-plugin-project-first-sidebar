import { useEffect } from "react";
import { useAtomValue, useStore } from "jotai";
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

export function usePreferencesReady(): boolean {
  return useAtomValue(preferencesReadyAtom());
}

let syncOwnerCount = 0;

export function usePreferencesSync(): void {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const store = useStore();
  const pluginId = experimental_usePluginId();
  useEffect(() => {
    attachPreferencesStore(store, pluginId);
    const updateFilterVisibility = () => {
      windowFilterStore.setBuiltInFilterVisible(PROJECTLESS_FILTER_ID, store.get(sidebarShowProjectlessFilterAtom));
    };
    const unsubscribeVisibility = store.sub(sidebarShowProjectlessFilterAtom, updateFilterVisibility);
    updateFilterVisibility();
    syncOwnerCount += 1;
    if (syncOwnerCount === 1) {
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
      unsubscribeVisibility();
      syncOwnerCount -= 1;
    };
  }, [pluginId, rpc, store]);
  useRealtime(PREFERENCES_CHANGED_CHANNEL, applyRemotePreferenceSignal);
}

export function PreferencesSync() {
  usePreferencesSync();
  return null;
}
