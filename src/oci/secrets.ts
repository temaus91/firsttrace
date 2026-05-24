const DEFAULT_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_MODEL_CHAT",
  "FIRSTTRACE_AI_PROVIDER",
  "FIRSTTRACE_INVESTIGATOR",
  "FIRSTTRACE_RECEIVER_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
];

const secretNamesFromEnv = (env: NodeJS.ProcessEnv) =>
  (env.OCI_VAULT_SECRET_NAMES?.trim()
    ? env.OCI_VAULT_SECRET_NAMES.split(",")
    : DEFAULT_SECRET_NAMES
  )
    .map((name) => name.trim())
    .filter(Boolean);

const createAuthProvider = async (env: NodeJS.ProcessEnv) => {
  const ociCommon = await import("oci-common");
  if (env.OCI_RESOURCE_PRINCIPAL_VERSION) {
    return ociCommon.ResourcePrincipalAuthenticationDetailsProvider.builder();
  }

  return new ociCommon.ConfigFileAuthenticationDetailsProvider(
    env.OCI_CONFIG_FILE,
    env.OCI_CONFIG_PROFILE ?? "DEFAULT",
  );
};

const decodedSecretContent = (content?: string) =>
  content === undefined ? undefined : Buffer.from(content, "base64").toString("utf8");

const errorStatus = (error: unknown) => {
  const value = error as { statusCode?: number; status?: number };
  return value.statusCode ?? value.status;
};

export const loadOciVaultSecretsIntoEnv = async (env: NodeJS.ProcessEnv = process.env) => {
  const vaultId = env.OCI_VAULT_ID?.trim();
  if (!vaultId) return [];

  const ociSecrets = await import("oci-secrets");
  const client = new ociSecrets.SecretsClient({ authenticationDetailsProvider: await createAuthProvider(env) });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;

  const loaded: string[] = [];
  for (const name of secretNamesFromEnv(env)) {
    if (env[name]?.trim()) continue;
    const response = await client
      .getSecretBundleByName({
        secretName: name,
        stage: ociSecrets.requests.GetSecretBundleByNameRequest.Stage.Current,
        vaultId,
      })
      .catch((error: unknown) => {
        if (errorStatus(error) === 404) {
          throw new Error(`OCI Vault secret ${name} is missing. Remove it from OCI_VAULT_SECRET_NAMES or create it.`);
        }
        throw error;
      });
    const value = decodedSecretContent(response.secretBundle.secretBundleContent?.content);
    if (value !== undefined) {
      env[name] = value;
      loaded.push(name);
    }
  }
  return loaded;
};
