import type { InvestigationJob, JobQueue } from "../types.js";
import { FileSystemJobQueue } from "./fs-queue.js";
import { createSupabaseJobQueueFromEnv, SUPABASE_JOBS_TABLE } from "./supabase-queue.js";

export type QueueProviderName = "filesystem" | "supabase";

export type QueueSelection = {
  describeJobLocation(job: InvestigationJob): string | undefined;
  provider: QueueProviderName;
  queue: JobQueue;
};

export const queueProviderFrom = (value?: string): QueueProviderName => {
  const provider = (value ?? process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "filesystem").trim();
  if (provider === "filesystem" || provider === "supabase") return provider;
  throw new Error(`Unsupported queue provider: ${provider}. Expected filesystem or supabase.`);
};

export const createJobQueue = (providerValue?: string): QueueSelection => {
  const provider = queueProviderFrom(providerValue);
  if (provider === "supabase") {
    return {
      describeJobLocation: () => `Supabase table: ${SUPABASE_JOBS_TABLE}`,
      provider,
      queue: createSupabaseJobQueueFromEnv(),
    };
  }

  const queue = new FileSystemJobQueue();
  return {
    describeJobLocation: (job) => queue.jobPath(job.id),
    provider,
    queue,
  };
};
