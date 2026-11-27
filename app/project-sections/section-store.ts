import type {
  ProjectSectionDocumentV1,
  ProjectSectionReadResult,
} from "../../shared/project-sections.js";

export interface ProjectSectionListRpc {
  call(method: "listProjectSections", input: null): Promise<ProjectSectionReadResult>;
}

export interface ProjectSectionSnapshot {
  document: ProjectSectionDocumentV1 | null;
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
}

export interface WindowProjectSectionStore {
  acquire(rpc: ProjectSectionListRpc): () => void;
  getSnapshot(): ProjectSectionSnapshot;
  subscribe(listener: () => void): () => void;
  invalidate(): void;
  apply(document: ProjectSectionDocumentV1): void;
}

const EMPTY_SNAPSHOT: ProjectSectionSnapshot = {
  document: null,
  status: "loading",
  errorMessage: null,
};

export function createWindowProjectSectionStore(): WindowProjectSectionStore {
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();
  let rpc: ProjectSectionListRpc | null = null;
  let ownerCount = 0;
  let requestId = 0;

  const publish = (next: ProjectSectionSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const read = () => {
    const client = rpc;
    if (client === null || ownerCount === 0) return;
    const id = ++requestId;
    void client.call("listProjectSections", null).then(
      (result) => {
        if (id !== requestId || ownerCount === 0) return;
        if (result.status === "success") {
          const current = snapshot.document?.revision ?? -1;
          if (snapshot.document !== null && result.document.revision < current) return;
          publish({ document: result.document, status: "ready", errorMessage: null });
          return;
        }
        publish({
          document: snapshot.document,
          status: "error",
          errorMessage: result.issues[0]?.message ?? "Не удалось прочитать секции проекта",
        });
      },
      () => {
        if (id !== requestId || ownerCount === 0) return;
        publish({
          document: snapshot.document,
          status: "error",
          errorMessage: "Не удалось прочитать секции проекта",
        });
      },
    );
  };

  return {
    acquire(client) {
      ownerCount += 1;
      rpc = client;
      if (ownerCount === 1) read();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ownerCount -= 1;
        if (ownerCount === 0) {
          rpc = null;
          requestId += 1;
        }
      };
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate() {
      read();
    },
    apply(document) {
      const current = snapshot.document?.revision ?? -1;
      if (document.revision < current) return;
      publish({ document, status: "ready", errorMessage: null });
    },
  };
}
