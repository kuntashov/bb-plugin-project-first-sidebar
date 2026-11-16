import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import { PROJECT_SECTIONS_CHANGED_CHANNEL } from "../../shared/project-sections.js";
import {
  createWindowProjectSectionStore,
  type ProjectSectionSnapshot,
  type WindowProjectSectionStore,
} from "./section-store.js";

const ProjectSectionStoreContext = createContext<WindowProjectSectionStore | null>(null);

const EMPTY_SNAPSHOT: ProjectSectionSnapshot = {
  document: null,
  status: "loading",
  errorMessage: null,
};

function subscribeNothing() {
  return () => undefined;
}

export function useProjectSectionStore(): WindowProjectSectionStore | null {
  return useContext(ProjectSectionStoreContext);
}

export function useProjectSectionSnapshot(): ProjectSectionSnapshot {
  const store = useProjectSectionStore();
  return useSyncExternalStore(
    store?.subscribe ?? subscribeNothing,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => store?.getSnapshot() ?? EMPTY_SNAPSHOT,
  );
}

function ProjectSectionStatusMarker() {
  const snapshot = useProjectSectionSnapshot();
  return <span hidden data-project-section-status={snapshot.status} />;
}

export function ProjectSectionSync({ children }: { children: ReactNode }) {
  const [store] = useState(createWindowProjectSectionStore);
  const rpc = useRpc<typeof projectFirstSidebarRpcContract>();
  const connectionState = useRealtimeConnectionState();
  const previousConnectionState = useRef(connectionState);
  useEffect(() => store.acquire(rpc), [rpc, store]);
  useEffect(() => {
    if (
      previousConnectionState.current === "reconnecting"
      && connectionState === "connected"
    ) {
      store.invalidate();
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, store]);
  useRealtime(PROJECT_SECTIONS_CHANGED_CHANNEL, () => {
    store.invalidate();
  });
  return (
    <ProjectSectionStoreContext.Provider value={store}>
      <ProjectSectionStatusMarker />
      {children}
    </ProjectSectionStoreContext.Provider>
  );
}
