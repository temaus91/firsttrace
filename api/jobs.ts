import { loadLocalEnv } from "../src/env.js";
import { handleJobStatusRequest } from "../src/http/receiver.js";
import { createJobQueue } from "../src/worker/queue-factory.js";

loadLocalEnv();

const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";
const allowUnauthenticatedReceiver = () => process.env.FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER === "true";

export default async function handler(request: Request): Promise<Response> {
  return handleJobStatusRequest(request, {
    allowUnauthenticated: allowUnauthenticatedReceiver(),
    configPath: hostedConfigPath(),
    queue: () => createJobQueue(hostedQueueProvider()).queue,
    receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
  });
}
