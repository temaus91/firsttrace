import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { zodTextFormat } from "openai/helpers/zod";
import { describe, expect, it } from "vitest";
import { AiInvestigationResultPayloadWireSchema } from "../src/ai/schema.js";
import { loadConfig } from "../src/config.js";
import { renderAiDoctor, runAiDoctor } from "../src/diagnostics/ai-doctor.js";
import {
  AgentFinalWireResponseSchema,
  AgentTurnWireResponseSchema,
} from "../src/investigator/agent-schemas.js";

const writeConfig = () => {
  const dir = path.join(tmpdir(), `firsttrace-ai-doctor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(dir, "repo"), { recursive: true });
  writeFileSync(path.join(dir, "repo", "README.md"), "README deployment plan is unclear.\n");
  const configPath = path.join(dir, "firsttrace.config.yaml");
  writeFileSync(
    configPath,
    [
      "repos:",
      "  - name: app",
      "    path: repo",
      "docs: []",
      "issue_exports: []",
      "investigation:",
      "  ai:",
      "    request:",
      "      output_token_limit:",
      "        value: 6000",
      "        field: maxCompletionTokens",
    ].join("\n"),
  );
  return loadConfig(configPath);
};

describe("AI doctor diagnostics", () => {
  it("uses OpenAI-compatible wire schemas for structured output", () => {
    expect(() => zodTextFormat(AgentTurnWireResponseSchema, "firsttrace_agent_turn")).not.toThrow();
    expect(() => zodTextFormat(AgentFinalWireResponseSchema, "firsttrace_agent_final")).not.toThrow();
    expect(() => zodTextFormat(AiInvestigationResultPayloadWireSchema, "firsttrace_ai_investigation_result")).not.toThrow();
  });

  it("passes provider and parser diagnostics with an injected live probe", async () => {
    const seen: string[] = [];
    const result = await runAiDoctor({
      config: writeConfig(),
      env: {
        FIRSTTRACE_MODEL_CHAT: "gpt-5.4-mini",
        OPENAI_API_KEY: "sk-test-1234567890abcdef",
      },
      liveProbe: async ({ provider, requestOptions }) => {
        seen.push(provider);
        expect(requestOptions.config.outputTokenLimit).toMatchObject({
          field: "maxCompletionTokens",
          value: 6000,
        });
      },
    });

    expect(result.passed).toBe(true);
    expect(seen).toEqual(["openai"]);
    expect(renderAiDoctor(result)).toContain("FirstTrace AI doctor: PASS");
  });

  it("redacts live probe failures", async () => {
    const secret = "sk-test-1234567890abcdef";
    const result = await runAiDoctor({
      config: writeConfig(),
      env: {
        OPENAI_API_KEY: secret,
      },
      liveProbe: async () => {
        throw new Error(`Provider rejected token=${secret} with Bearer ${secret}.`);
      },
    });
    const rendered = renderAiDoctor(result);

    expect(result.passed).toBe(false);
    expect(rendered).toContain("FAIL Live provider probe");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain("[REDACTED_SECRET]");
  });

  it("fails clearly when the default live probe is missing provider credentials", async () => {
    const result = await runAiDoctor({
      config: writeConfig(),
      env: {},
    });

    expect(result.passed).toBe(false);
    expect(renderAiDoctor(result)).toContain("OPENAI_API_KEY is required");
  });
});
