import { investigate } from "./investigate.js";
import { prepareConfigForInvestigation, type RepoPreparationOptions } from "./repositories/prepare.js";
import type { FirstTraceConfig, InvestigationResult, InvestigatorProvider } from "./types.js";

export type ExecuteInvestigationOptions = {
  aiFailureMode?: "throw" | "warn";
  config: FirstTraceConfig;
  investigatorProvider?: InvestigatorProvider;
  report: string;
  repoPreparation?: RepoPreparationOptions;
};

export const executeInvestigation = async ({
  aiFailureMode = "warn",
  config,
  investigatorProvider,
  report,
  repoPreparation,
}: ExecuteInvestigationOptions): Promise<InvestigationResult> => {
  const preparedConfig = await prepareConfigForInvestigation(config, repoPreparation);
  const result = await investigate(report, preparedConfig);

  if (investigatorProvider) {
    try {
      result.ai = await investigatorProvider.investigate({ preparedConfig, result });
    } catch (error) {
      const message = `Investigation failed with provider ${investigatorProvider.name}: ${(error as Error).message}`;
      if (aiFailureMode === "throw") throw new Error(message);
      result.warnings.push(message);
    }
  }

  return result;
};
