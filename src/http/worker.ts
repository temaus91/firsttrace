import type { Awaitable, JobQueue, JobResultNotifier } from "../types.js";
import type { RepoPreparationOptions } from "../repositories/prepare.js";
import { runWorkerOnce } from "../worker/runner.js";

type WorkerRunOnceOptions = {
  cronSecret?: string;
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
      queue: await resolveQueue(options.queue),
      repoPreparation: options.repoPreparation,
      resultNotifier: await resolveNotifier(options.resultNotifier),
    });

    return jsonResponse(200, {
      job: result.job,
      message: result.message,
      notifications: result.notifications ?? [],
      status: result.status,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonResponse(500, { error: (error as Error).message });
  }
};
