import { createAiProviderFromEnv } from "../ai/provider-factory.js";
import { handleSlackEventsRequest } from "../chat/slack/events.js";
import { SlackJobResultNotifier } from "../chat/slack/notifier.js";
import { createSlackSignature } from "../chat/slack/signature.js";
import { createJobQueue, type QueueProviderName } from "../worker/queue-factory.js";
import { FileSystemJobQueue } from "../worker/fs-queue.js";
import { runWorkerOnce } from "../worker/runner.js";
import type {
  AiProvider,
  ChatTrigger,
  FirstTraceConfig,
  HostedVerifyCheck,
  HostedVerifyResult,
  EnqueueInvestigationJobInput,
  InvestigationJob,
  InvestigationResult,
  JobQueue,
  SlackChannelConfig,
} from "../types.js";
import { SlackWebApiClient, type SlackClient, type SlackPostMessageInput } from "../chat/slack/client.js";

const VERIFY_SIGNING_SECRET = "firsttrace-hosted-verify-signing-secret";
const VERIFY_USER_ID = "UFIRSTTRACEVERIFY";
const VERIFY_BOT_ID = "UFIRSTTRACEBOT";
const FILESYSTEM_VERIFY_QUEUE_ROOT = ".firsttrace/hosted-verify/jobs";

type EnvRecord = Record<string, string | undefined>;

export type HostedVerifyOptions = {
  aiEnabled: boolean;
  aiProviderFactory?: () => AiProvider;
  channelId?: string;
  config: FirstTraceConfig;
  env?: EnvRecord;
  liveSlackPost: boolean;
  queue: JobQueue;
  queueProvider: QueueProviderName;
  report: string;
};

class CaptureSlackClient implements SlackClient {
  readonly posts: SlackPostMessageInput[] = [];

  constructor(private readonly report: string) {}

  async fetchMessageText() {
    return this.report;
  }

  async fetchThreadMessages() {
    return [this.report];
  }

  async postMessage(input: SlackPostMessageInput) {
    this.posts.push(input);
  }
}

class FailingJobQueue implements JobQueue {
  constructor(private readonly message: string) {}

  async claimNext(): Promise<never> {
    throw new Error(this.message);
  }

  async complete(_id: string, _result: InvestigationResult): Promise<never> {
    throw new Error(this.message);
  }

  async enqueue(_input: EnqueueInvestigationJobInput): Promise<never> {
    throw new Error(this.message);
  }

  async fail(_id: string, _error: string): Promise<never> {
    throw new Error(this.message);
  }

  async get(_id: string): Promise<never> {
    throw new Error(this.message);
  }

  async list(): Promise<never> {
    throw new Error(this.message);
  }
}

const check = (
  status: HostedVerifyCheck["status"],
  name: string,
  message: string,
  required = true,
): HostedVerifyCheck => ({
  message,
  name,
  required,
  status,
});

const missingEnv = (env: EnvRecord, names: string[]) => names.filter((name) => !env[name]?.trim());

const requiredChecksPassed = (checks: HostedVerifyCheck[]) =>
  checks.every((item) => !item.required || item.status === "passed");

const selectChannel = (config: FirstTraceConfig, channelId?: string) => {
  const channels = config.chat?.provider === "slack" ? config.chat.channels : [];
  if (!channels.length) {
    throw new Error("Config must define at least one Slack channel under chat.channels.");
  }

  const channel = channelId ? channels.find((item) => item.id === channelId) : channels[0];
  if (!channel) {
    throw new Error(`Configured Slack channel not found: ${channelId}`);
  }
  return channel;
};

const syntheticTriggerFor = (channel: SlackChannelConfig): ChatTrigger => {
  if (channel.triggers.includes("message")) return "message";
  if (channel.triggers.includes("app_mention")) return "app_mention";
  if (channel.triggers.includes("reaction")) return "reaction";
  throw new Error(`Slack channel ${channel.id} must define at least one supported trigger.`);
};

