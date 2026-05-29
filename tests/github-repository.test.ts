import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runEval } from "../src/eval/runner.js";
import { executeInvestigation } from "../src/investigation-runner.js";
import { CommandArchiveRepoMaterializer } from "../src/repositories/archive-materializer.js";
import {
  GitHubAppRepoMaterializer,
  githubGitAuthHeader,
  githubRepositoryUrl,
  redactGitHubTokenArgs,
  withGitHubAuthHeader,
  type GitHubRepoMaterializer,
} from "../src/repositories/github-materializer.js";
import {
  createGitHubTokenProviderFromEnv,
  normalizeGitHubPrivateKey,
  readGitHubAppCredentialsFromEnv,
  readGitHubTokenFromEnv,
} from "../src/repositories/github-auth.js";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";
import { runWorkerOnce } from "../src/worker/runner.js";
import type { ArchiveRepoConfig, FirstTraceConfig, GitHubRepoConfig } from "../src/types.js";

const tempDir = (name: string) =>
  path.join(tmpdir(), `firsttrace-github-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const createSearchableRepo = () => {
  const dir = tempDir("repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "README deployment plan is unclear in this example.\n");
  return dir;
};

const githubConfig = (): FirstTraceConfig => ({
  configPath: "firsttrace.github.local.yaml",
  docs: ["README.md"],
  issueExports: [],
  owners: [{ owner: "@project-docs", path: "README.md" }],
  repos: [
    {
      defaultBranch: "main",
      name: "example-app",
      owner: "exampleco",
      provider: "github",
      repo: "web-app",
    },
  ],
  search: {
    maxCommits: 8,
    maxEvidencePerFile: 3,
    maxFiles: 10,
  },
});

const fakeMaterializer = (repoPath: string): GitHubRepoMaterializer => ({
  async materialize(repo: GitHubRepoConfig, options) {
    expect(repo.owner).toBe("exampleco");
    expect(repo.repo).toBe("web-app");
    expect(options.fetchDepth).toBe(80);
    return {
      defaultBranch: repo.defaultBranch,
      name: repo.name,
      owner: repo.owner,
      path: repoPath,
      provider: "local",
      remoteRepo: repo.repo,
      sourceProvider: "github",
    };
  },
});

const archiveConfig = (): FirstTraceConfig => ({
  configPath: "firsttrace.archive.local.yaml",
  docs: ["README.md"],
  issueExports: [],
  owners: [{ owner: "@project-docs", path: "README.md" }],
  repos: [
    {
      archiveCommand: "./scripts/download-app.sh",
      commandCwd: "/tmp/firsttrace-config",
      name: "example-app",
      path: "/tmp/firsttrace-repos/example-app",
      provider: "archive",
      ref: "refs/heads/main",
    },
  ],
  search: {
    maxCommits: 8,
    maxEvidencePerFile: 3,
    maxFiles: 10,
  },
});

const fakeArchiveMaterializer = (repoPath: string) => ({
  async materialize(repo: ArchiveRepoConfig) {
    expect(repo.archiveCommand).toBe("./scripts/download-app.sh");
    expect(repo.ref).toBe("refs/heads/main");
    return {
      defaultBranch: repo.ref,
      name: repo.name,
      path: repoPath,
      provider: "local" as const,
      sourceProvider: "archive" as const,
    };
  },
});

describe("GitHub repository provider", () => {
  it("normalizes escaped private key newlines", () => {
    expect(normalizeGitHubPrivateKey("-----BEGIN KEY-----\\nabc\\n-----END KEY-----")).toBe(
      "-----BEGIN KEY-----\nabc\n-----END KEY-----",
    );
  });

  it("fails clearly when GitHub App environment variables are missing", () => {
    expect(() => readGitHubAppCredentialsFromEnv({})).toThrow(
      "Missing GitHub App environment variables: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.",
    );
  });

  it("uses a static GitHub token when configured for local validation", async () => {
    expect(readGitHubTokenFromEnv({ GITHUB_TOKEN: "  validation-token  " })).toBe("validation-token");

    const tokenProvider = createGitHubTokenProviderFromEnv({ GITHUB_TOKEN: "validation-token" });
    await expect(tokenProvider.getInstallationToken("web-app")).resolves.toBe("validation-token");
  });

  it("builds token-safe git command arguments", () => {
    const repo = githubConfig().repos[0] as GitHubRepoConfig;
    const remoteUrl = githubRepositoryUrl(repo);
    const args = withGitHubAuthHeader("secret-token", ["clone", remoteUrl, "/tmp/cache"]);
    const redactedArgs = redactGitHubTokenArgs("secret-token", args);
    const authHeader = githubGitAuthHeader("secret-token");

    expect(args).toContain(`http.extraHeader=${authHeader}`);
    expect(remoteUrl).toBe("https://github.com/exampleco/web-app.git");
    expect(remoteUrl).not.toContain("secret-token");
    expect(redactedArgs.join(" ")).not.toContain("secret-token");
    expect(redactedArgs.join(" ")).not.toContain(authHeader);
    expect(redactedArgs).toContain("http.extraHeader=Authorization: Basic <redacted>");
  });

  it("materializes with a one-command auth header without embedding tokens in the remote URL", async () => {
    const commands: { args: string[]; displayArgs?: string[] }[] = [];
    const materializer = new GitHubAppRepoMaterializer({
      cacheRoot: tempDir("cache"),
      runner: (_cwd, args, options) => {
        commands.push({ args, displayArgs: options?.displayArgs });
        return { stderr: "", stdout: "", status: 0 };
      },
      tokenProvider: {
        async getInstallationToken() {
          return "secret-token";
        },
      },
    });

    await materializer.materialize(githubConfig().repos[0] as GitHubRepoConfig, { fetchDepth: 80 });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toContain(`http.extraHeader=${githubGitAuthHeader("secret-token")}`);
    expect(commands[0]?.args).toContain("https://github.com/exampleco/web-app.git");
    expect(commands[0]?.displayArgs?.join(" ")).not.toContain("secret-token");
    expect(commands[0]?.displayArgs?.join(" ")).not.toContain(githubGitAuthHeader("secret-token"));
    expect(commands[0]?.args.find((arg) => arg.startsWith("https://github.com/"))).not.toContain("secret-token");
  });

  it("prepares a GitHub repo into a local path usable by investigation search", async () => {
    const repoPath = createSearchableRepo();
    const result = await executeInvestigation({
      config: githubConfig(),
      report: "README deployment plan is unclear",
      repoPreparation: { githubMaterializer: fakeMaterializer(repoPath) },
    });

    expect(result.likelyComponent).toBe("README.md");
    expect(result.suspiciousFiles[0]?.path).toBe("README.md");
    expect(result.likelyOwners).toContain("@project-docs");
  });

  it("runs eval through a fake GitHub materializer", async () => {
    const repoPath = createSearchableRepo();
    const result = await runEval({
      cases: [
        {
          expectedClassification: "unknown",
          expectedComponent: "README.md",
          expectedFiles: ["README.md"],
          expectedOwners: ["@project-docs"],
          id: "github-readme",
          report: "README deployment plan is unclear",
        },
      ],
      config: githubConfig(),
      repoPreparation: { githubMaterializer: fakeMaterializer(repoPath) },
    });

    expect(result.passed).toBe(true);
    expect(result.caseResults[0]?.deterministicResult.suspiciousFiles[0]?.repo).toBe("example-app");
  });

  it("prepares an archive repo into a local path usable by investigation search", async () => {
    const repoPath = createSearchableRepo();
    const result = await executeInvestigation({
      config: archiveConfig(),
      report: "README deployment plan is unclear",
      repoPreparation: { archiveMaterializer: fakeArchiveMaterializer(repoPath) },
    });

    expect(result.likelyComponent).toBe("README.md");
    expect(result.suspiciousFiles[0]?.repo).toBe("example-app");
    expect(result.likelyOwners).toContain("@project-docs");
  });

  it("runs archive commands with target path and ref environment variables", async () => {
    const commands: Array<{ args: string[]; cwd: string; envPath?: string; envRef?: string }> = [];
    const targetPath = tempDir("archive-target");
    const materializer = new CommandArchiveRepoMaterializer({
      runner: (cwd, _command, args, options) => {
        commands.push({
          args,
          cwd,
          envPath: options?.env?.FIRSTTRACE_ARCHIVE_REPO_PATH,
          envRef: options?.env?.FIRSTTRACE_ARCHIVE_REPO_REF,
        });
        mkdirSync(targetPath, { recursive: true });
        writeFileSync(path.join(targetPath, "README.md"), "README deployment plan is unclear.\n");
        return { stderr: "", stdout: "", status: 0 };
      },
    });

    const repo = archiveConfig().repos[0] as ArchiveRepoConfig;
    const searchable = await materializer.materialize({ ...repo, path: targetPath });

    expect(commands).toEqual([
      {
        args: ["-lc", "./scripts/download-app.sh"],
        cwd: "/tmp/firsttrace-config",
        envPath: targetPath,
        envRef: "refs/heads/main",
      },
    ]);
    expect(searchable).toMatchObject({
      path: targetPath,
      sourceProvider: "archive",
    });
  });

  it("runs worker jobs through a fake GitHub materializer", async () => {
    const repoPath = createSearchableRepo();
    const configPath = path.join(tempDir("config"), "firsttrace.config.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      [
        "repos:",
        "  - name: example-app",
        "    provider: github",
        "    owner: exampleco",
        "    repo: web-app",
        "docs:",
        "  - README.md",
        "issue_exports: []",
        "owners:",
        '  - path: README.md',
        '    owner: "@project-docs"',
      ].join("\n"),
    );

    const queue = new FileSystemJobQueue(tempDir("queue"));
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath,
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({
      queue,
      repoPreparation: { githubMaterializer: fakeMaterializer(repoPath) },
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.result?.likelyComponent).toBe("README.md");
  });
});
