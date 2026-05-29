import { groundAiResult } from "./grounding.js";
import { createOciGenAiJsonClient, type OciGenAiJsonClient } from "./oci-genai-json-client.js";
import { evidenceSystemPrompt, evidenceUserPrompt } from "./prompts.js";
import { AiInvestigationResultPayloadSchema } from "./schema.js";
import type { AiInvestigationResult, AiProvider, AiReasonerRequest } from "../types.js";

export type OciGenAiProviderOptions = {
  jsonClient: OciGenAiJsonClient;
  resultProviderName?: string;
};

export const createOciGenAiProvider = ({
  jsonClient,
  resultProviderName = "evidence",
}: OciGenAiProviderOptions): AiProvider => ({
  model: jsonClient.model,
  name: resultProviderName,
  async reason(request: AiReasonerRequest): Promise<AiInvestigationResult> {
    const payload = AiInvestigationResultPayloadSchema.parse(
      await jsonClient.generateJson({
        responseName: "firsttrace_ai_investigation_result",
        systemPrompt: evidenceSystemPrompt,
        userPrompt: evidenceUserPrompt(request),
      }),
    );

    return groundAiResult(
      {
        ...payload,
        provider: resultProviderName,
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
