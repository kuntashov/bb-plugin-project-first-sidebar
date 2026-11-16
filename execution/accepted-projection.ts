import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type AcceptedProjection =
  | { state: "absent" }
  | { state: "error" }
  | { state: "ready"; reasoningLevel: string | null; serviceTier: string | null; acceptedId: string; acceptedSeq: number; requestId: string; requestSeq: number };

type ListEvents = BbPluginApi["sdk"]["threads"]["events"]["list"];

/** Reads only the correlated execution pair; event bodies never escape this function. */
export async function readAcceptedProjection(list: ListEvents, threadId: string): Promise<AcceptedProjection> {
  try {
    const acceptedRows = await list({ threadId, types: ["turn/input/accepted"], order: "desc", limit: "1" });
    if (acceptedRows.length === 0) return { state: "absent" };
    const accepted = acceptedRows[0];
    if (accepted.type !== "turn/input/accepted" || !accepted.id || !Number.isSafeInteger(accepted.seq) || accepted.seq < 0 || typeof accepted.data.clientRequestId !== "string" || !accepted.data.clientRequestId) return { state: "error" };
    let before = accepted.seq;
    let limit = "1";
    while (true) {
      const rows = await list({ threadId, types: ["client/turn/requested"], order: "desc", limit, beforeSeq: String(before) });
      if (!rows.length) return { state: "error" };
      for (const row of rows) {
        if (row.type !== "client/turn/requested" || !row.id || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq >= before || typeof row.data.requestId !== "string" || !row.data.requestId) return { state: "error" };
        before = row.seq;
        if (row.data.requestId === accepted.data.clientRequestId) {
          const execution = row.data.execution;
          if (!execution || typeof execution !== "object") return { state: "error" };
          const reasoningLevel = execution.reasoningLevel;
          const serviceTier = execution.serviceTier;
          if ((reasoningLevel != null && typeof reasoningLevel !== "string") || (serviceTier != null && typeof serviceTier !== "string")) return { state: "error" };
          return { state: "ready", reasoningLevel: reasoningLevel || null, serviceTier: serviceTier || null, acceptedId: accepted.id, acceptedSeq: accepted.seq, requestId: row.data.requestId, requestSeq: row.seq };
        }
      }
      limit = "100";
    }
  } catch {
    return { state: "error" };
  }
}
