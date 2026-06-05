import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";
import type { Citation, EvidenceItem, SearchableRepoConfig } from "./types.js";
import type { ManagerOwnerTriageEvidenceSource } from "./manager-triage.js";

export type OwnerEvidenceKind = "exact_line_blame" | "file_history";

export type OwnerEvidenceCommit = {
  authorEmail: string;
  authorName: string;
  authorTime: string;
  commitId: string;
  commitTime: string;
  commitTitle: string;
  committerEmail: string;
  committerName: string;
  committerTime: string;
  evidenceCode: string;
  evidenceKind: OwnerEvidenceKind;
  evidenceSource: ManagerOwnerTriageEvidenceSource;
  file: string;
  line: number | null;
  repo: string;
  score: number;
  whyRelevant: string;
};

export type OwnerEvidenceCandidate = {
  confidence: "High" | "Medium" | "Low";
  email: string;
  evidenceCommits: OwnerEvidenceCommit[];
  evidenceSource: ManagerOwnerTriageEvidenceSource;
  name: string;
  rank: number;
  reason: string;
  score: number;
};

export type OwnerEvidenceResult = {
  candidates: OwnerEvidenceCandidate[];
  missingInfo: string[];
  warnings: string[];
  weakCommits: OwnerEvidenceCommit[];
};

type GitCommitMetadata = {
  authorEmail: string;
  authorName: string;
  authorTime: string;
  commitId: string;
  commitTitle: string;
  committerEmail: string;
  committerName: string;
  committerTime: string;
};

const gitOutput = (repoPath: string, args: string[], maxBuffer?: number) => {
  try {
    const result = runCommand(repoPath, "git", args, { allowExitCodes: [128], maxBuffer });
    if (result.status === 128) return undefined;
    return result.stdout;
  } catch (error) {
    if ((error as Error).message.includes("spawnSync git ENOENT")) return undefined;
    throw error;
  }
};

const hasGitHistory = (repoPath: string) => gitOutput(repoPath, ["rev-parse", "--is-inside-work-tree"]) === "true";

const stripEmailBrackets = (value: string | undefined) => value?.replace(/^<|>$/g, "") ?? "";

const isoFromUnixSeconds = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed * 1000).toISOString() : "";
};

const fieldFrom = (lines: string[], name: string) =>
  lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);

const parseBlameMetadata = (stdout: string): GitCommitMetadata | undefined => {
  const lines = stdout.split("\n");
  const commitId = lines[0]?.split(" ")[0];
  if (!commitId || /^0+$/.test(commitId)) return undefined;

  return {
    authorEmail: stripEmailBrackets(fieldFrom(lines, "author-mail")),
    authorName: fieldFrom(lines, "author") ?? "",
    authorTime: isoFromUnixSeconds(fieldFrom(lines, "author-time")),
    commitId,
    commitTitle: fieldFrom(lines, "summary") ?? "",
    committerEmail: stripEmailBrackets(fieldFrom(lines, "committer-mail")),
    committerName: fieldFrom(lines, "committer") ?? "",
    committerTime: isoFromUnixSeconds(fieldFrom(lines, "committer-time")),
  };
};

const parseGitLogMetadata = (row: string): GitCommitMetadata | undefined => {
  const [commitId, authorTime, authorName, authorEmail, committerTime, committerName, committerEmail, ...titleParts] =
    row.split("\t");
  const commitTitle = titleParts.join("\t");
  if (!commitId || !authorTime || !authorName || !commitTitle) return undefined;

  return {
    authorEmail: authorEmail ?? "",
    authorName,
    authorTime,
    commitId,
    commitTitle,
    committerEmail: committerEmail ?? "",
    committerName: committerName ?? "",
    committerTime: committerTime ?? "",
  };
};

const fullCommitMetadata = (repo: SearchableRepoConfig, commitId: string): GitCommitMetadata | undefined => {
  const stdout = gitOutput(repo.path, [
    "show",
    "-s",
    "--date=iso-strict",
    "--pretty=format:%H%x09%aI%x09%an%x09%ae%x09%cI%x09%cn%x09%ce%x09%s",
    commitId,
  ]);
  return stdout ? parseGitLogMetadata(stdout) : undefined;
};

const lineText = (repo: SearchableRepoConfig, filePath: string, line: number, fallback?: string) => {
  if (fallback?.trim()) return fallback.trim();
  const absolutePath = path.resolve(repo.path, filePath);
  if (!existsSync(absolutePath)) return "";
  const lines = readFileSync(absolutePath, "utf8").split("\n");
  return lines[line - 1]?.trim() ?? "";
};

const lineTargetsFrom = (items: EvidenceItem[]) =>
  items.flatMap((item) =>
    item.citations.flatMap((citation) =>
      item.repo === citation.repo && item.path && citation.path && citation.line
        ? [{
            citation,
            line: citation.line,
            path: citation.path,
            repo: item.repo,
          }]
        : [],
    ),
  );

const candidatePathsFrom = (items: EvidenceItem[]) => [
  ...new Set(items.flatMap((item) => (item.path ? [`${item.repo}\t${item.path}`] : []))),
].map((value) => {
  const [repo, filePath] = value.split("\t");
  return { filePath: filePath ?? "", repo: repo ?? "" };
});

