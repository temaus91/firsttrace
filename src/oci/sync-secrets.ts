import { loadLocalEnv } from "../env.js";
import { createOciAuthProvider } from "./auth.js";

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

const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const secretNames = () =>
  (process.env.OCI_VAULT_SECRET_NAMES?.trim()
    ? process.env.OCI_VAULT_SECRET_NAMES.split(",")
    : DEFAULT_SECRET_NAMES
  )
    .map((name) => name.trim())
    .filter(Boolean);

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

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

export const syncOciVaultSecretsFromEnv = async () => {
  loadLocalEnv();
  const ociVault = await import("oci-vault");
  const client = new ociVault.VaultsClient({ authenticationDetailsProvider: await createOciAuthProvider() });
  const region = process.env.OCI_REGION?.trim();
  if (region) client.regionId = region;

  const compartmentId = requiredEnv("OCI_COMPARTMENT_ID");
  const keyId = requiredEnv("OCI_VAULT_KEY_ID");
  const vaultId = requiredEnv("OCI_VAULT_ID");
  const synced: string[] = [];
  const skipped: string[] = [];

  for (const name of secretNames()) {
    const value = process.env[name];
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

if (import.meta.url === `file://${process.argv[1]}`) {
  await syncOciVaultSecretsFromEnv();
}
