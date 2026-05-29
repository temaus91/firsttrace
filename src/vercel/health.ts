import { runVercelHandler, type VercelRequestLike, type VercelResponseLike } from "../http/vercel-adapter.js";
import { buildRef, hostedQueueProviderName, jsonResponse, slackReplyFormat } from "./shared.js";

export const config = {
  maxDuration: 10,
};

const handleHealthRequest = async (request: Request) => {
  if (request.method !== "GET") return jsonResponse(405, { error: "Method not allowed." });
  return jsonResponse(200, {
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
