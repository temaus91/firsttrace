import { buildAiReasonerRequest } from "./ai/evidence.js";
import { investigate } from "./investigate.js";
import type { AiProvider, FirstTraceConfig, InvestigationResult } from "./types.js";

export type ExecuteInvestigationOptions = {
  aiFailureMode?: "throw" | "warn";
  aiProvider?: AiProvider;
  config: FirstTraceConfig;
  report: string;
};

export const executeInvestigation = async ({
  aiFailureMode = "warn",
  aiProvider,
  config,
  report,
}: ExecuteInvestigationOptions): Promise<InvestigationResult> => {
  const result = investigate(report, config);

  if (aiProvider) {
    try {
      result.ai = await aiProvider.reason(buildAiReasonerRequest(result));
    } catch (error) {
      const message = `AI reasoning failed with provider ${aiProvider.name}: ${(error as Error).message}`;
      if (aiFailureMode === "throw") throw new Error(message);
      result.warnings.push(message);
    }
  }

  return result;
};
