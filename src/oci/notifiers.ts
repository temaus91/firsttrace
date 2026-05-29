import { SlackWebApiClient } from "../chat/slack/client.js";
import { SlackJobProgressNotifier, SlackJobResultNotifier } from "../chat/slack/notifier.js";
import type { JobProgressNotifier, JobResultNotifier } from "../types.js";
import { createOciSlackNotificationStateFromEnv } from "./slack-state.js";

export const createOciSlackNotifiersFromEnv = async (): Promise<{
  progressNotifier?: JobProgressNotifier;
  resultNotifier?: JobResultNotifier;
}> => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return {};

  const client = new SlackWebApiClient(botToken);
  const state = await createOciSlackNotificationStateFromEnv();
  return {
    progressNotifier: new SlackJobProgressNotifier(client, state),
    resultNotifier: new SlackJobResultNotifier(client, state),
  };
};
