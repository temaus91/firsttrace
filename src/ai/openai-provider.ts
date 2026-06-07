import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { groundAiResult } from "./grounding.js";
import { evidenceBaseSystemPrompt, evidenceUserPrompt } from "./prompts.js";
import { applyOpenAiResponsesRequestOptions, type ResolvedAiRequestOptions } from "./request-options.js";
import {
  AiInvestigationResultPayloadWireSchema,
  normalizeAiInvestigationResultPayload,
} from "./schema.js";
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
          format: zodTextFormat(AiInvestigationResultPayloadWireSchema, "firsttrace_ai_investigation_result"),
        },
      }, requestOptions) as never);

      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured investigation result.");
      }
      const parsed = normalizeAiInvestigationResultPayload(response.output_parsed);

      return groundAiResult({
        ...parsed,
        provider: resultProviderName,
        promptProfile: prompt.profile,
        promptVersion: prompt.version,
      }, request);
    },
  };
};
