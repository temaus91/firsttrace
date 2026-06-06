import {
  rankOwnerEvidenceCandidates,
  type OwnerEvidenceCommit,
  type OwnerEvidenceResult,
} from "./owner-evidence.js";
import {
  createGitHubTokenProviderFromEnv,
  type GitHubInstallationTokenProvider,
} from "./repositories/github-auth.js";
import type { ManagerOwnerTriageEvidenceSource } from "./manager-triage.js";
import type { SearchableRepoConfig } from "./types.js";

export type ProviderCommitMetadata = {
  commitId: string;
  email: string;
  evidenceSource: ManagerOwnerTriageEvidenceSource;
  name: string;
};

export type ProviderMetadataAdapter = {
  getCommitMetadata(repo: SearchableRepoConfig, commitId: string): Promise<ProviderCommitMetadata | undefined>;
};

const hasGitHubProviderMetadataCredentials = (env: NodeJS.ProcessEnv) =>
  Boolean(
    env.GITHUB_TOKEN?.trim() ||
    env.GH_TOKEN?.trim() ||
    (env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_INSTALLATION_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim()),
  );

type GitHubPullResponse = {
  user?: {
    login?: string;
  } | null;
};

const metadataKey = (repo: string, commitId: string) => `${repo}\t${commitId}`;

const explicitPersonEvidence = (
  metadata: ProviderCommitMetadata | undefined,
): metadata is ProviderCommitMetadata =>
  Boolean(
    metadata &&
    metadata.evidenceSource !== "unknown" &&
    (metadata.name.trim() || metadata.email.trim()),
  );

const commitWithProviderMetadata = (
  commit: OwnerEvidenceCommit,
  metadata: ProviderCommitMetadata | undefined,
): OwnerEvidenceCommit => {
  if (!explicitPersonEvidence(metadata)) return commit;

  return {
    ...commit,
    authorEmail: metadata.email,
    authorName: metadata.name,
    evidenceSource: metadata.evidenceSource,
    whyRelevant: `${commit.whyRelevant} Provider metadata identifies ${metadata.evidenceSource} ${metadata.name || metadata.email}.`,
  };
};

export const enrichOwnerEvidenceWithProviderMetadata = async (
  ownerEvidence: OwnerEvidenceResult,
  repos: SearchableRepoConfig[],
  adapter: ProviderMetadataAdapter,
): Promise<OwnerEvidenceResult> => {
  const repoByName = new Map(repos.map((repo) => [repo.name, repo]));
  const commits = ownerEvidence.candidates.flatMap((candidate) => candidate.evidenceCommits);
  if (!commits.length) return ownerEvidence;
  const metadata = new Map<string, ProviderCommitMetadata | undefined>();

  for (const commit of commits) {
    const repo = repoByName.get(commit.repo);
    if (!repo) continue;
    metadata.set(metadataKey(commit.repo, commit.commitId), await adapter.getCommitMetadata(repo, commit.commitId));
  }

  const enrichedCommits = commits.map((commit) =>
    commitWithProviderMetadata(commit, metadata.get(metadataKey(commit.repo, commit.commitId))),
  );
  const providerHitCount = enrichedCommits.filter((commit, index) => commit.evidenceSource !== commits[index]?.evidenceSource).length;

  return {
    ...ownerEvidence,
    candidates: rankOwnerEvidenceCandidates(enrichedCommits),
    missingInfo: providerHitCount
      ? ownerEvidence.missingInfo
      : [
          ...ownerEvidence.missingInfo,
          "Provider metadata was unavailable for owner evidence commits; FirstTrace kept local Git author evidence.",
        ],
  };
};

export const createProviderMetadataAdapterFromEnv = (
  repos: SearchableRepoConfig[],
  env: NodeJS.ProcessEnv = process.env,
): ProviderMetadataAdapter | undefined => {
  if (!repos.some((repo) => repo.sourceProvider === "github")) return undefined;
  if (!hasGitHubProviderMetadataCredentials(env)) return undefined;
  return new GitHubProviderMetadataAdapter({ tokenProvider: createGitHubTokenProviderFromEnv(env) });
};

export class GitHubProviderMetadataAdapter implements ProviderMetadataAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: GitHubInstallationTokenProvider;

  constructor({
    fetchImpl = fetch,
    tokenProvider = createGitHubTokenProviderFromEnv(),
  }: {
    fetchImpl?: typeof fetch;
    tokenProvider?: GitHubInstallationTokenProvider;
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.tokenProvider = tokenProvider;
  }

  async getCommitMetadata(
    repo: SearchableRepoConfig,
    commitId: string,
  ): Promise<ProviderCommitMetadata | undefined> {
    if (repo.sourceProvider !== "github" || !repo.owner || !repo.remoteRepo) return undefined;

    const token = await this.tokenProvider.getInstallationToken(repo.remoteRepo);
    const response = await this.fetchImpl(
      `https://api.github.com/repos/${repo.owner}/${repo.remoteRepo}/commits/${commitId}/pulls`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "firsttrace",
        },
      },
    );
    if (!response.ok) return undefined;

    const pulls = (await response.json()) as GitHubPullResponse[];
    const login = pulls[0]?.user?.login?.trim();
    if (!login) return undefined;

    return {
      commitId,
      email: "",
      evidenceSource: "pr_author",
      name: login,
    };
  }
}
