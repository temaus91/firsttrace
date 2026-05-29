import type { FirstTraceConfig } from "../types.js";
import { createSlackSignature } from "../chat/slack/signature.js";
import { SlackWebApiClient, type SlackPostMessageResult, type SlackThreadMessage } from "../chat/slack/client.js";
import { runOciQueueRedeliveryProbe, type OciRedeliveryProbeResult } from "../oci/queue-redelivery-probe.js";

type EnvRecord = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type HostedAcceptTrigger = "app_mention" | "message";

export type HostedAcceptStatus = "passed" | "failed";
export type HostedAcceptBackend = "oci" | "vercel-supabase";

export type HostedAcceptCheck = {
  message: string;
  name: string;
  status: HostedAcceptStatus;
};

export type HostedAcceptResult = {
  backend: HostedAcceptBackend;
  baseUrl: string;
  buildRef?: string;
  channelId: string;
  checks: HostedAcceptCheck[];
  finalReplyCount?: number;
  jobId?: string;
  jobStatus?: string;
  passed: boolean;
  processingReplyCount?: number;
  queueProvider?: string;
  redelivery?: OciRedeliveryProbeResult;
  seedMessageTs?: string;
};

export type HostedAcceptSlackClient = {
  fetchThreadMessageDetails(input: { channel: string; ts: string }): Promise<SlackThreadMessage[]>;
  postMessage(input: { channel: string; text: string; threadTs?: string }): Promise<SlackPostMessageResult | void>;
};

export type HostedAcceptOptions = {
  backend: HostedAcceptBackend;
  baseUrl: string;
  channelId: string;
  config: FirstTraceConfig;
  env?: EnvRecord;
  expectedBuildRef: string;
  fetchImpl?: FetchLike;
  gracePeriodMs?: number;
  pollIntervalMs?: number;
  redeliveryProbe?: () => Promise<OciRedeliveryProbeResult>;
  report: string;
  slackClient?: HostedAcceptSlackClient;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_GRACE_PERIOD_MS = 5_000;
const PROCESSING_REPLY = "FirstTrace is investigating this report.";
const FINAL_REPLY_TEXT = "FirstTrace investigation";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const passed = (name: string, message: string): HostedAcceptCheck => ({ message, name, status: "passed" });
const failed = (name: string, message: string): HostedAcceptCheck => ({ message, name, status: "failed" });

const requiredEnv = (env: EnvRecord, names: string[]) => {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}.`);
};

const requiredEnvForBackend = (backend: HostedAcceptBackend, env: EnvRecord) => {
  const common = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "FIRSTTRACE_RECEIVER_TOKEN"];
  requiredEnv(env, backend === "oci" ? [...common, "OCI_COMPARTMENT_ID"] : common);
};

const expectedQueueProvider = (backend: HostedAcceptBackend) => {
  if (backend === "oci") return "oci";
  if (backend === "vercel-supabase") return "supabase";
  const exhaustive: never = backend;
  return exhaustive;
};

const urlFor = (baseUrl: string, pathname: string) => new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

const parseJsonResponse = async <T>(response: Response, action: string): Promise<T> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${action} returned non-JSON status ${response.status}.`);
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : response.statusText;
    throw new Error(`${action} failed with status ${response.status}: ${message}`);
  }
  return body as T;
};

const configuredSlackChannel = (config: FirstTraceConfig, channelId: string): HostedAcceptTrigger => {
  const channel = config.chat?.provider === "slack" ? config.chat.channels.find((item) => item.id === channelId) : undefined;
  if (!channel) throw new Error(`Config does not define Slack channel ${channelId}.`);
  if (channel.triggers.includes("message")) return "message";
  if (channel.triggers.includes("app_mention")) return "app_mention";
  throw new Error(`Slack channel ${channelId} must enable the message or app_mention trigger for live acceptance.`);
};

const createSyntheticSlackBody = ({
  channelId,
  report,
  seedMessageTs,
  teamId,
  trigger,
}: {
  channelId: string;
  report: string;
  seedMessageTs: string;
  teamId: string;
  trigger: HostedAcceptTrigger;
}) => {
  const event =
    trigger === "app_mention"
      ? {
          channel: channelId,
          text: `<@UFIRSTTRACEBOT> ${report}`,
          thread_ts: seedMessageTs,
          ts: seedMessageTs,
          type: "app_mention",
          user: "UFIRSTTRACEACCEPT",
        }
      : {
          channel: channelId,
          text: report,
          ts: seedMessageTs,
          type: "message",
          user: "UFIRSTTRACEACCEPT",
        };

  return JSON.stringify({
    event: {
      ...event,
    },
    team_id: teamId,
    type: "event_callback",
  });
};

