import {
  aiModelProviderFromEnv,
  createAiProviderFromEnv,
  ociGenAiConfigFromEnv,
  requireOpenAiApiKey,
  resolveChatModelFromEnv,
} from "../ai/provider-factory.js";
import { createAgentInvestigator } from "./agent-provider.js";
import { createEvidenceInvestigator } from "./evidence-provider.js";
import { createOciGenAiAgentModelClientFromConfig } from "./oci-genai-agent-client.js";
import type { InvestigatorProvider } from "../types.js";

export type InvestigatorProviderName = "agent" | "evidence" | "codex-cli";

export const investigatorProviderFrom = (value?: string): InvestigatorProviderName => {
  const provider = (value ?? "agent").trim().toLowerCase();
  if (provider === "agent" || provider === "evidence" || provider === "codex-cli") return provider;
  throw new Error(
    `Unsupported investigator provider: ${provider}. Expected agent, evidence, or codex-cli.`,
  );
};

export const createInvestigatorProviderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): InvestigatorProvider => {
  const provider = investigatorProviderFrom(env.FIRSTTRACE_INVESTIGATOR);
  const aiProvider = aiModelProviderFromEnv(env);
  const model = resolveChatModelFromEnv(env, aiProvider);

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
    return createEvidenceInvestigator(createAiProviderFromEnv(env));
  }

  if (aiProvider === "oci-genai") {
    return createAgentInvestigator({
      model,
      modelClient: createOciGenAiAgentModelClientFromConfig({
        ...ociGenAiConfigFromEnv(env),
        env,
        model,
      }),
    });
  }

  const apiKey = requireOpenAiApiKey(env);
  return createAgentInvestigator({ apiKey, model });
};
