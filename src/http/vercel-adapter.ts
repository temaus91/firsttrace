type NodeRequestLike = AsyncIterable<Buffer | Uint8Array | string> & {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
};

type NodeResponseLike = {
  end(body?: Buffer | string): void;
  setHeader(name: string, value: number | string | readonly string[]): void;
  statusCode: number;
};

export type VercelRequestLike = Request | NodeRequestLike;
export type VercelResponseLike = NodeResponseLike | undefined;

const isWebRequest = (request: VercelRequestLike): request is Request =>
  typeof Request !== "undefined" && request instanceof Request;

const headerEntriesFrom = (headers: NodeRequestLike["headers"] = {}) =>
  Object.entries(headers).flatMap(([key, value]) => {
    if (value === undefined) return [];
    return [[key, Array.isArray(value) ? value.join(", ") : value] as [string, string]];
  });

const arrayBufferFrom = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const readNodeBody = async (request: NodeRequestLike): Promise<BodyInit | undefined> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (typeof request.body === "string") return request.body;
  if (request.body instanceof Uint8Array) return arrayBufferFrom(request.body);
  if (request.body !== undefined) return JSON.stringify(request.body);

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length ? arrayBufferFrom(Buffer.concat(chunks)) : undefined;
};

const nodeRequestToWebRequest = async (request: NodeRequestLike) => {
  const headers = new Headers(headerEntriesFrom(request.headers));
  const host = headers.get("host") ?? "firsttrace.local";
  const url = new URL(request.url ?? "/", `https://${host}`);

  return new Request(url, {
    body: await readNodeBody(request),
    headers,
    method: request.method ?? "GET",
  });
};

const sendWebResponse = async (response: Response, nodeResponse: NodeResponseLike) => {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, key) => nodeResponse.setHeader(key, value));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
};

export const runVercelHandler = async (
  request: VercelRequestLike,
  response: VercelResponseLike,
  handle: (request: Request) => Promise<Response>,
): Promise<Response | void> => {
  if (isWebRequest(request)) return handle(request);
  if (!response) return handle(await nodeRequestToWebRequest(request));

  await sendWebResponse(await handle(await nodeRequestToWebRequest(request)), response);
};