const signedSlackHeaders = (signingSecret: string, timestamp: string, body: string) => ({
  "content-type": "application/json",
  "x-slack-request-timestamp": timestamp,
  "x-slack-signature": createSlackSignature(signingSecret, timestamp, body),
});

const postSignedSlackEvent = async ({
  baseUrl,
  body,
  fetchImpl,
  signingSecret,
  timestamp,
}: {
  baseUrl: string;
  body: string;
  fetchImpl: FetchLike;
  signingSecret: string;
  timestamp: string;
}) =>
  parseJsonResponse<{ error?: string; jobId?: string; ok?: boolean; status?: string }>(
    await fetchImpl(urlFor(baseUrl, "/api/slack/events"), {
      body,
      headers: signedSlackHeaders(signingSecret, timestamp, body),
      method: "POST",
    }),
    "Slack event receiver",
  );

const countReplies = (messages: SlackThreadMessage[]) => ({
  final: messages.filter((message) => message.text?.includes(FINAL_REPLY_TEXT)).length,
  processing: messages.filter((message) => message.text === PROCESSING_REPLY).length,
});

const jobStatus = async ({
  baseUrl,
  fetchImpl,
  jobId,
  receiverToken,
}: {
  baseUrl: string;
  fetchImpl: FetchLike;
  jobId: string;
  receiverToken: string;
}) =>
  parseJsonResponse<{ job?: { status?: string }; status?: string }>(
    await fetchImpl(urlFor(baseUrl, `/api/jobs?id=${encodeURIComponent(jobId)}`), {
      headers: { authorization: `Bearer ${receiverToken}` },
      method: "GET",
    }),
    "Job status",
  );

