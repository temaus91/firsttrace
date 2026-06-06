import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runEval } from "../src/eval/runner.js";
import { executeInvestigation } from "../src/investigation-runner.js";
import {
  enrichOwnerEvidenceWithProviderMetadata,
  GitHubProviderMetadataAdapter,
  type ProviderMetadataAdapter,
} from "../src/provider-metadata.js";
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
import type { ArchiveRepoConfig, FirstTraceConfig, GitHubRepoConfig, SearchableRepoConfig } from "../src/types.js";
import type { OwnerEvidenceCommit, OwnerEvidenceResult } from "../src/owner-evidence.js";

const tempDir = (name: string) =>
  path.join(tmpdir(), `firsttrace-github-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const createSearchableRepo = () => {
  const dir = tempDir("repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "README.md"), "README deployment plan is unclear in this example.\n");
  return dir;
};

const createGitBackedRouteRepo = () => {
  const dir = tempDir("route-repo");
  const filePath = "src/components/EntityLinks.tsx";
  mkdirSync(path.join(dir, "src", "components"), { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(
    path.join(dir, filePath),
    [
      "export function EntityLinks({ entity, navigate }) {",
      "  return <button onClick={() => navigate(`/entities/${entity.id}/detail`)}>Open</button>;",
      "}",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["add", filePath], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Add entity detail route"], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-05-20T17:15:30Z",
      GIT_AUTHOR_EMAIL: "git-author@example.com",
      GIT_AUTHOR_NAME: "Git Author",
      GIT_COMMITTER_DATE: "2026-05-20T17:15:30Z",
      GIT_COMMITTER_EMAIL: "git-author@example.com",
      GIT_COMMITTER_NAME: "Git Author",
    },
    stdio: "ignore",
  });
  return dir;
};

const githubConfig = (): FirstTraceConfig => ({
  configPath: "firsttrace.github.local.yaml",
  docs: ["README.md"],
  investigation: {
    prompt: {
      overlayFiles: [],
      profile: "default",
    },
  },
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
  investigation: {
    prompt: {
      overlayFiles: [],
      profile: "default",
    },
  },
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

const githubSearchableRepo = (): SearchableRepoConfig => ({
  defaultBranch: "main",
  name: "example-app",
  owner: "exampleco",
  path: "/tmp/example-app",
  provider: "local",
  remoteRepo: "web-app",
  sourceProvider: "github",
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ownerCommit = (overrides: Partial<OwnerEvidenceCommit> = {}): OwnerEvidenceCommit => ({
  authorEmail: "git-author@example.com",
  authorName: "Git Author",
  authorTime: "2026-05-20T00:00:00Z",
  commitId: "abcdef1234567890abcdef1234567890abcdef12",
  commitTime: "2026-05-20T00:00:00Z",
  commitTitle: "Add entity route",
  committerEmail: "committer@example.com",
  committerName: "Committer",
  committerTime: "2026-05-20T00:00:00Z",
  evidenceCode: "navigate(`/entities/${entity.id}/detail`)",
  evidenceKind: "exact_line_blame",
  evidenceSource: "commit_author",
  file: "src/components/EntityLinks.tsx",
  line: 4,
  repo: "example-app",
  score: 100,
  whyRelevant: "Exact-line blame for the route interpolation.",
  ...overrides,
});

const ownerEvidence = (): OwnerEvidenceResult => ({
  candidates: [
    {
      confidence: "High",
      email: "git-author@example.com",
      evidenceCommits: [ownerCommit()],
      evidenceSource: "commit_author",
      name: "Git Author",
      rank: 1,
      reason: "Exact-line blame points to src/components/EntityLinks.tsx:4.",
      score: 100,
    },
  ],
  missingInfo: [],
  warnings: [],
  weakCommits: [],
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

  it("automatically enriches GitHub owner evidence with PR metadata when credentials are present", async () => {
    const repoPath = createGitBackedRouteRepo();
    const requests: Array<{ headers?: HeadersInit; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      (async (url, init) => {
        requests.push({ headers: init?.headers, url: String(url) });
        if (String(url).includes("/pulls")) {
          return new Response(JSON.stringify([{ user: { login: "pr-author" } }]), { status: 200 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }) as typeof fetch,
    );

    const result = await executeInvestigation({
      config: githubConfig(),
      env: { GITHUB_TOKEN: "github-token" },
      report: "Entity detail links fail for ID ACME/123 when clicking dashboard links.",
      repoPreparation: { githubMaterializer: fakeMaterializer(repoPath) },
    });

    const pullRequest = requests.find((request) => request.url.includes("/pulls"));
    expect(result.ownerEvidence?.candidates[0]).toMatchObject({
      email: "",
      evidenceSource: "pr_author",
      name: "pr-author",
    });
    expect(result.ownerEvidence?.candidates[0]?.evidenceCommits[0]).toMatchObject({
      authorName: "pr-author",
      evidenceSource: "pr_author",
      file: "src/components/EntityLinks.tsx",
    });
    expect(pullRequest?.url).toMatch(
      /https:\/\/api\.github\.com\/repos\/exampleco\/web-app\/commits\/[a-f0-9]{40}\/pulls/,
    );
    expect(pullRequest?.headers).toMatchObject({
      authorization: "Bearer github-token",
    });
    expect(result.warnings.join("\n")).not.toContain("Provider metadata was unavailable");
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

  it("fetches GitHub PR author metadata for a commit", async () => {
    const requests: Array<{ headers?: HeadersInit; url: string }> = [];
    const adapter = new GitHubProviderMetadataAdapter({
      fetchImpl: (async (url, init) => {
        requests.push({ headers: init?.headers, url: String(url) });
        return new Response(JSON.stringify([{ user: { login: "pr-author" } }]), { status: 200 });
      }) as typeof fetch,
      tokenProvider: {
        async getInstallationToken(repositoryName) {
          expect(repositoryName).toBe("web-app");
          return "github-token";
        },
      },
    });

    const metadata = await adapter.getCommitMetadata(githubSearchableRepo(), "abcdef1234567890abcdef1234567890abcdef12");

    expect(metadata).toEqual({
      commitId: "abcdef1234567890abcdef1234567890abcdef12",
      email: "",
      evidenceSource: "pr_author",
      name: "pr-author",
    });
    expect(requests[0]?.url).toBe(
      "https://api.github.com/repos/exampleco/web-app/commits/abcdef1234567890abcdef1234567890abcdef12/pulls",
    );
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer github-token",
    });
  });

  it("does not fabricate pushed-by metadata when GitHub does not expose it", async () => {
    const adapter = new GitHubProviderMetadataAdapter({
      fetchImpl: (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch,
      tokenProvider: {
        async getInstallationToken() {
          return "github-token";
        },
      },
    });

    await expect(
      adapter.getCommitMetadata(githubSearchableRepo(), "abcdef1234567890abcdef1234567890abcdef12"),
    ).resolves.toBeUndefined();
  });

  it("enriches owner evidence with explicit provider metadata", async () => {
    const adapter: ProviderMetadataAdapter = {
      async getCommitMetadata() {
        return {
          commitId: "abcdef1234567890abcdef1234567890abcdef12",
          email: "",
          evidenceSource: "pr_author",
          name: "pr-author",
        };
      },
    };

    const enriched = await enrichOwnerEvidenceWithProviderMetadata(ownerEvidence(), [githubSearchableRepo()], adapter);

    expect(enriched.candidates[0]).toMatchObject({
      email: "",
      evidenceSource: "pr_author",
      name: "pr-author",
      rank: 1,
    });
    expect(enriched.candidates[0]?.evidenceCommits[0]).toMatchObject({
      authorName: "pr-author",
      evidenceSource: "pr_author",
    });
    expect(enriched.candidates[0]?.evidenceCommits[0]?.whyRelevant).toContain("Provider metadata identifies pr_author");
    expect(enriched.missingInfo).toEqual([]);
  });

  it("keeps local Git owner evidence when provider metadata is unavailable", async () => {
    const adapter: ProviderMetadataAdapter = {
      async getCommitMetadata() {
        return undefined;
      },
    };

    const enriched = await enrichOwnerEvidenceWithProviderMetadata(ownerEvidence(), [githubSearchableRepo()], adapter);

    expect(enriched.candidates[0]).toMatchObject({
      email: "git-author@example.com",
      evidenceSource: "commit_author",
      name: "Git Author",
    });
    expect(enriched.missingInfo.join("\n")).toContain("Provider metadata was unavailable");
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
