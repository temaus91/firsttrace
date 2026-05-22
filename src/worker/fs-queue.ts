import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EnqueueInvestigationJobInput,
  InvestigationJob,
  InvestigationJobStatus,
  InvestigationResult,
  JobQueue,
} from "../types.js";

const DEFAULT_QUEUE_ROOT = ".firsttrace/jobs";
const DEFAULT_MAX_ATTEMPTS = 1;
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

const now = () => new Date().toISOString();

const statusOrder: Record<InvestigationJobStatus, number> = {
  queued: 0,
  running: 1,
  failed: 2,
  succeeded: 3,
};

const parseJob = (value: string, filePath: string): InvestigationJob => {
  try {
    return JSON.parse(value) as InvestigationJob;
  } catch (error) {
    throw new Error(`Invalid job file ${filePath}: ${(error as Error).message}`);
  }
};

export class FileSystemJobQueue implements JobQueue {
  readonly rootPath: string;

  constructor(rootPath = DEFAULT_QUEUE_ROOT) {
    this.rootPath = path.resolve(rootPath);
  }

  async claimNext(): Promise<InvestigationJob | undefined> {
    const job = (await this.list())
      .filter((item) => item.status === "queued" && item.attempts < item.maxAttempts)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return undefined;

    const updated = {
      ...job,
      attempts: job.attempts + 1,
      error: undefined,
      startedAt: now(),
      status: "running" as const,
      updatedAt: now(),
    };
    this.write(updated);
    return updated;
  }

  async complete(id: string, result: InvestigationResult): Promise<InvestigationJob> {
    const job = this.requireJob(id);
    const updated = {
      ...job,
      error: undefined,
      finishedAt: now(),
      result,
      status: "succeeded" as const,
      updatedAt: now(),
    };
    this.write(updated);
    return updated;
  }

  async enqueue(input: EnqueueInvestigationJobInput): Promise<InvestigationJob> {
    const timestamp = now();
    const job: InvestigationJob = {
      aiEnabled: input.aiEnabled,
      attempts: 0,
      configPath: path.resolve(input.configPath),
      createdAt: timestamp,
      id: randomUUID(),
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      report: input.report,
      source: input.source,
      status: "queued",
      updatedAt: timestamp,
    };
    this.write(job);
    return job;
  }

  async fail(id: string, error: string): Promise<InvestigationJob> {
    const job = this.requireJob(id);
    const updated = {
      ...job,
      error,
      finishedAt: now(),
      status: "failed" as const,
      updatedAt: now(),
    };
    this.write(updated);
    return updated;
  }

  async get(id: string): Promise<InvestigationJob | undefined> {
    const filePath = this.jobPath(id);
    if (!existsSync(filePath)) return undefined;
    return parseJob(readFileSync(filePath, "utf8"), filePath);
  }

  jobPath(id: string) {
    if (!JOB_ID_PATTERN.test(id)) {
      throw new Error(`Invalid job id: ${id}`);
    }
    return path.join(this.rootPath, `${id}.json`);
  }

  async list(): Promise<InvestigationJob[]> {
    if (!existsSync(this.rootPath)) return [];
    return readdirSync(this.rootPath)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => {
        const filePath = path.join(this.rootPath, fileName);
        return parseJob(readFileSync(filePath, "utf8"), filePath);
      })
      .sort(
        (a, b) =>
          statusOrder[a.status] - statusOrder[b.status] ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  private ensureRoot() {
    mkdirSync(this.rootPath, { recursive: true });
  }

  private requireJob(id: string) {
    const filePath = this.jobPath(id);
    const job = existsSync(filePath) ? parseJob(readFileSync(filePath, "utf8"), filePath) : undefined;
    if (!job) throw new Error(`Job not found: ${id}`);
    return job;
  }

  private write(job: InvestigationJob) {
    this.ensureRoot();
    writeFileSync(this.jobPath(job.id), `${JSON.stringify(job, null, 2)}\n`);
  }
}
