import { aiReadinessMetadataFromEnv } from "../ai/readiness.js";
import { loadConfig } from "../config.js";
import {
  diagnoseConfiguredRepositoryPaths,
  repositoryReadinessFromDiagnostics,
  type RepositoryReadiness,
} from "../diagnostics/repositories.js";
import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { buildRef, hostedConfigPath, hostedQueueProviderName, jsonResponse, slackReplyFormat } from "./shared.js";

export const config = {
  maxDuration: 10,
};

const handleHealthRequest = async (request: Request) => {
  if (request.method !== "GET") return jsonResponse(405, { error: "Method not allowed." });
  let promptConfig;
  let repos: RepositoryReadiness[] = [];
  try {
    const config = loadConfig(hostedConfigPath());
    promptConfig = config.investigation.prompt;
    repos = repositoryReadinessFromDiagnostics(diagnoseConfiguredRepositoryPaths(config));
  } catch {
    promptConfig = undefined;
  }
  return jsonResponse(200, {
    ai: aiReadinessMetadataFromEnv(process.env, promptConfig),
    buildRef: buildRef(),
    ok: true,
    queueProvider: hostedQueueProviderName(),
    repos,
    slackReplyFormat: slackReplyFormat(),
  });
};

export default async function handler(
  request: VercelRequestLike,
  response?: VercelResponseLike,
): Promise<Response | void> {
  return runVercelHandler(request, response, handleHealthRequest);
}