const blameCommitForLine = (
  repo: SearchableRepoConfig,
  filePath: string,
  line: number,
  citation: Citation,
  score: number,
): OwnerEvidenceCommit | undefined => {
  const stdout = gitOutput(repo.path, ["blame", "--line-porcelain", "-L", `${line},${line}`, "--", filePath], 1024 * 1024);
  if (!stdout) return undefined;
  const blamed = parseBlameMetadata(stdout);
  if (!blamed) return undefined;
  const metadata = fullCommitMetadata(repo, blamed.commitId) ?? blamed;

  return {
    ...metadata,
    commitTime: metadata.authorTime,
    evidenceCode: lineText(repo, filePath, line, citation.snippet),
    evidenceKind: "exact_line_blame",
    evidenceSource: "commit_author",
    file: filePath,
    line,
    repo: repo.name,
    score,
    whyRelevant: citation.whyRelevant ?? `Exact-line blame for ${filePath}:${line}.`,
  };
};

const fileHistoryCommits = (repo: SearchableRepoConfig, filePath: string, limit: number) => {
  const stdout = gitOutput(repo.path, [
    "log",
    "--follow",
    "--date=iso-strict",
    "--max-count",
    String(limit),
    "--pretty=format:%H%x09%aI%x09%an%x09%ae%x09%cI%x09%cn%x09%ce%x09%s",
    "--",
    filePath,
  ]);
  if (!stdout) return [];

  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((row, index) => {
      const metadata = parseGitLogMetadata(row);
      if (!metadata) return [];
      return [{
        ...metadata,
        commitTime: metadata.authorTime,
        evidenceCode: "",
        evidenceKind: "file_history" as const,
        evidenceSource: "commit_author" as const,
        file: filePath,
        line: null,
        repo: repo.name,
        score: Math.max(1, 20 - index),
        whyRelevant: `Recent file history for ${filePath}; weak context unless tied to an exact suspicious line.`,
      }];
    });
};

const personKey = (commit: OwnerEvidenceCommit) =>
  (commit.authorEmail.trim() || commit.authorName.trim()).toLowerCase();

const confidenceFor = (commits: OwnerEvidenceCommit[]): OwnerEvidenceCandidate["confidence"] =>
  commits.some((commit) => commit.evidenceKind === "exact_line_blame") ? "High" : "Low";

const reasonFor = (commits: OwnerEvidenceCommit[]) => {
  const exact = commits.filter((commit) => commit.evidenceKind === "exact_line_blame");
  if (exact.length) {
    const first = exact[0];
    return `Exact-line blame points to ${first?.file}:${first?.line}.`;
  }
  return "Only weak recent file history is available.";
};

export const rankOwnerEvidenceCandidates = (commits: OwnerEvidenceCommit[]): OwnerEvidenceCandidate[] => {
  const grouped = new Map<string, OwnerEvidenceCommit[]>();
  for (const commit of commits) {
    const key = personKey(commit);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), commit]);
  }

  return [...grouped.values()]
    .map((evidenceCommits) => {
      const sortedCommits = [...evidenceCommits].sort((a, b) => b.score - a.score || a.commitTime.localeCompare(b.commitTime));
      const first = sortedCommits[0]!;
      return {
        confidence: confidenceFor(sortedCommits),
        email: first.authorEmail,
        evidenceCommits: sortedCommits,
        evidenceSource: first.evidenceSource,
        name: first.authorName,
        rank: 0,
        reason: reasonFor(sortedCommits),
        score: sortedCommits.reduce((sum, commit) => sum + commit.score, 0),
      };
    })
    .filter((candidate) => candidate.evidenceCommits.some((commit) => commit.evidenceKind === "exact_line_blame"))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 2)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
};

export const collectOwnerEvidenceForRepo = (
  repo: SearchableRepoConfig,
  suspiciousFiles: EvidenceItem[],
): OwnerEvidenceResult => {
  const missingInfo: string[] = [];
  const warnings: string[] = [];
  const lineTargets = lineTargetsFrom(suspiciousFiles).filter((target) => target.repo === repo.name);
  const candidatePaths = candidatePathsFrom(suspiciousFiles).filter((target) => target.repo === repo.name);

  if (!lineTargets.length && !candidatePaths.length) {
    return {
      candidates: [],
      missingInfo,
      warnings,
      weakCommits: [],
    };
  }

  if (!hasGitHistory(repo.path)) {
    return {
      candidates: [],
      missingInfo: [`Git history is unavailable for ${repo.name}; collect .git history or provider metadata for owner attribution.`],
      warnings,
      weakCommits: [],
    };
  }

  const exactCommits = lineTargets
    .slice(0, 8)
    .flatMap((target, index) => {
      const commit = blameCommitForLine(repo, target.path, target.line, target.citation, Math.max(1, 100 - index * 4));
      return commit ? [commit] : [];
    });

  const weakCommits = candidatePaths
    .slice(0, 5)
    .flatMap((target) => fileHistoryCommits(repo, target.filePath, 3));

  if (!exactCommits.length) {
    missingInfo.push(`No exact line blame evidence was available for ${repo.name}; person owner candidates require exact suspicious lines or provider metadata.`);
  }

  return {
    candidates: rankOwnerEvidenceCandidates(exactCommits),
    missingInfo,
    warnings,
    weakCommits,
  };
};

export const collectOwnerEvidence = (
  repos: SearchableRepoConfig[],
  suspiciousFiles: EvidenceItem[],
): OwnerEvidenceResult => {
  const results = repos.map((repo) => collectOwnerEvidenceForRepo(repo, suspiciousFiles));
  const candidates = rankOwnerEvidenceCandidates(results.flatMap((result) =>
    result.candidates.flatMap((candidate) => candidate.evidenceCommits),
  ));

  return {
    candidates,
    missingInfo: [...new Set(results.flatMap((result) => result.missingInfo))],
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
    weakCommits: results.flatMap((result) => result.weakCommits),
  };
};
