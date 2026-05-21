import path from "node:path";
import { buildAiReasonerRequest } from "./ai/evidence.js";
import { createAiProviderFromEnv } from "./ai/provider-factory.js";
import { loadConfig } from "./config.js";
import { loadLocalEnv } from "./env.js";
import { investigate } from "./investigate.js";
import { renderInvestigation } from "./render.js";

type ParsedArgs = {
  ai: boolean;
  command?: string;
  configPath: string;
  help: boolean;
  report?: string;
};

const usage = () => `Usage:
  npm run firsttrace -- investigate --config firsttrace.config.yaml --report "bug text"
  npm run firsttrace -- investigate --config firsttrace.config.yaml --report "bug text" --ai

Options:
  --ai              Add AI reasoning over the deterministic evidence bundle.
  --config <path>   Path to a FirstTrace YAML config. Defaults to firsttrace.config.yaml.
  --report <text>   Bug report or feedback text to investigate.
  --help            Show this message.`;

const parseArgs = (argv: string[]): ParsedArgs => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return {
      ai: false,
      configPath: path.resolve("firsttrace.config.yaml"),
      help: true,
    };
  }

  const parsed: ParsedArgs = {
    ai: false,
    command: argv[0],
    configPath: path.resolve("firsttrace.config.yaml"),
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--ai") {
      parsed.ai = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path.");
      parsed.configPath = value;
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
  if (args.command !== "investigate") {
    throw new Error(`Unknown or missing command: ${args.command ?? "<none>"}`);
  }
  if (!args.report?.trim()) {
    throw new Error("Missing required --report.");
  }

  const config = loadConfig(args.configPath);
  const result = investigate(args.report, config);

  if (args.ai) {
    const aiProvider = createAiProviderFromEnv();
    try {
      result.ai = await aiProvider.reason(buildAiReasonerRequest(result));
    } catch (error) {
      result.warnings.push(
        `AI reasoning failed with provider ${aiProvider.name}: ${(error as Error).message}`,
      );
    }
  }

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
