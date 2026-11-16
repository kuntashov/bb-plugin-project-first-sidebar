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
  it("distinguishes absent from unmatchable, malformed, and unreadable history", async () => {
    expect(await readAcceptedProjection(vi.fn().mockResolvedValue([]), "t")).toEqual({ state: "absent" });
    expect(await readAcceptedProjection(vi.fn().mockResolvedValueOnce([accepted]).mockResolvedValueOnce([]), "t")).toEqual({ state: "error" });
    expect(await readAcceptedProjection(vi.fn().mockResolvedValue([{ ...accepted, data: {} }]), "t")).toEqual({ state: "error" });
    expect(await readAcceptedProjection(vi.fn().mockRejectedValue(new Error("413")), "t")).toEqual({ state: "error" });
  });
});
