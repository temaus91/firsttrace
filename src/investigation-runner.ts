import {
  aiDryRunFromEnv,
  aiSafetyModeFromEnv,
  sanitizeReportForAi,
  type AiSafetyResult,
} from "./ai/safety.js";
import { investigate } from "./investigate.js";
import { prepareConfigForInvestigation, type RepoPreparationOptions } from "./repositories/prepare.js";
import type { FirstTraceConfig, InvestigationJobSource, InvestigationResult, InvestigatorProvider } from "./types.js";

export type ExecuteInvestigationOptions = {
  aiFailureMode?: "throw" | "warn";
  config: FirstTraceConfig;
  env?: NodeJS.ProcessEnv;
  investigatorProvider?: InvestigatorProvider;
  report: string;
  repoPreparation?: RepoPreparationOptions;
  source?: InvestigationJobSource;
};

const slackChannelFor = (config: FirstTraceConfig, source?: InvestigationJobSource) =>
  source?.provider === "slack" && source.channelId
    ? config.chat?.channels.find((channel) => channel.id === source.channelId)
    : undefined;

const dryRunAiResult = (
  result: InvestigationResult,
  investigatorProvider: InvestigatorProvider,
  safety: AiSafetyResult,
) => ({
  confidence: 0,
  explanation: `AI dry run: sanitized report that would be sent to ${investigatorProvider.name}: ${safety.report}`,
  implementerHints: [],
  likelyComponent: result.likelyComponent,
  likelyFiles: result.suspiciousFiles.slice(0, 3).flatMap((item) =>
    item.path
      ? [{
          citations: item.citations.map((citation) => citation.label),
          confidence: Math.min(0.9, Math.max(0.1, item.score / 10)),
          path: item.path,
          reason: item.summary,
          repo: item.repo,
        }]
      : [],
  ),
  likelyOwners: result.likelyOwners,
  missingInfoQuestions: [],
  provider: "ai-dry-run",
  warnings: safety.warnings,
});

export const executeInvestigation = async ({
  aiFailureMode = "warn",
  config,
  env = process.env,
  investigatorProvider,
  report,
  repoPreparation,
  source,
}: ExecuteInvestigationOptions): Promise<InvestigationResult> => {
  const preparedConfig = await prepareConfigForInvestigation(config, repoPreparation);
  const result = await investigate(report, preparedConfig);

  if (investigatorProvider) {
    const slackChannel = slackChannelFor(config, source);
    if (slackChannel?.dataClassification === "restricted") {
      result.warnings.push("AI skipped: Slack channel data_classification is restricted.");
      return result;
    }

    const safety = sanitizeReportForAi(result.report, aiSafetyModeFromEnv(env));
    result.warnings.push(...safety.warnings);
    if (!safety.allowed) {
      result.warnings.push(`AI skipped by safety guardrail: ${safety.blockedReasons.join(", ")}.`);
      return result;
    }

    const aiInput = {
      ...result,
      report: safety.report,
      warnings: [...result.warnings],
    };
    if (aiDryRunFromEnv(env)) {
      result.ai = dryRunAiResult(result, investigatorProvider, safety);
      return result;
    }

    try {
      result.ai = await investigatorProvider.investigate({ preparedConfig, result: aiInput });
    } catch (error) {
      const message = `Investigation failed with provider ${investigatorProvider.name}: ${(error as Error).message}`;
      if (aiFailureMode === "throw") throw new Error(message);
      result.warnings.push(message);
    }
  }

  return result;
};
