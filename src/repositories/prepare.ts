import type {
  FirstTraceConfig,
  ArchiveRepoConfig,
  GitRepoConfig,
  GitHubRepoConfig,
  PreparedFirstTraceConfig,
  RepoConfig,
  SearchableRepoConfig,
} from "../types.js";
import { CommandArchiveRepoMaterializer, type ArchiveRepoMaterializer } from "./archive-materializer.js";
import { CommandGitRepoMaterializer, type GenericGitRepoMaterializer } from "./git-materializer.js";
import { GitHubAppRepoMaterializer, type GitHubRepoMaterializer } from "./github-materializer.js";

export type RepoPreparationOptions = {
  archiveMaterializer?: ArchiveRepoMaterializer;
  gitMaterializer?: GenericGitRepoMaterializer;
  githubMaterializer?: GitHubRepoMaterializer;
};

const isGitHubRepo = (repo: RepoConfig): repo is GitHubRepoConfig => repo.provider === "github";
const isArchiveRepo = (repo: RepoConfig): repo is ArchiveRepoConfig => repo.provider === "archive";
const isGitRepo = (repo: RepoConfig): repo is GitRepoConfig => repo.provider === "git";

export const localSearchableRepo = (repo: RepoConfig): SearchableRepoConfig => {
  if (isGitHubRepo(repo)) {
    throw new Error("GitHub repos must be materialized before investigation.");
  }
  if (isArchiveRepo(repo)) {
    throw new Error("Archive repos must be materialized before investigation.");
  }
  if (isGitRepo(repo)) {
    throw new Error("Git repos must be materialized before investigation.");
  }

  return {
    name: repo.name,
    path: repo.path,
    provider: "local",
    sourceProvider: "local",
  };
};

export const prepareRepoForInvestigation = async (
  repo: RepoConfig,
  {
    archiveMaterializer,
    gitMaterializer,
    githubMaterializer,
  }: RepoPreparationOptions = {},
  { fetchDepth }: { fetchDepth: number },
): Promise<SearchableRepoConfig> => {
  if (isArchiveRepo(repo)) {
    const materializer = archiveMaterializer ?? new CommandArchiveRepoMaterializer();
    return materializer.materialize(repo);
  }
  if (isGitRepo(repo)) {
    const materializer = gitMaterializer ?? new CommandGitRepoMaterializer();
    return materializer.materialize(repo);
  }
  if (isGitHubRepo(repo)) {
    const materializer = githubMaterializer ?? new GitHubAppRepoMaterializer();
    return materializer.materialize(repo, { fetchDepth });
  }
  return localSearchableRepo(repo);
};

export const prepareConfigForInvestigation = async (
  config: FirstTraceConfig,
  { archiveMaterializer, gitMaterializer, githubMaterializer }: RepoPreparationOptions = {},
): Promise<PreparedFirstTraceConfig> => {
  const fetchDepth = Math.max(25, config.search.maxCommits * 10);
  let defaultArchiveMaterializer: ArchiveRepoMaterializer | undefined;
  let defaultGitMaterializer: GenericGitRepoMaterializer | undefined;
  let defaultGitHubMaterializer: GitHubRepoMaterializer | undefined;
  const repos = await Promise.all(
    config.repos.map((repo) => {
      if (isArchiveRepo(repo)) {
        const materializer = archiveMaterializer ?? (defaultArchiveMaterializer ??= new CommandArchiveRepoMaterializer());
        return materializer.materialize(repo);
      }
      if (isGitRepo(repo)) {
        const materializer = gitMaterializer ?? (defaultGitMaterializer ??= new CommandGitRepoMaterializer());
        return materializer.materialize(repo);
      }
      if (isGitHubRepo(repo)) {
        const materializer = githubMaterializer ?? (defaultGitHubMaterializer ??= new GitHubAppRepoMaterializer());
        return materializer.materialize(repo, { fetchDepth });
      }
      return Promise.resolve(localSearchableRepo(repo));
    }),
  );

  return {
    ...config,
    repos,
  };
};
