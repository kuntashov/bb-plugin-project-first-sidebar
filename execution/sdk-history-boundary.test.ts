import { createBBSdk } from "bb-app";
import { expect, it } from "vitest";
import { readAcceptedProjection } from "./accepted-projection.js";

it("uses the public SDK's history query and recognizes its HTTP 413 error without exposing its body", async () => {
  const queries: URLSearchParams[] = [];
  const sdk = createBBSdk({ baseUrl: "http://127.0.0.1:18888", fetch: async (input) => {
    const url = new URL(String(input));
    queries.push(url.searchParams);
    if (queries.length === 1) return Response.json([{ id: "a", seq: 10, type: "turn/input/accepted", data: { clientRequestId: "r" } }]);
    return Response.json({ error: { code: "event_data_too_large", message: "sensitive example" } }, { status: 413 });
  } });
  const result = await readAcceptedProjection(sdk.threads.events.list, "thread");
  expect(result).toEqual({ state: "error", reason: "too_large" });
  expect(queries.map((q) => [q.get("types"), q.get("order"), q.get("limit"), q.get("beforeSeq")])).toEqual([
    ["turn/input/accepted", "desc", "1", null], ["client/turn/requested", "desc", "1", "10"],
  ]);
  expect(JSON.stringify(result)).not.toContain("sensitive example");
});
