import { loadConfig } from "../config.js";
import { aiModelProviderFromEnv, resolveChatModelFromEnv } from "../ai/provider-factory.js";
import type { FirstTraceConfig, GitHubRepoConfig } from "../types.js";

export type SetupCheckLevel = "FAIL" | "PASS" | "WARN";

export type SetupCheck = {
  level: SetupCheckLevel;
  message: string;
  name: string;
};

export type SetupValidationOptions = {
  aiRequested?: boolean;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  loadConfigFn?: (configPath: string) => FirstTraceConfig;
};

export type SetupValidationResult = {
  checks: SetupCheck[];
  passed: boolean;
};

const check = (level: SetupCheckLevel, name: string, message: string): SetupCheck => ({ level, message, name });

const truthyEnv = (env: NodeJS.ProcessEnv, name: string) => (env[name] ?? "").trim().toLowerCase() === "true";
const hasEnv = (env: NodeJS.ProcessEnv, name: string) => Boolean(env[name]?.trim());

const githubRepos = (config: FirstTraceConfig) =>
  config.repos.filter((repo): repo is GitHubRepoConfig => repo.provider === "github");

const hasGitHubAccess = (env: NodeJS.ProcessEnv) =>
  hasEnv(env, "GITHUB_TOKEN") ||
  (hasEnv(env, "GITHUB_APP_ID") && hasEnv(env, "GITHUB_APP_INSTALLATION_ID") && hasEnv(env, "GITHUB_APP_PRIVATE_KEY"));

const slackAiRequested = (config: FirstTraceConfig, env: NodeJS.ProcessEnv) =>
  truthyEnv(env, "FIRSTTRACE_AI_ENABLED") && Boolean(config.chat?.channels.some((channel) => channel.aiEnabled));

const validateAi = (config: FirstTraceConfig, env: NodeJS.ProcessEnv, aiRequested: boolean) => {
  const checks: SetupCheck[] = [];
  const aiRequired = aiRequested || slackAiRequested(config, env);
  let provider: ReturnType<typeof aiModelProviderFromEnv>;
  try {
    provider = aiModelProviderFromEnv(env);
  } catch (error) {
    checks.push(check(aiRequired ? "FAIL" : "WARN", "AI provider", (error as Error).message));
    return checks;
  }

  if (provider === "openai") {
    if (hasEnv(env, "OPENAI_API_KEY")) {
      checks.push(check("PASS", "AI provider", `OpenAI is configured with ${resolveChatModelFromEnv(env, provider)}.`));
      return checks;
    }
    checks.push(
      check(
        aiRequired ? "FAIL" : "WARN",
        "AI provider",
        "OpenAI AI is unavailable because OPENAI_API_KEY is missing; deterministic investigation still works.",
      ),
    );
    return checks;
  }

  const missing = ["OCI_COMPARTMENT_ID"].filter((name) => !hasEnv(env, name));
  const hasModel = hasEnv(env, "FIRSTTRACE_MODEL_CHAT") || hasEnv(env, "OCI_GENAI_MODEL_ID");
  if (!hasModel) missing.push("FIRSTTRACE_MODEL_CHAT or OCI_GENAI_MODEL_ID");
  if (missing.length) {
    checks.push(
      check(
        aiRequired ? "FAIL" : "WARN",
        "AI provider",
        `OCI GenAI is unavailable because ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing; deterministic investigation still works.`,
      ),
    );
    return checks;
  }

  checks.push(check("PASS", "AI provider", `OCI GenAI is configured with ${resolveChatModelFromEnv(env, provider)}.`));
  return checks;
};

export const validateFirstTraceSetup = ({
  aiRequested = false,
  configPath,
  env = process.env,
  loadConfigFn = loadConfig,
}: SetupValidationOptions): SetupValidationResult => {
  const checks: SetupCheck[] = [];
  let config: FirstTraceConfig;
  try {
    config = loadConfigFn(configPath);
    checks.push(check("PASS", "Config", `Loaded ${config.configPath}.`));
  } catch (error) {
    checks.push(check("FAIL", "Config", (error as Error).message));
    return { checks, passed: false };
  }

  checks.push(check("PASS", "Repositories", `${config.repos.length} repos configured; local repo paths are valid.`));

  const github = githubRepos(config);
  if (github.length > 0) {
    checks.push(
      hasGitHubAccess(env)
        ? check("PASS", "GitHub repositories", `${github.length} GitHub repos can be materialized.`)
        : check(
            "FAIL",
            "GitHub repositories",
            `GitHub repos require either GITHUB_TOKEN or GitHub App env vars: GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY.`,
          ),
    );
  }

  if (config.chat?.provider === "slack") {
    checks.push(
      hasEnv(env, "SLACK_SIGNING_SECRET")
        ? check("PASS", "Slack receiver", "SLACK_SIGNING_SECRET is configured.")
        : check("FAIL", "Slack receiver", "Receiver unavailable: SLACK_SIGNING_SECRET is required to verify Slack Events."),
    );
    checks.push(
      hasEnv(env, "SLACK_BOT_TOKEN")
        ? check("PASS", "Slack replies", "SLACK_BOT_TOKEN is configured.")
        : check("WARN", "Slack replies", "Replies unavailable: SLACK_BOT_TOKEN is required to post Slack thread replies."),
    );
  }

  checks.push(...validateAi(config, env, aiRequested));

  return {
    checks,
    passed: !checks.some((item) => item.level === "FAIL"),
  };
};

export const renderSetupValidation = (result: SetupValidationResult) =>
  [
    `FirstTrace setup validation: ${result.passed ? "PASS" : "FAIL"}`,
    "",
    ...result.checks.map((item) => `${item.level} ${item.name}: ${item.message}`),
  ].join("\n");
