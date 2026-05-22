import { createAiProviderFromEnv } from "../ai/provider-factory.js";
import { loadConfig } from "../config.js";
import { executeInvestigation } from "../investigation-runner.js";
import type { AiProvider, JobQueue, WorkerRunResult } from "../types.js";

export type RunWorkerOnceOptions = {
  aiProviderFactory?: () => AiProvider;
  queue: JobQueue;
};

export const runWorkerOnce = async ({
  aiProviderFactory = createAiProviderFromEnv,
  queue,
}: RunWorkerOnceOptions): Promise<WorkerRunResult> => {
  const job = queue.claimNext();
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
      aiProvider: job.aiEnabled ? aiProviderFactory() : undefined,
      config,
      report: job.report,
    });
    const completed = queue.complete(job.id, result);
    return {
      job: completed,
      message: `Processed job ${job.id}.`,
      status: "processed",
    };
  } catch (error) {
    const failed = queue.fail(job.id, (error as Error).message);
    return {
      job: failed,
      message: `Job ${job.id} failed: ${(error as Error).message}`,
      status: "processed",
    };
  }
};
