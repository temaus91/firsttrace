import type { FirstTraceConfig, RepoConfig, SearchableRepoConfig } from "../types.js";
import { runCommand } from "../shell.js";
import {
  localSearchableRepo,
  prepareRepoForInvestigation,
  type RepoPreparationOptions,
} from "../repositories/prepare.js";

export type RepositoryDiagnostic = {
  git_history_available: boolean;
  head_sha: string | null;
  is_shallow: boolean;
  last_refresh_status: "failed" | "not_run" | "succeeded";
  missing_info: string[];
  owner_evidence_ready: boolean;
  owner_evidence_sources: string[];
  path: string | null;
  provider: RepoConfig["provider"];
  ref: string | null;
  repo: string;
  source_provider: SearchableRepoConfig["sourceProvider"] | RepoConfig["provider"];
  warnings: string[];
};

export type RepositoryDiagnosticsResult = {
  passed: boolean;
  repos: RepositoryDiagnostic[];
};

const providerName = (repo: RepoConfig): RepoConfig["provider"] => repo.provider ?? "local";

const configuredPath = (repo: RepoConfig) => ("path" in repo ? repo.path : null);

const configuredRef = (repo: RepoConfig) => {
  if ("ref" in repo && repo.ref) return repo.ref;
  if ("defaultBranch" in repo && repo.defaultBranch) return repo.defaultBranch;
  return null;
};

const gitOutput = (repoPath: string, args: string[]) => {
  try {
    const result = runCommand(repoPath, "git", args, { allowExitCodes: [1, 128] });
    if (result.status !== 0) return undefined;
    return result.stdout;
  } catch (error) {
    if ((error as Error).message.includes("spawnSync git ENOENT")) return undefined;
    throw error;
  }
};

const historyAvailable = (repoPath: string) => gitOutput(repoPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
const shallow = (repoPath: string) => gitOutput(repoPath, ["rev-parse", "--is-shallow-repository"]) === "true";
const headSha = (repoPath: string) => gitOutput(repoPath, ["rev-parse", "HEAD"]) ?? null;

export const diagnoseSearchableRepository = (
  repo: SearchableRepoConfig,
  provider: RepoConfig["provider"] = repo.sourceProvider,
): RepositoryDiagnostic => {
  const git_history_available = historyAvailable(repo.path);
  const is_shallow = git_history_available ? shallow(repo.path) : false;
  const missing_info = git_history_available
    ? []
    : [`Repository ${repo.name} does not include .git history.`];
  const warnings = is_shallow
    ? [`Repository ${repo.name} is shallow; blame/log evidence may be incomplete.`]
    : [];

  return {
    git_history_available,
    head_sha: git_history_available ? headSha(repo.path) : null,
    is_shallow,
    last_refresh_status: repo.lastRefreshStatus ?? "not_run",
    missing_info,
    owner_evidence_ready: git_history_available,
    owner_evidence_sources: git_history_available ? ["git_blame", "git_log"] : [],
    path: repo.path,
    provider,
    ref: repo.ref ?? repo.defaultBranch ?? null,
    repo: repo.name,
    source_provider: repo.sourceProvider,
    warnings,
  };
};

const failedDiagnostic = (repo: RepoConfig, error: unknown): RepositoryDiagnostic => ({
  git_history_available: false,
  head_sha: null,
  is_shallow: false,
  last_refresh_status: "failed",
  missing_info: [(error as Error).message],
  owner_evidence_ready: false,
  owner_evidence_sources: [],
  path: configuredPath(repo),
  provider: providerName(repo),
  ref: configuredRef(repo),
  repo: repo.name,
  source_provider: providerName(repo),
  warnings: [],
});

export const diagnoseConfiguredRepositories = async (
  config: FirstTraceConfig,
  repoPreparation: RepoPreparationOptions = {},
): Promise<RepositoryDiagnosticsResult> => {
  const fetchDepth = Math.max(25, config.search.maxCommits * 10);
  const repos = await Promise.all(
    config.repos.map(async (repo) => {
      try {
        const searchable =
          providerName(repo) === "local"
            ? localSearchableRepo(repo)
            : await prepareRepoForInvestigation(repo, repoPreparation, { fetchDepth });
        return diagnoseSearchableRepository(searchable, providerName(repo));
      } catch (error) {
        return failedDiagnostic(repo, error);
      }
    }),
  );

  return {
    passed: repos.every((repo) => repo.last_refresh_status !== "failed" && repo.owner_evidence_ready),
    repos,
  };
};

export const renderRepositoryDiagnostics = (result: RepositoryDiagnosticsResult) =>
  JSON.stringify(result, null, 2);
