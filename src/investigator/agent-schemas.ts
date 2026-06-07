import { z } from "zod";
import { AiInvestigationResultPayloadSchema, normalizeAiInvestigationResultPayload } from "../ai/schema.js";

export const ToolNameSchema = z.enum([
  "findFiles",
  "readFile",
  "searchRepo",
  "findReferences",
  "gitLog",
  "gitBlame",
  "runSafeCommand",
]);

const JsonObjectSchema = z.record(z.string(), z.any());
const ArgumentPayloadSchema = z.union([z.string(), JsonObjectSchema]);

export const AgentTurnWireResponseSchema = z.object({
  action: z.string().nullable(),
  args: JsonObjectSchema.nullable(),
  argsJson: ArgumentPayloadSchema.nullable(),
  arguments: ArgumentPayloadSchema.nullable(),
  reason: z.string().nullable(),
  result: z.any().nullable(),
  tool: z.string().nullable(),
  tool_arguments: ArgumentPayloadSchema.nullable(),
  type: z.string().nullable(),
});

export const AgentFinalWireResponseSchema = z.object({
  result: z.any().nullable(),
});

export const AgentTurnResponseSchema = z.object({
  action: z.string().optional(),
  args: JsonObjectSchema.optional(),
  argsJson: ArgumentPayloadSchema.optional(),
  arguments: ArgumentPayloadSchema.optional(),
  reason: z.string().optional(),
  result: z.any().nullable().optional(),
  tool: z.union([ToolNameSchema, z.string()]).nullable().optional(),
  tool_arguments: ArgumentPayloadSchema.optional(),
  type: z.union([z.enum(["tool", "final"]), z.string()]).optional(),
}).passthrough();

export const AgentFinalResponseSchema = z.object({
  result: z.any().optional(),
}).passthrough();

export type NormalizedAgentTurnResponse =
  | {
      args: Record<string, unknown>;
      argsJson: string;
      reason: string;
      result: null;
      tool: z.infer<typeof ToolNameSchema>;
      type: "tool";
    }
  | {
      args: Record<string, unknown>;
      argsJson: "{}";
      reason: string;
      result: z.infer<typeof AiInvestigationResultPayloadSchema>;
      tool: null;
      type: "final";
    };

export type NormalizedAgentFinalResponse = {
  result: z.infer<typeof AiInvestigationResultPayloadSchema>;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const withNormalizationWarning = (payload: z.infer<typeof AiInvestigationResultPayloadSchema>, warning: string) => ({
  ...payload,
  warnings: [...payload.warnings, warning].slice(0, 8),
});

const looksLikeFinalPayload = (value: unknown) =>
  isObject(value) &&
  [
    "bugLikelihood",
    "confidence",
    "explanation",
    "likelyComponent",
    "likelyFiles",
    "likelyOwners",
    "managerTriage",
    "missingInfoQuestions",
  ].some((key) => value[key] !== undefined);

const safeFinalPayload = (value: unknown) => {
  try {
    return normalizeAiInvestigationResultPayload(value);
  } catch {
    return undefined;
  }
};

const turnTypeFrom = (value: Record<string, unknown>): "tool" | "final" | undefined => {
  const raw = String(value.type ?? value.action ?? "").trim().toLowerCase();
  if (raw === "tool" || raw === "call_tool" || raw === "tool_call") return "tool";
  if (raw === "final" || raw === "answer" || raw === "final_answer") return "final";
  if ((value.result !== undefined && value.result !== null) || looksLikeFinalPayload(value)) return "final";
  if (
    (value.tool !== undefined && value.tool !== null) ||
    (value.argsJson !== undefined && value.argsJson !== null) ||
    (value.args !== undefined && value.args !== null) ||
    (value.arguments !== undefined && value.arguments !== null) ||
    (value.tool_arguments !== undefined && value.tool_arguments !== null)
  ) {
    return "tool";
  }
  return undefined;
};

const toolNameFrom = (value: unknown) => {
  const parsed = ToolNameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const argsFrom = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(`${label} contains invalid JSON: ${(error as Error).message}`);
    }
    if (isObject(parsed)) return parsed;
    throw new Error(`${label} must decode to a JSON object.`);
  }
  if (isObject(value)) return value;
  throw new Error(`${label} must be a JSON object or JSON object string.`);
};

