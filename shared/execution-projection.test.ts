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
  it.each([
    [null, "fast", "reasoning unknown; service tier fast", "purple"],
    ["high", null, "reasoning high; service tier unknown", "orange"],
    [null, null, "reasoning unknown; service tier unknown", null],
  ] as const)("explains independently unknown dimensions", (reasoningLevel, serviceTier, values, color) => {
    const appearance = executionAppearance({ threadId: "t", state: "ready", reasoningLevel, serviceTier });
    expect(appearance.color).toBe(color);
    expect(appearance.explanation).toContain(values);
    expect(appearance.explanation).toContain("this thread's saved history");
    expect(appearance.explanation).toContain("Updated when saved history is indexed");
  });
});
