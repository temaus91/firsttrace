import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { countTermHits } from "./terms.js";
import { resolveOwners, toPosixPath } from "./owners.js";
import { runCommand } from "./shell.js";
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

const lineSummary = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 220);

const isSearchableFile = (filePath: string) =>
  SEARCHABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

const rgGlobArgs = () => EXCLUDE_GLOBS.flatMap((glob) => ["-g", glob]);

export const scorePath = (filePath: string, terms: string[]) => countTermHits(filePath, terms) * 8;

export const scoreTextLine = (line: string, terms: string[]) => 2 + countTermHits(line, terms);

export const sortEvidenceItems = (items: EvidenceItem[]) =>
  [...items].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

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

export const searchCommits = (
  repo: SearchableRepoConfig,
  terms: string[],
  config: PreparedFirstTraceConfig,
) => {
  if (!terms.length) return [];

  let result;
  try {
    result = runCommand(
      repo.path,
      "git",
      [
        "log",
        "--all",
        "--date=short",
        "--max-count=250",
        "--pretty=format:%h%x09%ad%x09%an%x09%s",
      ],
      { allowExitCodes: [128] },
    );
  } catch (error) {
    if ((error as Error).message.includes("spawnSync git ENOENT")) return [];
    throw error;
  }
  if (result.status === 128 || !result.stdout) return [];

  return result.stdout
    .split("\n")
    .flatMap((row) => {
      const [hash, date, author, subject] = row.split("\t");
      if (!hash || !date || !author || !subject) return [];
      const score = countTermHits(`${subject} ${author}`, terms) * 3;
      if (score <= 0) return [];
      return [
        {
          citations: [{ commit: hash, label: `${repo.name}:${hash}`, repo: repo.name }],
          repo: repo.name,
          score,
          summary: subject,
          title: `${hash} ${subject}`,
          type: "commit" as const,
          metadata: { author, date },
        },
      ];
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, config.search.maxCommits);
};
