import type { InvestigationJob, JobProgressNotifier, JobResultNotifier } from "../../types.js";
import { SlackWebApiClient, type SlackClient } from "./client.js";
import { renderSlackInvestigationReply } from "./render.js";

export type SlackNotificationState = {
  markFinalReply(job: InvestigationJob): Promise<boolean>;
  markProcessing(job: InvestigationJob): Promise<boolean>;
  recordFinalReply(job: InvestigationJob, messageTs?: string): Promise<void>;
  recordProcessingReply(job: InvestigationJob, messageTs?: string): Promise<void>;
};

const slackThreadTs = (job: InvestigationJob) => job.source?.threadId;

const shouldNotifySlack = (job: InvestigationJob) =>
  job.source?.provider === "slack" && Boolean(job.source.channelId);

export class SlackJobProgressNotifier implements JobProgressNotifier {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly state?: SlackNotificationState,
  ) {}

  async notifyStarted(job: InvestigationJob): Promise<void> {
    if (!shouldNotifySlack(job)) return;
    if (!job.source?.channelId) throw new Error(`Slack job ${job.id} is missing source.channelId.`);
    if (this.state && !(await this.state.markProcessing(job))) return;
    const result = await this.slackClient.postMessage({
      channel: job.source.channelId,
      text: "FirstTrace is investigating this report.",
      threadTs: slackThreadTs(job),
    });
    await this.state?.recordProcessingReply(job, result?.ts);
  }
}

export class SlackJobResultNotifier implements JobResultNotifier {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly state?: SlackNotificationState,
  ) {}

  async notify(job: InvestigationJob): Promise<void> {
    if (job.source?.provider !== "slack" || job.status !== "succeeded" || !job.result) return;
    if (!job.source.channelId) throw new Error(`Slack job ${job.id} is missing source.channelId.`);
    if (this.state && !(await this.state.markFinalReply(job))) return;
    const result = await this.slackClient.postMessage({
      channel: job.source.channelId,
      text: renderSlackInvestigationReply(job.result),
      threadTs: slackThreadTs(job),
    });
    await this.state?.recordFinalReply(job, result?.ts);
  }
}

export const createJobResultNotifierFromEnv = (): JobResultNotifier | undefined => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return undefined;
  return new SlackJobResultNotifier(new SlackWebApiClient(botToken));
};

export const createJobProgressNotifierFromEnv = (): JobProgressNotifier | undefined => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) return undefined;
  return new SlackJobProgressNotifier(new SlackWebApiClient(botToken));
};
