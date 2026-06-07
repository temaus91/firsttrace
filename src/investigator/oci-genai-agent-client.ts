import { createOciGenAiJsonClient, type OciGenAiJsonClient } from "../ai/oci-genai-json-client.js";
import type { ResolvedAiRequestOptions } from "../ai/request-options.js";
import { agentBaseSystemPrompt } from "./agent-prompts.js";
import { normalizeAgentFinalResponse, normalizeAgentTurnResponse } from "./agent-schemas.js";
import { agentUserPrompt, buildSystemPrompt } from "./prompt-contract.js";
import type { AgentModelClient, AgentTurn } from "./agent-provider.js";

export type OciGenAiAgentClientOptions = {
  jsonClient: OciGenAiJsonClient;
};

const turnFromPayload = (payload: unknown): AgentTurn => {
  let parsed;
  try {
    parsed = normalizeAgentTurnResponse(payload);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes("argsJson") || message.includes("args") || message.includes("arguments") || message.includes("tool_arguments")) {
      throw new Error(`OCI GenAI returned invalid tool arguments: ${message}`);
    }
    throw error;
  }
  if (parsed.type === "final") {
    if (!parsed.result) {
      throw new Error("OCI GenAI returned a final agent turn without result.");
    }
    return { result: parsed.result, type: "final" };
  }
  if (!parsed.tool) {
    throw new Error("OCI GenAI returned a tool agent turn without tool.");
  }

  return {
    args: parsed.args,
    reason: parsed.reason,
    tool: parsed.tool,
    type: "tool",
  };
};

export const createOciGenAiAgentModelClient = ({ jsonClient }: OciGenAiAgentClientOptions): AgentModelClient => ({
  async next(input) {
    const prompt = input.prompt ?? buildSystemPrompt({ basePrompt: agentBaseSystemPrompt });
    return turnFromPayload(
      await jsonClient.generateJson({
        responseName: "firsttrace_agent_turn",
        systemPrompt: prompt.systemPrompt,
        userPrompt: agentUserPrompt(input),
      }),
    );
  },
  async final(input) {
    const prompt = input.prompt ?? buildSystemPrompt({ basePrompt: agentBaseSystemPrompt });
    const payload = normalizeAgentFinalResponse(
      await jsonClient.generateJson({
        responseName: "firsttrace_agent_final",
        systemPrompt: prompt.systemPrompt,
        userPrompt: agentUserPrompt(input, true),
      }),
    );
    return payload.result;
  },
});

export const createOciGenAiAgentModelClientFromConfig = ({
  compartmentId,
  dedicatedEndpointId,
  endpoint,
  env,
  model,
  region,
  requestOptions,
}: {
  compartmentId: string;
  dedicatedEndpointId?: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  model: string;
  region?: string;
  requestOptions?: ResolvedAiRequestOptions;
}) =>
  createOciGenAiAgentModelClient({
    jsonClient: createOciGenAiJsonClient({
      compartmentId,
      dedicatedEndpointId,
      endpoint,
      env,
      model,
      region,
      requestOptions,
    }),
  });
