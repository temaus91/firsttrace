import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { buildAiReasonerRequest } from "../ai/evidence.js";
import { groundAiResult } from "../ai/grounding.js";
import {
  AiInvestigationResultPayloadSchema,
  type AiInvestigationResultPayload,
} from "../ai/schema.js";
import { createInvestigationToolset } from "./tools.js";
import type {
  AiEvidenceItem,
  AiReasonerRequest,
  InvestigationToolName,
  InvestigationToolResult,
  InvestigatorProvider,
} from "../types.js";

const MAX_AGENT_STEPS = 6;
const MAX_TOOL_ERROR_LENGTH = 500;

const ToolNameSchema = z.enum(["readFile", "searchRepo", "findReferences", "gitLog", "gitBlame", "runSafeCommand"]);

const OpenAiAgentTurnSchema = z.object({
  argsJson: z.string(),
  reason: z.string(),
  result: AiInvestigationResultPayloadSchema.nullable(),
  tool: ToolNameSchema.nullable(),
  type: z.enum(["tool", "final"]),
});

const AgentFinalSchema = z.object({
  result: AiInvestigationResultPayloadSchema,
});

export type AgentTurn =
  | {
      args: Record<string, unknown>;
      reason: string;
      tool: InvestigationToolName;
      type: "tool";
    }
  | {
      result: AiInvestigationResultPayload;
      type: "final";
    };

export type AgentObservation = InvestigationToolResult & {
  id: string;
  tool: InvestigationToolName;
};

export type AgentModelInput = {
  maxSteps: number;
  observations: AgentObservation[];
  request: AiReasonerRequest;
  step: number;
};

export type AgentModelClient = {
  final(input: AgentModelInput): Promise<AiInvestigationResultPayload>;
  next(input: AgentModelInput): Promise<AgentTurn>;
};

const systemPrompt = `You are FirstTrace's read-only investigation agent.
Your job is to localize the likely cause of a bug report.

Rules:
- Use only the provided evidence and tool observations.
- Prefer cited file, line, git log, and git blame evidence.
- Use tools when they can materially improve the fault-location lead.
- Never suggest code edits as if they were already made.
- Do not ask to inspect the repo if a read-only tool can inspect it.
- Every likely file and implementer hint must cite evidence or tool observation citations.
- Return final JSON when you have the strongest supported handoff.`;

const userPrompt = (input: AgentModelInput, finalOnly = false) =>
  [
    finalOnly
      ? "Return the final FirstTrace investigation JSON. Do not request another tool."
      : "Choose the next read-only investigation step or return the final investigation JSON.",
    "",
    `Step: ${input.step}/${input.maxSteps}`,
    "",
    "Available tools:",
    "- readFile: read a bounded window from a file by repo/path/line/window.",
    "- searchRepo: fixed-string search by repo/query.",
    "- findReferences: fixed-string reference search by repo/symbolOrPath.",
    "- gitLog: recent git history by repo/path.",
    "- gitBlame: blame one file line by repo/path/line.",
    "- runSafeCommand: exact allowlist only: npm test, npm run test, npm run typecheck, npm run lint.",
    "",
    "When choosing a tool, set type=tool, set tool, and put tool arguments in argsJson as valid JSON.",
    "When returning final output, set type=final and put the final handoff in result.",
    "",
    "Investigation request and evidence:",
    JSON.stringify(input.request, null, 2),
    "",
    "Tool observations:",
    JSON.stringify(input.observations, null, 2),
  ].join("\n");

const createOpenAiAgentModelClient = (apiKey: string, model: string): AgentModelClient => {
  const client = new OpenAI({ apiKey });

  return {
    async next(input) {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(input) },
        ],
        model,
        text: {
          format: zodTextFormat(OpenAiAgentTurnSchema, "firsttrace_agent_turn"),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured investigation agent turn.");
      }
      if (response.output_parsed.type === "final") {
        if (!response.output_parsed.result) {
          throw new Error("OpenAI returned a final agent turn without result.");
        }
        return { result: response.output_parsed.result, type: "final" };
      }
      if (!response.output_parsed.tool) {
        throw new Error("OpenAI returned a tool agent turn without tool.");
      }
      let args: Record<string, unknown>;
      try {
        const argsJson = response.output_parsed.argsJson.trim() || "{}";
        const parsedArgs = JSON.parse(argsJson) as unknown;
        args = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
          ? (parsedArgs as Record<string, unknown>)
          : {};
      } catch {
        throw new Error(`OpenAI returned invalid tool args JSON: ${response.output_parsed.argsJson}`);
      }
      return {
        args,
        reason: response.output_parsed.reason,
        tool: response.output_parsed.tool,
        type: "tool",
      };
    },
    async final(input) {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(input, true) },
        ],
        model,
        text: {
          format: zodTextFormat(AgentFinalSchema, "firsttrace_agent_final"),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured final investigation result.");
      }
      return response.output_parsed.result;
    },
  };
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown tool error";

const toolErrorResult = (tool: InvestigationToolName, error: unknown): InvestigationToolResult => {
  const message = errorMessage(error);
  return {
    citations: [],
    summary: `Tool call failed: ${message.slice(0, MAX_TOOL_ERROR_LENGTH)}`,
    title: `${tool} failed`,
  };
};

const observationEvidence = (observations: AgentObservation[]): AiEvidenceItem[] =>
  observations.map((observation) => ({
    citations: observation.citations,
    id: observation.id,
    kind: "agent_observation",
    summary: observation.summary,
    title: observation.title,
  }));

const requestWithObservations = (
  request: AiReasonerRequest,
  observations: AgentObservation[],
): AiReasonerRequest => ({
  ...request,
  evidence: [...request.evidence, ...observationEvidence(observations)],
});

const groundedResult = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) =>
  groundAiResult(
    {
      ...payload,
      provider: "agent",
    },
    requestWithObservations(request, observations),
  );

export type AgentInvestigatorOptions =
  | {
      apiKey: string;
      model: string;
      modelClient?: never;
    }
  | {
      model: string;
      modelClient: AgentModelClient;
      apiKey?: never;
    };

export const createAgentInvestigator = (options: AgentInvestigatorOptions): InvestigatorProvider => {
  const modelClient = options.modelClient ?? createOpenAiAgentModelClient(options.apiKey, options.model);

  return {
    model: options.model,
    name: "agent",
    async investigate({ preparedConfig, result }) {
      const baseRequest = buildAiReasonerRequest(result);
      const toolset = createInvestigationToolset(preparedConfig);
      const observations: AgentObservation[] = [];

      for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
        const request = requestWithObservations(baseRequest, observations);
        const turn = await modelClient.next({ maxSteps: MAX_AGENT_STEPS, observations, request, step });
        if (turn.type === "final") {
          return groundedResult(turn.result, baseRequest, observations);
        }

        let toolResult: InvestigationToolResult;
        try {
          toolResult = await toolset.execute(turn.tool, turn.args);
        } catch (error) {
          toolResult = toolErrorResult(turn.tool, error);
        }
        observations.push({
          ...toolResult,
          id: `tool-${observations.length + 1}`,
          tool: turn.tool,
        });
      }

      const request = requestWithObservations(baseRequest, observations);
      const resultPayload = await modelClient.final({
        maxSteps: MAX_AGENT_STEPS,
        observations,
        request,
        step: MAX_AGENT_STEPS,
      });
      return groundedResult(resultPayload, baseRequest, observations);
    },
  };
};
