import { describe, expect, it } from "vitest";
import { buildAiReasonerRequest } from "../src/ai/evidence.js";
import { createOciGenAiJsonClient, type OciGenAiChatClient } from "../src/ai/oci-genai-json-client.js";
import { createOciGenAiProvider } from "../src/ai/oci-genai-provider.js";
import { resolveAiRequestOptions } from "../src/ai/request-options.js";
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
      model: "openai.gpt-5-codex",
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
        },
        compartmentId: "ocid1.compartment.oc1..test",
        servingMode: {
          modelId: "openai.gpt-5-codex",
          servingType: "ON_DEMAND",
        },
      },
    });
    const chatRequest = (requests[0] as { chatDetails: { chatRequest: Record<string, unknown> } }).chatDetails.chatRequest;
    expect(chatRequest).not.toHaveProperty("maxTokens");
    expect(chatRequest).not.toHaveProperty("maxCompletionTokens");
    expect(chatRequest).not.toHaveProperty("temperature");
  });

  it("applies configured request options to chat requests", async () => {
    const requests: unknown[] = [];
    const model = "openai.gpt-5-codex";
    const client = createOciGenAiJsonClient({
      chatClient: fakeChatClient('{"ok":true}', requests),
      compartmentId: "ocid1.compartment.oc1..test",
      model,
      requestOptions: resolveAiRequestOptions({
        config: {
          extra: { serviceTier: "priority" },
          outputTokenLimit: { value: 4096 },
          temperature: { value: 0 },
        },
        env: {},
        model,
        provider: "oci-genai",
      }),
    });

    await client.generateJson({ responseName: "test_response", systemPrompt: "System", userPrompt: "User" });

    const chatRequest = (requests[0] as { chatDetails: { chatRequest: Record<string, unknown> } }).chatDetails.chatRequest;
    expect(chatRequest).toMatchObject({
      maxCompletionTokens: 4096,
      serviceTier: "priority",
      temperature: 0,
    });
    expect(chatRequest).not.toHaveProperty("maxTokens");
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
      model: "openai.gpt-5-codex",
    });

    await expect(
      client.generateJson({ responseName: "test_response", systemPrompt: "System", userPrompt: "User" }),
    ).rejects.toThrow("OCI GenAI did not return valid JSON");
  });

  it("includes model and region when OCI GenAI chat fails", async () => {
    const client = createOciGenAiJsonClient({
      chatClient: {
        async chat() {
          throw new Error("fetch failed");
        },
      },
      compartmentId: "ocid1.compartment.oc1..test",
      model: "openai.gpt-5-codex",
      region: "us-sanjose-1",
    });

    await expect(
      client.generateJson({ responseName: "test_response", systemPrompt: "System", userPrompt: "User" }),
    ).rejects.toThrow("OCI GenAI chat failed for model openai.gpt-5-codex in region us-sanjose-1: fetch failed");
  });

  it("grounds one-shot evidence results from OCI GenAI", async () => {
    const provider = createOciGenAiProvider({
      jsonClient: {
        async generateJson() {
          return aiPayload();
        },
        model: "openai.gpt-5-codex",
      },
    });

    const result = await provider.reason(buildAiReasonerRequest(investigationResult()));

    expect(result.provider).toBe("evidence");
    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
  });

  it("normalizes wrapped one-shot evidence results from OCI GenAI", async () => {
    const provider = createOciGenAiProvider({
      jsonClient: {
        async generateJson() {
          return { result: aiPayload() };
        },
        model: "openai.gpt-5-codex",
      },
    });

    const result = await provider.reason(buildAiReasonerRequest(investigationResult()));

    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
    expect(result.warnings).toContain(
      "Provider returned a nested final payload; FirstTrace normalized it to the investigation result schema.",
    );
  });

  it("normalizes agent-turn-shaped one-shot evidence results from OCI GenAI", async () => {
    const provider = createOciGenAiProvider({
      jsonClient: {
        async generateJson() {
          return {
            argsJson: "{}",
            reason: "Provider returned a final turn.",
            result: aiPayload(),
            tool: null,
            type: "final",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    const result = await provider.reason(buildAiReasonerRequest(investigationResult()));

    expect(result.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
    expect(result.warnings).toContain(
      "Provider returned an agent final turn; FirstTrace normalized it to the investigation result schema.",
    );
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
        model: "openai.gpt-5-codex",
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

  it("accepts OCI GenAI tool arguments as argsJson object", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            argsJson: { path: "src/render.ts" },
            tool: "readFile",
            type: "tool",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      args: { path: "src/render.ts" },
      reason: "Model requested tool execution.",
      tool: "readFile",
      type: "tool",
    });
  });

  it("accepts OCI GenAI tool arguments as args object", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            args: { query: "renderCitation" },
            tool: "searchRepo",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      args: { query: "renderCitation" },
      tool: "searchRepo",
      type: "tool",
    });
  });

  it("accepts OCI GenAI tool arguments as arguments JSON string", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            arguments: "{\"symbolOrPath\":\"renderCitation\"}",
            tool: "findReferences",
            type: "tool",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      args: { symbolOrPath: "renderCitation" },
      tool: "findReferences",
      type: "tool",
    });
  });

  it("accepts OCI GenAI tool arguments as tool_arguments object", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            tool: "gitLog",
            tool_arguments: { path: "src/render.ts" },
            type: "tool",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      args: { path: "src/render.ts" },
      tool: "gitLog",
      type: "tool",
    });
  });

  it("normalizes simplified OCI GenAI final payloads", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return aiPayload();
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      result: {
        likelyComponent: "src/render.ts",
        warnings: expect.arrayContaining([
          "Provider returned a direct final payload; FirstTrace normalized it to the agent turn schema.",
        ]),
      },
      type: "final",
    });
  });

  it("normalizes wrapped OCI GenAI final-only responses", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            argsJson: "{}",
            reason: "Provider returned an agent final turn.",
            result: aiPayload(),
            tool: null,
            type: "final",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.final({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 8 }),
    ).resolves.toMatchObject({
      likelyComponent: "src/render.ts",
      warnings: expect.arrayContaining([
        "Provider returned an agent final turn; FirstTrace normalized it to the final response schema.",
      ]),
    });
  });

  it("accepts final turns without argsJson or reason", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            result: {
              ...aiPayload(),
              bugLikelihood: "Likely Bug",
            },
            type: "final",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).resolves.toMatchObject({
      result: {
        bugLikelihood: "likely_bug",
        likelyComponent: "src/render.ts",
      },
      type: "final",
    });
  });

  it("fails clearly on malformed OCI GenAI tool arguments", async () => {
    const client = createOciGenAiAgentModelClient({
      jsonClient: {
        async generateJson() {
          return {
            argsJson: "{not-json",
            reason: "Read a file.",
            result: null,
            tool: "readFile",
            type: "tool",
          };
        },
        model: "openai.gpt-5-codex",
      },
    });

    await expect(
      client.next({ maxSteps: 8, observations: [], request: buildAiReasonerRequest(investigationResult()), step: 1 }),
    ).rejects.toThrow("OCI GenAI returned invalid tool arguments");
  });
});
