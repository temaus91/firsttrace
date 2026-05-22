import type { InvestigationJob, JobResultNotifier } from "../../types.js";
import { SlackWebApiClient, type SlackClient } from "./client.js";
import { renderSlackInvestigationReply } from "./render.js";

export class SlackJobResultNotifier implements JobResultNotifier {
  constructor(private readonly slackClient: SlackClient) {}

  async notify(job: InvestigationJob): Promise<void> {
    if (job.source?.provider !== "slack" || job.status !== "succeeded" || !job.result) return;
    if (!job.source.channelId) throw new Error(`Slack job ${job.id} is missing source.channelId.`);
    await this.slackClient.postMessage({
      channel: job.source.channelId,
      text: renderSlackInvestigationReply(job.result),
      threadTs: job.source.threadId,
    });
  }
}

export const createJobResultNotifierFromEnv = (): JobResultNotifier | undefined => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return undefined;
  return new SlackJobResultNotifier(new SlackWebApiClient(botToken));
};
