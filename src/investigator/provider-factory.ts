import {
  aiModelProviderFromEnv,
  createAiProviderFromEnv,
  ociGenAiConfigFromEnv,
  requireOpenAiApiKey,
  resolveChatModelFromEnv,
} from "../ai/provider-factory.js";
import { resolveAiRequestOptions } from "../ai/request-options.js";
import { createAgentInvestigator } from "./agent-provider.js";
import { createEvidenceInvestigator } from "./evidence-provider.js";
import { createOciGenAiAgentModelClientFromConfig } from "./oci-genai-agent-client.js";
import type { AiRequestConfig, InvestigatorProvider } from "../types.js";

export type InvestigatorProviderName = "agent" | "evidence" | "codex-cli";

export const investigatorProviderFrom = (value?: string): InvestigatorProviderName => {
  const provider = (value ?? "agent").trim().toLowerCase();
  if (provider === "agent" || provider === "evidence" || provider === "codex-cli") return provider;
  throw new Error(
    `Unsupported investigator provider: ${provider}. Expected agent, evidence, or codex-cli.`,
  );
};

export type CreateInvestigatorProviderFromEnvOptions = {
  requestConfig?: AiRequestConfig;
};

export const createInvestigatorProviderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  options: CreateInvestigatorProviderFromEnvOptions = {},
): InvestigatorProvider => {
  const provider = investigatorProviderFrom(env.FIRSTTRACE_INVESTIGATOR);
  const aiProvider = aiModelProviderFromEnv(env);
  const model = resolveChatModelFromEnv(env, aiProvider);
  const requestOptions = resolveAiRequestOptions({
    config: options.requestConfig,
    env,
    model,
    provider: aiProvider,
  });

  if (provider === "codex-cli") {
    return {
      model,
      name: "codex-cli",
      async investigate(): Promise<never> {
        throw new Error("codex-cli investigator is not implemented yet; use FIRSTTRACE_INVESTIGATOR=agent or evidence.");
      },
    };
  }

  if (provider === "evidence") {
    return createEvidenceInvestigator(createAiProviderFromEnv(env, options));
  }

  if (aiProvider === "oci-genai") {
    return createAgentInvestigator({
      env,
      model,
      modelClient: createOciGenAiAgentModelClientFromConfig({
        ...ociGenAiConfigFromEnv(env),
        env,
        model,
        requestOptions,
      }),
    });
  }

  const apiKey = requireOpenAiApiKey(env);
  return createAgentInvestigator({ apiKey, env, model, requestOptions });
};