const configWithSyntheticChannel = (
  config: FirstTraceConfig,
  selectedChannel: SlackChannelConfig,
  aiEnabled: boolean,
): FirstTraceConfig => ({
  ...config,
  chat: config.chat
    ? {
        ...config.chat,
        channels: config.chat.channels.map((channel) =>
          channel.id === selectedChannel.id ? { ...channel, aiEnabled } : channel,
        ),
      }
    : config.chat,
});

const syntheticSlackPayload = (channel: SlackChannelConfig, trigger: ChatTrigger, report: string, messageTs: string) => {
  if (trigger === "app_mention") {
    return {
      event: {
        channel: channel.id,
        text: `<@${VERIFY_BOT_ID}> ${report}`,
        ts: messageTs,
        type: "app_mention",
        user: VERIFY_USER_ID,
      },
      type: "event_callback",
    };
  }

  if (trigger === "reaction") {
    return {
      event: {
        item: { channel: channel.id, ts: messageTs, type: "message" },
        reaction: "firsttrace",
        type: "reaction_added",
        user: VERIFY_USER_ID,
      },
      type: "event_callback",
    };
  }

  return {
    event: {
      channel: channel.id,
      text: report,
      ts: messageTs,
      type: "message",
      user: VERIFY_USER_ID,
    },
    type: "event_callback",
  };
};

const signedSlackRequest = (payload: unknown, timestamp: string) => {
  const body = JSON.stringify(payload);
  return new Request("https://firsttrace.local/api/slack/events", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": createSlackSignature(VERIFY_SIGNING_SECRET, timestamp, body),
    },
    method: "POST",
  });
};

