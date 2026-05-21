import { describe, expect, it } from "vitest";
import { scorePath, scoreTextLine, sortEvidenceItems } from "../src/search.js";
import type { EvidenceItem } from "../src/types.js";

const item = (title: string, score: number): EvidenceItem => ({
  citations: [{ label: title, repo: "repo" }],
  repo: "repo",
  score,
  summary: title,
  title,
  type: "file",
});

describe("search scoring", () => {
  it("scores path and content matches predictably", () => {
    expect(scorePath("docs/PRODUCT_PLAN.md", ["docs", "plan"])).toBeGreaterThan(
      scorePath("README.md", ["docs", "plan"]),
    );
    expect(scoreTextLine("deployment plan plan", ["plan", "deployment"])).toBe(5);
  });

  it("ranks evidence by score", () => {
    expect(sortEvidenceItems([item("low", 1), item("high", 5)]).map((result) => result.title)).toEqual([
      "high",
      "low",
    ]);
  });
});
