import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runHostedVerify } from "../src/hosted/verify.js";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";
import type { EnqueueInvestigationJobInput, InvestigationJob, InvestigationResult, JobQueue } from "../src/types.js";

const tempDir = (name: string) =>
  path.join(tmpdir(), `firsttrace-hosted-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const writeConfig = ({ slack = true }: { slack?: boolean } = {}) => {
  const dir = tempDir(slack ? "slack" : "no-slack");
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
      ...(slack
        ? [
            "chat:",
            "  provider: slack",
            "  channels:",
            "    - id: C0123456789",
            "      name: example-ai-triage",
            "      triggers:",
            "        - message",
            "      response: thread",
            "      ai_enabled: false",
            "      repositories:",
            "        - app",
          ]
        : []),
    ].join("\n"),
  );
  return configPath;
};

class FakeQueue implements JobQueue {
  jobs = new Map<string, InvestigationJob>();

  async claimNext() {
    const job = [...this.jobs.values()].find((item) => item.status === "queued");
    if (!job) return undefined;
    const updated = { ...job, attempts: job.attempts + 1, status: "running" as const };
    this.jobs.set(job.id, updated);
    return updated;
  }

  async complete(id: string, result: InvestigationResult) {
    const job = this.require(id);
    const updated = { ...job, result, status: "succeeded" as const };
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
    const updated = { ...job, error, status: "failed" as const };
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

describe("hosted verification runner", () => {
  it("fails clearly when config has no Slack channel", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig({ slack: false })),
      env: {},
      liveSlackPost: false,
      queue: new FileSystemJobQueue(tempDir("queue")),
      queueProvider: "filesystem",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Slack channel config",
        status: "failed",
        message: "Config must define at least one Slack channel under chat.channels.",
      }),
    );
  });

  it("processes a synthetic Slack event through filesystem queue and captures fake Slack reply", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig()),
      env: {},
      liveSlackPost: false,
      queue: new FileSystemJobQueue(tempDir("queue")),
      queueProvider: "filesystem",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(true);
    expect(result.job?.status).toBe("succeeded");
    expect(result.job?.source).toMatchObject({ provider: "slack", channelId: "C0123456789" });
    expect(result.job?.result?.likelyComponent).toBe("README.md");
    expect(result.job?.result?.likelyOwners).toContain("@project-docs");
    expect(result.slackReplyText).toContain("*FirstTrace investigation*");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Synthetic Slack receiver",
        status: "passed",
      }),
    );
  });

  it("reports missing live env values as blocked or skipped without failing local verification", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig()),
      env: {},
      liveSlackPost: false,
      queue: new FileSystemJobQueue(tempDir("queue")),
      queueProvider: "filesystem",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Slack live environment",
        status: "blocked",
        required: false,
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "GitHub repository environment",
        status: "blocked",
        required: false,
      }),
    );
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Supabase live queue",
        status: "skipped",
        required: false,
      }),
    );
  });

  it("requires SLACK_BOT_TOKEN for live Slack posting", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig()),
      env: { SLACK_SIGNING_SECRET: "set" },
      liveSlackPost: true,
      queue: new FileSystemJobQueue(tempDir("queue")),
      queueProvider: "filesystem",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Slack live post token",
        status: "failed",
      }),
    );
  });

  it("reports missing Supabase env values when Supabase queue is selected", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig()),
      env: {},
      liveSlackPost: false,
      queue: new FakeQueue(),
      queueProvider: "supabase",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Supabase live environment",
        required: true,
        status: "failed",
      }),
    );
  });

  it("can run through a fake Supabase queue path", async () => {
    const result = await runHostedVerify({
      aiEnabled: false,
      config: loadConfig(writeConfig()),
      env: {
        SUPABASE_SERVICE_ROLE_KEY: "set",
        SUPABASE_URL: "https://example.supabase.co",
      },
      liveSlackPost: false,
      queue: new FakeQueue(),
      queueProvider: "supabase",
      report: "README deployment plan is unclear",
    });

    expect(result.passed).toBe(true);
    expect(result.queueProvider).toBe("supabase");
    expect(result.job?.id).toBe("job-1");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: "Supabase live environment",
        required: true,
        status: "passed",
      }),
    );
  });
});
