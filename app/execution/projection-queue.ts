import type { ExecutionProjection } from "../../shared/execution-projection.js";

/** Serialize reads so invalidations arriving during a batch are always read afterwards. */
export function createProjectionQueue(
  read: (ids: string[]) => Promise<ExecutionProjection[]>,
  apply: (values: ExecutionProjection[]) => void,
) {
  const pending = new Set<string>();
  let running = false;
  let disposed = false;
  async function drain() {
    if (running || disposed) return;
    running = true;
    while (!disposed && pending.size) {
      const ids = [...pending].slice(0, 500);
      ids.forEach((id) => pending.delete(id));
      let values: ExecutionProjection[];
      try { values = await read(ids); }
      catch { values = ids.map((threadId) => ({ threadId, state: "error" })); }
      if (!disposed) apply(values);
    }
    running = false;
  }
  return {
    add(ids: string[]) { ids.forEach((id) => pending.add(id)); void drain(); },
    dispose() { disposed = true; pending.clear(); },
  };
}
