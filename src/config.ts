import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { FirstTraceConfig, OwnerRule, RepoConfig, SearchConfig } from "./types.js";

type RawConfig = {
  docs?: unknown;
  issue_exports?: unknown;
  owners?: unknown;
  repos?: unknown;
  search?: unknown;
};

const DEFAULT_SEARCH: SearchConfig = {
  maxCommits: 8,
  maxEvidencePerFile: 3,
  maxFiles: 10,
};

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const stringArray = (value: unknown, label: string, fallback: string[] = []) => {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
};

const positiveInteger = (value: unknown, label: string, fallback: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
};

const reposFrom = (value: unknown, configDir: string): RepoConfig[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("repos must be a non-empty array.");
  }

  return value.map((repo, index) => {
    const item = asObject(repo, `repos[${index}]`);
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new Error(`repos[${index}].name must be a non-empty string.`);
    }
    if (typeof item.path !== "string" || !item.path.trim()) {
      throw new Error(`repos[${index}].path must be a non-empty string.`);
    }

    const repoPath = path.resolve(configDir, item.path);
    if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
      throw new Error(`repos[${index}].path does not exist or is not a directory: ${repoPath}`);
    }

    return { name: item.name, path: repoPath };
  });
};

const ownersFrom = (value: unknown): OwnerRule[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("owners must be an array.");

  return value.map((owner, index) => {
    const item = asObject(owner, `owners[${index}]`);
    if (typeof item.path !== "string" || !item.path.trim()) {
      throw new Error(`owners[${index}].path must be a non-empty string.`);
    }
    if (typeof item.owner !== "string" || !item.owner.trim()) {
      throw new Error(`owners[${index}].owner must be a non-empty string.`);
    }
    return { owner: item.owner, path: item.path };
  });
};

const searchFrom = (value: unknown): SearchConfig => {
  if (value === undefined) return DEFAULT_SEARCH;
  const item = asObject(value, "search");
  return {
    maxCommits: positiveInteger(item.max_commits, "search.max_commits", DEFAULT_SEARCH.maxCommits),
    maxEvidencePerFile: positiveInteger(
      item.max_evidence_per_file,
      "search.max_evidence_per_file",
      DEFAULT_SEARCH.maxEvidencePerFile,
    ),
    maxFiles: positiveInteger(item.max_files, "search.max_files", DEFAULT_SEARCH.maxFiles),
  };
};

export const loadConfig = (configPath: string): FirstTraceConfig => {
  const resolvedConfigPath = path.resolve(configPath);
  if (!existsSync(resolvedConfigPath)) {
    throw new Error(`Config file not found: ${resolvedConfigPath}`);
  }

  const configDir = path.dirname(resolvedConfigPath);
  const raw = parse(readFileSync(resolvedConfigPath, "utf8")) as RawConfig;
  const root = asObject(raw, "config");

  return {
    configPath: resolvedConfigPath,
    docs: stringArray(root.docs, "docs"),
    issueExports: stringArray(root.issue_exports, "issue_exports"),
    owners: ownersFrom(root.owners),
    repos: reposFrom(root.repos, configDir),
    search: searchFrom(root.search),
  };
};
