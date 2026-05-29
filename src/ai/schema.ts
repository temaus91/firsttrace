import { z } from "zod";

export const Confidence = z.number().min(0).max(1);

export const AiInvestigationResultPayloadSchema = z.object({
  confidence: Confidence,
  explanation: z.string(),
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
  missingInfoQuestions: z.array(z.string()).max(5),
  warnings: z.array(z.string()).max(8),
});

export type AiInvestigationResultPayload = z.infer<typeof AiInvestigationResultPayloadSchema>;
