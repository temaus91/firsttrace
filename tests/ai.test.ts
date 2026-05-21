import { describe, expect, it } from "vitest";
import { buildAiReasonerRequest } from "../src/ai/evidence.js";
import { groundAiResult } from "../src/ai/grounding.js";
import { createAiProviderFromEnv } from "../src/ai/provider-factory.js";
import type { InvestigationResult } from "../src/types.js";

const investigationResult = (): InvestigationResult => ({
  classification: "bug",
  likelyComponent: "src",
  likelyOwners: ["@core"],
  relatedCommits: [
    {
      citations: [{ commit: "abc123", label: "repo:abc123", repo: "repo" }],
      metadata: { author: "Dev Owner", date: "2026-05-21" },
      repo: "repo",
      score: 4,
      summary: "Fix investigation renderer",
      title: "abc123 Fix investigation renderer",
      type: "commit",
    },
  ],
  relatedDocs: [],
  report: "Renderer crashes on citations",
  searchTerms: ["renderer", "citations"],
  suggestedNextSteps: ["Inspect src/render.ts."],
  suspiciousFiles: [
    {
      citations: [{ label: "repo:src/render.ts:12", line: 12, path: "src/render.ts", repo: "repo" }],
      owner: "@core",
      path: "src/render.ts",
      repo: "repo",
      score: 12,
      summary: "Renderer handles citations",
      title: "src/render.ts",
      type: "file",
    },
  ],
  warnings: ["No issue exports configured."],
});

describe("AI provider support", () => {
  it("builds a bounded cited evidence bundle", () => {
    const request = buildAiReasonerRequest(investigationResult());

    expect(request.report).toBe("Renderer crashes on citations");
    expect(request.evidence.map((item) => item.id)).toEqual(["file-1", "commit-1", "warning-1"]);
    expect(request.evidence[0]).toMatchObject({
      citations: ["src/render.ts:12"],
      kind: "suspicious_file",
      owner: "@core",
      path: "src/render.ts",
      summary: "Renderer handles citations",
    });
    expect(request.evidence[1]).toMatchObject({
      citations: ["commit abc123"],
      kind: "related_commit",
      metadata: { author: "Dev Owner", date: "2026-05-21" },
    });
  });

  it("requires an OpenAI API key for the default provider", () => {
    expect(() => createAiProviderFromEnv({ FIRSTTRACE_AI_PROVIDER: "openai" })).toThrow(
      "OPENAI_API_KEY is required",
    );
  });

  it("keeps the AI provider selection explicit", () => {
    expect(() =>
      createAiProviderFromEnv({
        FIRSTTRACE_AI_PROVIDER: "unknown",
        OPENAI_API_KEY: "test-key",
      }),
    ).toThrow("Unsupported AI provider");
  });

  it("flags AI citations that were not in the evidence bundle", () => {
    const request = buildAiReasonerRequest(investigationResult());
    const grounded = groundAiResult(
      {
        confidence: 0.7,
        explanation: "Renderer evidence points at the bug.",
        implementerHints: [
          {
            citations: ["commit abc123", "made-up-commit"],
            commit: "abc123",
            email: null,
            name: "Dev Owner",
            reason: "Recent commit is related.",
          },
        ],
        likelyComponent: "src",
        likelyFiles: [
          {
            citations: ["src/render.ts:12", "unknown.ts:1"],
            confidence: 0.8,
            path: "src/render.ts",
            reason: "Renderer evidence matches.",
            repo: "repo",
          },
        ],
        likelyOwners: ["@core"],
        missingInfoQuestions: [],
        provider: "test",
        warnings: [],
      },
      request,
    );

    expect(grounded.likelyFiles[0]?.citations).toEqual(["src/render.ts:12"]);
    expect(grounded.implementerHints[0]?.citations).toEqual(["commit abc123"]);
    expect(grounded.warnings.join("\n")).toContain("unsupported citations");
  });
});
