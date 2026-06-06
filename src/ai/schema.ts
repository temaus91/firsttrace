import { z } from "zod";
import { ManagerOwnerTriageResultSchema } from "../manager-triage.js";

export const Confidence = z.number().min(0).max(1);

export const AiInvestigationResultPayloadSchema = z.object({
  bugLikelihood: z
    .enum(["likely_bug", "feature_request", "support_question", "needs_clarification"])
    .optional(),
  confidence: Confidence,
  confidenceRationale: z.string().nullable().optional(),
  explanation: z.string(),
  firstContact: z.string().nullable().optional(),
  implementerHints: z
    .array(
      z.object({
        citations: z.array(z.string()),
        commit: z.string().nullable(),
        email: z.string().nullable(),
        name: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .max(5),
  likelyComponent: z.string(),
  likelyFiles: z
    .array(
      z.object({
        citations: z.array(z.string()),
        confidence: Confidence,
        path: z.string(),
        reason: z.string(),
        repo: z.string(),
      }),
    )
    .max(5),
  likelyOwners: z.array(z.string()).max(8),
  managerTriage: ManagerOwnerTriageResultSchema.optional(),
  missingInfoQuestions: z.array(z.string()).max(5),
  relatedChange: z.string().nullable().optional(),
  userImpact: z.string().nullable().optional(),
  warnings: z.array(z.string()).max(8),
});

export type AiInvestigationResultPayload = z.infer<typeof AiInvestigationResultPayloadSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const withNormalizationWarning = (payload: AiInvestigationResultPayload, warning: string) => ({
  ...payload,
  warnings: [...payload.warnings, warning].slice(0, 8),
});

export const normalizeAiInvestigationResultPayload = (payload: unknown): AiInvestigationResultPayload => {
  const strict = AiInvestigationResultPayloadSchema.safeParse(payload);
  if (strict.success) return strict.data;

  if (isObject(payload) && payload.type === "final" && isObject(payload.result)) {
    const turnResult = AiInvestigationResultPayloadSchema.safeParse(payload.result);
    if (turnResult.success) {
      return withNormalizationWarning(
        turnResult.data,
        "Provider returned an agent final turn; FirstTrace normalized it to the investigation result schema.",
      );
    }
  }

  if (isObject(payload) && isObject(payload.result)) {
    const nested = AiInvestigationResultPayloadSchema.safeParse(payload.result);
    if (nested.success) {
      return withNormalizationWarning(
        nested.data,
        "Provider returned a nested final payload; FirstTrace normalized it to the investigation result schema.",
      );
    }
  }

  return AiInvestigationResultPayloadSchema.parse(payload);
};
