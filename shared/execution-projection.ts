import { z } from "zod";

export const EXECUTION_CHANGED_CHANNEL = "execution-projection-changed";

export const executionProjectionSchema = z.discriminatedUnion("state", [
  z.object({ threadId: z.string().min(1), state: z.literal("loading") }).strict(),
  z.object({ threadId: z.string().min(1), state: z.literal("unverified") }).strict(),
  z.object({ threadId: z.string().min(1), state: z.literal("absent") }).strict(),
  z.object({ threadId: z.string().min(1), state: z.literal("error") }).strict(),
  z.object({ threadId: z.string().min(1), state: z.literal("ready"), reasoningLevel: z.string().nullable(), serviceTier: z.string().nullable() }).strict(),
]);
export type ExecutionProjection = z.infer<typeof executionProjectionSchema>;

export function executionAppearance(projection: ExecutionProjection): { color: "red" | "orange" | "purple" | null; explanation: string } {
  if (projection.state !== "ready") return { color: null, explanation: ({ loading: "Execution configuration is loading", unverified: "Execution configuration has not been verified", error: "Execution configuration could not be read", absent: "No accepted execution configuration" })[projection.state] };
  const high = ["high", "xhigh", "ultracode", "max", "ultra"].includes(projection.reasoningLevel ?? "");
  const fast = projection.serviceTier === "fast";
  return { color: high ? (fast ? "red" : "orange") : fast ? "purple" : null, explanation: `Last accepted request in this thread's saved history: reasoning ${projection.reasoningLevel ?? "unknown"}; service tier ${projection.serviceTier ?? "unknown"}. Updated when saved history is indexed.` };
}
