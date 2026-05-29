import { waitUntil } from "@vercel/functions";
import { handleSlackEventsRequest, loadSlackConfigFromPath } from "../chat/slack/events.js";
import { runHostedWorkerOnceFromEnv } from "../hosted/worker-runtime.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { hostedConfigPath, hostedQueue, slackClient } from "./shared.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(
  request: VercelRequestLike,
  response?: VercelResponseLike,
): Promise<Response | void> {
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
    queue: hostedQueue,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    slackClient: slackClient(),
  }));
}
