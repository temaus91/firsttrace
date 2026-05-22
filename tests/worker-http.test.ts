import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { handleWorkerRunOnceRequest } from "../src/http/worker.js";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";
import type { InvestigationJob, JobResultNotifier } from "../src/types.js";

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const tempConfigPath = () => {
  const dir = path.join(tmpdir(), `firsttrace-worker-http-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(dir, "repo"), { recursive: true });
  writeFileSync(path.join(dir, "repo", "README.md"), "README deployment plan is unclear.\n");
  const configPath = path.join(dir, "firsttrace.config.yaml");
  writeFileSync(
    configPath,
    [
      "repos:",
      "  - name: app",
      "    path: repo",
      "docs:",
      "  - README.md",
      "issue_exports: []",
      "owners:",
      '  - path: README.md',
      '    owner: "@project-docs"',
    ].join("\n"),
  );
  return configPath;
};

const request = (token?: string, method = "GET") =>
  new Request("https://firsttrace.example.com/api/worker/run-once", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method,
  });

class CaptureNotifier implements JobResultNotifier {
  notified: InvestigationJob[] = [];

  async notify(job: InvestigationJob) {
    this.notified.push(job);
  }
}

describe("worker HTTP endpoint", () => {
  it("fails closed when no worker token is configured", async () => {
    const response = await handleWorkerRunOnceRequest(request(), {
      queue: () => {
        throw new Error("queue should not be created");
      },
    });

    expect(response.status).toBe(500);
    expect((await json(response)).error).toBe("CRON_SECRET or FIRSTTRACE_RECEIVER_TOKEN is required for worker runs.");
  });

  it("rejects an incorrect bearer token before creating the queue", async () => {
    const response = await handleWorkerRunOnceRequest(request("wrong"), {
      cronSecret: "expected",
      queue: () => {
        throw new Error("queue should not be created");
      },
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error).toBe("Unauthorized.");
  });

  it("processes one queued job with the receiver token", async () => {
    const queue = new FileSystemJobQueue(path.join(tmpdir(), `firsttrace-worker-http-queue-${Date.now()}`));
    const notifier = new CaptureNotifier();
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath: tempConfigPath(),
      report: "README deployment plan is unclear",
      source: { provider: "slack", channelId: "C0123456789", threadId: "1710000000.000100" },
    });

    const response = await handleWorkerRunOnceRequest(request("receiver-token", "POST"), {
      queue,
      receiverToken: "receiver-token",
      resultNotifier: notifier,
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.status).toBe("processed");
    expect((body.job as InvestigationJob).id).toBe(job.id);
    expect((await queue.get(job.id))?.status).toBe("succeeded");
    expect(notifier.notified).toHaveLength(1);
  });

  it("accepts CRON_SECRET for Vercel cron calls", async () => {
    const queue = new FileSystemJobQueue(path.join(tmpdir(), `firsttrace-worker-http-cron-${Date.now()}`));

    const response = await handleWorkerRunOnceRequest(request("cron-token"), {
      cronSecret: "cron-token",
      queue,
    });

    expect(response.status).toBe(200);
    expect((await json(response)).status).toBe("idle");
  });
});
