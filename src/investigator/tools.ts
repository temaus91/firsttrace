import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { toPosixPath } from "../owners.js";
import { runCommand } from "../shell.js";
import type {
  InvestigationToolName,
  InvestigationToolResult,
  InvestigationToolset,
  PreparedFirstTraceConfig,
  SearchableRepoConfig,
} from "../types.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_LENGTH = 4_000;
const SAFE_COMMAND_TIMEOUT_MS = 30_000;
const TOOL_COMMAND_TIMEOUT_MS = 10_000;

const RepoArg = z.object({
  repo: z.string().optional(),
});

const PathArg = RepoArg.extend({
  path: z.string(),
});

const ReadFileArg = PathArg.extend({
  line: z.number().int().positive().optional(),
  window: z.number().int().positive().max(80).optional(),
});

const SearchArg = RepoArg.extend({
  query: z.string().min(1),
});

const FindFilesArg = RepoArg.extend({
  query: z.string().min(1),
});

const ReferencesArg = RepoArg.extend({
  symbolOrPath: z.string().min(1),
});

const GitLogArg = RepoArg.extend({
  path: z.string().optional(),
});

const GitBlameArg = PathArg.extend({
  line: z.number().int().positive(),
});

const SafeCommandArg = RepoArg.extend({
  command: z.string().min(1),
});

const SAFE_COMMANDS = new Map<string, [string, string[]]>([
  ["npm test", ["npm", ["test"]]],
  ["npm run test", ["npm", ["run", "test"]]],
  ["npm run typecheck", ["npm", ["run", "typecheck"]]],
  ["npm run lint", ["npm", ["run", "lint"]]],
]);

const truncate = (value: string, maxLength = MAX_TOOL_OUTPUT_LENGTH) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;

const repoByName = (config: PreparedFirstTraceConfig, repoName?: string) => {
  const repo = repoName ? config.repos.find((item) => item.name === repoName) : config.repos[0];
  if (!repo) {
    throw new Error(repoName ? `Repository not found: ${repoName}` : "No repositories are configured.");
  }
  return repo;
};

const safeRepoPath = (repo: SearchableRepoConfig, requestedPath: string) => {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const repoRoot = path.resolve(repo.path);
  const resolved = path.resolve(repoRoot, requestedPath);
  if (resolved !== repoRoot && !resolved.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error("Path is outside the repository root.");
  }

  const relativePath = toPosixPath(path.relative(repoRoot, resolved));
  if (!relativePath || relativePath.startsWith("..")) {
    throw new Error("Path is outside the repository root.");
  }

  return { absolutePath: resolved, relativePath };
};

const lineCitation = (relativePath: string, line: number) => `${relativePath}:${line}`;

const gitCommitCitation = (hash: string) => `commit ${hash.slice(0, 7)}`;

const listRepoFiles = (repo: SearchableRepoConfig) => {
  try {
    return runCommand(repo.path, "rg", ["--files", "--glob", "!**/.git/**", "--glob", "!**/node_modules/**"], {
      allowExitCodes: [1],
      maxBuffer: 2 * 1024 * 1024,
      timeoutMs: TOOL_COMMAND_TIMEOUT_MS,
    }).stdout
      .split("\n")
      .filter(Boolean)
      .map(toPosixPath);
  } catch (error) {
    if ((error as Error).message.includes("spawnSync rg ENOENT")) {
      throw new Error("findFiles requires ripgrep to list repository files.");
    }
    throw error;
  }
};

const findFilesTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = FindFilesArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const query = parsed.query.toLowerCase();
  const matches = listRepoFiles(repo)
    .filter((filePath) => filePath.toLowerCase().includes(query))
    .slice(0, 20);

  return {
    citations: matches,
    summary: matches.length ? matches.join("\n") : "No matching file paths.",
    title: `Find files in ${repo.name} matching ${parsed.query}`,
  };
};

const readFileTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = ReadFileArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const { absolutePath, relativePath } = safeRepoPath(repo, parsed.path);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`File not found: ${relativePath}`);
  }
  if (statSync(absolutePath).size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read through the agent tool: ${relativePath}`);
  }

  const lines = readFileSync(absolutePath, "utf8").split("\n");
  const windowSize = parsed.window ?? 40;
  const centerLine = parsed.line ?? 1;
  const start = Math.max(1, centerLine - Math.floor(windowSize / 2));
  const end = Math.min(lines.length, start + windowSize - 1);
  const selected = lines.slice(start - 1, end);
  const body = selected.map((line, index) => `${start + index}: ${line}`).join("\n");
  const citations = selected.map((_line, index) => lineCitation(relativePath, start + index));

  return {
    citations,
    summary: truncate(body),
    title: `Read ${repo.name}:${relativePath}:${start}-${end}`,
  };
};

const parseRgOutput = (stdout: string) =>
  stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((row) => {
      const match = /^(.*?):(\d+):(.*)$/.exec(row);
      if (!match) return [];
      return [{ line: Number(match[2]), path: toPosixPath(match[1] ?? ""), text: match[3] ?? "" }];
    });

const rgSearch = (repo: SearchableRepoConfig, query: string) => {
  const result = runCommand(
    repo.path,
    "rg",
    [
      "--line-number",
      "--ignore-case",
      "--fixed-strings",
      "--glob",
      "!**/.git/**",
      "--glob",
      "!**/node_modules/**",
      "--glob",
      "!**/dist/**",
      "--glob",
      "!**/build/**",
      "--",
      query,
      ".",
    ],
    { allowExitCodes: [1], maxBuffer: 2 * 1024 * 1024, timeoutMs: TOOL_COMMAND_TIMEOUT_MS },
  );
  return parseRgOutput(result.stdout).slice(0, 12);
};

const searchRepoTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = SearchArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const matches = rgSearch(repo, parsed.query);
  return {
    citations: matches.map((match) => lineCitation(match.path, match.line)),
    summary: truncate(matches.map((match) => `${match.path}:${match.line}: ${match.text.trim()}`).join("\n") || "No matches."),
    title: `Search ${repo.name} for ${parsed.query}`,
  };
};

const findReferencesTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = ReferencesArg.parse(args);
  return searchRepoTool(config, { query: parsed.symbolOrPath, repo: parsed.repo });
};

const gitLogTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = GitLogArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const pathArgs = parsed.path ? ["--", safeRepoPath(repo, parsed.path).relativePath] : [];
  const result = runCommand(
    repo.path,
    "git",
    ["log", "--date=short", "--max-count", "6", "--pretty=format:%h%x09%ad%x09%an%x09%s", ...pathArgs],
    { allowExitCodes: [128], maxBuffer: 1024 * 1024, timeoutMs: TOOL_COMMAND_TIMEOUT_MS },
  );
  if (result.status === 128) {
    return { citations: [], summary: "Git history is not available.", title: `Git log ${repo.name}` };
  }

  const rows = result.stdout.split("\n").filter(Boolean);
  const citations = rows.flatMap((row) => {
    const [hash] = row.split("\t");
    return hash ? [gitCommitCitation(hash)] : [];
  });
  const summary = rows
    .map((row) => {
      const [hash, date, author, ...subject] = row.split("\t");
      return `${hash} ${date} ${author}: ${subject.join("\t")}`;
    })
    .join("\n");

  return {
    citations,
    summary: truncate(summary || "No commits found."),
    title: parsed.path ? `Git log ${repo.name}:${parsed.path}` : `Git log ${repo.name}`,
  };
};

const gitBlameTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = GitBlameArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const { relativePath } = safeRepoPath(repo, parsed.path);
  const result = runCommand(
    repo.path,
    "git",
    ["blame", "--line-porcelain", "-L", `${parsed.line},${parsed.line}`, "--", relativePath],
    { allowExitCodes: [128], maxBuffer: 1024 * 1024, timeoutMs: TOOL_COMMAND_TIMEOUT_MS },
  );
  if (result.status === 128) {
    return { citations: [lineCitation(relativePath, parsed.line)], summary: "Git blame is not available.", title: `Git blame ${relativePath}:${parsed.line}` };
  }

  const lines = result.stdout.split("\n");
  const hash = lines[0]?.split(" ")[0]?.slice(0, 7);
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  const author = field("author") ?? "unknown";
  const summary = field("summary") ?? "Line change";
  const authorTime = field("author-time");
  const date = authorTime ? new Date(Number(authorTime) * 1000).toISOString().slice(0, 10) : "unknown date";

  return {
    citations: [lineCitation(relativePath, parsed.line), ...(hash ? [gitCommitCitation(hash)] : [])],
    summary: `${relativePath}:${parsed.line} was last changed by ${author} on ${date}: ${summary}`,
    title: `Git blame ${repo.name}:${relativePath}:${parsed.line}`,
  };
};

const safeCommandTool = (config: PreparedFirstTraceConfig, args: unknown): InvestigationToolResult => {
  const parsed = SafeCommandArg.parse(args);
  const repo = repoByName(config, parsed.repo);
  const command = parsed.command.trim();
  const commandParts = SAFE_COMMANDS.get(command);
  if (!commandParts) {
    throw new Error(`Command is not allowlisted: ${command}`);
  }

  const [binary, binaryArgs] = commandParts;
  const result = runCommand(repo.path, binary, binaryArgs, {
    allowExitCodes: [1],
    maxBuffer: 2 * 1024 * 1024,
    timeoutMs: SAFE_COMMAND_TIMEOUT_MS,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return {
    citations: [],
    summary: truncate(`exit ${result.status}\n${output}`),
    title: `Safe command ${command}`,
  };
};

export const createInvestigationToolset = (config: PreparedFirstTraceConfig): InvestigationToolset => ({
  async execute(name: InvestigationToolName, args: unknown) {
    if (name === "findFiles") return findFilesTool(config, args);
    if (name === "readFile") return readFileTool(config, args);
    if (name === "searchRepo") return searchRepoTool(config, args);
    if (name === "findReferences") return findReferencesTool(config, args);
    if (name === "gitLog") return gitLogTool(config, args);
    if (name === "gitBlame") return gitBlameTool(config, args);
    if (name === "runSafeCommand") return safeCommandTool(config, args);
    throw new Error(`Unsupported investigation tool: ${name}`);
  },
});