const normalizedArgsFrom = (value: Record<string, unknown>) => {
  const candidates: Array<[string, unknown]> = [
    ["argsJson", value.argsJson],
    ["args", value.args],
    ["arguments", value.arguments],
    ["tool_arguments", value.tool_arguments],
  ];
  for (const [label, candidate] of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    return argsFrom(candidate, label);
  }
  return {};
};

const argsJsonFrom = (args: Record<string, unknown>) => JSON.stringify(args);

export const normalizeAgentTurnResponse = (payload: unknown): NormalizedAgentTurnResponse => {
  const raw = isObject(payload) && isObject(payload.result) && (payload.result.type !== undefined || payload.result.tool !== undefined)
    ? payload.result
    : payload;
  const parsedRaw = AgentTurnResponseSchema.safeParse(raw);
  const value = parsedRaw.success && isObject(parsedRaw.data) ? parsedRaw.data : raw;

  if (isObject(value)) {
    const type = turnTypeFrom(value);
    if (type === "tool") {
      const tool = toolNameFrom(value.tool);
      if (!tool) {
        throw new Error(`Provider returned an unsupported or missing tool name: ${JSON.stringify(value.tool)}.`);
      }
      const args = normalizedArgsFrom(value);
      return {
        args,
        argsJson: argsJsonFrom(args),
        reason: typeof value.reason === "string" ? value.reason : "Model requested tool execution.",
        result: null,
        tool,
        type: "tool",
      };
    }

    if (type === "final") {
      const result = safeFinalPayload(value.result ?? value);
      if (result) {
        return {
          args: {},
          argsJson: "{}",
          reason: typeof value.reason === "string" ? value.reason : "Provider returned a final investigation payload.",
          result: value.result === undefined
            ? withNormalizationWarning(
                result,
                "Provider returned a direct final payload; FirstTrace normalized it to the agent turn schema.",
              )
            : result,
          tool: null,
          type: "final",
        };
      }
    }
  }

  const directFinal = safeFinalPayload(payload);
  if (directFinal) {
    return {
      args: {},
      argsJson: "{}",
      reason: "Provider returned a direct final investigation payload.",
      result: withNormalizationWarning(
        directFinal,
        "Provider returned a direct final payload; FirstTrace normalized it to the agent turn schema.",
      ),
      tool: null,
      type: "final" as const,
    };
  }

  throw new Error("Provider agent output did not match a supported FirstTrace tool or final turn shape.");
};

export const normalizeAgentFinalResponse = (payload: unknown): NormalizedAgentFinalResponse => {
  if (isObject(payload) && turnTypeFrom(payload) === "final") {
    const turn = normalizeAgentTurnResponse(payload);
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
  if (strict.success && strict.data.result !== undefined) {
    const result = safeFinalPayload(strict.data.result);
    if (result) return { result };
  }

  const directFinal = safeFinalPayload(payload);
  if (directFinal) {
    return {
      result: withNormalizationWarning(
        directFinal,
        "Provider returned a direct final payload; FirstTrace normalized it to the final response schema.",
      ),
    };
  }

  if (isObject(payload) && isObject(payload.result)) {
    const nestedFinal = safeFinalPayload(payload.result);
    if (nestedFinal) {
      return {
        result: withNormalizationWarning(
          nestedFinal,
          "Provider returned a nested final payload; FirstTrace normalized it to the final response schema.",
        ),
      };
    }
  }

  throw new Error("Provider final output did not match a supported FirstTrace final response shape.");
};