const externalReadinessChecks = (
  env: EnvRecord,
  queueProvider: QueueProviderName,
  liveSlackPost: boolean,
): HostedVerifyCheck[] => {
  const slackMissing = missingEnv(env, ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN"]);
  const githubMissing = missingEnv(env, ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"]);
  const supabaseMissing = missingEnv(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);

  return [
    slackMissing.length
      ? check(
          liveSlackPost ? "failed" : "blocked",
          "Slack live environment",
          `Missing ${slackMissing.join(", ")}.`,
          liveSlackPost,
        )
      : check("passed", "Slack live environment", "Slack live environment variables are present.", false),
    githubMissing.length
      ? check("blocked", "GitHub App live environment", `Missing ${githubMissing.join(", ")}.`, false)
      : check("passed", "GitHub App live environment", "GitHub App environment variables are present.", false),
    queueProvider === "supabase"
      ? supabaseMissing.length
        ? check("failed", "Supabase live environment", `Missing ${supabaseMissing.join(", ")}.`)
        : check("passed", "Supabase live environment", "Supabase environment variables are present.")
      : check("skipped", "Supabase live queue", "Not requested; verification is using filesystem queue.", false),
    liveSlackPost
      ? env.SLACK_BOT_TOKEN?.trim()
        ? check("passed", "Slack live post mode", "Worker result will be posted through Slack Web API.", false)
        : check("blocked", "Slack live post mode", "SLACK_BOT_TOKEN is missing.", false)
      : check("skipped", "Slack live post mode", "Using fake Slack notifier; no Slack message will be posted.", false),
  ];
};

const syntheticTimestamps = () => {
  const nowMs = Date.now();
  const requestTimestamp = String(Math.floor(nowMs / 1000));
  const messageTimestamp = `${requestTimestamp}.${String(nowMs % 1_000_000).padStart(6, "0")}`;
  return { messageTimestamp, requestTimestamp };
};

export const createHostedVerifyQueue = (provider: QueueProviderName) => {
  if (provider === "filesystem") return new FileSystemJobQueue(FILESYSTEM_VERIFY_QUEUE_ROOT);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return new FailingJobQueue("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the Supabase queue.");
  }
  return createJobQueue(provider).queue;
};

export const runHostedVerify = async ({
  aiEnabled,
  aiProviderFactory = createAiProviderFromEnv,
  channelId,
  config,
  env = process.env,
  liveSlackPost,
  queue,
  queueProvider,
  report,
}: HostedVerifyOptions): Promise<HostedVerifyResult> => {
  const checks: HostedVerifyCheck[] = [];
  checks.push(...externalReadinessChecks(env, queueProvider, liveSlackPost));

  let channel: SlackChannelConfig;
  try {
    channel = selectChannel(config, channelId);
    checks.push(check("passed", "Slack channel config", `Using Slack channel ${channel.id}.`));
  } catch (error) {
    checks.push(check("failed", "Slack channel config", (error as Error).message));
    return {
      checks,
      configPath: config.configPath,
      passed: false,
      queueProvider,
    };
  }

  if (liveSlackPost && !env.SLACK_BOT_TOKEN?.trim()) {
    checks.push(check("failed", "Slack live post token", "SLACK_BOT_TOKEN is required with --live-slack-post."));
    return {
      channelId: channel.id,
      channelName: channel.name,
      checks,
      configPath: config.configPath,
      passed: false,
      queueProvider,
    };
  }

  const captureSlackClient = new CaptureSlackClient(report);
  const effectiveConfig = configWithSyntheticChannel(config, channel, aiEnabled);
  const trigger = syntheticTriggerFor(channel);
  const { messageTimestamp, requestTimestamp } = syntheticTimestamps();
  const response = await handleSlackEventsRequest(
    signedSlackRequest(syntheticSlackPayload(channel, trigger, report, messageTimestamp), requestTimestamp),
    {
      config: effectiveConfig,
      nowSeconds: Number(requestTimestamp),
      queue,
      signingSecret: VERIFY_SIGNING_SECRET,
      slackClient: captureSlackClient,
    },
  );
  const responseBody = (await response.json()) as { error?: string; jobId?: string; ok?: boolean; status?: string };

  if (response.status !== 200 || !responseBody.ok || !responseBody.jobId) {
    checks.push(
      check(
        "failed",
        "Synthetic Slack receiver",
        responseBody.error ?? `Slack receiver returned status ${response.status}.`,
      ),
    );
    return {
      channelId: channel.id,
      channelName: channel.name,
      checks,
      configPath: config.configPath,
      passed: false,
      queueProvider,
    };
  }
  checks.push(check("passed", "Synthetic Slack receiver", `Enqueued job ${responseBody.jobId}.`));

  const notifier = new SlackJobResultNotifier(
    liveSlackPost ? new SlackWebApiClient(env.SLACK_BOT_TOKEN as string) : captureSlackClient,
  );
  const workerResult = await runWorkerOnce({
    aiProviderFactory,
    queue,
    resultNotifier: notifier,
  });

  if (workerResult.status !== "processed" || !workerResult.job) {
    checks.push(check("failed", "Worker processing", workerResult.message));
    return {
      channelId: channel.id,
      channelName: channel.name,
      checks,
      configPath: config.configPath,
      passed: false,
      queueProvider,
    };
  }

  if (workerResult.job.id !== responseBody.jobId) {
    checks.push(
      check(
        "failed",
        "Worker processing",
        `Worker processed ${workerResult.job.id}, expected ${responseBody.jobId}.`,
      ),
    );
  } else if (workerResult.job.status !== "succeeded") {
    checks.push(
      check("failed", "Worker processing", workerResult.job.error ?? `Job ended as ${workerResult.job.status}.`),
    );
  } else {
    checks.push(
      check("passed", "Worker processing", `Job succeeded with component ${workerResult.job.result?.likelyComponent}.`),
    );
  }

  const notificationFailure = workerResult.notifications?.find((notification) => notification.includes("failed"));
  if (notificationFailure) {
    checks.push(check("failed", "Slack result notification", notificationFailure));
  } else if (liveSlackPost) {
    checks.push(check("passed", "Slack result notification", "Slack live post was attempted by worker notifier."));
  } else {
    checks.push(
      captureSlackClient.posts.length
        ? check("passed", "Slack result notification", "Fake Slack notifier captured worker reply.")
        : check("failed", "Slack result notification", "Fake Slack notifier did not capture a reply."),
    );
  }

  return {
    channelId: channel.id,
    channelName: channel.name,
    checks,
    configPath: config.configPath,
    job: workerResult.job,
    passed: requiredChecksPassed(checks),
    queueProvider,
    slackReplyText: captureSlackClient.posts[0]?.text,
  };
};
