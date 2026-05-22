import type { Awaitable, InvestigationJobSource, JobQueue } from "../types.js";

type ReceiverOptions = {
  configPath: string;
  queue: JobQueue | (() => Awaitable<JobQueue>);
  receiverToken?: string;
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const sourceFrom = (value: unknown): InvestigationJobSource | undefined => {
  if (value === undefined) return { provider: "http" };
  if (!isObject(value) || typeof value.provider !== "string" || !value.provider.trim()) {
    throw new Error("source.provider must be a non-empty string when source is provided.");
  }

  const source: InvestigationJobSource = { provider: value.provider };
  for (const key of ["channelId", "channelName", "messageId", "threadId", "userId"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw new Error(`source.${key} must be a string.`);
      source[key] = value[key];
    }
  }
  return source;
};

const assertAuthorized = (request: Request, receiverToken?: string) => {
  if (!receiverToken) return;
  if (request.headers.get("authorization") !== `Bearer ${receiverToken}`) {
    throw new Response(JSON.stringify({ error: "Unauthorized." }), {
      headers: { "content-type": "application/json; charset=utf-8" },
      status: 401,
    });
  }
};

const parseJsonBody = async (request: Request) => {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
};

const resolveQueue = async (queue: ReceiverOptions["queue"]) => (typeof queue === "function" ? queue() : queue);

export const handleInvestigationRequest = async (request: Request, options: ReceiverOptions): Promise<Response> => {
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  try {
    assertAuthorized(request, options.receiverToken);
    const body = await parseJsonBody(request);
    if (!isObject(body)) throw new Error("Request body must be a JSON object.");
    if (typeof body.report !== "string" || !body.report.trim()) {
      throw new Error("report must be a non-empty string.");
    }
    if (body.aiEnabled !== undefined && typeof body.aiEnabled !== "boolean") {
      throw new Error("aiEnabled must be a boolean when provided.");
    }

    const queue = await resolveQueue(options.queue);
    const job = await queue.enqueue({
      aiEnabled: body.aiEnabled ?? false,
      configPath: options.configPath,
      report: body.report.trim(),
      source: sourceFrom(body.source),
    });

    return jsonResponse(202, {
      job,
      status: job.status,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonResponse(400, { error: (error as Error).message });
  }
};

export const handleJobStatusRequest = async (request: Request, options: ReceiverOptions): Promise<Response> => {
  if (request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  try {
    assertAuthorized(request, options.receiverToken);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return jsonResponse(400, { error: "Missing required id query parameter." });

    const queue = await resolveQueue(options.queue);
    const job = await queue.get(id);
    if (!job) return jsonResponse(404, { error: `Job not found: ${id}` });

    return jsonResponse(200, { job, status: job.status });
  } catch (error) {
    if (error instanceof Response) return error;
    return jsonResponse(400, { error: (error as Error).message });
  }
};
