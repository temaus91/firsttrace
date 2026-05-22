import { buildAiReasonerRequest } from "./ai/evidence.js";
import { investigate } from "./investigate.js";
import { prepareConfigForInvestigation, type RepoPreparationOptions } from "./repositories/prepare.js";
import type { AiProvider, FirstTraceConfig, InvestigationResult } from "./types.js";

export type ExecuteInvestigationOptions = {
  aiFailureMode?: "throw" | "warn";
  aiProvider?: AiProvider;
  config: FirstTraceConfig;
  report: string;
  repoPreparation?: RepoPreparationOptions;
};

export const executeInvestigation = async ({
  aiFailureMode = "warn",
  aiProvider,
  config,
  report,
  repoPreparation,
}: ExecuteInvestigationOptions): Promise<InvestigationResult> => {
  const preparedConfig = await prepareConfigForInvestigation(config, repoPreparation);
  const result = await investigate(report, preparedConfig);

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
