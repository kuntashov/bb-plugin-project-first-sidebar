import { describe, expect, it } from "vitest";
import { executionAppearance, type ExecutionProjection } from "./execution-projection.js";

describe("execution title appearance", () => {
  it.each([
    ["high", "fast", "red"], ["ultra", "priority", "orange"], ["custom", "fast", "purple"], [null, "fast", "purple"], ["max", null, "orange"], ["medium", "ultrafast", null], ["High", "fast", "purple"],
  ] as const)("classifies reasoning %s and tier %s independently", (reasoningLevel, serviceTier, color) => {
    expect(executionAppearance({ threadId: "t", state: "ready", reasoningLevel, serviceTier }).color).toBe(color);
  });
  it.each(["absent", "loading", "unverified", "error"] as const)("does not assign a current colour to %s", (state) => {
    const appearance = executionAppearance({ threadId: "t", state } as ExecutionProjection);
    expect(appearance.color).toBeNull();
    expect(appearance.explanation).not.toBe("");
  });
});
