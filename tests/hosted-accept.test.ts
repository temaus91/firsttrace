import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runHostedAccept, type HostedAcceptSlackClient } from "../src/hosted/accept.js";
import { renderHostedAccept } from "../src/hosted/render.js";
import type { SlackThreadMessage } from "../src/chat/slack/client.js";
import { runOciQueueRedeliveryProbe, type OciRedeliveryProbeAdminClient, type OciRedeliveryProbeQueueClient } from "../src/oci/queue-redelivery-probe.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const tempDir = (name: string) =>
  path.join(tmpdir(), `firsttrace-accept-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);

const writeConfig = (triggers: string[] = ["message"]) => {
  const dir = tempDir("config");
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
      "owners: []",
      "chat:",
      "  provider: slack",
      "  channels:",
      "    - id: C0123456789",
      "      name: example-ai-triage",
      "      triggers:",
      ...triggers.map((trigger) => `        - ${trigger}`),
      "      response: thread",
      "      ai_enabled: false",
      "      repositories:",
      "        - app",
    ].join("\n"),
  );
  return loadConfig(configPath);
};

const env = {
  FIRSTTRACE_RECEIVER_TOKEN: "receiver-secret",
  OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..example",
  SLACK_BOT_TOKEN: "xoxb-secret",
  SLACK_SIGNING_SECRET: "signing-secret",
  SLACK_TEAM_ID: "T0123456789",
};

class FakeSlack implements HostedAcceptSlackClient {
  readonly posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  private threadCallCount = 0;

  constructor(private readonly threadResponses: SlackThreadMessage[][]) {}

  async fetchThreadMessageDetails() {
    const response = this.threadResponses[Math.min(this.threadCallCount, this.threadResponses.length - 1)] ?? [];
    this.threadCallCount += 1;
    return response;
  }

  async postMessage(input: { channel: string; text: string; threadTs?: string }) {
    this.posts.push(input);
    return { ts: "1716500000.000100" };
  }
}

const passingThread: SlackThreadMessage[] = [
  { text: "seed report", ts: "1716500000.000100" },
  { text: "FirstTrace is investigating this report.", ts: "1716500000.000200" },
  { text: "*FirstTrace investigation*\nClassification: likely bug", ts: "1716500000.000300" },
];

const createFetch = ({
  buildRef = "npm:firsttrace@0.1.2",
  duplicateJobId = "job-1",
  jobStatuses = ["succeeded"],
  queueProvider = "oci",
}: {
  buildRef?: string;
  duplicateJobId?: string;
  jobStatuses?: string[];
  queueProvider?: string;
} = {}) => {
  const calls: Array<{ body?: string; headers?: HeadersInit; method?: string; pathname: string }> = [];
  let jobPollCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    calls.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: init?.headers,
      method: init?.method,
      pathname: url.pathname,
    });
    if (url.pathname === "/healthz") return json({ buildRef, ok: true, queueProvider });
    if (url.pathname === "/api/slack/events") {
      return json({ jobId: duplicateJobId, ok: true, status: "queued" });
    }
    if (url.pathname === "/api/jobs") {
      const status = jobStatuses[Math.min(jobPollCount, jobStatuses.length - 1)];
      jobPollCount += 1;
      return json({ job: { id: "job-1", status }, status });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
};

describe("hosted acceptance runner", () => {
  it("passes a full fake OCI acceptance flow and renders a compact checklist", async () => {
    const { calls, fetchImpl } = createFetch();
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      fetchImpl,
      gracePeriodMs: 0,
      pollIntervalMs: 0,
      redeliveryProbe: async () => ({ deliveryCount: 2, queueId: "queue-id", queueName: "firsttrace-accept-test" }),
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread, passingThread]),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(true);
    expect(result.jobId).toBe("job-1");
    expect(result.processingReplyCount).toBe(1);
    expect(result.finalReplyCount).toBe(1);

    const slackEventCalls = calls.filter((call) => call.pathname === "/api/slack/events");
    expect(slackEventCalls).toHaveLength(2);
    expect(slackEventCalls[1]?.body).toBe(slackEventCalls[0]?.body);
    expect(slackEventCalls[1]?.headers).toEqual(slackEventCalls[0]?.headers);
    expect(calls.find((call) => call.pathname === "/api/jobs")?.headers).toEqual({
      authorization: "Bearer receiver-secret",
    });

    const rendered = renderHostedAccept(result);
    expect(rendered).toContain("# FirstTrace Hosted Acceptance");
    expect(rendered).toContain("Status: PASS");
    expect(rendered).toContain("- PASSED Slack replies");
    expect(rendered).not.toContain("receiver-secret");
    expect(rendered).not.toContain("xoxb-secret");
  });

  it("fails clearly when required acceptance environment is missing", async () => {
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env: {},
      expectedBuildRef: "npm:firsttrace@0.1.2",
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread]),
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: "Acceptance failure",
      status: "failed",
    });
    expect(result.checks.at(-1)?.message).toContain("SLACK_BOT_TOKEN");
    expect(result.checks.at(-1)?.message).not.toContain("receiver-secret");
  });

  it("fails when the deployed health endpoint is not the expected npm build", async () => {
    const { fetchImpl } = createFetch({ buildRef: "local" });
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      fetchImpl,
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread]),
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)?.message).toContain("expected npm:firsttrace@0.1.2");
  });

  it("fails when duplicate Slack events produce different jobs", async () => {
    let eventCount = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/healthz") return json({ buildRef: "npm:firsttrace@0.1.2", ok: true, queueProvider: "oci" });
      if (url.pathname === "/api/slack/events") {
        eventCount += 1;
        return json({ jobId: `job-${eventCount}`, ok: true, status: "queued" });
      }
      return json({ job: { id: "job-1", status: "succeeded" }, status: "succeeded" });
    }) as typeof fetch;

    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      fetchImpl,
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread]),
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)?.message).toContain("Duplicate Slack event returned job job-2");
  });

  it("fails when Slack replies are duplicated", async () => {
    const { fetchImpl } = createFetch();
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      fetchImpl,
      pollIntervalMs: 0,
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([
        [
          ...passingThread,
          { text: "FirstTrace is investigating this report.", ts: "1716500000.000400" },
        ],
      ]),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)?.message).toContain("Expected one processing reply, found 2");
  });

  it("fails when the job does not reach succeeded", async () => {
    const { fetchImpl } = createFetch({ jobStatuses: ["failed"] });
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      fetchImpl,
      pollIntervalMs: 0,
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread]),
      timeoutMs: 1_000,
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)?.message).toContain("ended as failed");
  });

  it("requires the configured Slack channel to support message events", async () => {
    const result = await runHostedAccept({
      backend: "oci",
      baseUrl: "https://firsttrace.example.com",
      channelId: "C0123456789",
      config: writeConfig(["app_mention"]),
      env,
      expectedBuildRef: "npm:firsttrace@0.1.2",
      report: "README deployment plan is unclear",
      slackClient: new FakeSlack([passingThread]),
    });

    expect(result.passed).toBe(false);
    expect(result.checks.at(-1)?.message).toContain("must enable the message trigger");
  });
});

describe("OCI Queue redelivery probe", () => {
  it("claims, abandons, reclaims, deletes, and cleans up a temporary queue", async () => {
    const adminDeletes: string[] = [];
    const adminClient: OciRedeliveryProbeAdminClient = {
      async createQueue() {},
      async deleteQueue({ queueId }) {
        adminDeletes.push(queueId);
      },
      async listQueues() {
        return {
          queueCollection: {
            items: [
              {
                displayName: "firsttrace-accept-test",
                id: "queue-id",
                lifecycleState: "ACTIVE",
                messagesEndpoint: "https://queue.example.com",
              },
            ],
          },
        };
      },
    };
    const queueDeletes: string[] = [];
    let getCount = 0;
    const queueClient: OciRedeliveryProbeQueueClient = {
      async deleteMessage({ messageReceipt }) {
        queueDeletes.push(messageReceipt);
      },
      async getMessages() {
        getCount += 1;
        return {
          getMessages: {
            messages: [
              {
                content: JSON.stringify({ probe: "firsttrace-oci-redelivery", queueName: "firsttrace-accept-test" }),
                deliveryCount: getCount,
                id: "message-id",
                receipt: `receipt-${getCount}`,
              },
            ],
          },
        };
      },
      async putMessages() {},
    };

    const result = await runOciQueueRedeliveryProbe({
      adminClient,
      env: { OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..example" },
      queueClient,
      queueName: "firsttrace-accept-test",
      sleep: async () => {},
      waitAfterClaimMs: 0,
    });

    expect(result).toMatchObject({ deliveryCount: 2, queueId: "queue-id", queueName: "firsttrace-accept-test" });
    expect(queueDeletes).toEqual(["receipt-2"]);
    expect(adminDeletes).toEqual(["queue-id"]);
  });

  it("cleans up the temporary queue when redelivery fails", async () => {
    const adminDeletes: string[] = [];
    const adminClient: OciRedeliveryProbeAdminClient = {
      async createQueue() {},
      async deleteQueue({ queueId }) {
        adminDeletes.push(queueId);
      },
      async listQueues() {
        return {
          queueCollection: {
            items: [
              {
                displayName: "firsttrace-accept-test",
                id: "queue-id",
                lifecycleState: "ACTIVE",
                messagesEndpoint: "https://queue.example.com",
              },
            ],
          },
        };
      },
    };
    let getCount = 0;
    const queueClient: OciRedeliveryProbeQueueClient = {
      async deleteMessage() {},
      async getMessages() {
        getCount += 1;
        return {
          getMessages: {
            messages:
              getCount === 1
                ? [
                    {
                      content: JSON.stringify({
                        probe: "firsttrace-oci-redelivery",
                        queueName: "firsttrace-accept-test",
                      }),
                      deliveryCount: 1,
                      receipt: "receipt-1",
                    },
                  ]
                : [],
          },
        };
      },
      async putMessages() {},
    };

    await expect(
      runOciQueueRedeliveryProbe({
        adminClient,
        env: { OCI_COMPARTMENT_ID: "ocid1.compartment.oc1..example" },
        queueClient,
        queueName: "firsttrace-accept-test",
        sleep: async () => {},
        waitAfterClaimMs: 0,
      }),
    ).rejects.toThrow("did not redeliver");
    expect(adminDeletes).toEqual(["queue-id"]);
  });
});
