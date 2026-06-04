import { aiReadinessMetadataFromEnv } from "../ai/readiness.js";
import { loadConfig } from "../config.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { buildRef, hostedConfigPath, hostedQueueProviderName, jsonResponse, slackReplyFormat } from "./shared.js";

export const config = {
  maxDuration: 10,
};

const handleHealthRequest = async (request: Request) => {
  if (request.method !== "GET") return jsonResponse(405, { error: "Method not allowed." });
  let promptConfig;
  try {
    promptConfig = loadConfig(hostedConfigPath()).investigation.prompt;
  } catch {
    promptConfig = undefined;
  }
  return jsonResponse(200, {
    ai: aiReadinessMetadataFromEnv(process.env, promptConfig),
    buildRef: buildRef(),
    ok: true,
    queueProvider: hostedQueueProviderName(),
    slackReplyFormat: slackReplyFormat(),
  });
};

export default async function handler(
  request: VercelRequestLike,
  response?: VercelResponseLike,
): Promise<Response | void> {
  return runVercelHandler(request, response, handleHealthRequest);
}
