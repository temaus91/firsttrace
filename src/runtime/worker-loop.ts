#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJobProgressNotifierFromEnv, createJobResultNotifierFromEnv } from "../chat/slack/notifier.js";
import { loadLocalEnv } from "../env.js";
import { createOciSlackNotifiersFromEnv } from "../oci/notifiers.js";
import { loadOciVaultSecretsIntoEnv } from "../oci/secrets.js";
import { GitHubArchiveRepoMaterializer } from "../repositories/github-materializer.js";
import { runWorkerOnce } from "../worker/runner.js";
import { createJobQueue } from "../worker/queue-factory.js";
import type { JobProgressNotifier, JobQueue, JobResultNotifier } from "../types.js";

export type WorkerLoopOptions = {
  idleDelayMs: number;
  progressNotifier?: JobProgressNotifier;
  queue: JobQueue;
  resultNotifier?: JobResultNotifier;
  signal?: AbortSignal;
};

export const runWorkerLoop = async ({
  idleDelayMs,
  progressNotifier,
  queue,
  resultNotifier,
  signal,
}: WorkerLoopOptions) => {
  while (!signal?.aborted) {
    const result = await runWorkerOnce({
      progressNotifier,
      queue,
      repoPreparation: {
        githubMaterializer: new GitHubArchiveRepoMaterializer(),
      },
      resultNotifier,
    });
    console.info(result.message);
    for (const notification of result.notifications ?? []) {
      console.info(notification);
    }
    if (result.status === "idle") {
      await sleep(idleDelayMs, undefined, { signal }).catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") throw error;
      });
    }
  }
};

export const startWorkerLoopFromEnv = async () => {
  loadLocalEnv();
  const loadedSecrets = await loadOciVaultSecretsIntoEnv();
  if (loadedSecrets.length > 0) {
    console.info(`Loaded ${loadedSecrets.length} OCI Vault secrets.`);
  }

  const queueProvider = process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "filesystem";
  const queue = createJobQueue(queueProvider).queue;
  const notifiers =
    queueProvider === "oci"
      ? await createOciSlackNotifiersFromEnv()
      : {
          progressNotifier: createJobProgressNotifierFromEnv(),
          resultNotifier: createJobResultNotifierFromEnv(),
        };
  const abortController = new AbortController();
  const stop = () => abortController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runWorkerLoop({
    idleDelayMs: process.env.FIRSTTRACE_WORKER_IDLE_DELAY_MS
      ? Number.parseInt(process.env.FIRSTTRACE_WORKER_IDLE_DELAY_MS, 10)
      : 1000,
    progressNotifier: notifiers.progressNotifier,
    queue,
    resultNotifier: notifiers.resultNotifier,
    signal: abortController.signal,
  });
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
  await startWorkerLoopFromEnv();
}
