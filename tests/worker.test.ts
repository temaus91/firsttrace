import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";
import { renderJobStatus } from "../src/worker/render.js";
import { runWorkerOnce } from "../src/worker/runner.js";
import type { Citation, InvestigationJob, InvestigatorProvider, JobQueue } from "../src/types.js";

const tempQueuePath = (name: string) => {
  const dir = path.join(tmpdir(), `firsttrace-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const citationLabel = (citation: Citation) =>
  citation.path && citation.line ? `${citation.path}:${citation.line}` : citation.label;

const fakeInvestigatorProvider: InvestigatorProvider = {
  name: "fake-investigator",
  async investigate({ result }) {
    const fileEvidence = result.suspiciousFiles[0];
    return {
      confidence: 0.8,
      explanation: "Fake provider used the bounded investigation result.",
      implementerHints: [
        {
          citations: fileEvidence?.citations.map(citationLabel).slice(0, 1) ?? [],
          commit: null,
          email: null,
          name: result.likelyOwners[0] ?? null,
          reason: "Owner came from gathered evidence.",
        },
      ],
      likelyComponent: result.likelyComponent,
      likelyFiles: fileEvidence?.path
        ? [
            {
              citations: fileEvidence.citations.map(citationLabel).slice(0, 1),
              confidence: 0.8,
              path: fileEvidence.path,
              reason: "File came from gathered evidence.",
              repo: fileEvidence.repo,
            },
          ]
        : [],
      likelyOwners: result.likelyOwners,
      missingInfoQuestions: [],
      provider: "fake-investigator",
      warnings: [],
    };
  },
};

const failingInvestigatorProvider: InvestigatorProvider = {
  name: "failing-investigator",
  async investigate() {
    throw new Error("provider unavailable");
  },
};

class AsyncFakeQueue implements JobQueue {
  job?: InvestigationJob;

  constructor(configPath = "firsttrace.config.yaml") {
    this.job = {
      aiEnabled: false,
      attempts: 0,
      configPath,
      createdAt: "2026-05-22T00:00:00.000Z",
      id: "async-fake-job",
      maxAttempts: 1,
      report: "README deployment plan is unclear",
      status: "queued",
      updatedAt: "2026-05-22T00:00:00.000Z",
    };
  }

  async claimNext() {
    if (!this.job || this.job.status !== "queued") return undefined;
    this.job = { ...this.job, attempts: 1, status: "running", updatedAt: "2026-05-22T00:00:01.000Z" };
    return this.job;
  }

  async complete(id: string, result: InvestigationJob["result"]) {
    if (!this.job || this.job.id !== id || !result) throw new Error("missing job");
    this.job = { ...this.job, result, status: "succeeded", updatedAt: "2026-05-22T00:00:02.000Z" };
    return this.job;
  }

  async enqueue() {
    if (!this.job) throw new Error("missing job");
    return this.job;
  }

  async fail(id: string, error: string) {
    if (!this.job || this.job.id !== id) throw new Error("missing job");
    this.job = { ...this.job, error, status: "failed", updatedAt: "2026-05-22T00:00:02.000Z" };
    return this.job;
  }

  async get() {
    return this.job;
  }

  async list() {
    return this.job ? [this.job] : [];
  }
}

describe("worker queue", () => {
  it("enqueues, reads, lists, claims, completes, and fails jobs", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("queue"));
    const first = await queue.enqueue({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });
    const second = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    expect((await queue.get(first.id))?.status).toBe("queued");
    expect((await queue.list()).map((job) => job.id)).toEqual([first.id, second.id]);

    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    const completed = await queue.complete(first.id, {
      classification: "unknown",
      likelyComponent: "README.md",
      likelyOwners: ["@project-docs"],
      relatedCommits: [],
      relatedDocs: [],
      report: "README deployment plan is unclear",
      searchTerms: ["readme"],
      suggestedNextSteps: [],
      suspiciousFiles: [],
      warnings: [],
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.result?.likelyComponent).toBe("README.md");

    const failedClaim = await queue.claimNext();
    expect(failedClaim?.id).toBe(second.id);
    const failed = await queue.fail(second.id, "provider unavailable");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("provider unavailable");
  });

  it("returns an existing filesystem job when enqueue receives the same dedupe key", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("dedupe"));
    const first = await queue.enqueue({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      report: "README deployment plan is unclear",
    });
    const second = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      report: "different retry body should not create a second job",
    });

    expect(second.id).toBe(first.id);
    expect(second.aiEnabled).toBe(false);
    expect(await queue.list()).toHaveLength(1);
  });

  it("processes a deterministic job to succeeded", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("deterministic"));
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({ queue });

    expect(result.status).toBe("processed");
    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.result?.likelyComponent).toBe("README.md");
  });

  it("processes jobs through an async queue implementation", async () => {
    const queue = new AsyncFakeQueue();

    const result = await runWorkerOnce({ queue });

    expect(result.job?.id).toBe("async-fake-job");
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.result?.likelyComponent).toBe("README.md");
  });

  it("processes an AI-enabled job through a provider", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("ai"));
    const job = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({
      investigatorProviderFactory: () => fakeInvestigatorProvider,
      queue,
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.result?.ai?.provider).toBe("fake-investigator");
    expect(renderJobStatus(result.job)).toContain("AI provider: `fake-investigator`");
  });

  it("records failed jobs with errors and attempt counts", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("failed"));
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath: "missing-config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({ queue });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("failed");
    expect(result.job?.attempts).toBe(1);
    expect(result.job?.error).toContain("Config file not found");
  });

  it("fails AI-enabled jobs when the provider fails", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("ai-failed"));
    const job = await queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({
      investigatorProviderFactory: () => failingInvestigatorProvider,
      queue,
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("failed");
    expect(result.job?.attempts).toBe(1);
    expect(result.job?.error).toContain("Investigation failed with provider failing-investigator");
  });

  it("rejects invalid job ids before building a path", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("invalid-id"));

    await expect(queue.get("../outside")).rejects.toThrow("Invalid job id");
  });

  it("returns a clean idle result when no queued jobs exist", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("idle"));

    const result = await runWorkerOnce({ queue });

    expect(result).toEqual({
      message: "No queued jobs found.",
      status: "idle",
    });
  });
});
