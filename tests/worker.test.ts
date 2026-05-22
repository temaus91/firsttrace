import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";
import { renderJobStatus } from "../src/worker/render.js";
import { runWorkerOnce } from "../src/worker/runner.js";
import type { AiProvider, AiReasonerRequest } from "../src/types.js";

const tempQueuePath = (name: string) => {
  const dir = path.join(tmpdir(), `firsttrace-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const fakeAiProvider: AiProvider = {
  name: "fake-ai",
  async reason(request: AiReasonerRequest) {
    const fileEvidence = request.evidence.find((item) => item.path);
    return {
      confidence: 0.8,
      explanation: "Fake provider used the bounded evidence bundle.",
      implementerHints: [
        {
          citations: fileEvidence?.citations.slice(0, 1) ?? [],
          commit: null,
          email: null,
          name: request.likelyOwners[0] ?? null,
          reason: "Owner came from gathered evidence.",
        },
      ],
      likelyComponent: request.likelyComponent,
      likelyFiles: fileEvidence?.path
        ? [
            {
              citations: fileEvidence.citations.slice(0, 1),
              confidence: 0.8,
              path: fileEvidence.path,
              reason: "File came from gathered evidence.",
              repo: fileEvidence.repo ?? "repo",
            },
          ]
        : [],
      likelyOwners: request.likelyOwners,
      missingInfoQuestions: [],
      provider: "fake-ai",
      warnings: [],
    };
  },
};

const failingAiProvider: AiProvider = {
  name: "failing-ai",
  async reason() {
    throw new Error("provider unavailable");
  },
};

describe("worker queue", () => {
  it("enqueues, reads, lists, claims, completes, and fails jobs", () => {
    const queue = new FileSystemJobQueue(tempQueuePath("queue"));
    const first = queue.enqueue({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });
    const second = queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    expect(queue.get(first.id)?.status).toBe("queued");
    expect(queue.list().map((job) => job.id)).toEqual([first.id, second.id]);

    const claimed = queue.claimNext();
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);

    const completed = queue.complete(first.id, {
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

    const failedClaim = queue.claimNext();
    expect(failedClaim?.id).toBe(second.id);
    const failed = queue.fail(second.id, "provider unavailable");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("provider unavailable");
  });

  it("processes a deterministic job to succeeded", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("deterministic"));
    const job = queue.enqueue({
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

  it("processes an AI-enabled job through a provider", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("ai"));
    const job = queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({
      aiProviderFactory: () => fakeAiProvider,
      queue,
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.result?.ai?.provider).toBe("fake-ai");
    expect(renderJobStatus(result.job)).toContain("AI provider: `fake-ai`");
  });

  it("records failed jobs with errors and attempt counts", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("failed"));
    const job = queue.enqueue({
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
    const job = queue.enqueue({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const result = await runWorkerOnce({
      aiProviderFactory: () => failingAiProvider,
      queue,
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("failed");
    expect(result.job?.attempts).toBe(1);
    expect(result.job?.error).toContain("AI reasoning failed with provider failing-ai");
  });

  it("rejects invalid job ids before building a path", () => {
    const queue = new FileSystemJobQueue(tempQueuePath("invalid-id"));

    expect(() => queue.get("../outside")).toThrow("Invalid job id");
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
