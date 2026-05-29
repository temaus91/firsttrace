import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type {
  ArchiveRepoConfig,
  ChatConfig,
  ChatTrigger,
  FirstTraceConfig,
  OwnerRule,
  RepoConfig,
  SearchConfig,
  SlackDataClassification,
} from "./types.js";

type RawConfig = {
  chat?: unknown;
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

const optionalString = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string when provided.`);
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

    const provider = typeof item.provider === "string" ? item.provider : item.path !== undefined ? "local" : undefined;
    if (provider !== "local" && provider !== "github" && provider !== "archive") {
      throw new Error(`repos[${index}].provider must be "local", "github", or "archive".`);
    }

    if (provider === "local") {
      if (typeof item.path !== "string" || !item.path.trim()) {
        throw new Error(`repos[${index}].path must be a non-empty string.`);
      }

      const repoPath = path.resolve(configDir, item.path);
      if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
        throw new Error(
          `repos[${index}].path for local repo "${item.name}" does not exist or is not a directory: ${repoPath}`,
        );
      }

      return { name: item.name, path: repoPath, provider: "local" };
    }

    if (provider === "archive") {
      if (typeof item.path !== "string" || !item.path.trim()) {
        throw new Error(`repos[${index}].path must be a non-empty string for archive repos.`);
      }
      if (typeof item.archive_command !== "string" || !item.archive_command.trim()) {
        throw new Error(`repos[${index}].archive_command must be a non-empty string for archive repos.`);
      }
      const repo: ArchiveRepoConfig = {
        archiveCommand: item.archive_command,
        commandCwd: configDir,
        name: item.name,
        path: path.resolve(configDir, item.path),
        provider: "archive",
      };
      if (item.ref !== undefined) {
        repo.ref = optionalString(item.ref, `repos[${index}].ref`);
      }
      return repo;
    }

    if (typeof item.owner !== "string" || !item.owner.trim()) {
      throw new Error(`repos[${index}].owner must be a non-empty string for github repos.`);
    }
    if (typeof item.repo !== "string" || !item.repo.trim()) {
      throw new Error(`repos[${index}].repo must be a non-empty string for github repos.`);
    }
    if (item.default_branch !== undefined && (typeof item.default_branch !== "string" || !item.default_branch.trim())) {
      throw new Error(`repos[${index}].default_branch must be a non-empty string when provided.`);
    }

    return {
      defaultBranch: item.default_branch ? item.default_branch : "main",
      name: item.name,
      owner: item.owner,
      provider: "github",
      repo: item.repo,
    };
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

const CHAT_TRIGGERS = new Set<ChatTrigger>(["app_mention", "message", "reaction"]);
const SLACK_DATA_CLASSIFICATIONS = new Set<SlackDataClassification>(["confidential", "internal", "restricted"]);

const chatTriggersFrom = (value: unknown, label: string): ChatTrigger[] => {
  const triggers = stringArray(value, label, ["app_mention"]);
  const invalid = triggers.find((trigger) => !CHAT_TRIGGERS.has(trigger as ChatTrigger));
  if (invalid) {
    throw new Error(`${label} contains unsupported trigger: ${invalid}.`);
  }
  return triggers as ChatTrigger[];
};

const slackDataClassificationFrom = (value: unknown, label: string): SlackDataClassification => {
  if (value === undefined) return "internal";
  if (typeof value !== "string" || !SLACK_DATA_CLASSIFICATIONS.has(value as SlackDataClassification)) {
    throw new Error(`${label} must be internal, confidential, or restricted.`);
  }
  return value as SlackDataClassification;
};

const chatFrom = (value: unknown): ChatConfig | undefined => {
  if (value === undefined) return undefined;
  const item = asObject(value, "chat");
  const provider = item.provider ?? "slack";
  if (provider !== "slack") {
    throw new Error("chat.provider must be slack.");
  }
  if (!Array.isArray(item.channels)) {
    throw new Error("chat.channels must be an array.");
  }

  return {
    provider: "slack",
    channels: item.channels.map((channel, index) => {
      const channelItem = asObject(channel, `chat.channels[${index}]`);
      if (typeof channelItem.id !== "string" || !channelItem.id.trim()) {
        throw new Error(`chat.channels[${index}].id must be a non-empty string.`);
      }
      const response = channelItem.response ?? "thread";
      if (response !== "thread" && response !== "channel") {
        throw new Error(`chat.channels[${index}].response must be "thread" or "channel".`);
      }
      if (channelItem.ai_enabled !== undefined && typeof channelItem.ai_enabled !== "boolean") {
        throw new Error(`chat.channels[${index}].ai_enabled must be a boolean when provided.`);
      }
      if (channelItem.include_thread_context !== undefined && typeof channelItem.include_thread_context !== "boolean") {
        throw new Error(`chat.channels[${index}].include_thread_context must be a boolean when provided.`);
      }

      return {
        aiEnabled: channelItem.ai_enabled ?? false,
        dataClassification: slackDataClassificationFrom(
          channelItem.data_classification,
          `chat.channels[${index}].data_classification`,
        ),
        id: channelItem.id,
        includeThreadContext: channelItem.include_thread_context ?? false,
        name: optionalString(channelItem.name, `chat.channels[${index}].name`),
        repositories: stringArray(channelItem.repositories, `chat.channels[${index}].repositories`),
        response,
        triggers: chatTriggersFrom(channelItem.triggers, `chat.channels[${index}].triggers`),
      };
    }),
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
    chat: chatFrom(root.chat),
    configPath: resolvedConfigPath,
    docs: stringArray(root.docs, "docs"),
    issueExports: stringArray(root.issue_exports, "issue_exports"),
    owners: ownersFrom(root.owners),
    repos: reposFrom(root.repos, configDir),
    search: searchFrom(root.search),
  };
};
