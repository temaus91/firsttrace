import { loadConfig } from "../../config.js";
import type { Awaitable, FirstTraceConfig, InvestigationJob, JobQueue, SlackChannelConfig } from "../../types.js";
import type { SlackClient } from "./client.js";
import { verifySlackRequestSignature } from "./signature.js";

type SlackEventReceiverOptions = {
  afterEnqueue?: (job: InvestigationJob) => void;
  config: FirstTraceConfig | (() => Awaitable<FirstTraceConfig>);
  nowSeconds?: number;
  queue: JobQueue | (() => Awaitable<JobQueue>);
  signingSecret?: string;
  slackClient?: SlackClient;
};

type SlackUrlVerificationPayload = {
  challenge?: string;
  type: "url_verification";
};

type SlackEventCallbackPayload = {
  event?: SlackEvent;
  team_id?: string;
  type: "event_callback";
};

type SlackEvent = {
  bot_id?: string;
  channel?: string;
  item?: {
    channel?: string;
    ts?: string;
    type?: string;
  };
  reaction?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  ts?: string;
  type?: string;
  user?: string;
};

type NormalizedSlackInvestigation = {
  channel: SlackChannelConfig;
  channelId: string;
  messageId: string;
  reaction?: string;
  report: string;
  threadId?: string;
  trigger: "app_mention" | "message" | "reaction";
  userId?: string;
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

const resolveQueue = async (queue: SlackEventReceiverOptions["queue"]) =>
  typeof queue === "function" ? queue() : queue;

const resolveConfig = async (config: SlackEventReceiverOptions["config"]) =>
  typeof config === "function" ? config() : config;

export const loadSlackConfigFromPath = (configPath: string) => () => loadConfig(configPath);

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parsePayload = (body: string) => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Slack request body must be valid JSON.");
  }
};

const stripSlackMentions = (text: string) => text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();

const reportFromEventText = async (event: SlackEvent, slackClient?: SlackClient) => {
  const fallback = stripSlackMentions(event.text ?? "");
  if (!event.channel || !event.thread_ts || event.thread_ts === event.ts || !slackClient?.fetchThreadMessages) {
    return fallback;
  }

  const threadMessages = await slackClient.fetchThreadMessages({ channel: event.channel, ts: event.thread_ts });
  const threadText = threadMessages.map(stripSlackMentions).filter(Boolean).join("\n");
  return threadText || fallback;
};

const topLevelMessage = (event: SlackEvent) => Boolean(event.ts && (!event.thread_ts || event.thread_ts === event.ts));

const configuredChannel = (config: FirstTraceConfig, channelId: string) =>
  config.chat?.provider === "slack" ? config.chat.channels.find((channel) => channel.id === channelId) : undefined;

const dedupePart = (value: string | undefined) => (value?.trim() ? value.trim().replaceAll(":", "_") : "unknown");

const slackDedupeKey = (payload: SlackEventCallbackPayload, normalized: NormalizedSlackInvestigation) =>
  [
    "slack",
    dedupePart(payload.team_id),
    dedupePart(normalized.trigger),
    dedupePart(normalized.channelId),
    dedupePart(normalized.messageId),
    ...(normalized.trigger === "reaction" ? [dedupePart(normalized.reaction)] : []),
  ].join(":");

