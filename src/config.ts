import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { normalizeAiRequestField } from "./ai/request-options.js";
import { MANAGER_OWNER_TRIAGE_PROFILE } from "./manager-triage.js";
import type {
  AiRequestConfig,
  AiRequestControl,
  ArchiveRepoConfig,
  ChatConfig,
  ChatTrigger,
  FirstTraceConfig,
  GitRepoConfig,
  GitRepoCredentialConfig,
  GitRepoMaterializationConfig,
  InvestigationConfig,
  JsonObject,
  JsonValue,
  OwnerRule,
  RepoConfig,
  SearchConfig,
  SlackDataClassification,
} from "./types.js";

type RawConfig = {
  chat?: unknown;
  docs?: unknown;
  investigation?: unknown;
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

const optionalBoolean = (value: unknown, label: string, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean when provided.`);
  }
  return value;
};

const optionalField = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  return normalizeAiRequestField(value, label);
};

const finiteNumber = (value: unknown, label: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
};

const positiveIntegerValue = (value: unknown, label: string) => {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value as number;
};

const nonNegativeIntegerValue = (value: unknown, label: string) => {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value as number;
};

const topPValue = (value: unknown, label: string) => {
  const parsed = finiteNumber(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`${label} must be between 0 and 1.`);
  return parsed;
};

const stringValue = (value: unknown, label: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const booleanValue = (value: unknown, label: string) => {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) return true;
  if (["boolean", "number", "string"].includes(typeof value)) return typeof value !== "number" || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
};

const jsonObject = (value: unknown, label: string): JsonObject | undefined => {
  if (value === undefined) return undefined;
  const item = asObject(value, label);
  for (const [key, nested] of Object.entries(item)) {
    if (!isJsonValue(nested)) throw new Error(`${label}.${key} must be JSON-compatible.`);
  }
  return item as JsonObject;
};

const requestControlFrom = <T>(
  value: unknown,
  label: string,
  valueFrom: (value: unknown, label: string) => T,
): AiRequestControl<T> | undefined => {
  if (value === undefined) return undefined;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(item, "value") || Object.prototype.hasOwnProperty.call(item, "field")) {
      const control: AiRequestControl<T> = {};
      if (Object.prototype.hasOwnProperty.call(item, "value")) {
        control.value = valueFrom(item.value, `${label}.value`);
      }
      control.field = optionalField(item.field, `${label}.field`);
      return control;
    }
  }
  return { value: valueFrom(value, label) };
};

const aiRequestFrom = (value: unknown): AiRequestConfig | undefined => {
  if (value === undefined) return undefined;
  const item = asObject(value, "investigation.ai.request");
  return {
    extra: jsonObject(item.extra, "investigation.ai.request.extra"),
    outputTokenLimit: requestControlFrom(
      item.output_token_limit,
      "investigation.ai.request.output_token_limit",
      positiveIntegerValue,
    ),
    reasoningEffort: requestControlFrom(
      item.reasoning_effort,
      "investigation.ai.request.reasoning_effort",
      stringValue,
    ),
    stopSequences: requestControlFrom(
      item.stop_sequences,
      "investigation.ai.request.stop_sequences",
      (nested, label) => stringArray(nested, label),
    ),
    store: requestControlFrom(item.store, "investigation.ai.request.store", booleanValue),
    temperature: requestControlFrom(item.temperature, "investigation.ai.request.temperature", finiteNumber),
    topK: requestControlFrom(item.top_k, "investigation.ai.request.top_k", nonNegativeIntegerValue),
    topP: requestControlFrom(item.top_p, "investigation.ai.request.top_p", topPValue),
    verbosity: requestControlFrom(item.verbosity, "investigation.ai.request.verbosity", stringValue),
  };
};

const gitCloneDepthFrom = (value: unknown, label: string): GitRepoConfig["cloneDepth"] => {
  if (value === undefined || value === "full") return "full";
  if (value === "shallow") return 1;
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be "full", "shallow", or a positive integer.`);
  }
  return value as number;
};

