import { createHostedWorkerRunOptions } from "../hosted/worker-runtime.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { handleWorkerRunOnceRequest } from "../http/worker.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(
  request: VercelRequestLike,
  response?: VercelResponseLike,
): Promise<Response | void> {
  const workerOptions = await createHostedWorkerRunOptions();
  return runVercelHandler(request, response, (webRequest) => handleWorkerRunOnceRequest(webRequest, {
    cronSecret: process.env.CRON_SECRET,
    progressNotifier: workerOptions.progressNotifier,
    queue: workerOptions.queue,
    receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
    repoPreparation: workerOptions.repoPreparation,
    resultNotifier: workerOptions.resultNotifier,
  }));
}
