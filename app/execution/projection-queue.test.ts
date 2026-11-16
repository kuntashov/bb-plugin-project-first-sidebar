import { expect, it } from "vitest";
import { createProjectionQueue } from "./projection-queue.js";
import type { ExecutionProjection } from "../../shared/execution-projection.js";

it("finishes existing batches and rereads only invalidated IDs when changes arrive during a read", async () => {
  const calls: string[][] = [];
  const applied: ExecutionProjection[] = [];
  const completions: Array<(values: ExecutionProjection[]) => void> = [];
  const queue = createProjectionQueue((ids) => { calls.push(ids); return new Promise((resolve) => completions.push(resolve)); }, (values) => applied.push(...values));
  const ids = Array.from({ length: 501 }, (_, i) => `t${i}`);
  queue.add(ids);
  queue.add(["t0"]);
  completions[0]!([{ threadId: "t0", state: "loading" }]);
  await Promise.resolve(); await Promise.resolve();
  expect(calls[1]).toEqual(["t500", "t0"]);
  completions[1]!([{ threadId: "t500", state: "absent" }, { threadId: "t0", state: "ready", reasoningLevel: "high", serviceTier: "fast" }]);
  await Promise.resolve(); await Promise.resolve();
  expect(applied).toHaveLength(3);
  queue.add(["t42"]);
  expect(calls[2]).toEqual(["t42"]);
  queue.dispose();
  completions[2]!([{ threadId: "t42", state: "absent" }]);
  await Promise.resolve();
  expect(applied).toHaveLength(3);
});
