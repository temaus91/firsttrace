import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { handleSlackEventsRequest } from "../src/chat/slack/events.js";
import { SlackJobResultNotifier } from "../src/chat/slack/notifier.js";
import { renderSlackInvestigationReply } from "../src/chat/slack/render.js";
import { createSlackSignature, verifySlackRequestSignature } from "../src/chat/slack/signature.js";
import { loadConfig } from "../src/config.js";
import { runWorkerOnce } from "../src/worker/runner.js";
import type {
  EnqueueInvestigationJobInput,
  InvestigationJob,
  InvestigationResult,
  JobQueue,
  SlackChannelConfig,
} from "../src/types.js";

const nowSeconds = 1_800_000_000;
const signingSecret = "test-signing-secret";

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
    if (!job) throw new Error(`missing job ${id}`);
    return job;
  }
}

const tempConfigPath = (channel: Partial<SlackChannelConfig> = {}) => {
  const dir = path.join(tmpdir(), `firsttrace-slack-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
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
      "chat:",
      "  provider: slack",
      "  channels:",
      "    - id: C0123456789",
      `      name: ${channel.name ?? "company-ai-triage"}`,
      `      response: ${channel.response ?? "thread"}`,
      `      ai_enabled: ${channel.aiEnabled ?? true}`,
      "      triggers:",
      ...(channel.triggers ?? ["app_mention", "message", "reaction"]).map((trigger) => `        - ${trigger}`),
    ].join("\n"),
  );
  return configPath;
};

const signedSlackRequest = (payload: unknown, overrides: { signature?: string; timestamp?: string } = {}) => {
  const body = JSON.stringify(payload);
  const timestamp = overrides.timestamp ?? String(nowSeconds);
  const signature = overrides.signature ?? createSlackSignature(signingSecret, timestamp, body);
  return new Request("https://firsttrace.example.com/api/slack/events", {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    method: "POST",
  });
};

describe("Slack signature verification", () => {
  it("accepts valid signatures and rejects stale or mismatched signatures", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const signature = createSlackSignature(signingSecret, String(nowSeconds), body);

    expect(
      verifySlackRequestSignature({
        body,
        nowSeconds,
        signature,
        signingSecret,
        timestamp: String(nowSeconds),
      }),
    ).toBe(true);
    expect(
      verifySlackRequestSignature({
        body,
        nowSeconds,
        signature: "v0=bad",
        signingSecret,
        timestamp: String(nowSeconds),
      }),
    ).toBe(false);
    expect(
      verifySlackRequestSignature({
        body,
        nowSeconds,
        signature,
        signingSecret,
        timestamp: String(nowSeconds - 999),
      }),
    ).toBe(false);
  });
});

describe("Slack event receiver", () => {
  it("returns URL verification challenge after signature verification", async () => {
    const response = await handleSlackEventsRequest(
      signedSlackRequest({ challenge: "challenge-token", type: "url_verification" }),
      {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue: new FakeQueue(),
        signingSecret,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-token");
  });

  it("rejects invalid signatures before enqueueing", async () => {
    const queue = new FakeQueue();
    const response = await handleSlackEventsRequest(
      signedSlackRequest({ challenge: "challenge-token", type: "url_verification" }, { signature: "v0=bad" }),
      {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue,
        signingSecret,
      },
    );

    expect(response.status).toBe(401);
    expect(await queue.list()).toEqual([]);
  });

  it("enqueues configured app mentions as investigation jobs", async () => {
    const queue = new FakeQueue();
    const response = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0123456789",
          text: "<@U999999> README deployment plan is unclear",
          ts: "1710000000.000100",
          type: "app_mention",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue,
        signingSecret,
      },
    );

    const jobs = await queue.list();
    expect(response.status).toBe(200);
    expect(jobs[0]).toMatchObject({
      aiEnabled: true,
      report: "README deployment plan is unclear",
      source: {
        channelId: "C0123456789",
        channelName: "company-ai-triage",
        messageId: "1710000000.000100",
        provider: "slack",
        threadId: "1710000000.000100",
        userId: "U0123456789",
      },
    });
  });

  it("ignores unconfigured channels and threaded replies for top-level message triggers", async () => {
    const queue = new FakeQueue();
    const config = loadConfig(tempConfigPath());

    const unconfigured = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0000000000",
          text: "README deployment plan is unclear",
          ts: "1710000000.000100",
          type: "message",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      { config, nowSeconds, queue, signingSecret },
    );
    const threadedReply = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0123456789",
          text: "README deployment plan is unclear",
          thread_ts: "1710000000.000100",
          ts: "1710000000.000200",
          type: "message",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      { config, nowSeconds, queue, signingSecret },
    );

    expect(unconfigured.status).toBe(200);
    expect(await unconfigured.json()).toMatchObject({ ignored: true, reason: "Slack channel is not configured." });
    expect(await threadedReply.json()).toMatchObject({
      ignored: true,
      reason: "Slack threaded replies are ignored for message trigger.",
    });
    expect(await queue.list()).toEqual([]);
  });

  it("fetches reacted message text before enqueueing reaction-triggered jobs", async () => {
    const queue = new FakeQueue();
    const fetched: Array<{ channel: string; ts: string }> = [];
    const response = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          item: { channel: "C0123456789", ts: "1710000000.000100", type: "message" },
          reaction: "bug",
          type: "reaction_added",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue,
        signingSecret,
        slackClient: {
          async fetchMessageText(input) {
            fetched.push(input);
            return "README deployment plan is unclear";
          },
          async postMessage() {},
        },
      },
    );

    expect(response.status).toBe(200);
    expect(fetched).toEqual([{ channel: "C0123456789", ts: "1710000000.000100" }]);
    expect((await queue.list())[0]).toMatchObject({
      report: "README deployment plan is unclear",
      source: { provider: "slack", threadId: "1710000000.000100" },
    });
  });

  it("uses fetched thread context for app mentions inside threads", async () => {
    const queue = new FakeQueue();
    const response = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0123456789",
          text: "<@U999999> investigate this",
          thread_ts: "1710000000.000100",
          ts: "1710000000.000200",
          type: "app_mention",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue,
        signingSecret,
        slackClient: {
          async fetchMessageText() {
            return undefined;
          },
          async fetchThreadMessages(input) {
            expect(input).toEqual({ channel: "C0123456789", ts: "1710000000.000100" });
            return ["Checkout failed after retry", "<@U999999> investigate this"];
          },
          async postMessage() {},
        },
      },
    );

    expect(response.status).toBe(200);
    expect((await queue.list())[0]?.report).toBe("Checkout failed after retry\ninvestigate this");
  });

  it("does not force thread replies when channel response is configured", async () => {
    const queue = new FakeQueue();
    const response = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0123456789",
          text: "<@U999999> README deployment plan is unclear",
          ts: "1710000000.000100",
          type: "app_mention",
          user: "U0123456789",
        },
        type: "event_callback",
      }),
      {
        config: loadConfig(tempConfigPath({ response: "channel" })),
        nowSeconds,
        queue,
        signingSecret,
      },
    );

    expect(response.status).toBe(200);
    expect((await queue.list())[0]?.source?.threadId).toBeUndefined();
  });
});

describe("Slack result notification", () => {
  it("renders and posts worker results back to the Slack thread", async () => {
    const queue = new FakeQueue();
    const configPath = tempConfigPath();
    const job = await queue.enqueue({
      aiEnabled: false,
      configPath,
      report: "README deployment plan is unclear",
      source: {
        channelId: "C0123456789",
        messageId: "1710000000.000100",
        provider: "slack",
        threadId: "1710000000.000100",
        userId: "U0123456789",
      },
    });
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];

    const result = await runWorkerOnce({
      queue,
      resultNotifier: new SlackJobResultNotifier({
        async fetchMessageText() {
          return undefined;
        },
        async postMessage(input) {
          posts.push(input);
        },
      }),
    });

    expect(result.job?.id).toBe(job.id);
    expect(result.job?.status).toBe("succeeded");
    expect(result.notifications).toEqual([`Result notification processed for job ${job.id}.`]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.channel).toBe("C0123456789");
    expect(posts[0]?.threadTs).toBe("1710000000.000100");
    expect(posts[0]?.text).toContain("*FirstTrace investigation*");
    expect(posts[0]?.text).toContain("README.md");
  });

  it("posts to the channel when no Slack thread id is stored", async () => {
    const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
    const notifier = new SlackJobResultNotifier({
      async fetchMessageText() {
        return undefined;
      },
      async postMessage(input) {
        posts.push(input);
      },
    });

    await notifier.notify({
      aiEnabled: false,
      attempts: 1,
      configPath: "firsttrace.config.yaml",
      createdAt: "2026-05-22T00:00:00.000Z",
      id: "job-1",
      maxAttempts: 1,
      report: "README deployment plan is unclear",
      result: {
        classification: "unknown",
        likelyComponent: "README.md",
        likelyOwners: [],
        relatedCommits: [],
        relatedDocs: [],
        report: "README deployment plan is unclear",
        searchTerms: ["readme"],
        suggestedNextSteps: [],
        suspiciousFiles: [],
        warnings: [],
      },
      source: {
        channelId: "C0123456789",
        messageId: "1710000000.000100",
        provider: "slack",
      },
      status: "succeeded",
      updatedAt: "2026-05-22T00:00:00.000Z",
    });

    expect(posts[0]?.threadTs).toBeUndefined();
  });

  it("renders concise Slack investigation replies", () => {
    const rendered = renderSlackInvestigationReply({
      classification: "unknown",
      likelyComponent: "README.md",
      likelyOwners: ["@project-docs"],
      relatedCommits: [],
      relatedDocs: [],
      report: "README deployment plan is unclear",
      searchTerms: ["readme"],
      suggestedNextSteps: ["Start by inspecting README.md."],
      suspiciousFiles: [
        {
          citations: [{ label: "app:README.md:1", line: 1, path: "README.md", repo: "app" }],
          owner: "@project-docs",
          path: "README.md",
          repo: "app",
          score: 10,
          summary: "README matched the report.",
          title: "README.md",
          type: "file",
        },
      ],
      warnings: [],
    });

    expect(rendered).toContain("Classification: `unknown`");
    expect(rendered).toContain("Likely owners: `@project-docs`");
    expect(rendered).toContain("Evidence: README.md:1");
  });
});
