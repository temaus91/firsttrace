import { execFileSync } from "node:child_process";
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

const preparedConfig = (repo: SearchableRepoConfig): PreparedFirstTraceConfig => ({
  chat: undefined,
  configPath: "firsttrace.config.yaml",
  docs: ["README.md", "docs"],
  issueExports: [],
  owners: [{ owner: "@docs", path: "docs/**" }],
  repos: [repo],
  search: { maxCommits: 5, maxEvidencePerFile: 3, maxFiles: 5 },
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

  it("falls back to Node file scanning when rg and git are unavailable", async () => {
    const previousPath = process.env.PATH;
    const repoPath = path.join(tmpdir(), `firsttrace-search-fallback-${Date.now()}`);
    mkdirSync(path.join(repoPath, "docs"), { recursive: true });
    writeFileSync(path.join(repoPath, "README.md"), "README deployment plan is unclear.\n");
    writeFileSync(path.join(repoPath, "docs", "PRODUCT_PLAN.md"), "The deployment plan mentions hosted Slack.\n");

    const repo: SearchableRepoConfig = { name: "app", path: repoPath, provider: "local", sourceProvider: "local" };
    const config = preparedConfig(repo);

    try {
      process.env.PATH = "/definitely-missing";
      expect(searchFiles(repo, ["deployment"], config).map((result) => result.path)).toContain("README.md");
      expect(searchDocs(repo, ["hosted"], config).map((result) => result.path)).toContain("docs/PRODUCT_PLAN.md");
      expect(await searchCommits(repo, ["deployment"], config)).toEqual([]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("adds git file-history and line-blame signals for suspicious files", async () => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }

    const repoPath = path.join(tmpdir(), `firsttrace-git-history-${Date.now()}`);
    const filePath = "app/artists/[artistId]/page.tsx";
    mkdirSync(path.dirname(path.join(repoPath, filePath)), { recursive: true });
    writeFileSync(path.join(repoPath, filePath), "export function ArtistPage() { return null }\n");

    const git = (args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
    git(["init"]);
    git(["config", "user.name", "FirstTrace Tester"]);
    git(["config", "user.email", "tester@example.com"]);
    git(["add", filePath]);
    git(["commit", "-m", "Create artist profile page"]);
    writeFileSync(path.join(repoPath, filePath), "export function ArtistPage() { return 'Loading profile' }\n");
    git(["add", filePath]);
    git(["commit", "-m", "Adjust artist profile loading state"]);

    const repo: SearchableRepoConfig = { name: "app", path: repoPath, provider: "local", sourceProvider: "local" };
    const config = preparedConfig(repo);
    const suspiciousFile: EvidenceItem = {
      citations: [{ label: `app:${filePath}:1`, line: 1, path: filePath, repo: "app" }],
      path: filePath,
      repo: "app",
      score: 10,
      summary: "profile loading state",
      title: filePath,
      type: "file",
    };

    const commits = await searchCommits(repo, ["profile"], config, [suspiciousFile]);

    expect(commits.map((commit) => commit.summary).join("\n")).toContain(filePath);
    expect(commits[0]?.metadata).toMatchObject({ author: "FirstTrace Tester" });
  });

  it("uses GitHub commit history for archive materialized repositories", async () => {
    const repoPath = path.join(tmpdir(), `firsttrace-github-history-${Date.now()}`);
    mkdirSync(repoPath, { recursive: true });
    const repo: SearchableRepoConfig = {
      defaultBranch: "main",
      name: "app",
      owner: "octo",
      path: repoPath,
      provider: "local",
      remoteRepo: "example",
      sourceProvider: "github",
    };
    const config = preparedConfig(repo);
    const suspiciousFile: EvidenceItem = {
      citations: [{ label: "app:app/artists/[artistId]/page.tsx:1", line: 1, path: "app/artists/[artistId]/page.tsx", repo: "app" }],
      path: "app/artists/[artistId]/page.tsx",
      repo: "app",
      score: 10,
      summary: "profile loading state",
      title: "app/artists/[artistId]/page.tsx",
      type: "file",
    };
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify([
          {
            sha: "abcdef1234567890",
            commit: {
              author: { date: "2026-05-21T00:00:00Z", name: "Dev Owner" },
              message: "Adjust artist profile loading state\n\nBody",
            },
          },
        ]),
        { headers: { "content-type": "application/json" }, status: 200 },
      );
    };

    const commits = await searchCommits(repo, ["profile"], config, [suspiciousFile], {
      fetchImpl,
      tokenProvider: { async getInstallationToken() { return "github-token"; } },
    });

    expect(urls.some((url) => url.includes("path=app%2Fartists%2F%5BartistId%5D%2Fpage.tsx"))).toBe(true);
    expect(commits[0]?.summary).toContain("Recent change to app/artists/[artistId]/page.tsx");
    expect(commits[0]?.metadata).toMatchObject({ author: "Dev Owner", date: "2026-05-21" });
  });
});
