import { executeInvestigation } from "../investigation-runner.js";
import type { AiProvider, EvalCase, EvalCaseResult, EvalRunResult, FirstTraceConfig } from "../types.js";
import { scoreEvalResult } from "./scoring.js";

export type RunEvalOptions = {
  aiProvider?: AiProvider;
  cases: EvalCase[];
  config: FirstTraceConfig;
};

export const runEval = async ({ aiProvider, cases, config }: RunEvalOptions): Promise<EvalRunResult> => {
  const caseResults: EvalCaseResult[] = [];

  for (const evalCase of cases) {
    const deterministicResult = await executeInvestigation({
      aiProvider,
      config,
      report: evalCase.report,
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
    aiProvider ? result.deterministicScore.passed && result.aiScore?.passed : result.deterministicScore.passed,
  );
  const passedCount = caseResults.filter((result) =>
    aiProvider ? result.deterministicScore.passed && result.aiScore?.passed : result.deterministicScore.passed,
  ).length;

  return {
    aiEnabled: Boolean(aiProvider),
    caseResults,
    passed,
    summary: {
      failed: caseResults.length - passedCount,
      passed: passedCount,
      total: caseResults.length,
    },
  };
};
