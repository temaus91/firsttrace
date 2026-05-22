import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { LocalMessageDeliveryAdapter } from "../src/message/local-submit.js";
import { renderMessageSubmitResult } from "../src/message/render.js";
import { FileSystemJobQueue } from "../src/worker/fs-queue.js";

const tempQueuePath = (name: string) => {
  const dir = path.join(tmpdir(), `firsttrace-message-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

describe("local message delivery adapter", () => {
  it("submits a local message as a queued investigation job", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("submit"));
    const adapter = new LocalMessageDeliveryAdapter(queue);

    const result = await adapter.submit({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "  README deployment plan is unclear  ",
    });

    const stored = await queue.get(result.job.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.report).toBe("README deployment plan is unclear");
    expect(stored?.source).toEqual({ provider: "local-cli" });
  });

  it("preserves explicit source metadata for future chat adapters", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("source"));
    const adapter = new LocalMessageDeliveryAdapter(queue);

    const result = await adapter.submit({
      aiEnabled: true,
      configPath: "firsttrace.config.yaml",
      report: "checkout fails after retry",
      source: {
        channelId: "C0123456789",
        channelName: "company-ai-triage",
        messageId: "1700000000.000100",
        provider: "test-chat",
        threadId: "1700000000.000100",
        userId: "U0123456789",
      },
    });

    expect((await queue.get(result.job.id))?.source).toMatchObject({
      channelId: "C0123456789",
      channelName: "company-ai-triage",
      provider: "test-chat",
    });
  });

  it("renders submitted job status and next commands", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("render"));
    const adapter = new LocalMessageDeliveryAdapter(queue);
    const result = await adapter.submit({
      aiEnabled: false,
      configPath: "firsttrace.config.yaml",
      report: "README deployment plan is unclear",
    });

    const rendered = renderMessageSubmitResult(result, queue.jobPath(result.job.id));

    expect(rendered).toContain("# FirstTrace Local Message Submitted");
    expect(rendered).toContain("Status: `queued`");
    expect(rendered).toContain("Source: `local-cli`");
    expect(rendered).toContain("Run worker:");
    expect(rendered).toContain("Check status:");
  });

  it("rejects empty reports before enqueueing", async () => {
    const queue = new FileSystemJobQueue(tempQueuePath("empty"));
    const adapter = new LocalMessageDeliveryAdapter(queue);

    await expect(
      adapter.submit({
        aiEnabled: false,
        configPath: "firsttrace.config.yaml",
        report: "   ",
      }),
    ).rejects.toThrow("Missing required --report.");
    expect(await queue.list()).toEqual([]);
  });
});