export const runHostedAccept = async ({
  backend,
  baseUrl,
  channelId,
  config,
  env = process.env,
  expectedBuildRef,
  fetchImpl = fetch,
  gracePeriodMs = DEFAULT_GRACE_PERIOD_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  redeliveryProbe = () => runOciQueueRedeliveryProbe({ env }),
  report,
  slackClient,
  sleep: sleepFn = sleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: HostedAcceptOptions): Promise<HostedAcceptResult> => {
  const checks: HostedAcceptCheck[] = [];
  const result: HostedAcceptResult = {
    backend,
    baseUrl,
    channelId,
    checks,
    passed: false,
  };

  try {
    requiredEnvForBackend(backend, env);
    const trigger = configuredSlackChannel(config, channelId);
    checks.push(passed("Configuration", `Using Slack channel ${channelId} with ${trigger} trigger.`));

    const health = await parseJsonResponse<{
      buildRef?: string;
      ok?: boolean;
      queueProvider?: string;
      slackReplyFormat?: string;
    }>(await fetchImpl(urlFor(baseUrl, "/healthz"), { method: "GET" }), "Health check");
    result.buildRef = health.buildRef;
    result.queueProvider = health.queueProvider;
    if (!health.ok) throw new Error("Health endpoint did not return ok=true.");
    const expectedProvider = expectedQueueProvider(backend);
    if (health.queueProvider !== expectedProvider) {
      throw new Error(`Health endpoint reported queueProvider=${health.queueProvider ?? "<missing>"}.`);
    }
    if (health.buildRef !== expectedBuildRef) {
      throw new Error(`Health endpoint reported buildRef=${health.buildRef ?? "<missing>"}, expected ${expectedBuildRef}.`);
    }
    checks.push(passed("Health endpoint", `${backend} deployment reports ${health.buildRef}.`));

    const effectiveSlackClient = slackClient ?? new SlackWebApiClient(env.SLACK_BOT_TOKEN!);
    const seedText = `[FirstTrace acceptance ${new Date().toISOString()}] ${report}`;
    const seed = await effectiveSlackClient.postMessage({ channel: channelId, text: seedText });
    if (!seed?.ts) throw new Error("Slack seed message did not return a timestamp.");
    result.seedMessageTs = seed.ts;
    checks.push(passed("Slack seed message", `Created seed thread ${seed.ts}.`));

    const requestTimestamp = String(Math.floor(Date.now() / 1000));
    const syntheticBody = createSyntheticSlackBody({
      channelId,
      report,
      seedMessageTs: seed.ts,
      teamId: env.SLACK_TEAM_ID?.trim() || "TACCEPTANCE",
      trigger,
    });
    const firstEvent = await postSignedSlackEvent({
      baseUrl,
      body: syntheticBody,
      fetchImpl,
      signingSecret: env.SLACK_SIGNING_SECRET!,
      timestamp: requestTimestamp,
    });
    const secondEvent = await postSignedSlackEvent({
      baseUrl,
      body: syntheticBody,
      fetchImpl,
      signingSecret: env.SLACK_SIGNING_SECRET!,
      timestamp: requestTimestamp,
    });
    if (!firstEvent.ok || !firstEvent.jobId) throw new Error(firstEvent.error ?? "First Slack event did not enqueue a job.");
    if (!secondEvent.ok || !secondEvent.jobId) throw new Error(secondEvent.error ?? "Duplicate Slack event did not return a job.");
    if (secondEvent.jobId !== firstEvent.jobId) {
      throw new Error(`Duplicate Slack event returned job ${secondEvent.jobId}, expected ${firstEvent.jobId}.`);
    }
    result.jobId = firstEvent.jobId;
    checks.push(passed("Slack event dedupe", `Duplicate signed event returned job ${firstEvent.jobId}.`));

    const deadlineMs = Date.now() + timeoutMs;
    let lastStatus = firstEvent.status;
    let lastCounts = { final: 0, processing: 0 };
    while (Date.now() < deadlineMs) {
      const [threadMessages, statusBody] = await Promise.all([
        effectiveSlackClient.fetchThreadMessageDetails({ channel: channelId, ts: seed.ts }),
        jobStatus({
          baseUrl,
          fetchImpl,
          jobId: firstEvent.jobId,
          receiverToken: env.FIRSTTRACE_RECEIVER_TOKEN!,
        }),
      ]);
      lastCounts = countReplies(threadMessages);
      lastStatus = statusBody.job?.status ?? statusBody.status ?? lastStatus;
      result.jobStatus = lastStatus;
      result.processingReplyCount = lastCounts.processing;
      result.finalReplyCount = lastCounts.final;

      if (lastCounts.processing > 1) throw new Error(`Expected one processing reply, found ${lastCounts.processing}.`);
      if (lastCounts.final > 1) throw new Error(`Expected one final reply, found ${lastCounts.final}.`);
      if (lastStatus === "failed") throw new Error(`Job ${firstEvent.jobId} ended as failed.`);
      if (lastCounts.processing === 1 && lastCounts.final === 1 && lastStatus === "succeeded") break;
      await sleepFn(pollIntervalMs);
    }

    if (lastStatus !== "succeeded") throw new Error(`Job ${firstEvent.jobId} ended as ${lastStatus ?? "<unknown>"}.`);
    if (lastCounts.processing !== 1) throw new Error(`Expected one processing reply, found ${lastCounts.processing}.`);
    if (lastCounts.final !== 1) throw new Error(`Expected one final reply, found ${lastCounts.final}.`);
    checks.push(passed("Worker completion", `Job ${firstEvent.jobId} reached succeeded.`));
    checks.push(passed("Slack replies", "Observed exactly one processing reply and one final reply."));

    await sleepFn(gracePeriodMs);
    const graceCounts = countReplies(await effectiveSlackClient.fetchThreadMessageDetails({ channel: channelId, ts: seed.ts }));
    result.processingReplyCount = graceCounts.processing;
    result.finalReplyCount = graceCounts.final;
    if (graceCounts.processing !== 1 || graceCounts.final !== 1) {
      throw new Error(
        `Duplicate reply check failed after grace period: processing=${graceCounts.processing}, final=${graceCounts.final}.`,
      );
    }
    checks.push(passed("Duplicate reply guard", "No duplicate processing or final replies appeared after grace period."));

    if (backend === "oci") {
      result.redelivery = await redeliveryProbe();
      checks.push(
        passed(
          "OCI Queue redelivery",
          `Temporary queue ${result.redelivery.queueName ?? result.redelivery.queueId ?? "<unknown>"} redelivered the abandoned message.`,
        ),
      );
    } else {
      checks.push(passed("Queue redelivery", "Skipped: Vercel/Supabase acceptance uses Supabase job status."));
    }
  } catch (error) {
    checks.push(failed("Acceptance failure", (error as Error).message));
  }

  result.passed = checks.every((item) => item.status === "passed");
  return result;
};
