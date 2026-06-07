import { z } from "zod";
import { ManagerOwnerTriageResultSchema, normalizeManagerOwnerTriageResult } from "../manager-triage.js";

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

export const AiInvestigationResultPayloadWireSchema = z.object({
  bugLikelihood: z.string().nullable(),
  confidence: z.union([Confidence, z.string()]).nullable(),
  confidenceRationale: z.string().nullable(),
  explanation: z.string().nullable(),
  firstContact: z.string().nullable(),
  implementerHints: z.array(
    z.object({
      citations: z.array(z.string()),
      commit: z.string().nullable(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      reason: z.string(),
    }),
  ).nullable(),
  likelyComponent: z.string().nullable(),
  likelyFiles: z.array(
    z.object({
      citations: z.array(z.string()),
      confidence: Confidence,
      path: z.string(),
      reason: z.string(),
      repo: z.string(),
    }),
  ).nullable(),
  likelyOwners: z.array(z.union([z.string(), z.record(z.string(), z.any())])).nullable(),
  managerTriage: z.any().nullable(),
  missingInfoQuestions: z.array(z.string()).nullable(),
  relatedChange: z.any().nullable(),
  userImpact: z.string().nullable(),
  warnings: z.array(z.string()).nullable(),
});

export type AiInvestigationResultPayload = z.infer<typeof AiInvestigationResultPayloadSchema>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFinalPayloadLike = (value: unknown) =>
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
    "userImpact",
    "warnings",
  ].some((key) => value[key] !== undefined);

const withNormalizationWarning = (payload: AiInvestigationResultPayload, warning: string) => ({
  ...payload,
  warnings: [...payload.warnings, warning].slice(0, 8),
});

const normalizedBugLikelihood = (value: unknown): AiInvestigationResultPayload["bugLikelihood"] => {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value)
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
  if (["likely_bug", "bug", "defect", "likely"].includes(normalized)) return "likely_bug";
  if (["feature_request", "feature", "enhancement"].includes(normalized)) return "feature_request";
  if (["support_question", "support", "question"].includes(normalized)) return "support_question";
  if (["needs_clarification", "unclear", "unknown", "needs_info"].includes(normalized)) return "needs_clarification";
  return undefined;
};

const confidenceFromCandidate = (candidate: unknown) => {
  if (!isObject(candidate)) return undefined;
  const confidence = String(candidate.confidence ?? "").trim().toLowerCase();
  if (confidence === "high") return 0.85;
  if (confidence === "medium") return 0.6;
  if (confidence === "low") return 0.35;
  return undefined;
};

const normalizedConfidence = (value: unknown, source: Record<string, unknown>, warnings: string[]) => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (Number.isFinite(parsed)) return Math.min(1, Math.max(0, parsed));
  const managerTriage = source.managerTriage;
  const candidates = isObject(managerTriage) && Array.isArray(managerTriage.likely_owner_candidates)
    ? managerTriage.likely_owner_candidates
    : [];
  const candidateConfidence = candidates.flatMap((candidate) => {
    const confidence = confidenceFromCandidate(candidate);
    return confidence === undefined ? [] : [confidence];
  })[0];
  if (candidateConfidence !== undefined) {
    warnings.push("Provider omitted top-level confidence; FirstTrace derived it from candidate confidence.");
    return candidateConfidence;
  }
  warnings.push("Provider omitted top-level confidence; FirstTrace used a neutral confidence value.");
  return 0.5;
};

const stringFrom = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : value === undefined || value === null ? fallback : String(value);

const stringArrayFrom = (value: unknown) =>
  Array.isArray(value) ? value.map((item) => stringFrom(item)).filter(Boolean) : [];

const ownerLabelFrom = (value: unknown) => {
  if (typeof value === "string") return value;
  if (!isObject(value)) return "";
  return stringFrom(value.name ?? value.email ?? value.owner ?? value.handle);
};

