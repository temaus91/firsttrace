import type { InvestigationJob, JobQueue } from "../types.js";
import { FileSystemJobQueue } from "./fs-queue.js";
import { createOciJobQueueFromEnv } from "./oci-queue.js";
import { createSupabaseJobQueueFromEnv, SUPABASE_JOBS_TABLE } from "./supabase-queue.js";

export type QueueProviderName = "filesystem" | "oci" | "supabase";

export type QueueSelection = {
  describeJobLocation(job: InvestigationJob): string | undefined;
  provider: QueueProviderName;
  queue: JobQueue;
};

export const queueProviderFrom = (value?: string): QueueProviderName => {
  const provider = (value ?? process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "filesystem").trim();
  if (provider === "filesystem" || provider === "oci" || provider === "supabase") return provider;
  throw new Error(`Unsupported queue provider: ${provider}. Expected filesystem, oci, or supabase.`);
};

class LazyJobQueue implements JobQueue {
  private queuePromise?: Promise<JobQueue>;

  constructor(private readonly createQueue: () => Promise<JobQueue>) {}

  claimNext() {
    return this.queue().then((queue) => queue.claimNext());
  }

  complete(id: string, result: Parameters<JobQueue["complete"]>[1]) {
    return this.queue().then((queue) => queue.complete(id, result));
  }

  enqueue(input: Parameters<JobQueue["enqueue"]>[0]) {
    return this.queue().then((queue) => queue.enqueue(input));
  }

  fail(id: string, error: string) {
    return this.queue().then((queue) => queue.fail(id, error));
  }

  get(id: string) {
    return this.queue().then((queue) => queue.get(id));
  }

  list() {
    return this.queue().then((queue) => queue.list());
  }

  private queue() {
    this.queuePromise ??= this.createQueue();
    return this.queuePromise;
  }
}

export const createJobQueue = (providerValue?: string): QueueSelection => {
  const provider = queueProviderFrom(providerValue);
  if (provider === "oci") {
    return {
      describeJobLocation: (job) => `OCI Object Storage job marker: jobs/${job.id}.json`,
      provider,
      queue: new LazyJobQueue(createOciJobQueueFromEnv),
    };
  }

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
