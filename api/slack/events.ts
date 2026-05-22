import { waitUntil } from "@vercel/functions";
import { SlackWebApiClient } from "../../src/chat/slack/client.js";
import { handleSlackEventsRequest, loadSlackConfigFromPath } from "../../src/chat/slack/events.js";
import { loadLocalEnv } from "../../src/env.js";
import { runHostedWorkerOnceFromEnv } from "../../src/hosted/worker-runtime.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../../src/http/vercel-adapter.js";
import { createJobQueue } from "../../src/worker/queue-factory.js";

loadLocalEnv();

export const config = {
  maxDuration: 60,
};

const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";
const slackClient = () => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  return botToken ? new SlackWebApiClient(botToken) : undefined;
};

export default async function handler(request: VercelRequestLike, response?: VercelResponseLike): Promise<Response | void> {
  const configPath = hostedConfigPath();
  return runVercelHandler(request, response, (webRequest) => handleSlackEventsRequest(webRequest, {
    afterEnqueue: (job) => {
      waitUntil(
        runHostedWorkerOnceFromEnv().catch((error) => {
          console.error(`Hosted Slack background worker failed after enqueueing ${job.id}: ${(error as Error).message}`);
        }),
      );
    },
    config: loadSlackConfigFromPath(configPath),
    queue: () => createJobQueue(hostedQueueProvider()).queue,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    slackClient: slackClient(),
  }));
}
