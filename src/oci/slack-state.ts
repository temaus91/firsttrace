import type { InvestigationJob } from "../types.js";
import type { SlackNotificationState } from "../chat/slack/notifier.js";
import { createOciObjectStoreFromEnv } from "./auth.js";
import { objectKeyForSlackMarker, type JsonObjectStore } from "./object-store.js";

type SlackMarker = {
  createdAt: string;
  jobId: string;
  messageTs?: string;
  status: "claimed" | "posted";
};

const marker = (job: InvestigationJob, status: SlackMarker["status"], messageTs?: string): SlackMarker => ({
  createdAt: new Date().toISOString(),
  jobId: job.id,
  messageTs,
  status,
});

export class ObjectStoreSlackNotificationState implements SlackNotificationState {
  constructor(private readonly store: JsonObjectStore) {}

  markFinalReply(job: InvestigationJob): Promise<boolean> {
    return this.store.putJson(objectKeyForSlackMarker(job, "final"), marker(job, "claimed"), { ifNotExists: true });
  }

  markProcessing(job: InvestigationJob): Promise<boolean> {
    return this.store.putJson(objectKeyForSlackMarker(job, "processing"), marker(job, "claimed"), { ifNotExists: true });
  }

  recordFinalReply(job: InvestigationJob, messageTs?: string): Promise<void> {
    return this.record(objectKeyForSlackMarker(job, "final"), job, messageTs);
  }

  recordProcessingReply(job: InvestigationJob, messageTs?: string): Promise<void> {
    return this.record(objectKeyForSlackMarker(job, "processing"), job, messageTs);
  }

  private async record(key: string, job: InvestigationJob, messageTs?: string) {
    await this.store.putJson(key, marker(job, "posted", messageTs));
  }
}

export class InMemorySlackNotificationState implements SlackNotificationState {
  private readonly markers = new Map<string, SlackMarker>();

  async markFinalReply(job: InvestigationJob): Promise<boolean> {
    return this.mark(objectKeyForSlackMarker(job, "final"), job);
  }

  async markProcessing(job: InvestigationJob): Promise<boolean> {
    return this.mark(objectKeyForSlackMarker(job, "processing"), job);
  }

  async recordFinalReply(job: InvestigationJob, messageTs?: string): Promise<void> {
    this.markers.set(objectKeyForSlackMarker(job, "final"), marker(job, "posted", messageTs));
  }

  async recordProcessingReply(job: InvestigationJob, messageTs?: string): Promise<void> {
    this.markers.set(objectKeyForSlackMarker(job, "processing"), marker(job, "posted", messageTs));
  }

  private async mark(key: string, job: InvestigationJob) {
    if (this.markers.has(key)) return false;
    this.markers.set(key, marker(job, "claimed"));
    return true;
  }
}

export const createOciSlackNotificationStateFromEnv = async () =>
  new ObjectStoreSlackNotificationState(await createOciObjectStoreFromEnv());
