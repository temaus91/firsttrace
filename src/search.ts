import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { countTermHits } from "./terms.js";
import { resolveOwners, toPosixPath } from "./owners.js";
import { runCommand } from "./shell.js";
import {
  createGitHubTokenProviderFromEnv,
  type GitHubInstallationTokenProvider,
} from "./repositories/github-auth.js";
import type { EvidenceItem, PreparedFirstTraceConfig, SearchableRepoConfig } from "./types.js";

const EXCLUDE_GLOBS = [
  "!**/.git/**",
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/coverage/**",
  "!**/package-lock.json",
];

const SEARCHABLE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);

type Match = {
  line: number;
  path: string;
  text: string;
};

type CommitSignalSource = "term" | "path_history" | "line_blame" | "github_term" | "github_path_history";

type CommitSignal = {
  author: string;
  date: string;
  hash: string;
  line?: number;
  path?: string;
  score: number;
  source: CommitSignalSource;
  subject: string;
};

export type CommitSearchOptions = {
  fetchImpl?: typeof fetch;
  tokenProvider?: GitHubInstallationTokenProvider;
};

const lineSummary = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 220);

const isSearchableFile = (filePath: string) =>
  SEARCHABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const rgGlobArgs = () => EXCLUDE_GLOBS.flatMap((glob) => ["-g", glob]);

export const scorePath = (filePath: string, terms: string[]) => countTermHits(filePath, terms) * 8;

export const scoreTextLine = (line: string, terms: string[]) => 2 + countTermHits(line, terms);

export const sortEvidenceItems = (items: EvidenceItem[]) =>
  [...items].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

const shortHash = (hash: string) => hash.slice(0, 7);

const dateFromUnixSeconds = (value: string | undefined) => {
  if (!value) return "";
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString().slice(0, 10);
};

const commitSignalSummary = (signal: CommitSignal) => {
  if (signal.source === "line_blame" && signal.path && signal.line) {
    return `Last change to ${signal.path}:${signal.line}: ${signal.subject}`;
  }

  if (signal.path) {
    return `Recent change to ${signal.path}: ${signal.subject}`;
  }

  return signal.subject;
};

const commitSignalToEvidence = (repo: SearchableRepoConfig, signal: CommitSignal): EvidenceItem => ({
  citations: [{ commit: shortHash(signal.hash), label: `${repo.name}:${shortHash(signal.hash)}`, repo: repo.name }],
  metadata: {
    author: signal.author,
    date: signal.date,
    line: signal.line ?? null,
    path: signal.path ?? null,
    source: signal.source,
  },
  repo: repo.name,
  score: signal.score,
  summary: commitSignalSummary(signal),
  title: `${shortHash(signal.hash)} ${signal.subject}`,
  type: "commit",
});

const parseGitLogRows = (
  stdout: string,
  scoreFor: (index: number, row: { author: string; date: string; hash: string; subject: string }) => number,
  source: CommitSignalSource,
  pathValue?: string,
): CommitSignal[] =>
  stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((row, index) => {
      const [hash, date, author, ...subjectParts] = row.split("\t");
      const subject = subjectParts.join("\t");
      if (!hash || !date || !author || !subject) return [];
      return [
        {
          author,
          date,
          hash,
          path: pathValue,
          score: scoreFor(index, { author, date, hash, subject }),
          source,
          subject,
        },
      ];
    });

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

const candidatePathsFrom = (items: EvidenceItem[]) => [
  ...new Set(items.flatMap((item) => (item.path ? [item.path] : []))),
];

const candidateLineTargetsFrom = (items: EvidenceItem[]) =>
  items.flatMap((item) =>
    item.citations.flatMap((citation) =>
      citation.path && citation.line ? [{ line: citation.line, path: citation.path }] : [],
    ),
  );

const parseBlamePorcelain = (stdout: string) => {
  const lines = stdout.split("\n");
  const hash = lines[0]?.split(" ")[0];
  if (!hash || /^0+$/.test(hash)) return undefined;
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);

  return {
    author: field("author") ?? "unknown",
    date: dateFromUnixSeconds(field("author-time")),
    hash,
    subject: field("summary") ?? "Line change",
  };
};

