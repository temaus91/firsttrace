import { loadLocalEnv } from "../src/env.js";
import { handleInvestigationRequest } from "../src/http/receiver.js";
import { createJobQueue } from "../src/worker/queue-factory.js";

loadLocalEnv();

const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";

export default async function handler(request: Request): Promise<Response> {
  return handleInvestigationRequest(request, {
    configPath: hostedConfigPath(),
    queue: () => createJobQueue(hostedQueueProvider()).queue,
    receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
  });
}
