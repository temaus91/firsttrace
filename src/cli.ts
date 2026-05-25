#!/usr/bin/env node

import path from "node:path";
import { createJobResultNotifierFromEnv } from "./chat/slack/notifier.js";
import { loadConfig } from "./config.js";
import { loadLocalEnv } from "./env.js";
import { loadEvalCases } from "./eval/cases.js";
import { renderEvalRun } from "./eval/render.js";
import { runEval } from "./eval/runner.js";
import { renderHostedVerify } from "./hosted/render.js";
import { createHostedVerifyQueue, runHostedVerify } from "./hosted/verify.js";
import { executeInvestigation } from "./investigation-runner.js";
import { createInvestigatorProviderFromEnv } from "./investigator/provider-factory.js";
import { LocalMessageDeliveryAdapter } from "./message/local-submit.js";
import { renderMessageSubmitResult } from "./message/render.js";
import { renderInvestigation } from "./render.js";
import { createJobQueue, queueProviderFrom } from "./worker/queue-factory.js";
import { renderEnqueuedJob, renderJobStatus, renderWorkerRun } from "./worker/render.js";
import { runWorkerOnce } from "./worker/runner.js";

type ParsedArgs = {
  ai: boolean;
  casesPath?: string;
  channelId?: string;
  command?: string;
  configPath: string;
  help: boolean;
  hostedAction?: string;
  jobId?: string;
  liveSlackPost: boolean;
  once: boolean;
  queueProvider?: string;
  report?: string;
  workerAction?: string;
};

const usage = () => `Usage:
  firsttrace investigate --config firsttrace.config.yaml --report "bug text"
  firsttrace investigate --config firsttrace.config.yaml --report "bug text" --ai
  firsttrace eval --config firsttrace.config.yaml --cases evals/example.yaml
  firsttrace eval --config firsttrace.config.yaml --cases evals/example.yaml --ai
  firsttrace submit --queue filesystem --config firsttrace.config.yaml --report "bug text"
  firsttrace submit --queue supabase --config firsttrace.config.yaml --report "bug text" --ai
  firsttrace hosted verify --config examples/hosted.local.config.yaml --queue filesystem --report "bug text"
  firsttrace worker enqueue --queue filesystem --config firsttrace.config.yaml --report "bug text"
  firsttrace worker run --once --queue filesystem
  firsttrace worker status --queue filesystem --job <job-id>

Options:
  --ai              Run the configured investigator over the deterministic evidence.
  --cases <path>    Path to a FirstTrace eval cases YAML file.
  --channel <id>    Configured Slack channel id for hosted verification.
  --config <path>   Path to a FirstTrace YAML config. Defaults to firsttrace.config.yaml.
  --job <id>        Worker job id for status lookup.
  --live-slack-post Post hosted verification results to Slack instead of using the fake notifier.
  --once            Process at most one queued job.
  --queue <name>    Queue provider: filesystem, supabase, or oci. Defaults to FIRSTTRACE_QUEUE_PROVIDER or filesystem.
  --report <text>   Bug report or feedback text to investigate.
  --help            Show this message.`;

