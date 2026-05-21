import { createOpenAiProvider } from "./openai-provider.js";
import type { AiProvider } from "../types.js";

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export const createAiProviderFromEnv = (env: NodeJS.ProcessEnv = process.env): AiProvider => {
  const providerName = (env.FIRSTTRACE_AI_PROVIDER ?? "openai").toLowerCase();

  if (providerName !== "openai") {
    throw new Error(
      `Unsupported AI provider: ${providerName}. Configure FIRSTTRACE_AI_PROVIDER=openai or add a provider adapter.`,
    );
  }

  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when --ai is enabled.");
  }

  return createOpenAiProvider({
    apiKey,
    model: env.OPENAI_MODEL_CHAT?.trim() || DEFAULT_OPENAI_MODEL,
  });
};
