import { handleInvestigationRequest } from "../http/receiver.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { allowUnauthenticatedReceiver, hostedConfigPath, hostedQueue } from "./shared.js";

export default async function handler(
  request: VercelRequestLike,
  response?: VercelResponseLike,
): Promise<Response | void> {
  return runVercelHandler(request, response, (webRequest) => handleInvestigationRequest(webRequest, {
    allowUnauthenticated: allowUnauthenticatedReceiver(),
    configPath: hostedConfigPath(),
    queue: hostedQueue,
    receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
  }));
}
