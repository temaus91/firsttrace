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

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const withNormalizationWarning = (payload: z.infer<typeof AiInvestigationResultPayloadSchema>, warning: string) => ({
  ...payload,
  warnings: [...payload.warnings, warning].slice(0, 8),
});

export const normalizeAgentTurnResponse = (payload: unknown) => {
  const strict = AgentTurnResponseSchema.safeParse(payload);
  if (strict.success) return strict.data;

  const directFinal = AiInvestigationResultPayloadSchema.safeParse(payload);
  if (directFinal.success) {
    return {
      argsJson: "{}",
      reason: "Provider returned a direct final investigation payload.",
      result: withNormalizationWarning(
        directFinal.data,
        "Provider returned a direct final payload; FirstTrace normalized it to the agent turn schema.",
      ),
      tool: null,
      type: "final" as const,
    };
  }

  if (isObject(payload) && isObject(payload.result)) {
    const nestedTurn = AgentTurnResponseSchema.safeParse(payload.result);
    if (nestedTurn.success) return nestedTurn.data;

    const nestedFinal = AiInvestigationResultPayloadSchema.safeParse(payload.result);
    if (nestedFinal.success) {
      return {
        argsJson: "{}",
        reason: "Provider returned a nested final investigation payload.",
        result: withNormalizationWarning(
          nestedFinal.data,
          "Provider returned a nested final payload; FirstTrace normalized it to the agent turn schema.",
        ),
        tool: null,
        type: "final" as const,
      };
    }
  }

  return AgentTurnResponseSchema.parse(payload);
};

export const normalizeAgentFinalResponse = (payload: unknown) => {
  if (isObject(payload) && payload.type === "final") {
    const turn = AgentTurnResponseSchema.parse(payload);
    if (turn.result) {
      return {
        result: withNormalizationWarning(
          turn.result,
          "Provider returned an agent final turn; FirstTrace normalized it to the final response schema.",
        ),
      };
    }
  }

  const strict = AgentFinalResponseSchema.safeParse(payload);
  if (strict.success) return strict.data;

  const turn = AgentTurnResponseSchema.safeParse(payload);
  if (turn.success && turn.data.type === "final" && turn.data.result) {
    return {
      result: withNormalizationWarning(
        turn.data.result,
        "Provider returned an agent final turn; FirstTrace normalized it to the final response schema.",
      ),
    };
  }

  const directFinal = AiInvestigationResultPayloadSchema.safeParse(payload);
  if (directFinal.success) {
    return {
      result: withNormalizationWarning(
        directFinal.data,
        "Provider returned a direct final payload; FirstTrace normalized it to the final response schema.",
      ),
    };
  }

  if (isObject(payload) && isObject(payload.result)) {
    const nestedFinal = AiInvestigationResultPayloadSchema.safeParse(payload.result);
    if (nestedFinal.success) {
      return {
        result: withNormalizationWarning(
          nestedFinal.data,
          "Provider returned a nested final payload; FirstTrace normalized it to the final response schema.",
        ),
      };
    }
  }

  return AgentFinalResponseSchema.parse(payload);
};
