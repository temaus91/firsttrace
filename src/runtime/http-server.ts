#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { SlackWebApiClient } from "../chat/slack/client.js";
import { handleSlackEventsRequest, loadSlackConfigFromPath } from "../chat/slack/events.js";
import { createJobProgressNotifierFromEnv, createJobResultNotifierFromEnv } from "../chat/slack/notifier.js";
import { loadLocalEnv } from "../env.js";
import { createOciSlackNotifiersFromEnv } from "../oci/notifiers.js";
import { loadOciVaultSecretsIntoEnv } from "../oci/secrets.js";
import { GitHubArchiveRepoMaterializer } from "../repositories/github-materializer.js";
import { handleJobStatusRequest, handleInvestigationRequest } from "../http/receiver.js";
import { handleWorkerRunOnceRequest } from "../http/worker.js";
import { createJobQueue } from "../worker/queue-factory.js";

const DEFAULT_PORT = 8080;

const hostedConfigPath = () => process.env.FIRSTTRACE_CONFIG_PATH ?? "firsttrace.config.yaml";
const hostedQueueProvider = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "filesystem";
const allowUnauthenticatedReceiver = () => process.env.FIRSTTRACE_ALLOW_UNAUTHENTICATED_RECEIVER === "true";

const slackClient = () => {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  return botToken ? new SlackWebApiClient(botToken) : undefined;
};

const requestFromIncoming = async (incoming: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const protocol = incoming.headers["x-forwarded-proto"]?.toString() ?? "http";
  const host = incoming.headers.host ?? `127.0.0.1:${process.env.PORT ?? DEFAULT_PORT}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return new Request(`${protocol}://${host}${incoming.url ?? "/"}`, {
    body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : Buffer.concat(chunks),
    headers,
    method: incoming.method,
  });
};

const writeResponse = async (outgoing: ServerResponse, response: Response) => {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, key) => outgoing.setHeader(key, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

export const createFirstTraceHttpServer = async () => {
  const queueProvider = hostedQueueProvider();
  const queueSelection = createJobQueue(queueProvider);
  const queue = queueSelection.queue;
  const configPath = hostedConfigPath();
  const notifiers =
    queueProvider === "oci"
      ? await createOciSlackNotifiersFromEnv()
      : {
          progressNotifier: createJobProgressNotifierFromEnv(),
          resultNotifier: createJobResultNotifierFromEnv(),
        };

  return createServer(async (incoming, outgoing) => {
    try {
      const request = await requestFromIncoming(incoming);
      const pathname = new URL(request.url).pathname;

      if (pathname === "/healthz") {
        await writeResponse(outgoing, jsonResponse(200, { ok: true, queueProvider: queueSelection.provider }));
        return;
      }

      if (pathname === "/api/slack/events") {
        await writeResponse(
          outgoing,
          await handleSlackEventsRequest(request, {
            config: loadSlackConfigFromPath(configPath),
            queue,
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            slackClient: slackClient(),
          }),
        );
        return;
      }

      if (pathname === "/api/investigations") {
        await writeResponse(
          outgoing,
          await handleInvestigationRequest(request, {
            allowUnauthenticated: allowUnauthenticatedReceiver(),
            configPath,
            queue,
            receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
          }),
        );
        return;
      }

      if (pathname === "/api/jobs") {
        await writeResponse(
          outgoing,
          await handleJobStatusRequest(request, {
            allowUnauthenticated: allowUnauthenticatedReceiver(),
            configPath,
            queue,
            receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
          }),
        );
        return;
      }

      if (pathname === "/api/worker/run-once") {
        await writeResponse(
          outgoing,
          await handleWorkerRunOnceRequest(request, {
            progressNotifier: notifiers.progressNotifier,
            queue,
            receiverToken: process.env.FIRSTTRACE_RECEIVER_TOKEN,
            repoPreparation: {
              githubMaterializer: new GitHubArchiveRepoMaterializer(),
            },
            resultNotifier: notifiers.resultNotifier,
          }),
        );
        return;
      }

      await writeResponse(outgoing, jsonResponse(404, { error: "Not found." }));
    } catch (error) {
      console.error(`HTTP server error: ${(error as Error).message}`);
      await writeResponse(outgoing, jsonResponse(500, { error: "Internal server error." }));
    }
  });
};

export const startFirstTraceHttpServer = async () => {
  loadLocalEnv();
  const loadedSecrets = await loadOciVaultSecretsIntoEnv();
  if (loadedSecrets.length > 0) {
    console.info(`Loaded ${loadedSecrets.length} OCI Vault secrets.`);
  }
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : DEFAULT_PORT;
  const server = await createFirstTraceHttpServer();
  server.listen(port, () => {
    console.info(`FirstTrace HTTP server listening on port ${port}.`);
  });
  return server;
};

const isMainModule = () => {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  await startFirstTraceHttpServer();
}
