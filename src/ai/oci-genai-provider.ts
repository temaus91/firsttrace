import { groundAiResult } from "./grounding.js";
import { createOciGenAiJsonClient, type OciGenAiJsonClient } from "./oci-genai-json-client.js";
import { evidenceBaseSystemPrompt, evidenceUserPrompt } from "./prompts.js";
import { normalizeAiInvestigationResultPayload } from "./schema.js";
import { buildSystemPrompt } from "../investigator/prompt-contract.js";
import type { AiInvestigationResult, AiProvider, AiReasonerRequest } from "../types.js";

export type OciGenAiProviderOptions = {
  env?: NodeJS.ProcessEnv;
  jsonClient: OciGenAiJsonClient;
  resultProviderName?: string;
};

export const createOciGenAiProvider = ({
  env,
  jsonClient,
  resultProviderName = "evidence",
}: OciGenAiProviderOptions): AiProvider => ({
  model: jsonClient.model,
  name: resultProviderName,
  async reason(request: AiReasonerRequest, promptConfig): Promise<AiInvestigationResult> {
    const prompt = buildSystemPrompt({
      basePrompt: evidenceBaseSystemPrompt,
      config: promptConfig,
      env,
    });
    const payload = normalizeAiInvestigationResultPayload(
      await jsonClient.generateJson({
        responseName: "firsttrace_ai_investigation_result",
        systemPrompt: prompt.systemPrompt,
        userPrompt: evidenceUserPrompt(request),
      }),
    );

    return groundAiResult(
      {
        ...payload,
        provider: resultProviderName,
        promptProfile: prompt.profile,
        promptVersion: prompt.version,
      },
      request,
    );
  },
});

export const createOciGenAiProviderFromConfig = ({
  compartmentId,
  dedicatedEndpointId,
  endpoint,
  env,
  maxTokens,
  model,
  region,
  resultProviderName,
}: {
  compartmentId: string;
  dedicatedEndpointId?: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  maxTokens?: number;
  model: string;
  region?: string;
  resultProviderName?: string;
}) =>
  createOciGenAiProvider({
    env,
    jsonClient: createOciGenAiJsonClient({
      compartmentId,
      dedicatedEndpointId,
      endpoint,
      env,
      maxTokens,
      model,
      region,
    }),
    resultProviderName,
  });
