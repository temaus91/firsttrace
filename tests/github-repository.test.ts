import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runEval } from "../src/eval/runner.js";
import { executeInvestigation } from "../src/investigation-runner.js";
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
import type { FirstTraceConfig, GitHubRepoConfig } from "../src/types.js";

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
