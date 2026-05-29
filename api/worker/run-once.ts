import { loadLocalEnv } from "../../src/env.js";
import { createHostedWorkerRunOptions } from "../../src/hosted/worker-runtime.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../../src/http/vercel-adapter.js";
import { handleWorkerRunOnceRequest } from "../../src/http/worker.js";

loadLocalEnv();

export const config = {
  maxDuration: 60,
};

export default async function handler(request: VercelRequestLike, response?: VercelResponseLike): Promise<Response | void> {
  const workerOptions = createHostedWorkerRunOptions();
  return runVercelHandler(request, response, (webRequest) => handleWorkerRunOnceRequest(webRequest, {
    cronSecret: process.env.CRON_SECRET,
    queue: workerOptions.queue,
    receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
    repoPreparation: workerOptions.repoPreparation,
    resultNotifier: workerOptions.resultNotifier,
  }));
}
