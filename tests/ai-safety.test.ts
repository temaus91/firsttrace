import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { sanitizeReportForAi } from "../src/ai/safety.js";
import { loadConfig } from "../src/config.js";
import { executeInvestigation } from "../src/investigation-runner.js";
import type { AiReasonerRequest, InvestigatorProvider } from "../src/types.js";

const tempConfigPath = () => {
  const dir = path.join(tmpdir(), `firsttrace-ai-safety-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "README.md"), "Checkout failed after retry with token handling.\n");
  const configPath = path.join(dir, "firsttrace.config.yaml");
  writeFileSync(
    configPath,
    [
      "repos:",
      "  - name: app",
      "    path: repo",
      "docs:",
      "  - README.md",
      "issue_exports: []",
      "chat:",
      "  provider: slack",
      "  channels:",
      "    - id: C0123456789",
      "      name: triage",
      "      triggers:",
      "        - app_mention",
      "      response: thread",
      "      ai_enabled: true",
      "      data_classification: internal",
      "      include_thread_context: false",
      "      repositories:",
      "        - app",
    ].join("\n"),
  );
  return configPath;
};

const fakeInvestigator = (requests: AiReasonerRequest[]): InvestigatorProvider => ({
  model: "test-model",
  name: "test-agent",
  async investigate({ result }) {
    requests.push({
      classification: result.classification,
      evidence: [],
      likelyComponent: result.likelyComponent,
      likelyOwners: result.likelyOwners,
      report: result.report,
      searchTerms: result.searchTerms,
      warnings: result.warnings,
    });
    return {
      confidence: 0.5,
      explanation: "ok",
      implementerHints: [],
      likelyComponent: result.likelyComponent,
      likelyFiles: [],
      likelyOwners: [],
      missingInfoQuestions: [],
      provider: "test-agent",
      warnings: [],
    };
  },
});

describe("AI safety guardrails", () => {
  it("redacts common credentials before AI receives the report", async () => {
    const requests: AiReasonerRequest[] = [];
    const slackToken = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    const result = await executeInvestigation({
      config: loadConfig(tempConfigPath()),
      env: {},
      investigatorProvider: fakeInvestigator(requests),
      report: `Checkout failed with token ${slackToken} and password=hunter2`,
      source: { channelId: "C0123456789", provider: "slack" },
    });

    expect(result.ai?.provider).toBe("test-agent");
    expect(requests[0]?.report).toContain("[REDACTED_SLACK_TOKEN]");
    expect(requests[0]?.report).toContain("password=[REDACTED_SECRET]");
    expect(requests[0]?.report).not.toContain("hunter2");
    expect(result.warnings).toContain("AI safety redacted Slack token.");
    expect(result.warnings).toContain("AI safety redacted password assignment.");
  });

  it("skips AI when blocked content markers are present", async () => {
    const requests: AiReasonerRequest[] = [];
    const result = await executeInvestigation({
      config: loadConfig(tempConfigPath()),
      env: {},
      investigatorProvider: fakeInvestigator(requests),
      report: "Checkout failed for patient diagnosis workflow",
      source: { channelId: "C0123456789", provider: "slack" },
    });

    expect(result.ai).toBeUndefined();
    expect(requests).toEqual([]);
    expect(result.warnings).toContain("AI safety blocked possible PHI.");
    expect(result.warnings).toContain("AI skipped by safety guardrail: possible PHI.");
  });

  it("returns a dry-run AI result with the sanitized report", async () => {
    const requests: AiReasonerRequest[] = [];
    const openAiKey = ["sk", "abcdefghijklmnop1234567890"].join("-");
    const result = await executeInvestigation({
      config: loadConfig(tempConfigPath()),
      env: { FIRSTTRACE_AI_DRY_RUN: "true" },
      investigatorProvider: fakeInvestigator(requests),
      report: `Checkout failed with ${openAiKey}`,
      source: { channelId: "C0123456789", provider: "slack" },
    });

    expect(requests).toEqual([]);
    expect(result.ai?.provider).toBe("ai-dry-run");
    expect(result.ai?.explanation).toContain("[REDACTED_OPENAI_KEY]");
    expect(result.ai?.explanation).not.toContain(openAiKey);
  });

  it("skips AI for restricted Slack channels", async () => {
    const config = loadConfig(tempConfigPath());
    config.chat!.channels[0]!.dataClassification = "restricted";
    const requests: AiReasonerRequest[] = [];
    const result = await executeInvestigation({
      config,
      env: {},
      investigatorProvider: fakeInvestigator(requests),
      report: "Checkout failed after retry",
      source: { channelId: "C0123456789", provider: "slack" },
    });

    expect(result.ai).toBeUndefined();
    expect(requests).toEqual([]);
    expect(result.warnings).toContain("AI skipped: Slack channel data_classification is restricted.");
  });

  it("detects payment cards separately from redaction", () => {
    const result = sanitizeReportForAi("Payment failed for card 4242 4242 4242 4242");

    expect(result.allowed).toBe(false);
    expect(result.blockedReasons).toEqual(["possible PCI payment card"]);
  });

  it("can reject instead of redact when configured", () => {
    const result = sanitizeReportForAi("Checkout failed with token=abc123", "reject");

    expect(result.allowed).toBe(false);
    expect(result.report).toContain("token=[REDACTED_SECRET]");
    expect(result.blockedReasons).toEqual(["sensitive password assignment"]);
  });
});
