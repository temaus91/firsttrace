import { describe, expect, it } from "vitest";
import { buildAiReasonerRequest } from "../src/ai/evidence.js";
import { createOciGenAiJsonClient, type OciGenAiChatClient } from "../src/ai/oci-genai-json-client.js";
import { createOciGenAiProvider } from "../src/ai/oci-genai-provider.js";
import { createOciGenAiAgentModelClient } from "../src/investigator/oci-genai-agent-client.js";
import type { AiInvestigationResultPayload } from "../src/ai/schema.js";
import type { InvestigationResult } from "../src/types.js";

const investigationResult = (): InvestigationResult => ({
  classification: "bug",
  likelyComponent: "src",
  likelyOwners: [],
  relatedCommits: [],
  relatedDocs: [],
  report: "Renderer crashes on citations",
  searchTerms: ["renderer", "citations"],
  suggestedNextSteps: ["Inspect src/render.ts."],
  suspiciousFiles: [
    {
      citations: [{ label: "repo:src/render.ts:12", line: 12, path: "src/render.ts", repo: "repo" }],
      path: "src/render.ts",
      repo: "repo",
      score: 12,
      summary: "Renderer handles citations",
      title: "src/render.ts",
      type: "file",
    },
  ],
  warnings: [],
});

const aiPayload = (): AiInvestigationResultPayload => ({
  confidence: 0.82,
  explanation: "Renderer evidence points at the citation crash.",
  implementerHints: [],
  likelyComponent: "src/render.ts",
  likelyFiles: [
    {
      citations: ["src/render.ts:12"],
      confidence: 0.82,
      path: "src/render.ts",
      reason: "The report and deterministic evidence both point to renderer citation handling.",
      repo: "repo",
    },
  ],
  likelyOwners: [],
  missingInfoQuestions: [],
  warnings: [],
});

const fakeChatClient = (text: string, requests: unknown[] = []): OciGenAiChatClient => ({
  async chat(request) {
    requests.push(request);
    return {
      chatResult: {
        chatResponse: {
          choices: [
            {
              message: {
                content: [{ text, type: "TEXT" }],
              },
            },
          ],
        },
      },
      etag: "",
      modelDeprecationInfo: "",
      opcRequestId: "request-id",
    } as never;
  },
});

describe("OCI GenAI provider", () => {
  it("sends JSON-mode on-demand chat requests and parses JSON", async () => {
    const requests: unknown[] = [];
    const client = createOciGenAiJsonClient({
      chatClient: fakeChatClient('{"ok":true}', requests),
      compartmentId: "ocid1.compartment.oc1..test",
      model: "openai.gpt-oss-120b",
      region: "us-chicago-1",
    });

    await expect(
      client.generateJson({
        responseName: "test_response",
        systemPrompt: "System",
        userPrompt: "User",
      }),
    ).resolves.toEqual({ ok: true });

    expect(requests[0]).toMatchObject({
      chatDetails: {
        chatRequest: {
          apiFormat: "GENERIC",
          responseFormat: { type: "JSON_OBJECT" },
          temperature: 0,
        },
        compartmentId: "ocid1.compartment.oc1..test",
        servingMode: {
          modelId: "openai.gpt-oss-120b",
          servingType: "ON_DEMAND",
        },
      },
    });
  });

  it("supports dedicated OCI GenAI endpoint serving mode", async () => {
    const requests: unknown[] = [];
    const client = createOciGenAiJsonClient({
      chatClient: fakeChatClient('{"ok":true}', requests),
      compartmentId: "ocid1.compartment.oc1..test",
      dedicatedEndpointId: "ocid1.generativeaiendpoint.oc1..test",
      model: "custom-model",
    });

    await client.generateJson({ responseName: "test_response", systemPrompt: "System", userPrompt: "User" });

    expect(requests[0]).toMatchObject({
      chatDetails: {
        servingMode: {
          endpointId: "ocid1.generativeaiendpoint.oc1..test",
          servingType: "DEDICATED",
        },
      },
    });
  });

  it("fails clearly on invalid OCI GenAI JSON", async () => {
    const client = createOciGenAiJsonClient({
      chatClient: fakeChatClient("not json"),
      compartmentId: "ocid1.compartment.oc1..test",
      model: "openai.gpt-oss-120b",
    });

    await expect(
      client.generateJson({ responseName: "test_response", systemPrompt: "System", userPrompt: "User" }),
    ).rejects.toThrow("OCI GenAI did not return valid JSON");
  });

  it("grounds one-shot evidence results from OCI GenAI", async () => {
    const provider = createOciGenAiProvider({
      jsonClient: {
        async generateJson() {
          return aiPayload();
        },
        model: "openai.gpt-oss-120b",
      },
    });

    const result = await provider.reason(buildAiReasonerRequest(investigationResult()));

    expect(result.provider).toBe("evidence");
    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
  });

  it("adapts OCI GenAI agent turns and final results", async () => {
    const calls: string[] = [];
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson(request) {
          calls.push(request.responseName);
          if (request.responseName === "firsttrace_agent_turn") {
            return {
              argsJson: "{\"path\":\"src/render.ts\"}",
              reason: "Read the strongest file lead.",
              result: null,
              tool: "readFile",
              type: "tool",
            };
          }
          return { result: aiPayload() };
        },
        model: "openai.gpt-oss-120b",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      args: { path: "src/render.ts" },
      tool: "readFile",
      type: "tool",
    });
    await expect(
      client.final({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 8 }),
    ).resolves.toMatchObject({
      likelyComponent: "src/render.ts",
    });
    expect(calls).toEqual(["firsttrace_agent_turn", "firsttrace_agent_final"]);
  });
});
