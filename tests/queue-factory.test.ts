import { describe, expect, it } from "vitest";
import { createJobQueue, queueProviderFrom } from "../src/worker/queue-factory.js";

describe("queue factory", () => {
  it("defaults to filesystem", () => {
    const previous = process.env.FIRSTTRACE_QUEUE_PROVIDER;
    delete process.env.FIRSTTRACE_QUEUE_PROVIDER;
    try {
      expect(queueProviderFrom(undefined)).toBe("filesystem");
      expect(createJobQueue("filesystem").provider).toBe("filesystem");
    } finally {
      if (previous === undefined) {
        delete process.env.FIRSTTRACE_QUEUE_PROVIDER;
      } else {
        process.env.FIRSTTRACE_QUEUE_PROVIDER = previous;
      }
    }
  });

  it("accepts supabase as a provider name", () => {
    expect(queueProviderFrom("supabase")).toBe("supabase");
  });

  it("rejects unsupported providers", () => {
    expect(() => queueProviderFrom("redis")).toThrow("Unsupported queue provider");
  });
});