const stringifyStructured = (value: unknown) => {
  if (value === undefined || value === null || typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizePayloadObject = (payload: Record<string, unknown>) => {
  const warnings = stringArrayFrom(payload.warnings);
  const normalized: Record<string, unknown> = {
    ...payload,
    bugLikelihood: normalizedBugLikelihood(payload.bugLikelihood),
    confidence: normalizedConfidence(payload.confidence, payload, warnings),
    explanation: stringFrom(
      payload.explanation,
      isObject(payload.managerTriage)
        ? stringFrom(payload.managerTriage.likely_root_cause ?? payload.managerTriage.issue, "Provider returned a final answer without explanation.")
        : "Provider returned a final answer without explanation.",
    ),
    implementerHints: Array.isArray(payload.implementerHints) ? payload.implementerHints : [],
    likelyComponent: stringFrom(
      payload.likelyComponent,
      Array.isArray(payload.likelyFiles) && isObject(payload.likelyFiles[0])
        ? stringFrom(payload.likelyFiles[0].path, "unknown")
        : "unknown",
    ),
    likelyFiles: Array.isArray(payload.likelyFiles) ? payload.likelyFiles : [],
    likelyOwners: Array.isArray(payload.likelyOwners)
      ? payload.likelyOwners.map(ownerLabelFrom).filter(Boolean).slice(0, 8)
      : [],
    missingInfoQuestions: Array.isArray(payload.missingInfoQuestions) ? payload.missingInfoQuestions : [],
    relatedChange: stringifyStructured(payload.relatedChange),
    warnings,
  };

  if (payload.managerTriage !== undefined && payload.managerTriage !== null) {
    normalized.managerTriage = normalizeManagerOwnerTriageResult(payload.managerTriage);
  } else {
    delete normalized.managerTriage;
  }

  if (payload.bugLikelihood !== undefined && payload.bugLikelihood !== null && normalized.bugLikelihood === undefined) {
    warnings.push(`Provider returned unsupported bugLikelihood ${JSON.stringify(payload.bugLikelihood)}; FirstTrace omitted it.`);
  }
  if (payload.relatedChange !== undefined && typeof payload.relatedChange !== "string" && payload.relatedChange !== null) {
    warnings.push("Provider returned structured relatedChange; FirstTrace serialized it.");
  }
  if (Array.isArray(payload.likelyOwners) && payload.likelyOwners.some((owner) => isObject(owner))) {
    warnings.push("Provider returned object likelyOwners; FirstTrace converted them to display strings.");
  }

  return normalized;
};

const safeNormalizeAiInvestigationResultPayload = (payload: unknown): AiInvestigationResultPayload | undefined => {
  try {
    return normalizeAiInvestigationResultPayload(payload);
  } catch {
    return undefined;
  }
};

export const normalizeAiInvestigationResultPayload = (payload: unknown): AiInvestigationResultPayload => {
  const strict = AiInvestigationResultPayloadSchema.safeParse(payload);
  if (strict.success) return strict.data;

  if (isObject(payload) && payload.type === "final" && isObject(payload.result)) {
    const turnResult = safeNormalizeAiInvestigationResultPayload(payload.result);
    if (turnResult) {
      return withNormalizationWarning(
        turnResult,
        "Provider returned an agent final turn; FirstTrace normalized it to the investigation result schema.",
      );
    }
  }

  if (isObject(payload) && isObject(payload.result)) {
    const nested = safeNormalizeAiInvestigationResultPayload(payload.result);
    if (nested) {
      return withNormalizationWarning(
        nested,
        "Provider returned a nested final payload; FirstTrace normalized it to the investigation result schema.",
      );
    }
  }

  if (isObject(payload) && isFinalPayloadLike(payload)) {
    return AiInvestigationResultPayloadSchema.parse(normalizePayloadObject(payload));
  }

  return AiInvestigationResultPayloadSchema.parse(payload);
};
