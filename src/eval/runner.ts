import { buildAiReasonerRequest } from "../ai/evidence.js";
import { investigate } from "../investigate.js";
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
    const deterministicResult = investigate(evalCase.report, config);
    if (aiProvider) {
      try {
        deterministicResult.ai = await aiProvider.reason(buildAiReasonerRequest(deterministicResult));
      } catch (error) {
        deterministicResult.warnings.push(
          `AI reasoning failed with provider ${aiProvider.name}: ${(error as Error).message}`,
        );
      }
    }

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
