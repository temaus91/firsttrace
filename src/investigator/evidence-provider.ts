import { buildAiReasonerRequest } from "../ai/evidence.js";
import type { AiProvider, InvestigatorProvider } from "../types.js";

export const createEvidenceInvestigator = (aiProvider: AiProvider): InvestigatorProvider => ({
  model: aiProvider.model,
  name: "evidence",
  investigate: async ({ result }) => aiProvider.reason(buildAiReasonerRequest(result)),
});
