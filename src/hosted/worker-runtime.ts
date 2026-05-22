import path from "node:path";
import { tmpdir } from "node:os";
import { createJobResultNotifierFromEnv } from "../chat/slack/notifier.js";
import { GitHubArchiveRepoMaterializer } from "../repositories/github-materializer.js";
import { runWorkerOnce, type RunWorkerOnceOptions } from "../worker/runner.js";
import { createJobQueue } from "../worker/queue-factory.js";

export const hostedQueueProviderFromEnv = () => process.env.FIRSTTRACE_QUEUE_PROVIDER ?? "supabase";

export const hostedGitHubCacheRootFromEnv = () =>
  process.env.FIRSTTRACE_GITHUB_CACHE_ROOT ?? path.join(tmpdir(), "firsttrace", "github");

export const createHostedWorkerRunOptions = (): RunWorkerOnceOptions => ({
  queue: createJobQueue(hostedQueueProviderFromEnv()).queue,
  repoPreparation: {
    githubMaterializer: new GitHubArchiveRepoMaterializer({ cacheRoot: hostedGitHubCacheRootFromEnv() }),
  },
  resultNotifier: createJobResultNotifierFromEnv(),
});

export const runHostedWorkerOnceFromEnv = () => runWorkerOnce(createHostedWorkerRunOptions());
