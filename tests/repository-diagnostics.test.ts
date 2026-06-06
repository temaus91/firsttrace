import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  diagnoseConfiguredRepositories,
  diagnoseSearchableRepository,
  renderRepositoryDiagnostics,
} from "../src/diagnostics/repositories.js";
import {
  CommandGitRepoMaterializer,
  gitBasicAuthHeader,
  redactGitArgs,
  safeGitRemoteUrl,
} from "../src/repositories/git-materializer.js";
import type { FirstTraceConfig, GitRepoConfig, SearchableRepoConfig } from "../src/types.js";

const gitAvailable = () => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const tempPath = (name: string) =>
  path.join(tmpdir(), `firsttrace-repos-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const initRepo = (name: string) => {
  const repoPath = tempPath(name);
  mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  writeFileSync(path.join(repoPath, "README.md"), "example source\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Add README"], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-20T17:15:30Z",
      GIT_AUTHOR_EMAIL: "owner@example.com",
      GIT_AUTHOR_NAME: "Repo Owner",
      GIT_COMMITTER_DATE: "2026-05-20T17:15:30Z",
      GIT_COMMITTER_EMAIL: "owner@example.com",
      GIT_COMMITTER_NAME: "Repo Owner",
    },
    stdio: "ignore",
  });
  return repoPath;
};

const searchable = (repoPath: string, sourceProvider: SearchableRepoConfig["sourceProvider"] = "local"): SearchableRepoConfig => ({
  name: "app",
  path: repoPath,
  provider: "local",
  sourceProvider,
});

const configFor = (repo: FirstTraceConfig["repos"][number]): FirstTraceConfig => ({
  configPath: "firsttrace.config.yaml",
  docs: [],
  investigation: {
    prompt: {
      overlayFiles: [],
      profile: "manager-owner-triage",
    },
  },
  issueExports: [],
  owners: [],
  repos: [repo],
  search: {
    maxCommits: 8,
    maxEvidencePerFile: 3,
    maxFiles: 10,
  },
});

describe("repository diagnostics", () => {
  it("reports a full local Git repo as owner-evidence ready", () => {
    if (!gitAvailable()) return;
    const repoPath = initRepo("full");

    const result = diagnoseSearchableRepository(searchable(repoPath), "local");

    expect(result).toMatchObject({
      git_history_available: true,
      is_shallow: false,
      owner_evidence_ready: true,
      owner_evidence_sources: ["git_blame", "git_log"],
      repo: "app",
    });
    expect(result.head_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.missing_info).toEqual([]);
  });

  it("reports source-only archive repos without inventing owner readiness", () => {
    const repoPath = tempPath("archive-only");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "README.md"), "source without git\n");

    const result = diagnoseSearchableRepository(searchable(repoPath, "archive"), "archive");

    expect(result).toMatchObject({
      git_history_available: false,
      head_sha: null,
      is_shallow: false,
      owner_evidence_ready: false,
      owner_evidence_sources: [],
      source_provider: "archive",
    });
    expect(result.missing_info.join("\n")).toContain("does not include .git history");
  });

  it("warns when a Git repo is shallow", () => {
    if (!gitAvailable()) return;
    const sourcePath = initRepo("shallow-source");
    const clonePath = tempPath("shallow-clone");
    execFileSync("git", ["clone", "--depth", "1", `file://${sourcePath}`, clonePath], { stdio: "ignore" });

    const result = diagnoseSearchableRepository(searchable(clonePath, "git"), "git");

    expect(result.git_history_available).toBe(true);
    expect(result.is_shallow).toBe(true);
    expect(result.owner_evidence_ready).toBe(true);
    expect(result.warnings.join("\n")).toContain("is shallow");
  });

  it("materializes a generic git repo and diagnoses it through doctor repos", async () => {
    if (!gitAvailable()) return;
    const sourcePath = initRepo("generic-source");
    const targetPath = tempPath("generic-target");
    const repo: GitRepoConfig = {
      cloneDepth: "full",
      materialization: {
        includeGitHistory: true,
        refresh: "startup",
        scrubRemoteCredentials: true,
      },
      name: "app",
      path: targetPath,
      provider: "git",
      ref: "HEAD",
      url: `file://${sourcePath}`,
    };

    const result = await diagnoseConfiguredRepositories(configFor(repo));

    expect(result.passed).toBe(true);
    expect(result.repos[0]).toMatchObject({
      git_history_available: true,
      last_refresh_status: "succeeded",
      owner_evidence_ready: true,
      provider: "git",
      source_provider: "git",
    });
    expect(readFileSync(path.join(targetPath, ".git", "config"), "utf8")).toContain(`url = file://${sourcePath}`);
  });

  it("supports commit SHA refs for generic git repos", async () => {
    if (!gitAvailable()) return;
    const sourcePath = initRepo("generic-sha-source");
    const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourcePath, encoding: "utf8" }).trim();
    const targetPath = tempPath("generic-sha-target");

    await new CommandGitRepoMaterializer().materialize({
      cloneDepth: "full",
      materialization: {
        includeGitHistory: true,
        refresh: "startup",
        scrubRemoteCredentials: true,
      },
      name: "app",
      path: targetPath,
      provider: "git",
      ref: commitSha,
      url: `file://${sourcePath}`,
    });

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetPath, encoding: "utf8" }).trim()).toBe(commitSha);
  });

  it("redacts token credentials from git display arguments and safe URLs", () => {
    const header = gitBasicAuthHeader("reader", "secret-token");
    const args = ["-c", `http.extraHeader=${header}`, "clone", "https://user:secret-token@example.com/org/repo.git"];
    const rendered = redactGitArgs(args, ["secret-token", header]).join(" ");

    expect(safeGitRemoteUrl("https://user:secret-token@example.com/org/repo.git")).toBe(
      "https://example.com/org/repo.git",
    );
    expect(rendered).not.toContain("secret-token");
    expect(rendered).not.toContain(header);
    expect(rendered).toContain("Authorization: Basic <redacted>");
  });

  it("uses a scrubbed remote URL after token-auth materialization commands", async () => {
    const repoPath = tempPath("token-scrub");
    const commands: string[][] = [];
    const materializer = new CommandGitRepoMaterializer({
      env: { FIRSTTRACE_REPO_TOKEN: "secret-token" },
      runner: (_cwd, args) => {
        commands.push(args);
        if (args.includes("clone")) mkdirSync(path.join(repoPath, ".git"), { recursive: true });
        return { stderr: "", stdout: "", status: 0 };
      },
    });

    await materializer.materialize({
      cloneDepth: "full",
      credential: {
        tokenEnv: "FIRSTTRACE_REPO_TOKEN",
        type: "token",
      },
      materialization: {
        includeGitHistory: true,
        refresh: "startup",
        scrubRemoteCredentials: true,
      },
      name: "app",
      path: repoPath,
      provider: "git",
      ref: "refs/heads/main",
      url: "https://user:secret-token@example.com/org/repo.git",
    });

    expect(commands).toContainEqual(["remote", "set-url", "origin", "https://example.com/org/repo.git"]);
    expect(commands.find((args) => args.includes("fetch"))?.join(" ")).not.toContain("secret-token");
  });

  it("renders repository diagnostics as parseable JSON", () => {
    const rendered = renderRepositoryDiagnostics({
      passed: true,
      repos: [],
    });

    expect(JSON.parse(rendered)).toEqual({
      passed: true,
      repos: [],
    });
  });
});
