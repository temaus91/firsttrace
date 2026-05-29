import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../shell.js";
import type { ArchiveRepoConfig, SearchableRepoConfig } from "../types.js";

export type ArchiveRepoMaterializer = {
  materialize(repo: ArchiveRepoConfig): Promise<SearchableRepoConfig>;
};

type ShellRunner = (
  cwd: string,
  command: string,
  args: string[],
  options?: { displayArgs?: string[]; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number },
) => CommandResult;

export class CommandArchiveRepoMaterializer implements ArchiveRepoMaterializer {
  private readonly runner: ShellRunner;
  private readonly timeoutMs: number;

  constructor({
    runner = runCommand,
    timeoutMs = 5 * 60 * 1000,
  }: {
    runner?: ShellRunner;
    timeoutMs?: number;
  } = {}) {
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async materialize(repo: ArchiveRepoConfig): Promise<SearchableRepoConfig> {
    mkdirSync(path.dirname(repo.path), { recursive: true });
    const env = {
      ...process.env,
      FIRSTTRACE_ARCHIVE_REPO_NAME: repo.name,
      FIRSTTRACE_ARCHIVE_REPO_PATH: repo.path,
      FIRSTTRACE_ARCHIVE_REPO_REF: repo.ref ?? "",
    };
    try {
      this.runner(repo.commandCwd, "sh", ["-lc", repo.archiveCommand], {
        displayArgs: ["-lc", "<archive_command>"],
        env,
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      throw new Error(`Failed to materialize archive repo ${repo.name}: ${(error as Error).message}`);
    }

    if (!existsSync(repo.path) || !statSync(repo.path).isDirectory()) {
      throw new Error(`Archive repo ${repo.name} command did not create directory: ${repo.path}`);
    }

    return {
      defaultBranch: repo.ref,
      name: repo.name,
      path: repo.path,
      provider: "local",
      sourceProvider: "archive",
    };
  }
}
