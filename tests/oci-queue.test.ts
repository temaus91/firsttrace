import { describe, expect, it } from "vitest";
import { OciJobQueue, type OciQueueClientLike } from "../src/worker/oci-queue.js";
import { InMemoryJsonObjectStore } from "../src/oci/object-store.js";
import { InMemorySlackNotificationState } from "../src/oci/slack-state.js";
import { SlackJobProgressNotifier, SlackJobResultNotifier } from "../src/chat/slack/notifier.js";
import type { InvestigationJob, InvestigationResult } from "../src/types.js";

class FakeOciQueueClient implements OciQueueClientLike {
  deletedReceipts: string[] = [];
  messages: Array<{ content: string; deliveryCount: number; receipt: string }> = [];

  async deleteMessage({ messageReceipt }: { messageReceipt: string }) {
    this.deletedReceipts.push(messageReceipt);
  }

  async getMessages() {
    const message = this.messages.shift();
    return { getMessages: { messages: message ? [message] : [] } };
  }

  async putMessages({ putMessagesDetails }: Parameters<OciQueueClientLike["putMessages"]>[0]) {
    for (const message of putMessagesDetails.messages) {
      this.messages.push({
        content: message.content,
        deliveryCount: 1,
        receipt: `receipt-${this.messages.length + 1}`,
      });
    }
  }
}

const createQueue = () => {
  const client = new FakeOciQueueClient();
  const store = new InMemoryJsonObjectStore();
  return {
    client,
    queue: new OciJobQueue(client, store, { pollTimeoutSeconds: 0, queueId: "queue-id" }),
    store,
  };
};

const resultFor = (report: string): InvestigationResult => ({
  classification: "unknown",
  likelyComponent: "README.md",
  likelyOwners: [],
  relatedCommits: [],
  relatedDocs: [],
  report,
  searchTerms: ["readme"],
  suggestedNextSteps: ["Inspect README.md."],
  suspiciousFiles: [],
  warnings: [],
});

describe("OCI job queue", () => {
  it("enqueues, claims, completes, and deletes the claimed OCI message", async () => {
    const { client, queue } = createQueue();
    const queued = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
      source: { provider: "slack", channelId: "C1", messageId: "1.1", threadId: "1.1" },
    });

    expect(client.messages).toHaveLength(1);
    const claimed = await queue.claimNext();
    expect(claimed).toMatchObject({ id: queued.id, attempts: 1, status: "running" });

    const completed = await queue.complete(queued.id, resultFor(queued.report));
    expect(completed.status).toBe("succeeded");
    expect(client.deletedReceipts).toEqual(["receipt-1"]);
    await expect(queue.get(queued.id)).resolves.toMatchObject({ id: queued.id, status: "succeeded" });
  });

  it("returns the existing job for a repeated dedupe key", async () => {
    const { client, queue } = createQueue();
    const first = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      dedupeKey: "slack:T1:message:C1:1.1",
      report: "first report",
    });
    const second = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      dedupeKey: "slack:T1:message:C1:1.1",
      report: "duplicate report",
    });

    expect(second.id).toBe(first.id);
    expect(client.messages).toHaveLength(1);
    await expect(queue.list()).resolves.toHaveLength(1);
  });

  it("deletes stale OCI messages for terminal jobs instead of reprocessing them", async () => {
    const { client, queue } = createQueue();
    const queued = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "already processed",
    });
    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe(queued.id);
    await queue.complete(queued.id, resultFor(queued.report));

    client.messages.push({
      content: JSON.stringify({ job: queued, version: 1 }),
      deliveryCount: 2,
      receipt: "stale-receipt",
    });

    await expect(queue.claimNext()).resolves.toBeUndefined();
    expect(client.deletedReceipts).toContain("stale-receipt");
    await expect(queue.get(queued.id)).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("OCI Slack notification state", () => {
  it("posts one processing reply and one final reply for duplicate delivery attempts", async () => {
    const state = new InMemorySlackNotificationState();
    const posts: Array<{ text: string; threadTs?: string }> = [];
    const slackClient = {
      async fetchMessageText() {
        return undefined;
      },
      async postMessage(input: { text: string; threadTs?: string }) {
        posts.push(input);
        return { ts: `ts-${posts.length}` };
      },
    };
    const job: InvestigationJob = {
      aiEnabled: true,
      attempts: 1,
      configPath: "firsttrace.config.yaml",
      createdAt: "2026-05-24T00:00:00.000Z",
      dedupeKey: "slack:T1:message:C1:1.1",
      id: "job-1",
      maxAttempts: 1,
      report: "README deployment plan is unclear",
      result: resultFor("README deployment plan is unclear"),
      source: { channelId: "C1", messageId: "1.1", provider: "slack", threadId: "1.1" },
      status: "succeeded",
      updatedAt: "2026-05-24T00:00:00.000Z",
    };

    const progress = new SlackJobProgressNotifier(slackClient, state);
    const final = new SlackJobResultNotifier(slackClient, state);
    await progress.notifyStarted(job);
    await progress.notifyStarted(job);
    await final.notify(job);
    await final.notify(job);

    expect(posts.map((post) => post.text)).toEqual([
      "FirstTrace is investigating this report.",
      expect.stringContaining("*FirstTrace investigation*"),
    ]);
    expect(posts.every((post) => post.threadTs === "1.1")).toBe(true);
  });
});
