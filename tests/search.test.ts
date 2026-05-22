import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { scorePath, scoreTextLine, searchCommits, searchDocs, searchFiles, sortEvidenceItems } from "../src/search.js";
import type { EvidenceItem, PreparedFirstTraceConfig, SearchableRepoConfig } from "../src/types.js";

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

  it("falls back to Node file scanning when rg and git are unavailable", () => {
    const previousPath = process.env.PATH;
    const repoPath = path.join(tmpdir(), `firsttrace-search-fallback-${Date.now()}`);
    mkdirSync(path.join(repoPath, "docs"), { recursive: true });
    writeFileSync(path.join(repoPath, "README.md"), "README deployment plan is unclear.\n");
    writeFileSync(path.join(repoPath, "docs", "PRODUCT_PLAN.md"), "The deployment plan mentions hosted Slack.\n");

    const repo: SearchableRepoConfig = { name: "app", path: repoPath, provider: "local", sourceProvider: "local" };
    const config: PreparedFirstTraceConfig = {
      chat: undefined,
      configPath: "firsttrace.config.yaml",
      docs: ["README.md", "docs"],
      issueExports: [],
      owners: [{ owner: "@docs", path: "docs/**" }],
      repos: [repo],
      search: { maxCommits: 5, maxEvidencePerFile: 3, maxFiles: 5 },
    };

    try {
      process.env.PATH = "/definitely-missing";
      expect(searchFiles(repo, ["deployment"], config).map((result) => result.path)).toContain("README.md");
      expect(searchDocs(repo, ["hosted"], config).map((result) => result.path)).toContain("docs/PRODUCT_PLAN.md");
      expect(searchCommits(repo, ["deployment"], config)).toEqual([]);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
