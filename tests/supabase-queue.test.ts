import { describe, expect, it } from "vitest";
import {
  jobFromSupabaseRow,
  SupabaseJobQueue,
  SupabaseRestJobStore,
  SUPABASE_CLAIM_NEXT_JOB_RPC,
  SUPABASE_JOBS_TABLE,
  type SupabaseJobRow,
  type SupabaseJobStore,
} from "../src/worker/supabase-queue.js";

const row = (overrides: Partial<SupabaseJobRow> = {}): SupabaseJobRow => ({
  ai_enabled: false,
  attempts: 0,
  config_path: "/repo/firsttrace.config.yaml",
  created_at: "2026-05-22T00:00:00.000Z",
  dedupe_key: null,
  error: null,
  finished_at: null,
  id: "11111111-1111-4111-8111-111111111111",
  max_attempts: 1,
  report: "README deployment plan is unclear",
  result: null,
  source: { provider: "http" },
  started_at: null,
  status: "queued",
  updated_at: "2026-05-22T00:00:00.000Z",
  ...overrides,
});

class FakeStore implements SupabaseJobStore {
  rows: SupabaseJobRow[];
  updates: Array<{ id: string; patch: Partial<SupabaseJobRow> }> = [];

  constructor(rows: SupabaseJobRow[] = []) {
    this.rows = rows;
  }

  async claimNext() {
    return this.rows.find((item) => item.status === "queued");
  }

  async get(id: string) {
    return this.rows.find((item) => item.id === id);
  }

  async getByDedupeKey(dedupeKey: string) {
    return this.rows.find((item) => item.dedupe_key === dedupeKey);
  }

  async insert(inserted: SupabaseJobRow) {
    this.rows.push(inserted);
    return inserted;
  }

  async list() {
    return this.rows;
  }

  async update(id: string, patch: Partial<SupabaseJobRow>) {
    this.updates.push({ id, patch });
    const current = this.rows.find((item) => item.id === id);
    if (!current) throw new Error(`missing ${id}`);
    Object.assign(current, patch);
    return current;
  }
}

describe("SupabaseJobQueue", () => {
  it("maps database rows to investigation jobs", () => {
    const job = jobFromSupabaseRow(
      row({
        ai_enabled: true,
        dedupe_key: "slack:T0123456789:message:C0123456789:1710000000.000100",
        error: "failed",
        source: { channelId: "C0123456789", provider: "test-chat" },
        status: "failed",
      }),
    );

    expect(job).toMatchObject({
      aiEnabled: true,
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      error: "failed",
      source: { channelId: "C0123456789", provider: "test-chat" },
      status: "failed",
    });
  });

  it("enqueues, claims, completes, fails, gets, and lists through the store", async () => {
    const store = new FakeStore();
    const queue = new SupabaseJobQueue(store);

    const enqueued = await queue.enqueue({
      aiEnabled: true,
      configPath: "/repo/firsttrace.config.yaml",
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      report: "checkout fails after retry",
      source: { provider: "http" },
    });

    expect(enqueued.status).toBe("queued");
    expect(enqueued.aiEnabled).toBe(true);
    expect(enqueued.dedupeKey).toBe("slack:T0123456789:message:C0123456789:1710000000.000100");
    expect(await queue.get(enqueued.id)).toMatchObject({ id: enqueued.id });
    expect((await queue.list()).map((job) => job.id)).toEqual([enqueued.id]);

    expect((await queue.claimNext())?.id).toBe(enqueued.id);

    const completed = await queue.complete(enqueued.id, {
      classification: "unknown",
      likelyComponent: "README.md",
      likelyOwners: [],
      relatedCommits: [],
      relatedDocs: [],
      report: "checkout fails after retry",
      searchTerms: ["checkout"],
      suggestedNextSteps: [],
      suspiciousFiles: [],
      warnings: [],
    });
    expect(completed.status).toBe("succeeded");
    expect(store.updates.at(-1)?.patch.result?.likelyComponent).toBe("README.md");

    const failed = await queue.fail(enqueued.id, "provider unavailable");
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("provider unavailable");
  });

  it("returns undefined when no queued row is claimed", async () => {
    const store = new FakeStore();
    store.claimNext = async () => undefined;
    const queue = new SupabaseJobQueue(store);

    await expect(queue.claimNext()).resolves.toBeUndefined();
  });

  it("returns an existing row when enqueue receives the same dedupe key", async () => {
    const store = new FakeStore([
      row({
        dedupe_key: "slack:T0123456789:message:C0123456789:1710000000.000100",
        id: "22222222-2222-4222-8222-222222222222",
      }),
    ]);
    const queue = new SupabaseJobQueue(store);

    const enqueued = await queue.enqueue({
      aiEnabled: true,
      configPath: "/repo/firsttrace.config.yaml",
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      report: "retry",
    });

    expect(enqueued.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(store.rows).toHaveLength(1);
  });

  it("returns the existing row when a duplicate insert races", async () => {
    const existing = row({
      dedupe_key: "slack:T0123456789:message:C0123456789:1710000000.000100",
      id: "33333333-3333-4333-8333-333333333333",
    });
    const store = new FakeStore([existing]);
    store.getByDedupeKey = async () => undefined;
    store.insert = async () => {
      store.getByDedupeKey = async () => existing;
      throw new Error("duplicate key value violates unique constraint");
    };
    const queue = new SupabaseJobQueue(store);

    const enqueued = await queue.enqueue({
      aiEnabled: true,
      configPath: "/repo/firsttrace.config.yaml",
      dedupeKey: "slack:T0123456789:message:C0123456789:1710000000.000100",
      report: "retry",
    });

    expect(enqueued.id).toBe("33333333-3333-4333-8333-333333333333");
  });
});

describe("SupabaseRestJobStore", () => {
  it("uses the claim-next RPC", async () => {
    const calls: string[] = [];
    const store = new SupabaseRestJobStore({
      from() {
        throw new Error("not used");
      },
      async rpc(name: string) {
        calls.push(name);
        return { data: row(), error: null };
      },
    } as never);

    const claimed = await store.claimNext();

    expect(calls).toEqual([SUPABASE_CLAIM_NEXT_JOB_RPC]);
    expect(claimed?.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("uses the configured jobs table for reads", async () => {
    const tables: string[] = [];
    const store = new SupabaseRestJobStore({
      from(table: string) {
        tables.push(table);
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: row(), error: null };
                  },
                };
              },
            };
          },
        };
      },
      rpc() {
        throw new Error("not used");
      },
    } as never);

    await expect(store.get("11111111-1111-4111-8111-111111111111")).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(tables).toEqual([SUPABASE_JOBS_TABLE]);
  });
});