const gitCredentialFrom = (value: unknown, label: string): GitRepoCredentialConfig | undefined => {
  if (value === undefined) return undefined;
  const item = asObject(value, label);
  if (item.type === "token") {
    return {
      tokenEnv: optionalString(item.token_env, `${label}.token_env`) ?? "FIRSTTRACE_REPO_TOKEN",
      type: "token",
      usernameEnv: optionalString(item.username_env, `${label}.username_env`),
    };
  }
  if (item.type === "ssh") {
    return {
      commandEnv: optionalString(item.command_env, `${label}.command_env`),
      keyFile: optionalString(item.key_file, `${label}.key_file`),
      keyFileEnv: optionalString(item.key_file_env, `${label}.key_file_env`),
      type: "ssh",
    };
  }
  throw new Error(`${label}.type must be "token" or "ssh" when credential is provided.`);
};

const gitMaterializationFrom = (value: unknown, label: string): GitRepoMaterializationConfig => {
  if (value === undefined) {
    return {
      includeGitHistory: true,
      refresh: "startup",
      scrubRemoteCredentials: true,
    };
  }
  const item = asObject(value, label);
  const refresh = optionalString(item.refresh, `${label}.refresh`) ?? "startup";
  if (refresh !== "startup" && refresh !== "manual") {
    throw new Error(`${label}.refresh must be "startup" or "manual".`);
  }
  return {
    includeGitHistory: optionalBoolean(item.include_git_history, `${label}.include_git_history`, true),
    refresh,
    scrubRemoteCredentials: optionalBoolean(item.scrub_remote_credentials, `${label}.scrub_remote_credentials`, true),
  };
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
    if (provider !== "local" && provider !== "github" && provider !== "git" && provider !== "archive") {
      throw new Error(`repos[${index}].provider must be "local", "github", "git", or "archive".`);
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

    if (provider === "git") {
      if (typeof item.url !== "string" || !item.url.trim()) {
        throw new Error(`repos[${index}].url must be a non-empty string for git repos.`);
      }
      if (typeof item.path !== "string" || !item.path.trim()) {
        throw new Error(`repos[${index}].path must be a non-empty string for git repos.`);
      }
      const repo: GitRepoConfig = {
        cloneDepth: gitCloneDepthFrom(item.clone_depth, `repos[${index}].clone_depth`),
        credential: gitCredentialFrom(item.credential, `repos[${index}].credential`),
        materialization: gitMaterializationFrom(item.materialization, `repos[${index}].materialization`),
        name: item.name,
        path: path.resolve(configDir, item.path),
        provider: "git",
        url: item.url,
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

const DEFAULT_INVESTIGATION: InvestigationConfig = {
  ai: {
    request: {},
  },
  prompt: {
    overlayFiles: [],
    profile: MANAGER_OWNER_TRIAGE_PROFILE,
  },
};

const investigationFrom = (value: unknown, configDir: string): InvestigationConfig => {
  if (value === undefined) return DEFAULT_INVESTIGATION;
  const item = asObject(value, "investigation");
  const aiRaw = item.ai === undefined ? {} : asObject(item.ai, "investigation.ai");
  const promptRaw = item.prompt === undefined ? {} : asObject(item.prompt, "investigation.prompt");
  const profile = optionalString(promptRaw.profile, "investigation.prompt.profile") ?? MANAGER_OWNER_TRIAGE_PROFILE;
  const overlayFiles = stringArray(
    promptRaw.overlay_files,
    "investigation.prompt.overlay_files",
  ).map((file) => path.resolve(configDir, file));

  return {
    ai: {
      request: aiRequestFrom(aiRaw.request),
    },
    prompt: {
      overlayFiles,
      profile,
    },
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
    investigation: investigationFrom(root.investigation, configDir),
    issueExports: stringArray(root.issue_exports, "issue_exports"),
    owners: ownersFrom(root.owners),
    repos: reposFrom(root.repos, configDir),
    search: searchFrom(root.search),
  };
};
