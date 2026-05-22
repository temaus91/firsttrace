import { createAppAuth } from "@octokit/auth-app";

export type GitHubAppCredentials = {
  appId: string;
  installationId: string;
  privateKey: string;
};

export type GitHubInstallationTokenProvider = {
  getInstallationToken(repositoryName: string): Promise<string>;
};

export const normalizeGitHubPrivateKey = (privateKey: string) => privateKey.replace(/\\n/g, "\n").trim();

export const readGitHubTokenFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();

export const readGitHubAppCredentialsFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): GitHubAppCredentials => {
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;

  const missing = [
    appId ? undefined : "GITHUB_APP_ID",
    installationId ? undefined : "GITHUB_APP_INSTALLATION_ID",
    privateKey?.trim() ? undefined : "GITHUB_APP_PRIVATE_KEY",
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Missing GitHub App environment variables: ${missing.join(", ")}.`);
  }

  return {
    appId: appId as string,
    installationId: installationId as string,
    privateKey: normalizeGitHubPrivateKey(privateKey as string),
  };
};

export class GitHubAppInstallationTokenProvider implements GitHubInstallationTokenProvider {
  private readonly credentials: GitHubAppCredentials;

  constructor(credentials = readGitHubAppCredentialsFromEnv()) {
    this.credentials = credentials;
  }

  async getInstallationToken(repositoryName: string): Promise<string> {
    const auth = createAppAuth({
      appId: this.credentials.appId,
      privateKey: this.credentials.privateKey,
    });
    const installationAuth = await auth({
      type: "installation",
      installationId: this.credentials.installationId,
      permissions: { contents: "read" },
      refresh: true,
      repositoryNames: [repositoryName],
    });

    return installationAuth.token;
  }
}

export class StaticGitHubTokenProvider implements GitHubInstallationTokenProvider {
  constructor(private readonly token: string) {}

  async getInstallationToken(): Promise<string> {
    return this.token;
  }
}

export const createGitHubTokenProviderFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  if (env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_INSTALLATION_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim()) {
    return new GitHubAppInstallationTokenProvider(readGitHubAppCredentialsFromEnv(env));
  }

  const token = readGitHubTokenFromEnv(env);
  if (token) return new StaticGitHubTokenProvider(token);

  return new GitHubAppInstallationTokenProvider(readGitHubAppCredentialsFromEnv(env));
};
