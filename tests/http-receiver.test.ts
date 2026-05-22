import { describe, expect, it } from "vitest";
import { handleInvestigationRequest, handleJobStatusRequest } from "../src/http/receiver.js";
import type { EnqueueInvestigationJobInput, InvestigationJob, InvestigationResult, JobQueue } from "../src/types.js";

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

class FakeQueue implements JobQueue {
  jobs = new Map<string, InvestigationJob>();

  async claimNext() {
    return [...this.jobs.values()].find((job) => job.status === "queued");
  }

  async complete(id: string, result: InvestigationResult) {
    const job = this.require(id);
    const updated = { ...job, result, status: "succeeded" as const, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }

  async enqueue(input: EnqueueInvestigationJobInput) {
    const timestamp = "2026-05-22T00:00:00.000Z";
    const job: InvestigationJob = {
      aiEnabled: input.aiEnabled,
      attempts: 0,
      configPath: input.configPath,
      createdAt: timestamp,
      id: `job-${this.jobs.size + 1}`,
      maxAttempts: input.maxAttempts ?? 1,
      report: input.report,
      source: input.source,
      status: "queued",
      updatedAt: timestamp,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async fail(id: string, error: string) {
    const job = this.require(id);
    const updated = { ...job, error, status: "failed" as const, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }

  async get(id: string) {
    return this.jobs.get(id);
  }

  async list() {
    return [...this.jobs.values()];
  }

  private require(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`missing ${id}`);
    return job;
  }
}

const post = (body: unknown, token?: string) =>
  new Request("https://firsttrace.example.com/api/investigations", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    method: "POST",
  });

describe("HTTP receiver", () => {
  it("enqueues a valid investigation request", async () => {
    const queue = new FakeQueue();
    const response = await handleInvestigationRequest(
      post({
        aiEnabled: true,
        report: "README deployment plan is unclear",
        source: { provider: "test-http", userId: "U0123456789" },
      }),
      { configPath: "firsttrace.config.yaml", queue },
    );
    const body = await json(response);

    expect(response.status).toBe(202);
    expect(body.status).toBe("queued");
    expect(await queue.get("job-1")).toMatchObject({
      aiEnabled: true,
      report: "README deployment plan is unclear",
      source: { provider: "test-http", userId: "U0123456789" },
    });
  });

  it("rejects missing report and invalid JSON", async () => {
    const queue = new FakeQueue();

    const missingReport = await handleInvestigationRequest(post({ report: "" }), {
      configPath: "firsttrace.config.yaml",
      queue,
    });
    const invalidJson = await handleInvestigationRequest(post("{bad"), {
      configPath: "firsttrace.config.yaml",
      queue,
    });

    expect(missingReport.status).toBe(400);
    expect((await json(missingReport)).error).toBe("report must be a non-empty string.");
    expect(invalidJson.status).toBe(400);
    expect((await json(invalidJson)).error).toBe("Request body must be valid JSON.");
  });

  it("rejects bad bearer token when configured", async () => {
    const response = await handleInvestigationRequest(post({ report: "bug" }, "wrong"), {
      configPath: "firsttrace.config.yaml",
      queue: () => {
        throw new Error("queue should not be created");
      },
      receiverToken: "expected",
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error).toBe("Unauthorized.");
  });

  it("returns job status", async () => {
    const queue = new FakeQueue();
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const response = await handleJobStatusRequest(
      new Request(`https://firsttrace.example.com/api/jobs?id=${job.id}`, { method: "GET" }),
      { configPath: "firsttrace.config.yaml", queue },
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe("queued");
  });
});
