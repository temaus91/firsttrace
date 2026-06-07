import type { Awaitable, JobProgressNotifier, JobQueue, JobResultNotifier } from "../types.js";
import type { RepoPreparationOptions } from "../repositories/prepare.js";
import { runWorkerOnce } from "../worker/runner.js";

type WorkerRunOnceOptions = {
  cronSecret?: string;
  progressNotifier?: JobProgressNotifier | (() => Awaitable<JobProgressNotifier | undefined>);
  queue: JobQueue | (() => Awaitable<JobQueue>);
  receiverToken?: string;
  repoPreparation?: RepoPreparationOptions;
  resultNotifier?: JobResultNotifier | (() => Awaitable<JobResultNotifier | undefined>);
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

const validTokensFrom = ({ cronSecret, receiverToken }: WorkerRunOnceOptions) =>
  [cronSecret, receiverToken].flatMap((token) => {
    const trimmed = token?.trim();
    return trimmed ? [trimmed] : [];
  });

const assertAuthorized = (request: Request, options: WorkerRunOnceOptions) => {
  const validTokens = validTokensFrom(options);
  if (!validTokens.length) {
    throw jsonResponse(500, { error: "CRON_SECRET or FIRSTTRACE_RECEIVER_TOKEN is required for worker runs." });
  }

  const authorization = request.headers.get("authorization");
  if (!validTokens.some((token) => authorization === `Bearer ${token}`)) {
    throw jsonResponse(401, { error: "Unauthorized." });
  }
};

const resolveQueue = async (queue: WorkerRunOnceOptions["queue"]) => (typeof queue === "function" ? queue() : queue);

const resolveNotifier = async (resultNotifier: WorkerRunOnceOptions["resultNotifier"]) =>
  typeof resultNotifier === "function" ? resultNotifier() : resultNotifier;

const resolveProgressNotifier = async (progressNotifier: WorkerRunOnceOptions["progressNotifier"]) =>
  typeof progressNotifier === "function" ? progressNotifier() : progressNotifier;

const errorTypeFrom = (error: string) => {
  const normalized = error.toLowerCase();
  if (normalized.includes("schema") || normalized.includes("agent output") || normalized.includes("zod")) {
    return "provider_agent_schema_validation";
  }
  if (normalized.includes("provider") || normalized.includes("openai") || normalized.includes("oci genai")) {
    return "provider_failure";
  }
  return "job_failed";
};

const errorSummaryFrom = (error: string) =>
  error.replace(/\s+/g, " ").trim().slice(0, 500);

export const handleWorkerRunOnceRequest = async (
  request: Request,
  options: WorkerRunOnceOptions,
): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  try {
    assertAuthorized(request, options);
    const result = await runWorkerOnce({
      progressNotifier: await resolveProgressNotifier(options.progressNotifier),
      queue: await resolveQueue(options.queue),
      repoPreparation: options.repoPreparation,
      resultNotifier: await resolveNotifier(options.resultNotifier),
    });
    const jobStatus = result.job?.status;
    const failedError = jobStatus === "failed" ? result.job?.error?.trim() : undefined;

    return jsonResponse(200, {
      errorSummary: failedError ? errorSummaryFrom(failedError) : undefined,
      errorType: failedError ? errorTypeFrom(failedError) : undefined,
      job: result.job,
      jobId: result.job?.id,
      jobStatus,
      message: result.message,
      notifications: result.notifications ?? [],
      ok: jobStatus !== "failed",
      status: result.status,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonResponse(500, { error: (error as Error).message });
  }
};
