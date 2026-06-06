import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { runCommand, type CommandResult } from "../shell.js";
import type { GitRepoConfig, SearchableRepoConfig } from "../types.js";

export type GenericGitRepoMaterializer = {
  materialize(repo: GitRepoConfig): Promise<SearchableRepoConfig>;
};

type GitRunner = (
  cwd: string,
  args: string[],
  options?: { displayArgs?: string[]; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeoutMs?: number },
) => CommandResult;

type GitCommandContext = {
  argsPrefix: string[];
  displayArgsPrefix: string[];
  env?: NodeJS.ProcessEnv;
  remoteUrl: string;
  safeRemoteUrl: string;
  sensitiveValues: string[];
};

export const safeGitRemoteUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url.replace(/(https?:\/\/)[^/@\s]+@/i, "$1");
  }
};

export const gitBasicAuthHeader = (username: string, token: string) =>
  `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;

export const redactGitArgs = (args: string[], sensitiveValues: string[]) =>
  args.map((arg) => {
    let redacted = arg.replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, "Authorization: Basic <redacted>");
    for (const value of sensitiveValues.filter(Boolean)) {
      redacted = redacted.replaceAll(value, "<redacted>");
    }
    return redacted;
  });

const depthArgs = (cloneDepth: GitRepoConfig["cloneDepth"]) =>
  cloneDepth === "full" ? [] : ["--depth", String(cloneDepth)];

const gitDirAvailable = (repoPath: string) => {
  const gitDir = path.join(repoPath, ".git");
  return existsSync(gitDir) && statSync(gitDir).isDirectory();
};

const looksLikeCommitSha = (value: string) => /^[a-f0-9]{7,40}$/i.test(value);

const tokenCredentialContext = (repo: GitRepoConfig, env: NodeJS.ProcessEnv): GitCommandContext => {
  const token = env[repo.credential?.type === "token" ? repo.credential.tokenEnv : ""]?.trim();
  if (!token) {
    throw new Error(`Git repo ${repo.name} requires token env ${repo.credential?.type === "token" ? repo.credential.tokenEnv : ""}.`);
  }
  const usernameEnv = repo.credential?.type === "token" ? repo.credential.usernameEnv : undefined;
  const username = usernameEnv ? env[usernameEnv]?.trim() || "x-access-token" : "x-access-token";
  const header = gitBasicAuthHeader(username, token);
  return {
    argsPrefix: ["-c", `http.extraHeader=${header}`],
    displayArgsPrefix: ["-c", "http.extraHeader=Authorization: Basic <redacted>"],
    remoteUrl: safeGitRemoteUrl(repo.url),
    safeRemoteUrl: safeGitRemoteUrl(repo.url),
    sensitiveValues: [token, header],
  };
};

const sshCredentialContext = (repo: GitRepoConfig, env: NodeJS.ProcessEnv): GitCommandContext => {
  if (repo.credential?.type !== "ssh") {
    return {
      argsPrefix: [],
      displayArgsPrefix: [],
      remoteUrl: repo.url,
      safeRemoteUrl: safeGitRemoteUrl(repo.url),
      sensitiveValues: [repo.url === safeGitRemoteUrl(repo.url) ? "" : repo.url],
    };
  }

  const keyFile = repo.credential.keyFileEnv ? env[repo.credential.keyFileEnv]?.trim() : repo.credential.keyFile;
  const command = repo.credential.commandEnv ? env[repo.credential.commandEnv]?.trim() : undefined;
  const gitSshCommand = command || (keyFile ? `ssh -i "${keyFile}" -o IdentitiesOnly=yes` : undefined);
  return {
    argsPrefix: [],
    displayArgsPrefix: [],
    env: gitSshCommand ? { ...env, GIT_SSH_COMMAND: gitSshCommand } : env,
    remoteUrl: repo.url,
    safeRemoteUrl: safeGitRemoteUrl(repo.url),
    sensitiveValues: [keyFile ?? "", gitSshCommand ?? "", repo.url === safeGitRemoteUrl(repo.url) ? "" : repo.url],
  };
};

const commandContext = (repo: GitRepoConfig, env: NodeJS.ProcessEnv): GitCommandContext => {
  if (repo.credential?.type === "token") return tokenCredentialContext(repo, env);
  return sshCredentialContext(repo, env);
};

export class CommandGitRepoMaterializer implements GenericGitRepoMaterializer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: GitRunner;
  private readonly timeoutMs: number;

  constructor({
    env = process.env,
    runner = (cwd, args, options) => runCommand(cwd, "git", args, options),
    timeoutMs = 10 * 60 * 1000,
  }: {
    env?: NodeJS.ProcessEnv;
    runner?: GitRunner;
    timeoutMs?: number;
  } = {}) {
    this.env = env;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async materialize(repo: GitRepoConfig): Promise<SearchableRepoConfig> {
    const context = commandContext(repo, this.env);
    mkdirSync(path.dirname(repo.path), { recursive: true });

    try {
      if (!existsSync(repo.path)) {
        this.run(path.dirname(repo.path), context, [
          "clone",
          ...depthArgs(repo.cloneDepth),
          context.remoteUrl,
          repo.path,
        ]);
      } else if (!gitDirAvailable(repo.path)) {
        throw new Error(`Git cache path exists but is not a git repository: ${repo.path}`);
      }

      if (repo.materialization.scrubRemoteCredentials) {
        this.runner(repo.path, ["remote", "set-url", "origin", context.safeRemoteUrl], {
          displayArgs: ["remote", "set-url", "origin", context.safeRemoteUrl],
          env: context.env,
          timeoutMs: this.timeoutMs,
        });
      }

      this.fetchAndCheckout(repo, context);
    } catch (error) {
      throw new Error(
        `Failed to materialize git repo ${repo.name}. Verify the read-only repository URL, ref, and credentials: ${(error as Error).message}`,
      );
    }

    return {
      cloneDepth: repo.cloneDepth,
      lastRefreshStatus: "succeeded",
      name: repo.name,
      path: repo.path,
      provider: "local",
      ref: repo.ref,
      sourceProvider: "git",
    };
  }

  private fetchAndCheckout(repo: GitRepoConfig, context: GitCommandContext) {
    const ref = repo.ref ?? "HEAD";
    if (looksLikeCommitSha(ref)) {
      this.run(repo.path, context, ["fetch", ...depthArgs(repo.cloneDepth), context.remoteUrl]);
      this.runner(repo.path, ["checkout", "--detach", ref], {
        displayArgs: ["checkout", "--detach", ref],
        env: context.env,
        timeoutMs: this.timeoutMs,
      });
      return;
    }

    this.run(repo.path, context, ["fetch", ...depthArgs(repo.cloneDepth), context.remoteUrl, ref]);
    this.runner(repo.path, ["checkout", "--detach", "FETCH_HEAD"], {
      displayArgs: ["checkout", "--detach", "FETCH_HEAD"],
      env: context.env,
      timeoutMs: this.timeoutMs,
    });
  }

  private run(cwd: string, context: GitCommandContext, args: string[]) {
    const fullArgs = [...context.argsPrefix, ...args];
    this.runner(cwd, fullArgs, {
      displayArgs: redactGitArgs([...context.displayArgsPrefix, ...args], context.sensitiveValues),
      env: context.env,
      timeoutMs: this.timeoutMs,
    });
  }
}
