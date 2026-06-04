import { aiDryRunFromEnv, aiSafetyModeFromEnv } from "./safety.js";
import { aiModelProviderFromEnv, resolveChatModelFromEnv } from "./provider-factory.js";
import {
  DEFAULT_PROMPT_PROFILE,
  INVESTIGATION_PROMPT_VERSION,
} from "../investigator/prompt-contract.js";
import { createInvestigatorProviderFromEnv, investigatorProviderFrom } from "../investigator/provider-factory.js";
import type { InvestigationPromptConfig } from "../types.js";

export type AiReadinessMetadata = {
  aiDryRun: boolean;
  aiEnabled: boolean;
  aiProvider: string;
  aiReady: boolean;
  aiSafetyMode: string;
  investigator: string;
  model?: string;
  promptOverlayConfigured: boolean;
  promptProfile: string;
  promptVersion: string;
  slackAiGate: "enabled" | "disabled";
  warning?: string;
};

export const aiReadinessMetadataFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  promptConfig?: InvestigationPromptConfig,
): AiReadinessMetadata => {
  const aiEnabled = env.FIRSTTRACE_AI_ENABLED?.trim().toLowerCase() === "true";
  const promptOverlayFiles = (env.FIRSTTRACE_PROMPT_OVERLAY_FILES ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const promptProfile = env.FIRSTTRACE_PROMPT_PROFILE?.trim() || promptConfig?.profile || DEFAULT_PROMPT_PROFILE;
  const promptOverlayConfigured = Boolean(
    env.FIRSTTRACE_PROMPT_OVERLAY?.trim() ||
      promptOverlayFiles.length ||
      (promptConfig?.overlayFiles.length ?? 0),
  );

  try {
    const aiProvider = aiModelProviderFromEnv(env);
    const investigator = investigatorProviderFrom(env.FIRSTTRACE_INVESTIGATOR);
    let model: string | undefined;
    try {
      model = resolveChatModelFromEnv(env, aiProvider);
    } catch (error) {
      if (aiEnabled) throw error;
    }

    if (!aiEnabled) {
      return {
        aiDryRun: aiDryRunFromEnv(env),
        aiEnabled,
        aiProvider,
        aiReady: false,
        aiSafetyMode: aiSafetyModeFromEnv(env),
        investigator,
        model,
        promptOverlayConfigured,
        promptProfile,
        promptVersion: INVESTIGATION_PROMPT_VERSION,
        slackAiGate: "disabled",
      };
    }

    if (investigator === "codex-cli") {
      throw new Error("codex-cli investigator is not implemented yet.");
    }

    const validatedProvider = createInvestigatorProviderFromEnv(env);
    return {
      aiDryRun: aiDryRunFromEnv(env),
      aiEnabled,
      aiProvider,
      aiReady: Boolean(validatedProvider.model),
      aiSafetyMode: aiSafetyModeFromEnv(env),
      investigator,
      model: validatedProvider.model ?? model,
      promptOverlayConfigured,
      promptProfile,
      promptVersion: INVESTIGATION_PROMPT_VERSION,
      slackAiGate: aiEnabled ? "enabled" : "disabled",
    };
  } catch (error) {
    return {
      aiDryRun: aiDryRunFromEnv(env),
      aiEnabled,
      aiProvider: env.FIRSTTRACE_AI_PROVIDER?.trim() || "openai",
      aiReady: false,
      aiSafetyMode: aiSafetyModeFromEnv(env),
      investigator: env.FIRSTTRACE_INVESTIGATOR?.trim() || "agent",
      promptOverlayConfigured,
      promptProfile,
      promptVersion: INVESTIGATION_PROMPT_VERSION,
      slackAiGate: aiEnabled ? "enabled" : "disabled",
      warning: (error as Error).message,
    };
  }
};
