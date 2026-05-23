import { createOpenAiProvider } from "../ai/openai-provider.js";
import { requireOpenAiApiKey, resolveOpenAiModelFromEnv } from "../ai/provider-factory.js";
import { createAgentInvestigator } from "./agent-provider.js";
import { createEvidenceInvestigator } from "./evidence-provider.js";
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
  const model = resolveOpenAiModelFromEnv(env);

  if (provider === "codex-cli") {
    return {
      model,
      name: "codex-cli",
      async investigate(): Promise<never> {
        throw new Error("codex-cli investigator is not implemented yet; use FIRSTTRACE_INVESTIGATOR=agent or evidence.");
      },
    };
  }

  const apiKey = requireOpenAiApiKey(env);

  if (provider === "evidence") {
    return createEvidenceInvestigator(
      createOpenAiProvider({
        apiKey,
        model,
        resultProviderName: "evidence",
      }),
    );
  }

  return createAgentInvestigator({ apiKey, model });
};
