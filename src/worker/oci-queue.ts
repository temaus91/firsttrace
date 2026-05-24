import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  EnqueueInvestigationJobInput,
  InvestigationJob,
  InvestigationJobStatus,
  InvestigationResult,
  JobQueue,
} from "../types.js";
import { createOciObjectStoreFromEnv, createOciQueueClientFromEnv, requiredOciQueueIdFromEnv } from "../oci/auth.js";
import { objectKeyForDedupe, objectKeyForJob, type JsonObjectStore } from "../oci/object-store.js";

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_QUEUE_POLL_TIMEOUT_SECONDS = 20;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;

const now = () => new Date().toISOString();

const statusOrder: Record<InvestigationJobStatus, number> = {
  queued: 0,
  running: 1,
  failed: 2,
  succeeded: 3,
};

const TERMINAL_STATUSES = new Set<InvestigationJobStatus>(["failed", "succeeded"]);

type OciQueueMessage = {
  content: string;
  deliveryCount?: number;
  receipt: string;
};

export type OciQueueClientLike = {
  deleteMessage(request: {
    consumerGroupId?: string;
    messageReceipt: string;
    queueId: string;
  }): Promise<unknown>;
  getMessages(request: {
    consumerGroupId?: string;
    limit?: number;
    queueId: string;
    timeoutInSeconds?: number;
    visibilityInSeconds?: number;
  }): Promise<{ getMessages: { messages: OciQueueMessage[] } }>;
  putMessages(request: {
    queueId: string;
    putMessagesDetails: {
      messages: Array<{ content: string }>;
    };
  }): Promise<unknown>;
};

type DedupeMarker = {
  createdAt: string;
  dedupeKey: string;
  jobId: string;
};

type OciJobEnvelope = {
  job: InvestigationJob;
  version: 1;
};

export class OciJobQueue implements JobQueue {
  private readonly receipts = new Map<string, string>();

  constructor(
    private readonly queueClient: OciQueueClientLike,
    private readonly objectStore: JsonObjectStore,
    private readonly options: {
      consumerGroupId?: string;
      pollTimeoutSeconds?: number;
      queueId: string;
      visibilityTimeoutSeconds?: number;
    },
  ) {}

  async claimNext(): Promise<InvestigationJob | undefined> {
    const response = await this.queueClient.getMessages({
      consumerGroupId: this.options.consumerGroupId,
      limit: 1,
      queueId: this.options.queueId,
      timeoutInSeconds: this.options.pollTimeoutSeconds ?? DEFAULT_QUEUE_POLL_TIMEOUT_SECONDS,
      visibilityInSeconds: this.options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    });
    const message = response.getMessages.messages[0];
    if (!message) return undefined;

    const messageJob = this.parseMessage(message);
    const job = (await this.get(messageJob.id)) ?? messageJob;
    if (TERMINAL_STATUSES.has(job.status)) {
      await this.deleteMessageReceipt(message.receipt);
      return undefined;
    }

    const updated = {
      ...job,
      attempts: Math.max(job.attempts + 1, message.deliveryCount ?? job.attempts + 1),
      error: undefined,
      startedAt: now(),
      status: "running" as const,
      updatedAt: now(),
    };
    this.receipts.set(job.id, message.receipt);
    await this.objectStore.putJson(objectKeyForJob(job.id), updated);
    return updated;
  }

  async complete(id: string, result: InvestigationResult): Promise<InvestigationJob> {
    const job = await this.requireJob(id);
    const updated = {
      ...job,
      error: undefined,
      finishedAt: now(),
      result,
      status: "succeeded" as const,
      updatedAt: now(),
    };
    await this.objectStore.putJson(objectKeyForJob(id), updated);
    await this.deleteClaimedMessage(id);
    return updated;
  }

