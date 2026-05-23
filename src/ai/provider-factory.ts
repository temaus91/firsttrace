import { createOpenAiProvider } from "./openai-provider.js";
import type { AiProvider } from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export const resolveOpenAiModelFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  env.OPENAI_MODEL_CHAT?.trim() || DEFAULT_OPENAI_MODEL;

export const requireOpenAiApiKey = (env: NodeJS.ProcessEnv = process.env) => {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when --ai is enabled.");
  }
  return apiKey;
};

export const createAiProviderFromEnv = (env: NodeJS.ProcessEnv = process.env): AiProvider => {
  const providerName = (env.FIRSTTRACE_AI_PROVIDER ?? "openai").toLowerCase();

  if (providerName !== "openai") {
    throw new Error(
      `Unsupported AI provider: ${providerName}. Configure FIRSTTRACE_AI_PROVIDER=openai or add a provider adapter.`,
    );
  }

  return createOpenAiProvider({
    apiKey: requireOpenAiApiKey(env),
    model: resolveOpenAiModelFromEnv(env),
    resultProviderName: "evidence",
  });
};