const normalizeSlackEvent = async (
  event: SlackEvent,
  config: FirstTraceConfig,
  slackClient?: SlackClient,
): Promise<NormalizedSlackInvestigation | { ignored: true; reason: string }> => {
  if (event.bot_id || event.subtype === "bot_message") return { ignored: true, reason: "Ignored bot message." };

  if (event.type === "app_mention") {
    const channelId = event.channel;
    const messageId = event.ts;
    if (!channelId || !messageId) return { ignored: true, reason: "Slack app mention is missing channel or timestamp." };
    const channel = configuredChannel(config, channelId);
    if (!channel) return { ignored: true, reason: "Slack channel is not configured." };
    if (!channel.triggers.includes("app_mention")) return { ignored: true, reason: "Slack app mention trigger is disabled." };
    const report = await reportFromEventText(event, slackClient);
    if (!report) return { ignored: true, reason: "Slack app mention did not include report text." };

    return {
      channel,
      channelId,
      messageId,
      report,
      threadId: channel.response === "thread" ? event.thread_ts ?? messageId : undefined,
      trigger: "app_mention",
      userId: event.user,
    };
  }

  if (event.type === "message") {
    if (event.subtype) return { ignored: true, reason: `Slack message subtype is ignored: ${event.subtype}.` };
    const channelId = event.channel;
    const messageId = event.ts;
    if (!channelId || !messageId) return { ignored: true, reason: "Slack message is missing channel or timestamp." };
    const channel = configuredChannel(config, channelId);
    if (!channel) return { ignored: true, reason: "Slack channel is not configured." };
    if (!channel.triggers.includes("message")) return { ignored: true, reason: "Slack message trigger is disabled." };
    if (!topLevelMessage(event)) return { ignored: true, reason: "Slack threaded replies are ignored for message trigger." };
    const report = stripSlackMentions(event.text ?? "");
    if (!report) return { ignored: true, reason: "Slack message did not include report text." };

    return {
      channel,
      channelId,
      messageId,
      report,
      threadId: channel.response === "thread" ? messageId : undefined,
      trigger: "message",
      userId: event.user,
    };
  }

  if (event.type === "reaction_added") {
    const channelId = event.item?.channel;
    const messageId = event.item?.ts;
    if (!channelId || !messageId) return { ignored: true, reason: "Slack reaction is missing message reference." };
    const channel = configuredChannel(config, channelId);
    if (!channel) return { ignored: true, reason: "Slack channel is not configured." };
    if (!channel.triggers.includes("reaction")) return { ignored: true, reason: "Slack reaction trigger is disabled." };
    if (!slackClient) return { ignored: true, reason: "Slack client is required to fetch reacted message text." };
    const report = stripSlackMentions((await slackClient.fetchMessageText({ channel: channelId, ts: messageId })) ?? "");
    if (!report) return { ignored: true, reason: "Reacted Slack message did not include report text." };

    return {
      channel,
      channelId,
      messageId,
      reaction: event.reaction,
      report,
      threadId: channel.response === "thread" ? messageId : undefined,
      trigger: "reaction",
      userId: event.user,
    };
  }

  return { ignored: true, reason: `Unsupported Slack event type: ${event.type ?? "<missing>"}.` };
};

export const handleSlackEventsRequest = async (
  request: Request,
  options: SlackEventReceiverOptions,
): Promise<Response> => {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  if (!options.signingSecret?.trim()) {
    return jsonResponse(500, { error: "SLACK_SIGNING_SECRET is required." });
  }

  const bodyText = await request.text();
  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  if (
    !verifySlackRequestSignature({
      body: bodyText,
      nowSeconds: options.nowSeconds,
      signature,
      signingSecret: options.signingSecret,
      timestamp,
    })
  ) {
    return jsonResponse(401, { error: "Invalid Slack signature." });
  }

  try {
    const payload = parsePayload(bodyText);
    if (!isObject(payload) || typeof payload.type !== "string") {
      throw new Error("Slack payload must include a type.");
    }

    if (payload.type === "url_verification") {
      const challenge = (payload as SlackUrlVerificationPayload).challenge;
      if (typeof challenge !== "string") throw new Error("Slack url_verification payload is missing challenge.");
      return new Response(challenge, {
        headers: { "content-type": "text/plain; charset=utf-8" },
        status: 200,
      });
    }

    if (payload.type !== "event_callback") {
      return jsonResponse(200, { ignored: true, reason: `Unsupported Slack payload type: ${payload.type}.` });
    }

    const config = await resolveConfig(options.config);
    const eventPayload = payload as SlackEventCallbackPayload;
    const normalized = await normalizeSlackEvent(
      eventPayload.event ?? {},
      config,
      options.slackClient,
    );
    if ("ignored" in normalized) return jsonResponse(200, normalized);

    const queue = await resolveQueue(options.queue);
    const job = await queue.enqueue({
      aiEnabled: normalized.channel.aiEnabled,
      configPath: config.configPath,
      dedupeKey: slackDedupeKey(eventPayload, normalized),
      report: normalized.report,
      source: {
        channelId: normalized.channelId,
        channelName: normalized.channel.name,
        messageId: normalized.messageId,
        provider: "slack",
        threadId: normalized.threadId,
        userId: normalized.userId,
      },
    });
    try {
      options.afterEnqueue?.(job);
    } catch (error) {
      console.error(`Slack after-enqueue hook failed for job ${job.id}: ${(error as Error).message}`);
    }

    return jsonResponse(200, {
      jobId: job.id,
      ok: true,
      status: job.status,
      trigger: normalized.trigger,
    });
  } catch (error) {
    return jsonResponse(400, { error: (error as Error).message });
  }
};
