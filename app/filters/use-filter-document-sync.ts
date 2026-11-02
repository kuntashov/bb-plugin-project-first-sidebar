import { useCallback, useEffect, useRef } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { FILTERS_CHANGED_CHANNEL } from "../../shared/filters.js";
import type { WindowFilterStore } from "./filter-store.js";

export function useFilterDocumentSync(store: WindowFilterStore): void {
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  const invalidate = useCallback(() => store.invalidate(), [store]);

  useRealtime(FILTERS_CHANGED_CHANNEL, invalidate);
  useEffect(() => store.acquire(rpc), [rpc, store]);
  useEffect(() => {
    if (
      previousConnectionState.current === "reconnecting"
      && connectionState === "connected"
    ) {
      store.reconnect();
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, store]);
}