const gitBlameSignal = (
  repo: SearchableRepoConfig,
  pathValue: string,
  line: number,
  score: number,
): CommitSignal | undefined => {
  const stdout = gitOutput(
    repo.path,
    ["blame", "--line-porcelain", "-L", `${line},${line}`, "--", pathValue],
    1024 * 1024,
  );
  if (stdout === undefined) return undefined;

  const blame = parseBlamePorcelain(stdout);
  if (!blame) return undefined;

  const show = gitOutput(
    repo.path,
    ["show", "-s", "--date=short", "--pretty=format:%h%x09%ad%x09%an%x09%s", blame.hash],
  );
  const [shown] = show ? parseGitLogRows(show, () => score, "line_blame", pathValue) : [];

  return {
    author: shown?.author ?? blame.author,
    date: shown?.date ?? blame.date,
    hash: shown?.hash ?? blame.hash,
    line,
    path: pathValue,
    score,
    source: "line_blame",
    subject: shown?.subject ?? blame.subject,
  };
};

const gitCommitSignals = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
  suspiciousFiles: EvidenceItem[],
) => {
  const signals: CommitSignal[] = [];
  let gitAvailable = false;

  if (terms.length) {
    const stdout = gitOutput(repo.path, [
      "log",
      "--all",
      "--date=short",
      "--max-count=250",
      "--pretty=format:%h%x09%ad%x09%an%x09%s",
    ]);
    if (stdout !== undefined) {
      gitAvailable = true;
      signals.push(
        ...parseGitLogRows(
          stdout,
          (_index, row) => countTermHits(`${row.subject} ${row.author}`, terms) * 3,
          "term",
        ).filter((signal) => signal.score > 0),
      );
    }
  }

  const candidatePaths = candidatePathsFrom(suspiciousFiles).slice(0, 3);
  const perPathLimit = Math.max(2, Math.ceil(config.search.maxCommits / Math.max(candidatePaths.length, 1)));
  candidatePaths.forEach((pathValue, pathIndex) => {
    const stdout = gitOutput(repo.path, [
      "log",
      "--date=short",
      "--max-count",
      String(perPathLimit),
      "--pretty=format:%h%x09%ad%x09%an%x09%s",
      "--",
      pathValue,
    ]);
    if (stdout !== undefined) {
      gitAvailable = true;
      signals.push(
        ...parseGitLogRows(
          stdout,
          (index) => Math.max(1, 24 - pathIndex * 4 - index),
          "path_history",
          pathValue,
        ),
      );
    }
  });

  candidateLineTargetsFrom(suspiciousFiles)
    .slice(0, 3)
    .forEach((target, index) => {
      const signal = gitBlameSignal(repo, target.path, target.line, Math.max(1, 32 - index * 3));
      if (signal) {
        gitAvailable = true;
        signals.push(signal);
      }
    });

  return { gitAvailable, signals };
};

type GitHubCommitResponse = {
  author?: { login?: string } | null;
  commit?: {
    author?: {
      date?: string;
      name?: string;
    } | null;
    message?: string;
  };
  sha?: string;
};

const githubCommitSignalFrom = (
  commit: GitHubCommitResponse,
  source: CommitSignalSource,
  score: number,
  pathValue?: string,
): CommitSignal | undefined => {
  const hash = commit.sha;
  const subject = commit.commit?.message?.split("\n")[0]?.trim();
  if (!hash || !subject) return undefined;

  return {
    author: commit.commit?.author?.name ?? commit.author?.login ?? "unknown",
    date: commit.commit?.author?.date?.slice(0, 10) ?? "",
    hash,
    path: pathValue,
    score,
    source,
    subject,
  };
};

