#!/usr/bin/env node

import crypto from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { createOciAuthProvider } from "./auth.js";

const DEFAULT_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL_CHAT",
  "FIRSTTRACE_RECEIVER_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
];

const REQUIRED_OCI_ENV_NAMES = ["OCI_COMPARTMENT_ID", "OCI_REGION", "OCI_VAULT_ID", "OCI_VAULT_KEY_ID"] as const;
const DEFAULT_MODEL = "gpt-5.4-mini";

export type OciSyncSecretsArgs = {
  envFile?: string;
  help: boolean;
  mode: "env" | "env-file" | "prompt";
};

type PromptStreams = {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
};

const requiredEnv = (name: string, env: NodeJS.ProcessEnv = process.env) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export const secretNamesFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  (env.OCI_VAULT_SECRET_NAMES?.trim()
    ? env.OCI_VAULT_SECRET_NAMES.split(",")
    : DEFAULT_SECRET_NAMES
  )
    .map((name) => name.trim())
    .filter(Boolean);

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
const generateReceiverToken = () => crypto.randomBytes(32).toString("base64url");

export const parseSyncSecretsArgs = (argv: string[] = process.argv.slice(2)): OciSyncSecretsArgs => {
  const parsed: OciSyncSecretsArgs = { help: false, mode: "env" };
  let envFileSeen = false;
  let promptSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--prompt") {
      promptSeen = true;
      parsed.mode = "prompt";
      continue;
    }
    if (arg === "--env-file") {
      const value = argv[index + 1];
      if (!value) throw new Error("--env-file requires a path.");
      envFileSeen = true;
      parsed.envFile = value;
      parsed.mode = "env-file";
      index += 1;
      continue;
    }
    if (arg?.startsWith("--env-file=")) {
      envFileSeen = true;
      parsed.envFile = arg.slice("--env-file=".length);
      parsed.mode = "env-file";
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (promptSeen && envFileSeen) {
    throw new Error("--prompt and --env-file cannot be used together.");
  }

  return parsed;
};

const usage = () => `Usage:
  firsttrace-oci-sync-secrets
  firsttrace-oci-sync-secrets --env-file ./secrets.env
  firsttrace-oci-sync-secrets --prompt

Modes:
  default      Read secrets from shell environment.
  --env-file   Read secrets from an explicit dotenv file.
  --prompt     Prompt interactively and sync secrets without writing them to disk.
`;

export const loadEnvFileValues = (filePath: string) => {
  if (!existsSync(filePath)) throw new Error(`Env file does not exist: ${filePath}`);
  return parseDotenv(readFileSync(filePath));
};

const activeSecretId = async (
  client: import("oci-vault").VaultsClient,
  {
    compartmentId,
    name,
    vaultId,
  }: {
    compartmentId: string;
    name: string;
    vaultId: string;
  },
) => {
  const response = await client.listSecrets({
    compartmentId,
    lifecycleState: "ACTIVE",
    limit: 1,
    name,
    vaultId,
  });
  return response.items[0]?.id;
};

export const syncOciVaultSecretsFromValues = async (
  values: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const ociVault = await import("oci-vault");
  const client = new ociVault.VaultsClient({ authenticationDetailsProvider: await createOciAuthProvider(env) });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;

  const compartmentId = requiredEnv("OCI_COMPARTMENT_ID", env);
  const keyId = requiredEnv("OCI_VAULT_KEY_ID", env);
  const vaultId = requiredEnv("OCI_VAULT_ID", env);
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const name of secretNamesFromEnv(env)) {
    const value = values[name];
    if (!value) {
      skipped.push(name);
      continue;
    }

    const secretContent = {
      content: base64(value),
      contentType: "BASE64",
    };
    const existingId = await activeSecretId(client, { compartmentId, name, vaultId });
    if (existingId) {
      await client.updateSecret({
        secretId: existingId,
        updateSecretDetails: {
          secretContent,
        },
      });
    } else {
      await client.createSecret({
        createSecretDetails: {
          compartmentId,
          description: `Runtime secret ${name} for FirstTrace.`,
          keyId,
          secretContent,
          secretName: name,
          vaultId,
        },
      });
    }
    synced.push(name);
  }

  console.info(`Synced ${synced.length} OCI Vault secrets.`);
  if (skipped.length) {
    console.info(`Skipped ${skipped.length} missing env values: ${skipped.join(", ")}.`);
  }
};

export const syncOciVaultSecretsFromEnv = async (env: NodeJS.ProcessEnv = process.env) => {
  await syncOciVaultSecretsFromValues(env, env);
};

export const syncOciVaultSecretsFromEnvFile = async (filePath: string, env: NodeJS.ProcessEnv = process.env) => {
  const values = { ...env, ...loadEnvFileValues(filePath) };
  Object.assign(env, values);
  await syncOciVaultSecretsFromValues(values, env);
};

