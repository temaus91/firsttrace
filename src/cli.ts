import path from "node:path";
import { createAiProviderFromEnv } from "./ai/provider-factory.js";
import { loadConfig } from "./config.js";
import { loadLocalEnv } from "./env.js";
import { loadEvalCases } from "./eval/cases.js";
import { renderEvalRun } from "./eval/render.js";
import { runEval } from "./eval/runner.js";
import { executeInvestigation } from "./investigation-runner.js";
import { LocalMessageDeliveryAdapter } from "./message/local-submit.js";
import { renderMessageSubmitResult } from "./message/render.js";
import { renderInvestigation } from "./render.js";
import { FileSystemJobQueue } from "./worker/fs-queue.js";
import { renderEnqueuedJob, renderJobStatus, renderWorkerRun } from "./worker/render.js";
import { runWorkerOnce } from "./worker/runner.js";

type ParsedArgs = {
  ai: boolean;
  casesPath?: string;
  command?: string;
  configPath: string;
  help: boolean;
  jobId?: string;
  once: boolean;
  report?: string;
  workerAction?: string;
};

const usage = () => `Usage:
  npm run firsttrace -- investigate --config firsttrace.config.yaml --report "bug text"
  npm run firsttrace -- investigate --config firsttrace.config.yaml --report "bug text" --ai
  npm run firsttrace -- eval --config firsttrace.config.yaml --cases evals/example.yaml
  npm run firsttrace -- eval --config firsttrace.config.yaml --cases evals/example.yaml --ai
  npm run firsttrace -- submit --config firsttrace.config.yaml --report "bug text"
  npm run firsttrace -- submit --config firsttrace.config.yaml --report "bug text" --ai
  npm run firsttrace -- worker enqueue --config firsttrace.config.yaml --report "bug text"
  npm run firsttrace -- worker run --once
  npm run firsttrace -- worker status --job <job-id>

Options:
  --ai              Add AI reasoning over the deterministic evidence bundle.
  --cases <path>    Path to a FirstTrace eval cases YAML file.
  --config <path>   Path to a FirstTrace YAML config. Defaults to firsttrace.config.yaml.
  --job <id>        Worker job id for status lookup.
  --once            Process at most one queued job.
  --report <text>   Bug report or feedback text to investigate.
  --help            Show this message.`;

const parseArgs = (argv: string[]): ParsedArgs => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return {
      ai: false,
      configPath: path.resolve("firsttrace.config.yaml"),
      help: true,
      once: false,
    };
  }

  const parsed: ParsedArgs = {
    ai: false,
    command: argv[0],
    configPath: path.resolve("firsttrace.config.yaml"),
    help: false,
    once: false,
    workerAction: argv[0] === "worker" ? argv[1] : undefined,
  };

  for (let index = parsed.command === "worker" ? 2 : 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--ai") {
      parsed.ai = true;
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
    if (arg === "--job") {
      const value = argv[index + 1];
      if (!value) throw new Error("--job requires an id.");
      parsed.jobId = value;
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
  if (args.command !== "investigate" && args.command !== "eval" && args.command !== "submit" && args.command !== "worker") {
    throw new Error(`Unknown or missing command: ${args.command ?? "<none>"}`);
  }

  if (args.command === "submit") {
    const queue = new FileSystemJobQueue();
    const adapter = new LocalMessageDeliveryAdapter(queue);
    const result = adapter.submit({
      aiEnabled: args.ai,
      configPath: args.configPath,
      report: args.report ?? "",
    });
    console.log(renderMessageSubmitResult(result, queue.jobPath(result.job.id)));
    return;
  }

  if (args.command === "worker") {
    const queue = new FileSystemJobQueue();
    if (args.workerAction === "enqueue") {
      if (!args.report?.trim()) {
        throw new Error("Missing required --report.");
      }
      const job = queue.enqueue({
        aiEnabled: args.ai,
        configPath: args.configPath,
        report: args.report,
      });
      console.log(renderEnqueuedJob(job, queue.jobPath(job.id)));
      return;
    }

    if (args.workerAction === "run") {
      if (!args.once) {
        throw new Error("worker run currently requires --once.");
      }
      const result = await runWorkerOnce({ queue });
      console.log(renderWorkerRun(result));
      return;
    }

    if (args.workerAction === "status") {
      if (!args.jobId?.trim()) {
        throw new Error("Missing required --job.");
      }
      const job = queue.get(args.jobId);
      if (!job) {
        throw new Error(`Job not found: ${args.jobId}`);
      }
      console.log(renderJobStatus(job));
      return;
    }

    throw new Error(`Unknown or missing worker action: ${args.workerAction ?? "<none>"}`);
  }

  const config = loadConfig(args.configPath);

  if (args.command === "eval") {
    if (!args.casesPath?.trim()) {
      throw new Error("Missing required --cases.");
    }
    const aiProvider = args.ai ? createAiProviderFromEnv() : undefined;
    const evalResult = await runEval({
      aiProvider,
      cases: loadEvalCases(args.casesPath),
      config,
    });
    console.log(renderEvalRun(evalResult));
    if (!evalResult.passed) process.exit(1);
    return;
  }

  if (!args.report?.trim()) {
    throw new Error("Missing required --report.");
  }

  const result = await executeInvestigation({
    aiProvider: args.ai ? createAiProviderFromEnv() : undefined,
    config,
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
