import { createInvestigatorProviderFromEnv } from "../investigator/provider-factory.js";
import { loadConfig } from "../config.js";
import { executeInvestigation } from "../investigation-runner.js";
import type { RepoPreparationOptions } from "../repositories/prepare.js";
import type { InvestigatorProvider, JobProgressNotifier, JobQueue, JobResultNotifier, WorkerRunResult } from "../types.js";

export type RunWorkerOnceOptions = {
  investigatorProviderFactory?: () => InvestigatorProvider;
  progressNotifier?: JobProgressNotifier;
  resultNotifier?: JobResultNotifier;
  queue: JobQueue;
  repoPreparation?: RepoPreparationOptions;
};

export const runWorkerOnce = async ({
  investigatorProviderFactory = createInvestigatorProviderFromEnv,
  progressNotifier,
  resultNotifier,
  queue,
  repoPreparation,
}: RunWorkerOnceOptions): Promise<WorkerRunResult> => {
  const job = await queue.claimNext();
  if (!job) {
    return {
      message: "No queued jobs found.",
      status: "idle",
    };
  }

  const notifications: string[] = [];
  if (progressNotifier) {
    try {
      await progressNotifier.notifyStarted(job);
      notifications.push(`Progress notification processed for job ${job.id}.`);
    } catch (notificationError) {
      notifications.push(`Progress notification failed for job ${job.id}: ${(notificationError as Error).message}`);
    }
  }

  try {
    const config = loadConfig(job.configPath);
    const result = await executeInvestigation({
      aiFailureMode: "throw",
      config,
      investigatorProvider: job.aiEnabled ? investigatorProviderFactory() : undefined,
      report: job.report,
      repoPreparation,
    });
    const completed = await queue.complete(job.id, result);
    if (resultNotifier) {
      try {
        await resultNotifier.notify(completed);
        notifications.push(`Result notification processed for job ${job.id}.`);
      } catch (notificationError) {
        notifications.push(`Result notification failed for job ${job.id}: ${(notificationError as Error).message}`);
      }
    }
    return {
      job: completed,
      message: `Processed job ${job.id}.`,
      notifications,
      status: "processed",
    };
  } catch (error) {
    const failed = await queue.fail(job.id, (error as Error).message);
    return {
      job: failed,
      message: `Job ${job.id} failed: ${(error as Error).message}`,
      notifications,
      status: "processed",
    };
  }
};
