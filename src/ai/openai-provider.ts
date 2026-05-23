import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { groundAiResult } from "./grounding.js";
import { AiInvestigationResultPayloadSchema } from "./schema.js";
import type { AiInvestigationResult, AiProvider, AiReasonerRequest } from "../types.js";

const systemPrompt = `You are FirstTrace's AI reasoner.
FirstTrace is a read-only bug localization tool.

Rules:
- Use only the provided evidence bundle.
- Do not claim to inspect files, commits, issues, or systems outside that bundle.
- Every likely file and implementer hint must cite evidence strings from the bundle.
- If the evidence is weak, lower confidence and ask concise missing-information questions.
- Prefer useful uncertainty over unsupported certainty.
- Act like a senior engineer doing the first debugging pass, not a generic summarizer.
- Pick the strongest fault-location hypothesis and explain why that code path fits the symptom.
- Set likelyComponent to the most specific route, component, module, or file path supported by evidence.
- Prefer exact file/line evidence, then recent commits or blame/history touching those files.
- Use implementer hints for the person or commit most likely to know or have contributed to the suspect code.
- For implementer hints, explain how the cited commit or author relates to the suspect code; do not only say it is recent.
- Avoid generic next steps such as "inspect the repo"; make the output useful to the next engineer opening the code.
- Keep provider-specific details out of the result.`;

const userPrompt = (request: AiReasonerRequest) => `Investigate this bug report using only this JSON evidence bundle.

Return a debugging handoff: likely fault location, why it is suspicious, owner/implementer hints, any commit that may have contributed, confidence, and missing-information questions.

${JSON.stringify(request, null, 2)}`;

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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(request) },
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
