import type { InvestigationJob, WorkerRunResult } from "../types.js";

const empty = "_None_";

export const renderJobSummary = (job: InvestigationJob) =>
  [
    `Job: \`${job.id}\``,
    `Status: \`${job.status}\``,
    job.source ? `Source: \`${job.source.provider}\`` : "",
    job.source?.channelName ? `Channel: \`${job.source.channelName}\`` : "",
    job.source?.channelId ? `Channel id: \`${job.source.channelId}\`` : "",
    job.source?.threadId ? `Thread id: \`${job.source.threadId}\`` : "",
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

export const renderEnqueuedJob = (job: InvestigationJob, location?: string) =>
  ["# FirstTrace Worker Job Enqueued", renderJobSummary(job), location ? `Storage: \`${location}\`` : ""]
    .filter(Boolean)
    .join("\n\n");

export const renderJobStatus = (job: InvestigationJob | undefined) =>
  job ? ["# FirstTrace Worker Job Status", renderJobSummary(job)].join("\n\n") : empty;

export const renderWorkerRun = (result: WorkerRunResult) =>
  [
    "# FirstTrace Worker Run",
    `Status: \`${result.status}\``,
    result.message,
    result.notifications?.length ? `Notifications: ${result.notifications.join("; ")}` : "",
    result.job ? renderJobSummary(result.job) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
