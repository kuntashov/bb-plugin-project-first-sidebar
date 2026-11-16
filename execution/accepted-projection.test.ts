import { describe, expect, it, vi } from "vitest";
import { readAcceptedProjection } from "./accepted-projection.js";

const accepted = { id: "a", seq: 10, type: "turn/input/accepted", data: { clientRequestId: "wanted" } };
const requested = (seq: number, requestId: string, reasoningLevel = "high", serviceTier = "fast") => ({ id: `r${seq}`, seq, type: "client/turn/requested", data: { requestId, execution: { reasoningLevel, serviceTier } } });

describe("accepted execution projection", () => {
  it("correlates a nonadjacent accepted request across backwards pages", async () => {
    const list = vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([requested(9, "other")]).mockResolvedValueOnce([requested(7, "wanted")]);
    expect(await readAcceptedProjection(list, "thread")).toEqual({ state: "ready", reasoningLevel: "high", serviceTier: "fast", acceptedId: "a", acceptedSeq: 10, requestId: "wanted", requestSeq: 7 });
    expect(list.mock.calls.map(([args]) => [args.limit, args.beforeSeq])).toEqual([["1", undefined], ["1", "10"], ["100", "9"]]);
  });
  it("distinguishes absent and terminal correlation failures", async () => {
    expect(await readAcceptedProjection(vi.fn().mockResolvedValue([]), "t")).toEqual({ state: "absent" });
    expect(await readAcceptedProjection(vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([]), "t")).toEqual({ state: "error", reason: "missing_request" });
    expect(await readAcceptedProjection(vi.fn().mockResolvedValue([{ ...accepted, data: {} }]), "t")).toEqual({ state: "error", reason: "malformed" });
  });
  it.each([{}, { reasoningLevel: "high" }, { serviceTier: "fast" }, { reasoningLevel: null, serviceTier: "fast" }, { reasoningLevel: "high", serviceTier: 1 }])("rejects malformed execution %j", async (execution) => {
    const row = { ...requested(7, "wanted"), data: { requestId: "wanted", execution } };
    expect(await readAcceptedProjection(vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([row]), "t")).toEqual({ state: "error", reason: "malformed" });
  });
  it("preserves unknown string dimensions independently", async () => {
    expect(await readAcceptedProjection(vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([requested(7, "wanted", "custom", "fast")]), "t")).toMatchObject({ state: "ready", reasoningLevel: "custom", serviceTier: "fast" });
  });
  it.each([
    [{ status: 413, message: "sensitive content" }, "too_large"],
    [{ status: 503, message: "sensitive content" }, "transient"],
    [Object.assign(new Error("sensitive content"), { name: "BbRequestTimeoutError" }), "transient"],
    [new Error("sensitive content"), "unknown"],
  ])("returns a safe reason for SDK failure %#", async (error, reason) => {
    const result = await readAcceptedProjection(vi.fn().mockRejectedValue(error), "t");
    expect(result).toEqual({ state: "error", reason });
    expect(JSON.stringify(result)).not.toContain("sensitive content");
  });
});
