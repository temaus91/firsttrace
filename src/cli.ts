import path from "node:path";
import { loadConfig } from "./config.js";
import { investigate } from "./investigate.js";
import { renderInvestigation } from "./render.js";

type ParsedArgs = {
  command?: string;
  configPath: string;
  help: boolean;
  report?: string;
};

const usage = () => `Usage:
  npm run firsttrace -- investigate --config firsttrace.config.yaml --report "bug text"

Options:
  --config <path>   Path to a FirstTrace YAML config. Defaults to firsttrace.config.yaml.
  --report <text>   Bug report or feedback text to investigate.
  --help            Show this message.`;

const parseArgs = (argv: string[]): ParsedArgs => {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return {
      configPath: path.resolve("firsttrace.config.yaml"),
      help: true,
    };
  }

  const parsed: ParsedArgs = {
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

const main = () => {
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
  console.log(renderInvestigation(result));
};

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  console.error("");
  console.error(usage());
  process.exit(1);
}
