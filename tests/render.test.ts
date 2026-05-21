import { describe, expect, it } from "vitest";
import { renderInvestigation } from "../src/render.js";
import type { InvestigationResult } from "../src/types.js";

describe("renderInvestigation", () => {
  it("renders citations and warnings", () => {
    const result: InvestigationResult = {
      classification: "bug",
      likelyComponent: "docs",
      likelyOwners: ["@docs"],
      relatedCommits: [],
      relatedDocs: [],
      report: "docs fail",
      searchTerms: ["docs", "fail"],
      suggestedNextSteps: ["Inspect docs/PRODUCT_PLAN.md."],
      suspiciousFiles: [
        {
          citations: [{ label: "repo:docs/PRODUCT_PLAN.md:10", line: 10, path: "docs/PRODUCT_PLAN.md", repo: "repo" }],
          owner: "@docs",
          path: "docs/PRODUCT_PLAN.md",
          repo: "repo",
          score: 9,
          summary: "docs failure",
          title: "docs/PRODUCT_PLAN.md",
          type: "file",
        },
      ],
      warnings: ["No related commits found."],
    };

    const rendered = renderInvestigation(result);
    expect(rendered).toContain("docs/PRODUCT_PLAN.md:10");
    expect(rendered).toContain("@docs");
    expect(rendered).toContain("No related commits found.");
  });

  it("renders AI reasoning when present", () => {
    const result: InvestigationResult = {
      ai: {
        confidence: 0.74,
        explanation: "The renderer evidence is the strongest match.",
        implementerHints: [
          {
            citations: ["commit abc123"],
            commit: "abc123",
            email: null,
            name: "Dev Owner",
            reason: "Recent related commit touched the renderer.",
          },
        ],
        likelyComponent: "src",
        likelyFiles: [
          {
            citations: ["src/render.ts:12"],
            confidence: 0.82,
            path: "src/render.ts",
            reason: "The file citation mentions renderer citation handling.",
            repo: "repo",
          },
        ],
        likelyOwners: ["@core"],
        missingInfoQuestions: ["What exact command reproduced the crash?"],
        provider: "openai",
        warnings: ["Evidence is limited."],
      },
      classification: "bug",
      likelyComponent: "src",
      likelyOwners: ["@core"],
      relatedCommits: [],
      relatedDocs: [],
      report: "renderer crashes",
      searchTerms: ["renderer", "crashes"],
      suggestedNextSteps: [],
      suspiciousFiles: [],
      warnings: [],
    };

    const rendered = renderInvestigation(result);
    expect(rendered).toContain("## AI Reasoning");
    expect(rendered).toContain("Provider: `openai`");
    expect(rendered).toContain("src/render.ts:12");
    expect(rendered).toContain("What exact command reproduced the crash?");
    expect(rendered).toContain("Evidence is limited.");
  });
});
