import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { groundAiResult } from "./grounding.js";
import { evidenceSystemPrompt, evidenceUserPrompt } from "./prompts.js";
import { AiInvestigationResultPayloadSchema } from "./schema.js";
import type { AiInvestigationResult, AiProvider, AiReasonerRequest } from "../types.js";

export type OpenAiProviderOptions = {
  apiKey: string;
  model: string;
  resultProviderName?: string;
};

export const createOpenAiProvider = ({ apiKey, model, resultProviderName = "evidence" }: OpenAiProviderOptions): AiProvider => {
  const client = new OpenAI({ apiKey });

  return {
    model,
    name: resultProviderName,
    async reason(request: AiReasonerRequest): Promise<AiInvestigationResult> {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: evidenceSystemPrompt },
          { role: "user", content: evidenceUserPrompt(request) },
        ],
        model,
        text: {
          format: zodTextFormat(AiInvestigationResultPayloadSchema, "firsttrace_ai_investigation_result"),
        },
      });

      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured investigation result.");
      }

      return groundAiResult({
        ...response.output_parsed,
        provider: resultProviderName,
      }, request);
    },
  };
};
