import type { InvestigationJob, WorkerRunResult } from "../types.js";

const empty = "_None_";

const jobSummary = (job: InvestigationJob) =>
  [
    `Job: \`${job.id}\``,
    `Status: \`${job.status}\``,
    `AI enabled: \`${job.aiEnabled}\``,
    `Attempts: \`${job.attempts}/${job.maxAttempts}\``,
    `Config: \`${job.configPath}\``,
    `Created: \`${job.createdAt}\``,
    `Updated: \`${job.updatedAt}\``,
    job.startedAt ? `Started: \`${job.startedAt}\`` : "",
    job.finishedAt ? `Finished: \`${job.finishedAt}\`` : "",
    job.error ? `Error: ${job.error}` : "",
    job.result ? `Result classification: \`${job.result.classification}\`` : "",
    job.result ? `Result component: \`${job.result.likelyComponent}\`` : "",
    job.result?.ai ? `AI provider: \`${job.result.ai.provider}\`` : "",
    job.result?.ai ? `AI confidence: \`${job.result.ai.confidence.toFixed(2)}\`` : "",
    job.result?.likelyOwners.length
      ? `Result owners: ${job.result.likelyOwners.map((owner) => `\`${owner}\``).join(", ")}`
      : "",
    job.result?.warnings.length ? `Warnings: ${job.result.warnings.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

export const renderEnqueuedJob = (job: InvestigationJob, filePath: string) =>
  ["# FirstTrace Worker Job Enqueued", jobSummary(job), `Path: \`${filePath}\``].join("\n\n");

export const renderJobStatus = (job: InvestigationJob | undefined) =>
  job ? ["# FirstTrace Worker Job Status", jobSummary(job)].join("\n\n") : empty;

export const renderWorkerRun = (result: WorkerRunResult) =>
  [
    "# FirstTrace Worker Run",
    `Status: \`${result.status}\``,
    result.message,
    result.job ? jobSummary(result.job) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
