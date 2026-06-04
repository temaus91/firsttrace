import { createOciGenAiJsonClient, type OciGenAiJsonClient } from "../ai/oci-genai-json-client.js";
import { agentBaseSystemPrompt } from "./agent-prompts.js";
import { normalizeAgentFinalResponse, normalizeAgentTurnResponse } from "./agent-schemas.js";
import { agentUserPrompt, buildSystemPrompt } from "./prompt-contract.js";
import type { AgentModelClient, AgentTurn } from "./agent-provider.js";

export type OciGenAiAgentClientOptions = {
  jsonClient: OciGenAiJsonClient;
};

const turnFromPayload = (payload: unknown): AgentTurn => {
  const parsed = normalizeAgentTurnResponse(payload);
  if (parsed.type === "final") {
    if (!parsed.result) {
      throw new Error("OCI GenAI returned a final agent turn without result.");
    }
    return { result: parsed.result, type: "final" };
  }
  if (!parsed.tool) {
    throw new Error("OCI GenAI returned a tool agent turn without tool.");
  }

  let args: Record<string, unknown>;
  try {
    const argsJson = parsed.argsJson.trim() || "{}";
    const parsedArgs = JSON.parse(argsJson) as unknown;
    args = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
      ? (parsedArgs as Record<string, unknown>)
      : {};
  } catch {
    throw new Error(`OCI GenAI returned invalid tool args JSON: ${parsed.argsJson}`);
  }

  return {
    args,
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
  maxTokens,
  model,
  region,
}: {
  compartmentId: string;
  dedicatedEndpointId?: string;
  endpoint?: string;
  env?: NodeJS.ProcessEnv;
  maxTokens?: number;
  model: string;
  region?: string;
}) =>
  createOciGenAiAgentModelClient({
    jsonClient: createOciGenAiJsonClient({
      compartmentId,
      dedicatedEndpointId,
      endpoint,
      env,
      maxTokens,
      model,
      region,
    }),
  });
