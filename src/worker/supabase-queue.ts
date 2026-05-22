import { randomUUID } from "node:crypto";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  EnqueueInvestigationJobInput,
  InvestigationJob,
  InvestigationJobSource,
  InvestigationJobStatus,
  InvestigationResult,
  JobQueue,
} from "../types.js";

export const SUPABASE_JOBS_TABLE = "firsttrace_jobs";
export const SUPABASE_CLAIM_NEXT_JOB_RPC = "firsttrace_claim_next_job";

type SupabaseError = {
  message: string;
};

type SupabaseResponse<T> = Promise<{
  data: T | null;
  error: SupabaseError | null;
}>;

type SupabaseClientLike = Pick<SupabaseClient, "from" | "rpc">;

export type SupabaseJobRow = {
  ai_enabled: boolean;
  attempts: number;
  config_path: string;
  created_at: string;
  error: string | null;
  finished_at: string | null;
  id: string;
  max_attempts: number;
  report: string;
  result: InvestigationResult | null;
  source: InvestigationJobSource | null;
  started_at: string | null;
  status: InvestigationJobStatus;
  updated_at: string;
};

export type SupabaseJobStore = {
  claimNext(): Promise<SupabaseJobRow | undefined>;
  get(id: string): Promise<SupabaseJobRow | undefined>;
  insert(row: SupabaseJobRow): Promise<SupabaseJobRow>;
  list(): Promise<SupabaseJobRow[]>;
  update(id: string, patch: Partial<SupabaseJobRow>): Promise<SupabaseJobRow>;
};

const statusOrder: Record<InvestigationJobStatus, number> = {
  queued: 0,
  running: 1,
  failed: 2,
  succeeded: 3,
};

const now = () => new Date().toISOString();

const messageFor = (error: SupabaseError | null) => error?.message ?? "Unknown Supabase error";

const assertData = <T>(data: T | null, error: SupabaseError | null, action: string): T => {
  if (error) throw new Error(`Supabase ${action} failed: ${messageFor(error)}`);
  if (!data) throw new Error(`Supabase ${action} failed: no row returned.`);
  return data;
};

export const jobFromSupabaseRow = (row: SupabaseJobRow): InvestigationJob => ({
  aiEnabled: row.ai_enabled,
  attempts: row.attempts,
  configPath: row.config_path,
  createdAt: row.created_at,
  error: row.error ?? undefined,
  finishedAt: row.finished_at ?? undefined,
  id: row.id,
  maxAttempts: row.max_attempts,
  report: row.report,
  result: row.result ?? undefined,
  source: row.source ?? undefined,
  startedAt: row.started_at ?? undefined,
  status: row.status,
  updatedAt: row.updated_at,
});

export class SupabaseRestJobStore implements SupabaseJobStore {
  constructor(private readonly client: SupabaseClientLike) {}

  async claimNext(): Promise<SupabaseJobRow | undefined> {
    const { data, error } = (await this.client.rpc(SUPABASE_CLAIM_NEXT_JOB_RPC)) as Awaited<
      SupabaseResponse<SupabaseJobRow>
    >;
    if (error) throw new Error(`Supabase claim failed: ${messageFor(error)}`);
    return data ?? undefined;
  }

  async get(id: string): Promise<SupabaseJobRow | undefined> {
    const { data, error } = (await this.client.from(SUPABASE_JOBS_TABLE).select("*").eq("id", id).maybeSingle()) as Awaited<
      SupabaseResponse<SupabaseJobRow>
    >;
    if (error) throw new Error(`Supabase get failed: ${messageFor(error)}`);
    return data ?? undefined;
  }

  async insert(row: SupabaseJobRow): Promise<SupabaseJobRow> {
    const { data, error } = (await this.client.from(SUPABASE_JOBS_TABLE).insert(row).select("*").single()) as Awaited<
      SupabaseResponse<SupabaseJobRow>
    >;
    return assertData(data, error, "insert");
  }

  async list(): Promise<SupabaseJobRow[]> {
    const { data, error } = (await this.client.from(SUPABASE_JOBS_TABLE).select("*")) as Awaited<
      SupabaseResponse<SupabaseJobRow[]>
    >;
    if (error) throw new Error(`Supabase list failed: ${messageFor(error)}`);
    return data ?? [];
  }

  async update(id: string, patch: Partial<SupabaseJobRow>): Promise<SupabaseJobRow> {
    const { data, error } = (await this.client
      .from(SUPABASE_JOBS_TABLE)
      .update(patch)
      .eq("id", id)
      .select("*")
      .single()) as Awaited<SupabaseResponse<SupabaseJobRow>>;
    return assertData(data, error, "update");
  }
}

export class SupabaseJobQueue implements JobQueue {
  constructor(private readonly store: SupabaseJobStore) {}

  async claimNext(): Promise<InvestigationJob | undefined> {
    const row = await this.store.claimNext();
    return row ? jobFromSupabaseRow(row) : undefined;
  }

  async complete(id: string, result: InvestigationResult): Promise<InvestigationJob> {
    const row = await this.store.update(id, {
      error: null,
      finished_at: now(),
      result,
      status: "succeeded",
      updated_at: now(),
    });
    return jobFromSupabaseRow(row);
  }

  async enqueue(input: EnqueueInvestigationJobInput): Promise<InvestigationJob> {
    const timestamp = now();
    const row = await this.store.insert({
      ai_enabled: input.aiEnabled,
      attempts: 0,
      config_path: path.resolve(input.configPath),
      created_at: timestamp,
      error: null,
      finished_at: null,
      id: randomUUID(),
      max_attempts: input.maxAttempts ?? 1,
      report: input.report,
      result: null,
      source: input.source ?? null,
      started_at: null,
      status: "queued",
      updated_at: timestamp,
    });
    return jobFromSupabaseRow(row);
  }

  async fail(id: string, error: string): Promise<InvestigationJob> {
    const row = await this.store.update(id, {
      error,
      finished_at: now(),
      status: "failed",
      updated_at: now(),
    });
    return jobFromSupabaseRow(row);
  }

  async get(id: string): Promise<InvestigationJob | undefined> {
    const row = await this.store.get(id);
    return row ? jobFromSupabaseRow(row) : undefined;
  }

  async list(): Promise<InvestigationJob[]> {
    const rows = await this.store.list();
    return rows
      .map(jobFromSupabaseRow)
      .sort(
        (a, b) =>
          statusOrder[a.status] - statusOrder[b.status] ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }
}

export const createSupabaseJobQueueFromEnv = () => {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the Supabase queue.");
  }

  return new SupabaseJobQueue(new SupabaseRestJobStore(createClient(url, serviceRoleKey, { auth: { persistSession: false } })));
};
