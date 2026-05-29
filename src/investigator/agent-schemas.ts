import { z } from "zod";
import { AiInvestigationResultPayloadSchema } from "../ai/schema.js";

export const ToolNameSchema = z.enum([
  "findFiles",
  "readFile",
  "searchRepo",
  "findReferences",
  "gitLog",
  "gitBlame",
  "runSafeCommand",
]);

export const AgentTurnResponseSchema = z.object({
  argsJson: z.string(),
  reason: z.string(),
  result: AiInvestigationResultPayloadSchema.nullable(),
  tool: ToolNameSchema.nullable(),
  type: z.enum(["tool", "final"]),
});

export const AgentFinalResponseSchema = z.object({
  result: AiInvestigationResultPayloadSchema,
});