const parseArgs = (argv: string[]): ParsedArgs => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return {
      ai: false,
      configPath: path.resolve("firsttrace.config.yaml"),
      help: true,
      liveSlackPost: false,
      once: false,
    };
  }

  const command = argv[0];
  const parsed: ParsedArgs = {
    ai: false,
    command,
    configPath: path.resolve("firsttrace.config.yaml"),
    help: false,
    hostedAction: command === "hosted" ? argv[1] : undefined,
    liveSlackPost: false,
    once: false,
    workerAction: command === "worker" ? argv[1] : undefined,
  };

  for (let index = parsed.command === "worker" || parsed.command === "hosted" ? 2 : 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--ai") {
      parsed.ai = true;
      continue;
    }
    if (arg === "--live-slack-post") {
      parsed.liveSlackPost = true;
      continue;
    }
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      parsed.configPath = value;
      index += 1;
      continue;
    }
    if (arg === "--cases") {
      const value = argv[index + 1];
      if (!value) throw new Error("--cases requires a path.");
      parsed.casesPath = value;
      index += 1;
      continue;
    }
    if (arg === "--channel") {
      const value = argv[index + 1];
      if (!value) throw new Error("--channel requires an id.");
      parsed.channelId = value;
      index += 1;
      continue;
    }
    if (arg === "--job") {
      const value = argv[index + 1];
      if (!value) throw new Error("--job requires an id.");
      parsed.jobId = value;
      index += 1;
      continue;
    }
    if (arg === "--queue") {
      const value = argv[index + 1];
      if (!value) throw new Error("--queue requires a provider name.");
      parsed.queueProvider = value;
      index += 1;
      continue;
    }
    if (arg === "--report") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report requires text.");
      parsed.report = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ""}`);
  }

  return parsed;
};

const main = async () => {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (
    args.command !== "investigate" &&
    args.command !== "eval" &&
    args.command !== "hosted" &&
    args.command !== "submit" &&
    args.command !== "worker"
  ) {
    throw new Error(`Unknown or missing command: ${args.command ?? "<none>"}`);
  }

  if (args.command === "submit") {
    const { describeJobLocation, provider, queue } = createJobQueue(args.queueProvider);
    const adapter = new LocalMessageDeliveryAdapter(queue);
    const result = await adapter.submit({
      aiEnabled: args.ai,
      configPath: args.configPath,
      report: args.report ?? "",
    });
    console.log(renderMessageSubmitResult(result, describeJobLocation(result.job), provider));
    return;
  }

  if (args.command === "worker") {
    const { describeJobLocation, queue } = createJobQueue(args.queueProvider);
    if (args.workerAction === "enqueue") {
      if (!args.report?.trim()) {
        throw new Error("Missing required --report.");
      }
      const job = await queue.enqueue({
        aiEnabled: args.ai,
        configPath: args.configPath,
        report: args.report,
      });
      console.log(renderEnqueuedJob(job, describeJobLocation(job)));
      return;
    }

    if (args.workerAction === "run") {
      if (!args.once) {
        throw new Error("worker run currently requires --once.");
      }
      const result = await runWorkerOnce({ queue, resultNotifier: createJobResultNotifierFromEnv() });
      console.log(renderWorkerRun(result));
      return;
    }

    if (args.workerAction === "status") {
      if (!args.jobId?.trim()) {
        throw new Error("Missing required --job.");
      }
      const job = await queue.get(args.jobId);
      if (!job) {
        throw new Error(`Job not found: ${args.jobId}`);
      }
      console.log(renderJobStatus(job));
      return;
    }

    throw new Error(`Unknown or missing worker action: ${args.workerAction ?? "<none>"}`);
  }

  const config = loadConfig(args.configPath);

  if (args.command === "hosted") {
    if (args.hostedAction !== "verify") {
      throw new Error(`Unknown or missing hosted action: ${args.hostedAction ?? "<none>"}`);
    }
    if (!args.report?.trim()) {
      throw new Error("Missing required --report.");
    }
    const provider = queueProviderFrom(args.queueProvider);
    const result = await runHostedVerify({
      aiEnabled: args.ai,
      channelId: args.channelId,
      config,
      liveSlackPost: args.liveSlackPost,
      queue: createHostedVerifyQueue(provider),
      queueProvider: provider,
      report: args.report,
    });
    console.log(renderHostedVerify(result));
    if (!result.passed) process.exit(1);
    return;
  }

  if (args.command === "eval") {
    if (!args.casesPath?.trim()) {
      throw new Error("Missing required --cases.");
    }
    const investigatorProvider = args.ai ? createInvestigatorProviderFromEnv() : undefined;
    const evalResult = await runEval({
      cases: loadEvalCases(args.casesPath),
      config,
      investigatorProvider,
    });
    console.log(renderEvalRun(evalResult));
    if (!evalResult.passed) process.exit(1);
    return;
  }

  if (!args.report?.trim()) {
    throw new Error("Missing required --report.");
  }

  const result = await executeInvestigation({
    config,
    investigatorProvider: args.ai ? createInvestigatorProviderFromEnv() : undefined,
    report: args.report,
  });

  console.log(renderInvestigation(result));
};

try {
  await main();
} catch (error) {
  console.error((error as Error).message);
  console.error("");
  console.error(usage());
  process.exit(1);
}
