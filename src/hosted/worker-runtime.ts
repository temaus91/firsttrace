import path from "node:path";
import { tmpdir } from "node:os";
import { createJobProgressNotifierFromEnv, createJobResultNotifierFromEnv } from "../chat/slack/notifier.js";
import { createOciSlackNotifiersFromEnv } from "../oci/notifiers.js";
import { GitHubArchiveRepoMaterializer } from "../repositories/github-materializer.js";
import { runWorkerOnce, type RunWorkerOnceOptions } from "../worker/runner.js";
import { createJobQueue } from "../worker/queue-factory.js";

export const hostedQueueProviderFromEnv = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";

export const hostedGitHubCacheRootFromEnv = () =>
  process.env.FIRSTTRACE_GITHUB_CACHE_ROOT ?? path.join(tmpdir(), "firsttrace", "github");

export const createHostedWorkerRunOptions = async (): Promise<RunWorkerOnceOptions> => {
  const queueProvider = hostedQueueProviderFromEnv();
  const notifiers =
    queueProvider === "oci"
      ? await createOciSlackNotifiersFromEnv()
      : {
          progressNotifier: createJobProgressNotifierFromEnv(),
          resultNotifier: createJobResultNotifierFromEnv(),
        };

  return {
    progressNotifier: notifiers.progressNotifier,
    queue: createJobQueue(queueProvider).queue,
    repoPreparation: {
      githubMaterializer: new GitHubArchiveRepoMaterializer({ cacheRoot: hostedGitHubCacheRootFromEnv() }),
    },
    resultNotifier: notifiers.resultNotifier,
  };
};

export const runHostedWorkerOnceFromEnv = async () => runWorkerOnce(await createHostedWorkerRunOptions());
