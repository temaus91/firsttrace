import { SlackWebApiClient } from "../../src/chat/slack/client.js";
import { handleSlackEventsRequest, loadSlackConfigFromPath } from "../../src/chat/slack/events.js";
import { loadLocalEnv } from "../../src/env.js";
import { createJobQueue } from "../../src/worker/queue-factory.js";

loadLocalEnv();

const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";
const slackClient = () => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  return botToken ? new SlackWebApiClient(botToken) : undefined;
};

export default async function handler(request: Request): Promise<Response> {
  const configPath = hostedConfigPath();
  return handleSlackEventsRequest(request, {
    config: loadSlackConfigFromPath(configPath),
    queue: () => createJobQueue(hostedQueueProvider()).queue,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    slackClient: slackClient(),
  });
}
