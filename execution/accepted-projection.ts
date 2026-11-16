import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export type ProjectionErrorReason = "too_large" | "malformed" | "missing_request" | "transient" | "unknown";
export type AcceptedProjection =
  | { state: "absent" }
  | { state: "error"; reason: ProjectionErrorReason }
  | { state: "ready"; reasoningLevel: string | null; serviceTier: string | null; acceptedId: string; acceptedSeq: number; requestId: string; requestSeq: number };

type ListEvents = BbPluginApi["sdk"]["threads"]["events"]["list"];
const sequence = z.number().int().nonnegative().safe();
const acceptedSchema = z.object({ id: z.string().min(1), seq: sequence, type: z.literal("turn/input/accepted"), data: z.object({ clientRequestId: z.string().min(1) }) });
const requestedSchema = z.object({ id: z.string().min(1), seq: sequence, type: z.literal("client/turn/requested"), data: z.object({ requestId: z.string().min(1), execution: z.unknown().optional() }) });
const executionSchema = z.object({ reasoningLevel: z.string(), serviceTier: z.string() });

/** Only classify structured transport facts. Unknown failures must not be retried as transient by assumption. */
function sdkFailure(error: unknown): AcceptedProjection {
  if (typeof error !== "object" || error === null) return { state: "error", reason: "unknown" };
  const value = error as { status?: unknown; name?: unknown; code?: unknown; cause?: unknown };
  if (value.status === 413) return { state: "error", reason: "too_large" };
  if (typeof value.status === "number" && [408, 429, 502, 503, 504].includes(value.status)) return { state: "error", reason: "transient" };
  const cause = value.cause;
  const causeCode = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  if (value.name === "BbRequestTimeoutError" || (typeof value.code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(value.code)) || (typeof causeCode === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(causeCode))) return { state: "error", reason: "transient" };
  return { state: "error", reason: "unknown" };
}

/** Reads only the correlated execution pair; event bodies never escape this function. */
export async function readAcceptedProjection(list: ListEvents, threadId: string, appendOnlyPrevious?: Extract<AcceptedProjection, { state: "ready" }>): Promise<AcceptedProjection> {
  let acceptedRows;
  try {
    acceptedRows = await list({ threadId, types: ["turn/input/accepted"], order: "desc", limit: "1" });
  } catch (error) {
    return sdkFailure(error);
  }
  if (!Array.isArray(acceptedRows)) return { state: "error", reason: "malformed" };
  if (acceptedRows.length === 0) return { state: "absent" };
  const parsedAccepted = acceptedSchema.safeParse(acceptedRows[0]);
  if (!parsedAccepted.success || acceptedRows.length !== 1) return { state: "error", reason: "malformed" };
  const accepted = parsedAccepted.data;
  // This shortcut is only valid for an observed append after a verified read.
  // Rewrites, reconnects and startup must read the request again even when IDs match.
  if (appendOnlyPrevious && accepted.id === appendOnlyPrevious.acceptedId && accepted.seq === appendOnlyPrevious.acceptedSeq && accepted.data.clientRequestId === appendOnlyPrevious.requestId) return appendOnlyPrevious;
  let before = accepted.seq;
  let limit = "1";
  while (true) {
    let rows;
    try {
      rows = await list({ threadId, types: ["client/turn/requested"], order: "desc", limit, beforeSeq: String(before) });
    } catch (error) {
      return sdkFailure(error);
    }
    if (!Array.isArray(rows) || rows.length > Number(limit)) return { state: "error", reason: "malformed" };
    if (!rows.length) return { state: "error", reason: "missing_request" };
    for (const row of rows) {
      const parsed = requestedSchema.safeParse(row);
      if (!parsed.success || parsed.data.seq >= before) return { state: "error", reason: "malformed" };
      const request = parsed.data;
      before = request.seq;
      if (request.data.requestId === accepted.data.clientRequestId) {
        const execution = executionSchema.safeParse(request.data.execution);
        if (!execution.success) return { state: "error", reason: "malformed" };
        return { state: "ready", reasoningLevel: execution.data.reasoningLevel || null, serviceTier: execution.data.serviceTier || null, acceptedId: accepted.id, acceptedSeq: accepted.seq, requestId: request.data.requestId, requestSeq: request.seq };
      }
    }
    limit = "100";
  }
}
