import { createInvestigatorProviderFromEnv } from "../investigator/provider-factory.js";
import { loadConfig } from "../config.js";
import { executeInvestigation } from "../investigation-runner.js";
import type { RepoPreparationOptions } from "../repositories/prepare.js";
import type { InvestigatorProvider, JobQueue, JobResultNotifier, WorkerRunResult } from "../types.js";

export type RunWorkerOnceOptions = {
  investigatorProviderFactory?: () => InvestigatorProvider;
  resultNotifier?: JobResultNotifier;
  queue: JobQueue;
  repoPreparation?: RepoPreparationOptions;
};

export const runWorkerOnce = async ({
  investigatorProviderFactory = createInvestigatorProviderFromEnv,
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
    const notifications: string[] = [];
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
      status: "processed",
    };
  }
};
