import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../shell.js";
import type { GitHubRepoConfig, SearchableRepoConfig } from "../types.js";
import {
  createGitHubTokenProviderFromEnv,
  type GitHubInstallationTokenProvider,
} from "./github-auth.js";

export type GitHubMaterializeOptions = {
  fetchDepth: number;
};

export type GitHubRepoMaterializer = {
  materialize(repo: GitHubRepoConfig, options: GitHubMaterializeOptions): Promise<SearchableRepoConfig>;
};

type GitRunner = (
  cwd: string,
  args: string[],
  options?: { displayArgs?: string[]; maxBuffer?: number },
) => CommandResult;

const GITHUB_REPO_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const assertGitHubRepoSegment = (value: string, label: string) => {
  if (!GITHUB_REPO_SEGMENT.test(value)) {
    throw new Error(`GitHub repo ${label} contains unsupported characters: ${value}`);
  }
};

const safeCacheSegment = (value: string) => value.replace(/[^A-Za-z0-9_.-]/g, "_");

export const githubRepositoryUrl = (repo: GitHubRepoConfig) => {
  assertGitHubRepoSegment(repo.owner, "owner");
  assertGitHubRepoSegment(repo.repo, "name");
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
};

export const githubGitAuthHeader = (token: string) =>
  `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

export const withGitHubAuthHeader = (token: string, args: string[]) => [
  "-c",
  `http.extraHeader=${githubGitAuthHeader(token)}`,
  ...args,
];

export const redactGitHubTokenArgs = (token: string, args: string[]) =>
  args.map((arg) =>
    arg.replaceAll(githubGitAuthHeader(token), "Authorization: Basic <redacted>").replaceAll(token, "<redacted>"),
  );

export class GitHubAppRepoMaterializer implements GitHubRepoMaterializer {
  private readonly cacheRoot: string;
  private readonly runner: GitRunner;
  private readonly tokenProvider: GitHubInstallationTokenProvider;

  constructor({
    cacheRoot = path.resolve(".firsttrace", "github"),
    runner = (cwd, args, options) => runCommand(cwd, "git", args, options),
    tokenProvider = createGitHubTokenProviderFromEnv(),
  }: {
    cacheRoot?: string;
    runner?: GitRunner;
    tokenProvider?: GitHubInstallationTokenProvider;
  } = {}) {
    this.cacheRoot = cacheRoot;
    this.runner = runner;
    this.tokenProvider = tokenProvider;
  }

  async materialize(
    repo: GitHubRepoConfig,
    { fetchDepth }: GitHubMaterializeOptions,
  ): Promise<SearchableRepoConfig> {
    const token = await this.tokenProvider.getInstallationToken(repo.repo);
    const repoPath = this.repoCachePath(repo);
    const remoteUrl = githubRepositoryUrl(repo);
    const branch = repo.defaultBranch;
    const depth = String(fetchDepth);

    mkdirSync(path.dirname(repoPath), { recursive: true });

    try {
      if (!existsSync(repoPath)) {
        const args = withGitHubAuthHeader(token, [
          "clone",
          "--depth",
          depth,
          "--branch",
          branch,
          remoteUrl,
          repoPath,
        ]);
        this.runner(path.dirname(repoPath), args, { displayArgs: redactGitHubTokenArgs(token, args) });
      } else {
        const gitDir = path.join(repoPath, ".git");
        if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
          throw new Error(`GitHub cache path exists but is not a git repository: ${repoPath}`);
        }

        const fetchArgs = withGitHubAuthHeader(token, ["fetch", "--depth", depth, "origin", branch]);
        this.runner(repoPath, ["remote", "set-url", "origin", remoteUrl]);
        this.runner(repoPath, fetchArgs, { displayArgs: redactGitHubTokenArgs(token, fetchArgs) });
        this.runner(repoPath, ["checkout", "--detach", "FETCH_HEAD"]);
      }
    } catch (error) {
      throw new Error(
        `Failed to materialize GitHub repo ${repo.owner}/${repo.repo}. Verify the GitHub App installation or GITHUB_TOKEN and read-only Contents access: ${(error as Error).message}`,
      );
    }

    return {
      defaultBranch: branch,
      name: repo.name,
      owner: repo.owner,
      path: repoPath,
      provider: "local",
      remoteRepo: repo.repo,
      sourceProvider: "github",
    };
  }

  private repoCachePath(repo: GitHubRepoConfig) {
    return path.join(this.cacheRoot, safeCacheSegment(repo.owner), safeCacheSegment(repo.repo));
  }
}
