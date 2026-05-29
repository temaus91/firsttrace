import type {
  FirstTraceConfig,
  ArchiveRepoConfig,
  GitHubRepoConfig,
  PreparedFirstTraceConfig,
  RepoConfig,
  SearchableRepoConfig,
} from "../types.js";
import { CommandArchiveRepoMaterializer, type ArchiveRepoMaterializer } from "./archive-materializer.js";
import { GitHubAppRepoMaterializer, type GitHubRepoMaterializer } from "./github-materializer.js";

export type RepoPreparationOptions = {
  archiveMaterializer?: ArchiveRepoMaterializer;
  githubMaterializer?: GitHubRepoMaterializer;
};

const isGitHubRepo = (repo: RepoConfig): repo is GitHubRepoConfig => repo.provider === "github";
const isArchiveRepo = (repo: RepoConfig): repo is ArchiveRepoConfig => repo.provider === "archive";

const localSearchableRepo = (repo: RepoConfig): SearchableRepoConfig => {
  if (isGitHubRepo(repo)) {
    throw new Error("GitHub repos must be materialized before investigation.");
  }
  if (isArchiveRepo(repo)) {
    throw new Error("Archive repos must be materialized before investigation.");
  }

  return {
    name: repo.name,
    path: repo.path,
    provider: "local",
    sourceProvider: "local",
  };
};

export const prepareConfigForInvestigation = async (
  config: FirstTraceConfig,
  { archiveMaterializer, githubMaterializer }: RepoPreparationOptions = {},
): Promise<PreparedFirstTraceConfig> => {
  const fetchDepth = Math.max(25, config.search.maxCommits * 10);
  let defaultArchiveMaterializer: ArchiveRepoMaterializer | undefined;
  let defaultGitHubMaterializer: GitHubRepoMaterializer | undefined;
  const repos = await Promise.all(
    config.repos.map((repo) => {
      if (isArchiveRepo(repo)) {
        const materializer = archiveMaterializer ?? (defaultArchiveMaterializer ??= new CommandArchiveRepoMaterializer());
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
