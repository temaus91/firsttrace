import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { groundAiResult } from "./grounding.js";
import { evidenceBaseSystemPrompt, evidenceUserPrompt } from "./prompts.js";
import { applyOpenAiResponsesRequestOptions, type ResolvedAiRequestOptions } from "./request-options.js";
import { AiInvestigationResultPayloadSchema, type AiInvestigationResultPayload } from "./schema.js";
import { buildSystemPrompt } from "../investigator/prompt-contract.js";
import type { AiInvestigationResult, AiProvider, AiReasonerRequest } from "../types.js";

export type OpenAiProviderOptions = {
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  model: string;
  requestOptions?: ResolvedAiRequestOptions;
  resultProviderName?: string;
};

export const createOpenAiProvider = ({
  apiKey,
  env,
  model,
  requestOptions,
  resultProviderName = "evidence",
}: OpenAiProviderOptions): AiProvider => {
  const client = new OpenAI({ apiKey });

  return {
    model,
    name: resultProviderName,
    async reason(request: AiReasonerRequest, promptConfig): Promise<AiInvestigationResult> {
      const prompt = buildSystemPrompt({
        basePrompt: evidenceBaseSystemPrompt,
        config: promptConfig,
        env,
      });
      const response = await client.responses.parse(applyOpenAiResponsesRequestOptions({
        input: [
          { role: "system", content: prompt.systemPrompt },
          { role: "user", content: evidenceUserPrompt(request) },
        ],
        model,
        text: {
          format: zodTextFormat(AiInvestigationResultPayloadSchema, "firsttrace_ai_investigation_result"),
        },
      }, requestOptions) as never);

      const parsed = response.output_parsed as AiInvestigationResultPayload | null;
      if (!parsed) {
        throw new Error("OpenAI did not return a structured investigation result.");
      }

      return groundAiResult({
        ...parsed,
        provider: resultProviderName,
        promptProfile: prompt.profile,
        promptVersion: prompt.version,
      }, request);
    },
  };
};