  async enqueue(input: EnqueueInvestigationJobInput): Promise<InvestigationJob> {
    if (input.dedupeKey) {
      const existing = await this.jobFromDedupeKey(input.dedupeKey);
      if (existing) return existing;
    }

    const timestamp = now();
    const job: InvestigationJob = {
      aiEnabled: input.aiEnabled,
      attempts: 0,
      configPath: path.resolve(input.configPath),
      createdAt: timestamp,
      dedupeKey: input.dedupeKey,
      id: randomUUID(),
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      report: input.report,
      source: input.source,
      status: "queued",
      updatedAt: timestamp,
    };

    if (input.dedupeKey) {
      const created = await this.objectStore.putJson<DedupeMarker>(
        objectKeyForDedupe(input.dedupeKey),
        {
          createdAt: timestamp,
          dedupeKey: input.dedupeKey,
          jobId: job.id,
        },
        { ifNotExists: true },
      );
      if (!created) {
        const existing = await this.jobFromDedupeKey(input.dedupeKey);
        if (existing) return existing;
      }
    }

    await this.objectStore.putJson(objectKeyForJob(job.id), job, { ifNotExists: true });
    await this.queueClient.putMessages({
      queueId: this.options.queueId,
      putMessagesDetails: {
        messages: [
          {
            content: JSON.stringify({ job, version: 1 } satisfies OciJobEnvelope),
          },
        ],
      },
    });
    return job;
  }

  async fail(id: string, error: string): Promise<InvestigationJob> {
    const job = await this.requireJob(id);
    const updated = {
      ...job,
      error,
      finishedAt: now(),
      status: "failed" as const,
      updatedAt: now(),
    };
    await this.objectStore.putJson(objectKeyForJob(id), updated);
    await this.deleteClaimedMessage(id);
    return updated;
  }

  async get(id: string): Promise<InvestigationJob | undefined> {
    return this.objectStore.getJson<InvestigationJob>(objectKeyForJob(id));
  }

  async list(): Promise<InvestigationJob[]> {
    const jobs = await this.objectStore.listJson<InvestigationJob>("jobs/");
    return jobs.sort(
      (a, b) =>
        statusOrder[a.status] - statusOrder[b.status] ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }

  private async deleteClaimedMessage(id: string) {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    await this.deleteMessageReceipt(receipt);
    this.receipts.delete(id);
  }

  private async deleteMessageReceipt(receipt: string) {
    await this.queueClient.deleteMessage({
      consumerGroupId: this.options.consumerGroupId,
      messageReceipt: receipt,
      queueId: this.options.queueId,
    });
  }

  private async jobFromDedupeKey(dedupeKey: string) {
    const marker = await this.objectStore.getJson<DedupeMarker>(objectKeyForDedupe(dedupeKey));
    return marker ? this.get(marker.jobId) : undefined;
  }

  private parseMessage(message: OciQueueMessage) {
    const parsed = JSON.parse(message.content) as Partial<OciJobEnvelope> | InvestigationJob;
    const job = "job" in parsed ? parsed.job : (parsed as InvestigationJob);
    if (!job || typeof job.id !== "string") {
      throw new Error("OCI Queue message did not contain a FirstTrace job.");
    }
    return job as InvestigationJob;
  }

  private async requireJob(id: string) {
    const job = await this.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }
}

export const createOciJobQueueFromEnv = async () =>
  new OciJobQueue(await createOciQueueClientFromEnv(), await createOciObjectStoreFromEnv(), {
    consumerGroupId: process.env.OCI_QUEUE_CONSUMER_GROUP_ID?.trim() || undefined,
    pollTimeoutSeconds: process.env.OCI_QUEUE_POLL_TIMEOUT_SECONDS
      ? Number.parseInt(process.env.OCI_QUEUE_POLL_TIMEOUT_SECONDS, 10)
      : undefined,
    queueId: requiredOciQueueIdFromEnv(),
    visibilityTimeoutSeconds: process.env.OCI_QUEUE_VISIBILITY_TIMEOUT_SECONDS
      ? Number.parseInt(process.env.OCI_QUEUE_VISIBILITY_TIMEOUT_SECONDS, 10)
      : undefined,
  });