const fetchGitHubCommits = async (
  repo: SearchableRepoConfig,
  token: string,
  fetchImpl: typeof fetch,
  pathValue?: string,
  perPage = 30,
) => {
  if (!repo.owner || !repo.remoteRepo) return [];
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.remoteRepo}/commits`);
  if (repo.defaultBranch) url.searchParams.set("sha", repo.defaultBranch);
  if (pathValue) url.searchParams.set("path", pathValue);
  url.searchParams.set("per_page", String(perPage));

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "firsttrace",
    },
  });

  if (!response.ok) return [];
  return (await response.json()) as GitHubCommitResponse[];
};

const githubCommitSignals = async (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
  suspiciousFiles: EvidenceItem[],
  options: CommitSearchOptions,
) => {
  if (repo.sourceProvider !== "github" || !repo.owner || !repo.remoteRepo) return [];

  try {
    const tokenProvider = options.tokenProvider ?? createGitHubTokenProviderFromEnv();
    const fetchImpl = options.fetchImpl ?? fetch;
    const token = await tokenProvider.getInstallationToken(repo.remoteRepo);
    const signals: CommitSignal[] = [];

    if (terms.length) {
      const commits = await fetchGitHubCommits(repo, token, fetchImpl, undefined, 100);
      signals.push(
        ...commits.flatMap((commit) => {
          const subject = commit.commit?.message?.split("\n")[0] ?? "";
          const author = commit.commit?.author?.name ?? commit.author?.login ?? "";
          const score = countTermHits(`${subject} ${author}`, terms) * 3;
          const signal = githubCommitSignalFrom(commit, "github_term", score);
          return signal && score > 0 ? [signal] : [];
        }),
      );
    }

    const candidatePaths = candidatePathsFrom(suspiciousFiles).slice(0, 3);
    const perPathLimit = Math.max(2, Math.ceil(config.search.maxCommits / Math.max(candidatePaths.length, 1)));
    for (const [pathIndex, pathValue] of candidatePaths.entries()) {
      const commits = await fetchGitHubCommits(repo, token, fetchImpl, pathValue, perPathLimit);
      signals.push(
        ...commits.flatMap((commit, index) => {
          const signal = githubCommitSignalFrom(
            commit,
            "github_path_history",
            Math.max(1, 22 - pathIndex * 4 - index),
            pathValue,
          );
          return signal ? [signal] : [];
        }),
      );
    }

    return signals;
  } catch {
    return [];
  }
};

const dedupeCommitSignals = (signals: CommitSignal[]) => {
  const byHash = new Map<string, CommitSignal>();
  for (const signal of signals) {
    const current = byHash.get(shortHash(signal.hash));
    if (!current || signal.score > current.score) byHash.set(shortHash(signal.hash), signal);
  }
  return [...byHash.values()];
};

const parseRipgrepJson = (stdout: string): Match[] =>
  stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as {
        data?: { line_number?: number; lines?: { text?: string }; path?: { text?: string } };
        type?: string;
      };
      if (parsed.type !== "match") return [];
      const filePath = parsed.data?.path?.text;
      const lineNumber = parsed.data?.line_number;
      const text = parsed.data?.lines?.text;
      if (!filePath || !lineNumber || !text) return [];
      return [{ line: lineNumber, path: toPosixPath(filePath), text }];
    });

const rgSearch = (repoPath: string, terms: string[], targets: string[], maxEvidence: number) => {
  if (!terms.length) return [];
  const searchTargets = targets.length ? targets : ["."];
  try {
    const result = runCommand(
      repoPath,
      "rg",
      [
        "--json",
        "--ignore-case",
        "--fixed-strings",
        "--max-count",
        String(maxEvidence),
        "--max-filesize",
        "500K",
        ...rgGlobArgs(),
        ...terms.flatMap((term) => ["-e", term]),
        ...searchTargets,
      ],
      { allowExitCodes: [1] },
    );

    return result.stdout ? parseRipgrepJson(result.stdout) : [];
  } catch (error) {
    if (!(error as Error).message.includes("spawnSync rg ENOENT")) throw error;
    return nodeSearch(repoPath, terms, searchTargets, maxEvidence);
  }
};

const walkFiles = (rootPath: string, currentPath = rootPath): string[] => {
  if (!existsSync(currentPath)) return [];
  return readdirSync(currentPath).flatMap((entry) => {
    if (EXCLUDE_DIRS.has(entry)) return [];
    const fullPath = path.join(currentPath, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return walkFiles(rootPath, fullPath);
    if (!stat.isFile() || stat.size > 500 * 1024) return [];
    return [toPosixPath(path.relative(rootPath, fullPath))];
  });
};

const listFilesWithNode = (repoPath: string) => walkFiles(repoPath).filter(isSearchableFile);

const nodeSearch = (repoPath: string, terms: string[], targets: string[], maxEvidence: number): Match[] => {
  const lowerTerms = terms.map((term) => term.toLowerCase());
  const files = listFilesWithNode(repoPath).filter((filePath) =>
    targets.some((target) => target === "." || filePath === toPosixPath(target) || filePath.startsWith(`${toPosixPath(target)}/`)),
  );

  return files.flatMap((filePath) => {
    const fullPath = path.join(repoPath, filePath);
    const text = readFileSync(fullPath, "utf8");
    let matches = 0;
    return text.split("\n").flatMap((line, index) => {
      if (matches >= maxEvidence) return [];
      const lowerLine = line.toLowerCase();
      if (!lowerTerms.some((term) => lowerLine.includes(term))) return [];
      matches += 1;
      return [{ line: index + 1, path: filePath, text: line }];
    });
  });
};

const listFiles = (repoPath: string) => {
  try {
    return runCommand(repoPath, "rg", ["--files", ...rgGlobArgs()], { allowExitCodes: [1] }).stdout
      .split("\n")
      .filter(Boolean)
      .map(toPosixPath)
      .filter(isSearchableFile);
  } catch (error) {
    if (!(error as Error).message.includes("spawnSync rg ENOENT")) throw error;
    return listFilesWithNode(repoPath);
  }
};

const itemFromPath = (
  repo: SearchableRepoConfig,
  filePath: string,
  score: number,
  config: PreparedFirstTraceConfig,
): EvidenceItem => {
  const owners = resolveOwners(filePath, config.owners);
  return {
    citations: [{ label: `${repo.name}:${filePath}`, path: filePath, repo: repo.name }],
    owner: owners[0],
    path: filePath,
    repo: repo.name,
    score,
    summary: "Path matched the report terms.",
    title: filePath,
    type: "file",
  };
};

export const searchFiles = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
) => {
  const byPath = new Map<string, EvidenceItem>();

  for (const filePath of listFiles(repo.path)) {
    const score = scorePath(filePath, terms);
    if (score > 0) byPath.set(filePath, itemFromPath(repo, filePath, score, config));
  }

  for (const match of rgSearch(repo.path, terms, [], config.search.maxEvidencePerFile)) {
    if (!isSearchableFile(match.path)) continue;
    const item =
      byPath.get(match.path) ?? itemFromPath(repo, match.path, scorePath(match.path, terms), config);
    item.score += scoreTextLine(match.text, terms);
    item.summary = lineSummary(match.text);
    item.citations = [
      ...item.citations.filter((citation) => citation.line !== undefined),
      {
        label: `${repo.name}:${match.path}:${match.line}`,
        line: match.line,
        path: match.path,
        repo: repo.name,
      },
    ].slice(0, config.search.maxEvidencePerFile);
    byPath.set(match.path, item);
  }

  return sortEvidenceItems([...byPath.values()]).slice(0, config.search.maxFiles);
};

const existingTargets = (repoPath: string, targets: string[]) =>
  targets.filter((target) => existsSync(path.resolve(repoPath, target)));

const searchConfiguredText = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
  targets: string[],
  type: "doc" | "issue",
) => {
  const byPath = new Map<string, EvidenceItem>();
  const validTargets = existingTargets(repo.path, targets);
  if (!validTargets.length) return [];

  for (const match of rgSearch(repo.path, terms, validTargets, config.search.maxEvidencePerFile)) {
    const owners = resolveOwners(match.path, config.owners);
    const item = byPath.get(match.path) ?? {
      citations: [],
      owner: owners[0],
      path: match.path,
      repo: repo.name,
      score: scorePath(match.path, terms),
      summary: lineSummary(match.text),
      title: match.path,
      type,
    };
    item.score += scoreTextLine(match.text, terms);
    item.summary = lineSummary(match.text);
    item.citations = [
      ...item.citations,
      {
        label: `${repo.name}:${match.path}:${match.line}`,
        line: match.line,
        path: match.path,
        repo: repo.name,
      },
    ].slice(0, config.search.maxEvidencePerFile);
    byPath.set(match.path, item);
  }

  return sortEvidenceItems([...byPath.values()]).slice(0, config.search.maxFiles);
};

export const searchDocs = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
) =>
  searchConfiguredText(repo, terms, config, config.docs, "doc");

export const searchIssueExports = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
) =>
  searchConfiguredText(repo, terms, config, config.issueExports, "issue");

export const searchCommits = async (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
  suspiciousFiles: EvidenceItem[] = [],
  options: CommitSearchOptions = {},
) => {
  if (!terms.length && !suspiciousFiles.length) return [];

  const gitSignals = gitCommitSignals(repo, terms, config, suspiciousFiles);
  const signals = gitSignals.gitAvailable
    ? gitSignals.signals
    : await githubCommitSignals(repo, terms, config, suspiciousFiles, options);

  return sortEvidenceItems(dedupeCommitSignals(signals).map((signal) => commitSignalToEvidence(repo, signal))).slice(
    0,
    config.search.maxCommits,
  );
};
