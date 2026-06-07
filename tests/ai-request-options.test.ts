import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  aiRequestConfigFromEnv,
  applyOciGenAiGenericChatRequestOptions,
  applyOpenAiResponsesRequestOptions,
  resolveAiRequestOptions,
} from "../src/ai/request-options.js";

const resolved = (
  config = {},
  model = "openai.gpt-5-codex",
  provider: "oci-genai" | "openai" = "oci-genai",
) =>
  resolveAiRequestOptions({
    config,
    env: {},
    model,
    provider,
  });

describe("AI request options", () => {
  it("omits OCI token limits by default", () => {
    const request = applyOciGenAiGenericChatRequestOptions({
      apiFormat: "GENERIC",
      responseFormat: { type: "JSON_OBJECT" },
    }, resolved());

    expect(request).not.toHaveProperty("maxTokens");
    expect(request).not.toHaveProperty("maxCompletionTokens");
    expect(request).toMatchObject({
      apiFormat: "GENERIC",
      responseFormat: { type: "JSON_OBJECT" },
    });
  });

  it("maps OCI OpenAI-family token limits to maxCompletionTokens in auto mode", () => {
    const request = applyOciGenAiGenericChatRequestOptions(
      { apiFormat: "GENERIC" },
      resolved({
        outputTokenLimit: { value: 4096 },
      }),
    );

    expect(request).toMatchObject({ maxCompletionTokens: 4096 });
    expect(request).not.toHaveProperty("maxTokens");
  });

  it("honors explicit OCI token field overrides", () => {
    const request = applyOciGenAiGenericChatRequestOptions(
      { apiFormat: "GENERIC" },
      resolved({
        outputTokenLimit: { field: "maxTokens", value: 2048 },
      }),
    );

    expect(request).toMatchObject({ maxTokens: 2048 });
    expect(request).not.toHaveProperty("maxCompletionTokens");
  });

  it("supports omitting configured common fields", () => {
    const request = applyOciGenAiGenericChatRequestOptions(
      { apiFormat: "GENERIC" },
      resolved({
        temperature: { field: "none", value: 0 },
      }),
    );

    expect(request).toEqual({ apiFormat: "GENERIC" });
  });

  it("applies raw request overlays and null removals last", () => {
    const request = applyOciGenAiGenericChatRequestOptions(
      {
        apiFormat: "GENERIC",
        responseFormat: { type: "JSON_OBJECT" },
        temperature: 0,
      },
      resolved({
        extra: {
          metadata: { owner: "firsttrace" },
          responseFormat: null,
          temperature: null,
        },
      }),
    );

    expect(request).toEqual({
      apiFormat: "GENERIC",
      metadata: { owner: "firsttrace" },
    });
  });

  it("maps OpenAI Responses controls without losing existing text format", () => {
    const request = applyOpenAiResponsesRequestOptions(
      {
        input: "report",
        model: "gpt-5.4-mini",
        text: { format: { name: "firsttrace" } },
      },
      resolved({
        outputTokenLimit: { value: 3000 },
        reasoningEffort: { value: "medium" },
        store: { value: false },
        topK: { value: 10 },
        topP: { value: 0.4 },
        verbosity: { value: "low" },
      }, "gpt-5.4-mini", "openai"),
    );

    expect(request).toMatchObject({
      max_output_tokens: 3000,
      reasoning: { effort: "medium" },
      store: false,
      text: { format: { name: "firsttrace" }, verbosity: "low" },
      top_p: 0.4,
    });
    expect(request).not.toHaveProperty("top_k");
  });

  it("parses environment aliases, fields, and raw JSON", () => {
    const config = aiRequestConfigFromEnv({
      FIRSTTRACE_AI_MAX_TOKENS: "2222",
      FIRSTTRACE_AI_OUTPUT_TOKEN_LIMIT_FIELD: "maxTokens",
      FIRSTTRACE_AI_REQUEST_EXTRA_JSON: "{\"serviceTier\":\"priority\"}",
      FIRSTTRACE_AI_TEMPERATURE: "0",
      FIRSTTRACE_AI_TEMPERATURE_FIELD: "",
    });

    expect(config).toMatchObject({
      extra: { serviceTier: "priority" },
      outputTokenLimit: { field: "maxTokens", value: 2222 },
      temperature: { field: "none", value: 0 },
    });
  });

  it("loads YAML request options from firsttrace config", () => {
    const dir = path.join(tmpdir(), `firsttrace-ai-request-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "firsttrace.config.yaml");
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: app",
        "    path: .",
        "investigation:",
        "  ai:",
        "    request:",
        "      output_token_limit:",
        "        value: 5000",
        "        field: maxCompletionTokens",
        "      reasoning_effort: medium",
        "      extra:",
        "        serviceTier: priority",
      ].join("\n"),
    );

    expect(loadConfig(configPath).investigation.ai?.request).toMatchObject({
      extra: { serviceTier: "priority" },
      outputTokenLimit: { field: "maxCompletionTokens", value: 5000 },
      reasoningEffort: { value: "medium" },
    });
  });
});
