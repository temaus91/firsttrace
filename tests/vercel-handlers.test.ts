import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import handleHealth from "../src/vercel/health.js";
import handleInvestigation from "../src/vercel/investigations.js";
import handleJobs from "../src/vercel/jobs.js";
import handleSlackEvents from "../src/vercel/slack-events.js";
import handleWorkerRunOnce from "../src/vercel/worker-run-once.js";
import { createHostedWorkerRunOptions } from "../src/hosted/worker-runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

const tempConfigPath = () => {
  const dir = path.join(tmpdir(), `firsttrace-vercel-handler-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
    ].join("\n"),
  );
  return configPath;
};

describe("packaged Vercel handlers", () => {
  it("exports all Vercel route handlers", () => {
    expect(handleHealth).toEqual(expect.any(Function));
    expect(handleInvestigation).toEqual(expect.any(Function));
    expect(handleJobs).toEqual(expect.any(Function));
    expect(handleSlackEvents).toEqual(expect.any(Function));
    expect(handleWorkerRunOnce).toEqual(expect.any(Function));
  });

  it("reports health metadata for the configured hosted backend", async () => {
    process.env.FIRSTTRACE_BUILD_REF = "npm:firsttrace@0.1.5";
    process.env.FIRSTTRACE_AI_ENABLED = "true";
    process.env.FIRSTTRACE_AI_PROVIDER = "oci-genai";
    process.env.FIRSTTRACE_MODEL_CHAT = "openai.gpt-oss-120b";
    process.env.FIRSTTRACE_INVESTIGATOR = "agent";
    process.env.FIRSTTRACE_QUEUE_PROVIDER = "supabase";
    process.env.FIRSTTRACE_SLACK_REPLY_FORMAT = "compact-v1";
    process.env.OCI_COMPARTMENT_ID = "ocid1.compartment.oc1..test";

    const response = await handleHealth(new Request("https://firsttrace.example.com/healthz"));
    const body = await json(response as Response);

    expect(response).toHaveProperty("status", 200);
    expect(body).toMatchObject({
      ai: {
        aiEnabled: true,
        aiProvider: "oci-genai",
        aiReady: true,
        investigator: "agent",
        model: "openai.gpt-oss-120b",
        promptProfile: "default",
        promptVersion: "firsttrace-agent-v1",
        slackAiGate: "enabled",
      },
      buildRef: "npm:firsttrace@0.1.5",
      ok: true,
      queueProvider: "supabase",
      slackReplyFormat: "compact-v1",
    });
  });

  it("routes generic investigation requests through the packaged handler", async () => {
    process.env.FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER = "true";
    process.env.FIRSTTRACE_CONFIG_PATH = tempConfigPath();
    process.env.FIRSTTRACE_QUEUE_PROVIDER = "filesystem";
    process.env.FIRSTTRACE_RECEIVER_TOKEN = "";

    const response = await handleInvestigation(
      new Request("https://firsttrace.example.com/api/investigations", {
        body: JSON.stringify({ report: "README deployment plan is unclear" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    const body = await json(response as Response);

    expect(response).toHaveProperty("status", 202);
    expect(body.status).toBe("queued");
    expect(body.job).toMatchObject({
      report: "README deployment plan is unclear",
      status: "queued",
    });
  });

  it("wires progress and result notifiers into the hosted Vercel worker path", async () => {
    process.env.FIRSTTRACE_QUEUE_PROVIDER = "supabase";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.SUPABASE_URL = "https://example.supabase.co";

    const workerOptions = await createHostedWorkerRunOptions();

    expect(workerOptions.progressNotifier).toBeDefined();
    expect(workerOptions.resultNotifier).toBeDefined();
  });
});
