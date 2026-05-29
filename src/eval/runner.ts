import { executeInvestigation } from "../investigation-runner.js";
import type { RepoPreparationOptions } from "../repositories/prepare.js";
import type { EvalCase, EvalCaseResult, EvalRunResult, FirstTraceConfig, InvestigatorProvider } from "../types.js";
import { scoreEvalResult } from "./scoring.js";

export type RunEvalOptions = {
  cases: EvalCase[];
  config: FirstTraceConfig;
  investigatorProvider?: InvestigatorProvider;
  repoPreparation?: RepoPreparationOptions;
};

export const runEval = async ({
  cases,
  config,
  investigatorProvider,
  repoPreparation,
}: RunEvalOptions): Promise<EvalRunResult> => {
  const caseResults: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    const deterministicResult = await executeInvestigation({
      config,
      investigatorProvider,
      report: evalCase.report,
      repoPreparation,
    });
    const deterministicScore = scoreEvalResult(evalCase, deterministicResult);
    const aiScore = deterministicResult.ai
      ? scoreEvalResult(evalCase, deterministicResult, deterministicResult.ai)
      : undefined;

    caseResults.push({
      aiScore,
      case: evalCase,
      deterministicResult,
      deterministicScore,
    });
  }

  const passed = caseResults.every((result) =>
    investigatorProvider ? result.deterministicScore.passed && result.aiScore?.passed : result.deterministicScore.passed,
  );
  const passedCount = caseResults.filter((result) =>
    investigatorProvider ? result.deterministicScore.passed && result.aiScore?.passed : result.deterministicScore.passed,
  ).length;

  return {
    aiEnabled: Boolean(investigatorProvider),
    caseResults,
    passed,
    summary: {
      failed: caseResults.length - passedCount,
      passed: passedCount,
      total: caseResults.length,
    },
  };
};
