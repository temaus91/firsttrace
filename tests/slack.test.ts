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
    if (input.dedupeKey) {
      const existing = [...this.jobs.values()].find((job) => job.dedupeKey === input.dedupeKey);
      if (existing) return existing;
    }

    const timestamp = "2026-05-22T00:00:00.000Z";
    const job: InvestigationJob = {
      aiEnabled: input.aiEnabled,
      attempts: 0,
      configPath: input.configPath,
      createdAt: timestamp,
      dedupeKey: input.dedupeKey,
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
    const acceptedJobs: InvestigationJob[] = [];
    const response = await handleSlackEventsRequest(
      signedSlackRequest({
        event: {
          channel: "C0123456789",
          text: "<@U999999> README deployment plan is unclear",
          ts: "1710000000.000100",
          type: "app_mention",
          user: "U0123456789",
        },
        team_id: "T0123456789",
        type: "event_callback",
      }),
      {
        config: loadConfig(tempConfigPath()),
        afterEnqueue: (job) => acceptedJobs.push(job),
        nowSeconds,
        queue,
        signingSecret,
      },
    );

    const jobs = await queue.list();
    expect(response.status).toBe(200);
    expect(jobs[0]).toMatchObject({
      aiEnabled: true,
      dedupeKey: "slack:T0123456789:app_mention:C0123456789:1710000000.000100",
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
    expect(acceptedJobs.map((job) => job.id)).toEqual(["job-1"]);
  });

  it("dedupes repeated Slack app mention, message, and reaction events", async () => {
    const cases: Array<{
      expectedDedupeKey: string;
      payload: unknown;
      slackClient?: Parameters<typeof handleSlackEventsRequest>[1]["slackClient"];
    }> = [
      {
        expectedDedupeKey: "slack:T0123456789:app_mention:C0123456789:1710000000.000100",
        payload: {
          event: {
            channel: "C0123456789",
            text: "<@U999999> README deployment plan is unclear",
            ts: "1710000000.000100",
            type: "app_mention",
            user: "U0123456789",
          },
          team_id: "T0123456789",
          type: "event_callback",
        },
      },
      {
        expectedDedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000200",
        payload: {
          event: {
            channel: "C0123456789",
            text: "README deployment plan is unclear",
            ts: "1710000000.000200",
            type: "message",
            user: "U0123456789",
          },
          team_id: "T0123456789",
          type: "event_callback",
        },
      },
      {
        expectedDedupeKey: "slack:T0123456789:reaction:C0123456789:1710000000.000300:bug",
        payload: {
          event: {
            item: { channel: "C0123456789", ts: "1710000000.000300", type: "message" },
            reaction: "bug",
            type: "reaction_added",
            user: "U0123456789",
          },
          team_id: "T0123456789",
          type: "event_callback",
        },
        slackClient: {
          async fetchMessageText() {
            return "README deployment plan is unclear";
          },
          async postMessage() {},
        },
      },
    ];

    for (const item of cases) {
      const queue = new FakeQueue();
      const options = {
        config: loadConfig(tempConfigPath()),
        nowSeconds,
        queue,
        signingSecret,
        slackClient: item.slackClient,
      };

      const first = await handleSlackEventsRequest(signedSlackRequest(item.payload), options);
      const second = await handleSlackEventsRequest(signedSlackRequest(item.payload), options);
      const firstBody = (await first.json()) as { jobId: string };
      const secondBody = (await second.json()) as { jobId: string };
      const jobs = await queue.list();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(secondBody.jobId).toBe(firstBody.jobId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.dedupeKey).toBe(item.expectedDedupeKey);
    }
  });

  it("creates separate jobs for different Slack message timestamps", async () => {
    const queue = new FakeQueue();
    const options = {
      config: loadConfig(tempConfigPath()),
      nowSeconds,
      queue,
      signingSecret,
    };

    const payloadFor = (ts: string) => ({
      event: {
        channel: "C0123456789",
        text: "README deployment plan is unclear",
        ts,
        type: "message",
        user: "U0123456789",
      },
      team_id: "T0123456789",
      type: "event_callback",
    });

    await handleSlackEventsRequest(signedSlackRequest(payloadFor("1710000000.000100")), options);
    await handleSlackEventsRequest(signedSlackRequest(payloadFor("1710000000.000200")), options);

    expect(await queue.list()).toHaveLength(2);
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

    expect(rendered).toContain("Classification: `needs clarification`");
    expect(rendered).toContain("Likely owner: `@project-docs`");
    expect(rendered).toContain("Primary files: `README.md`");
    expect(rendered).not.toContain("Likely owners:");
    expect(rendered).not.toContain("Best fault-location lead");
    expect(rendered).not.toContain("Evidence: README.md:1");
    expect(rendered).toContain("*Evidence*");
    expect(rendered).toContain("README.md: README matched the report.");
  });

  it("does not truncate likely-cause sentences at file extensions", () => {
    const rendered = renderSlackInvestigationReply({
      ai: {
        confidence: 0.91,
        explanation:
          "The lead is app/page.tsx because it routes the authenticated profile tab. The app context controls readiness.",
        implementerHints: [],
        likelyComponent: "app/page.tsx",
        likelyFiles: [],
        likelyOwners: [],
        missingInfoQuestions: [],
        provider: "agent",
        warnings: [],
      },
      classification: "bug",
      likelyComponent: "app/page.tsx",
      likelyOwners: [],
      relatedCommits: [],
      relatedDocs: [],
      report: "Profile is blank after login",
      searchTerms: ["profile"],
      suggestedNextSteps: [],
      suspiciousFiles: [],
      warnings: [],
    });

    expect(rendered).toContain(
      "The lead is app/page.tsx because it routes the authenticated profile tab. The app context controls readiness.",
    );
    expect(rendered).not.toContain("*Likely cause*\nThe lead is app/page.\n");
  });

  it("renders compact AI debugging leads and implementer hints in Slack replies", () => {
    const rendered = renderSlackInvestigationReply({
      ai: {
        confidence: 0.82,
        explanation:
          "The profile route is the strongest lead because its initial render can show empty state before data hydration completes. The app context owns the readiness flags. Extra detail should not render.",
        implementerHints: [
          {
            citations: ["commit abc123"],
            commit: "abc123",
            email: null,
            name: "Dev Owner",
            reason: "This recent commit changed the artist profile loading state.",
          },
        ],
        likelyComponent: "app/artists/[artistId]/page.tsx",
        likelyFiles: [
          {
            citations: ["app/artists/[artistId]/page.tsx:21"],
            confidence: 0.86,
            path: "app/artists/[artistId]/page.tsx",
            reason: "The route owns the artist profile loading branch and matches the blank-profile symptom.",
            repo: "wallspace",
          },
        ],
        likelyOwners: ["@app-platform"],
        missingInfoQuestions: ["Does the blank state appear after a hard refresh or only client navigation?"],
        provider: "openai",
        warnings: [],
      },
      classification: "bug",
      likelyComponent: "app",
      likelyOwners: ["@frontend"],
      relatedCommits: [
        {
          citations: [{ commit: "abc123456789", label: "wallspace:abc123456789", repo: "wallspace" }],
          metadata: { author: "Dev Owner", date: "2026-05-20" },
          repo: "wallspace",
          score: 8,
          summary: "Changed the artist profile loading state.",
          title: "abc123 Change profile loading state",
          type: "commit",
        },
      ],
      relatedDocs: [],
      report: "Artist profile is empty for a few seconds after login",
      searchTerms: ["artist", "profile", "empty"],
      suggestedNextSteps: ["Open the artist profile route and check the loading branch."],
      suspiciousFiles: [],
      warnings: [],
    });

    const expected = [
      "*FirstTrace investigation*",
      "Classification: `likely bug`",
      "Likely owner: `Dev Owner`",
      "Primary files: `app/artists/[artistId]/page.tsx`",
      "AI confidence: `0.82`",
      "",
      "*Likely cause*",
      "The profile route is the strongest lead because its initial render can show empty state before data hydration completes. The app context owns the readiness flags.",
      "",
      "*Next checks*",
      "1. Inspect `app/artists/[artistId]/page.tsx` first.",
      "2. Route the first pass to Dev Owner.",
      "3. Confirm: Does the blank state appear after a hard refresh or only client navigation?",
      "",
      "*Evidence*",
      "1. Dev Owner - commit abc123, 2026-05-20: This recent commit changed the artist profile loading state.",
      "2. Dev Owner, commit abc123456789, 2026-05-20: Changed the artist profile loading state.",
      "3. app/artists/[artistId]/page.tsx: The route owns the artist profile loading branch and matches the blank-profile symptom.",
    ].join("\n");

    expect(rendered).toBe(expected);
    expect(rendered).not.toContain("Likely owners:");
    expect(rendered).toContain("*Likely cause*");
    expect(rendered).not.toContain("*Best fault-location lead*");
    expect(rendered).not.toContain("*Implementer / commit signals*");
    expect(rendered.indexOf("*Next checks*")).toBeLessThan(rendered.indexOf("*Evidence*"));
    expect(rendered).not.toContain("*Why this is suspicious*");
    expect(rendered).toContain("Dev Owner");
    expect(rendered).toContain("2026-05-20");
    expect(rendered).not.toContain("@app-platform");
    expect(rendered).toContain("Inspect `app/artists/[artistId]/page.tsx` first.");
    expect(rendered).toContain("Route the first pass to Dev Owner.");
    expect(rendered).toContain("Confirm: Does the blank state appear");
    expect(rendered).not.toContain("Evidence: app/artists/[artistId]/page.tsx:21");
  });
});
