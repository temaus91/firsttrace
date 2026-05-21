import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadEvalCases } from "../src/eval/cases.js";
import { renderEvalRun } from "../src/eval/render.js";
import { runEval } from "../src/eval/runner.js";
import { scoreEvalResult } from "../src/eval/scoring.js";
import type { EvalCase, FirstTraceConfig, InvestigationResult } from "../src/types.js";

const evalCase = (): EvalCase => ({
  expectedClassification: "bug",
  expectedComponent: "src",
  expectedFiles: ["src/render.ts"],
  expectedOwners: ["@core"],
  id: "renderer-crash",
  report: "Renderer crashes on citations",
});

const investigationResult = (): InvestigationResult => ({
  classification: "bug",
  likelyComponent: "src",
  likelyOwners: ["@core"],
  relatedCommits: [
    {
      citations: [{ commit: "abc123", label: "repo:abc123", repo: "repo" }],
      repo: "repo",
      score: 3,
      summary: "Fix renderer crash",
      title: "abc123 Fix renderer crash",
      type: "commit",
    },
  ],
  relatedDocs: [],
  report: "Renderer crashes on citations",
  searchTerms: ["renderer", "citations"],
  suggestedNextSteps: ["Inspect src/render.ts."],
  suspiciousFiles: [
    {
      citations: [{ label: "repo:src/render.ts:10", line: 10, path: "src/render.ts", repo: "repo" }],
      owner: "@core",
      path: "src/render.ts",
      repo: "repo",
      score: 9,
      summary: "Renderer handles citations",
      title: "src/render.ts",
      type: "file",
    },
  ],
  warnings: [],
});

const config = (): FirstTraceConfig => ({
  configPath: "firsttrace.config.yaml",
  docs: [],
  issueExports: [],
  owners: [{ owner: "@project-docs", path: "README.md" }],
  repos: [{ name: "firsttrace", path: process.cwd() }],
  search: {
    maxCommits: 8,
    maxEvidencePerFile: 3,
    maxFiles: 10,
  },
});

describe("eval support", () => {
  it("loads eval cases from YAML", () => {
    const dir = path.join(tmpdir(), `firsttrace-eval-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "cases.yaml");
    writeFileSync(
      filePath,
      [
        "- id: readme-deployment-plan",
        '  report: "README deployment plan is unclear"',
        "  expected_classification: unknown",
        "  expected_component: README.md",
        "  expected_files:",
        "    - README.md",
        "  expected_owners:",
        '    - "@project-docs"',
      ].join("\n"),
    );

    expect(loadEvalCases(filePath)).toEqual([
      {
        expectedClassification: "unknown",
        expectedComponent: "README.md",
        expectedFiles: ["README.md"],
        expectedOwners: ["@project-docs"],
        id: "readme-deployment-plan",
        notes: undefined,
        report: "README deployment plan is unclear",
      },
    ]);
  });

  it("rejects eval cases without expectations", () => {
    const dir = path.join(tmpdir(), `firsttrace-empty-eval-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "cases.yaml");
    writeFileSync(filePath, ['- id: empty-case', '  report: "Something happened"'].join("\n"));

    expect(() => loadEvalCases(filePath)).toThrow("must define at least one expected result field");
  });

  it("scores deterministic eval results", () => {
    const score = scoreEvalResult(evalCase(), investigationResult());

    expect(score.passed).toBe(true);
    expect(score.classificationMatched).toBe(true);
    expect(score.componentMatched).toBe(true);
    expect(score.expectedFilesFound).toEqual(["src/render.ts"]);
    expect(score.expectedOwnersFound).toEqual(["@core"]);
    expect(score.citationCoverage).toBe(1);
    expect(score.usefulness).toBe(1);
  });

  it("scores AI eval results and counts unsupported citations", () => {
    const result = investigationResult();
    result.ai = {
      confidence: 0.8,
      explanation: "Renderer evidence matches.",
      implementerHints: [
        {
          citations: [],
          commit: null,
          email: null,
          name: "@core",
          reason: "Owner is responsible.",
        },
      ],
      likelyComponent: "src",
      likelyFiles: [
        {
          citations: ["src/render.ts:10"],
          confidence: 0.9,
          path: "src/render.ts",
          reason: "Renderer evidence matches.",
          repo: "repo",
        },
      ],
      likelyOwners: ["@core"],
      missingInfoQuestions: [],
      provider: "test",
      warnings: ["AI returned unsupported citations for implementer hint 1: made-up"],
    };

    const score = scoreEvalResult(evalCase(), result, result.ai);
    expect(score.passed).toBe(false);
    expect(score.unsupportedAiCitationCount).toBe(1);
    expect(score.citationCoverage).toBe(0.5);
  });

  it("runs eval cases and renders pass/fail output", async () => {
    const result = await runEval({
      cases: [
        {
          expectedClassification: "unknown",
          expectedComponent: "README.md",
          expectedFiles: ["README.md"],
          expectedOwners: ["@project-docs"],
          id: "readme-deployment-plan",
          report: "README deployment plan is unclear",
        },
      ],
      config: config(),
    });

    expect(result.passed).toBe(true);
    expect(result.summary).toEqual({ failed: 0, passed: 1, total: 1 });

    const rendered = renderEvalRun(result);
    expect(rendered).toContain("# FirstTrace Eval Run");
    expect(rendered).toContain("readme-deployment-plan: PASS");
    expect(rendered).toContain("Deterministic: PASS");
    expect(rendered).toContain("Usefulness: `1.00`");
  });

  it("renders AI failures when AI was requested but unavailable", () => {
    const rendered = renderEvalRun({
      aiEnabled: true,
      caseResults: [
        {
          case: evalCase(),
          deterministicResult: {
            ...investigationResult(),
            warnings: ["AI reasoning failed with provider test: unavailable"],
          },
          deterministicScore: scoreEvalResult(evalCase(), investigationResult()),
        },
      ],
      passed: false,
      summary: { failed: 1, passed: 0, total: 1 },
    });

    expect(rendered).toContain("renderer-crash: FAIL");
    expect(rendered).toContain("AI-Assisted: FAIL");
    expect(rendered).toContain("AI result unavailable.");
    expect(rendered).toContain("AI reasoning failed with provider test: unavailable");
  });
});
