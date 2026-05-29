import { spawnSync } from "node:child_process";

export type CommandResult = {
  stderr: string;
  stdout: string;
  status: number;
};

export const runCommand = (
  cwd: string,
  command: string,
  args: string[],
  options: { allowExitCodes?: number[]; displayArgs?: string[]; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number } = {},
): CommandResult => {
  const allowExitCodes = new Set([0, ...(options.allowExitCodes ?? [])]);
  const displayArgs = options.displayArgs ?? args;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    timeout: options.timeoutMs,
  });

  if (result.error) {
    throw new Error(`${command} ${displayArgs.join(" ")} failed: ${result.error.message}`);
  }

  const status = result.status ?? 0;
  if (!allowExitCodes.has(status)) {
    throw new Error(`${command} ${displayArgs.join(" ")} failed with exit ${status}: ${result.stderr}`);
  }

  return {
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
    status,
  };
};