const writeLine = (output: NodeJS.WriteStream, value = "") => {
  output.write(`${value}\n`);
};

const promptLine = async (
  rl: Interface,
  question: string,
  { hidden = false, output = process.stdout }: { hidden?: boolean; output?: NodeJS.WriteStream } = {},
) => {
  if (!hidden) return rl.question(question);

  const mutable = rl as Interface & {
    _writeToOutput?: (value: string) => void;
    stdoutMuted?: boolean;
  };
  const originalWrite = mutable._writeToOutput;
  mutable._writeToOutput = (value: string) => {
    if (!mutable.stdoutMuted) {
      if (originalWrite) originalWrite.call(rl, value);
      else output.write(value);
    }
  };
  output.write(question);
  mutable.stdoutMuted = true;
  try {
    return await rl.question("");
  } finally {
    mutable.stdoutMuted = false;
    mutable._writeToOutput = originalWrite;
    writeLine(output);
  }
};

const promptMultilineSecret = async (rl: Interface, name: string, output: NodeJS.WriteStream) => {
  writeLine(output, `${name}: paste multiline value. Finish with a line containing only END.`);
  const lines: string[] = [];
  while (true) {
    const line = await promptLine(rl, "> ", { hidden: true, output });
    if (line === "END") break;
    lines.push(line);
  }
  return lines.join("\n").trim();
};

const promptSecretValue = async (
  rl: Interface,
  name: string,
  env: NodeJS.ProcessEnv,
  output: NodeJS.WriteStream,
) => {
  if (env[name]?.trim()) return env[name];

  if (name === "OPENAI_MODEL_CHAT") {
    const value = await promptLine(rl, `${name} (${DEFAULT_MODEL}): `, { output });
    return value.trim() || DEFAULT_MODEL;
  }

  if (name === "FIRSTTRACE_RECEIVER_TOKEN") {
    const value = await promptLine(rl, `${name} (press Enter to generate): `, { hidden: true, output });
    if (value.trim()) return value;
    const generated = generateReceiverToken();
    writeLine(output, `Generated ${name}.`);
    return generated;
  }

  if (name === "GITHUB_APP_ID" || name === "GITHUB_APP_INSTALLATION_ID") {
    return promptLine(rl, `${name}: `, { output });
  }

  if (name === "GITHUB_APP_PRIVATE_KEY") {
    return promptMultilineSecret(rl, name, output);
  }

  return promptLine(rl, `${name}: `, { hidden: true, output });
};

const promptMissingOciEnv = async (rl: Interface, env: NodeJS.ProcessEnv, output: NodeJS.WriteStream) => {
  for (const name of REQUIRED_OCI_ENV_NAMES) {
    if (env[name]?.trim()) continue;
    env[name] = await promptLine(rl, `${name}: `, { output });
  }
};

export const collectPromptSecretValues = async (
  env: NodeJS.ProcessEnv = process.env,
  { input = process.stdin, output = process.stdout }: PromptStreams = {},
) => {
  const rl = createInterface({ input, output, terminal: Boolean(output.isTTY) });
  try {
    writeLine(output, "FirstTrace OCI secret setup");
    writeLine(output);
    await promptMissingOciEnv(rl, env, output);

    const values: Record<string, string | undefined> = {};
    for (const name of secretNamesFromEnv(env)) {
      values[name] = await promptSecretValue(rl, name, env, output);
    }

    writeLine(output);
    writeLine(output, "Review:");
    for (const name of secretNamesFromEnv(env)) {
      const value = values[name]?.trim();
      const display = name === "OPENAI_MODEL_CHAT" || name.endsWith("_ID") ? value || "missing" : value ? "set" : "missing";
      writeLine(output, `${name.padEnd(32)} ${display}`);
    }
    writeLine(output);

    const confirm = await promptLine(rl, "Sync these secrets to OCI Vault? (yes/no): ", { output });
    if (confirm.trim().toLowerCase() !== "yes") throw new Error("Secret sync canceled.");

    return values;
  } finally {
    rl.close();
  }
};

export const syncOciVaultSecretsFromPrompt = async (
  env: NodeJS.ProcessEnv = process.env,
  streams: PromptStreams = {},
) => {
  const values = await collectPromptSecretValues(env, streams);
  await syncOciVaultSecretsFromValues(values, env);
};

export const runSyncSecretsCli = async (argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) => {
  const args = parseSyncSecretsArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  if (args.mode === "prompt") {
    await syncOciVaultSecretsFromPrompt(env);
    return;
  }

  if (args.mode === "env-file") {
    await syncOciVaultSecretsFromEnvFile(args.envFile!, env);
    return;
  }

  await syncOciVaultSecretsFromEnv(env);
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
  await runSyncSecretsCli();
}
