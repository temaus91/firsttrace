import { SlackWebApiClient } from "../chat/slack/client.js";
import { loadLocalEnv } from "../env.js";
import { createJobQueue, queueProviderFrom } from "../worker/queue-factory.js";

loadLocalEnv();

export const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
export const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";
export const allowUnauthenticatedReceiver = () => process.env.FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER === "true";
export const buildRef = () => process.env.FIRSTTRACE_BUILD_REF?.trim() || "local";
export const slackReplyFormat = () => process.env.FIRSTTRACE_SLACK_REPLY_FORMAT?.trim() || "compact-v1";

export const slackClient = () => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  return botToken ? new SlackWebApiClient(botToken) : undefined;
};

export const hostedQueue = () => createJobQueue(hostedQueueProvider()).queue;
export const hostedQueueProviderName = () => queueProviderFrom(hostedQueueProvider());

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
