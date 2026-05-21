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
});
