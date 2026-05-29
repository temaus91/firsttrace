import type { JsonObjectStore } from "./object-store.js";
import { OciObjectJsonStore } from "./object-store.js";

const requireEnv = (name: string, env: NodeJS.ProcessEnv = process.env) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for OCI runtime.`);
  return value;
};

export const createOciAuthProvider = async (env: NodeJS.ProcessEnv = process.env) => {
  const ociCommon = await import("oci-common");
  if (env.OCI_RESOURCE_PRINCIPAL_VERSION) {
    return ociCommon.ResourcePrincipalAuthenticationDetailsProvider.builder();
  }

  return new ociCommon.ConfigFileAuthenticationDetailsProvider(
    env.OCI_CONFIG_FILE,
    env.OCI_CONFIG_PROFILE ?? "DEFAULT",
  );
};

export const createOciQueueClientFromEnv = async (env: NodeJS.ProcessEnv = process.env) => {
  const ociQueue = await import("oci-queue");
  const client = new ociQueue.QueueClient({ authenticationDetailsProvider: await createOciAuthProvider(env) });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;
  const endpoint = env.OCI_QUEUE_MESSAGES_ENDPOINT?.trim();
  if (endpoint) client.endpoint = endpoint;
  return client;
};

export const createOciObjectStoreFromEnv = async (env: NodeJS.ProcessEnv = process.env): Promise<JsonObjectStore> => {
  const ociObjectStorage = await import("oci-objectstorage");
  const client = new ociObjectStorage.ObjectStorageClient({
    authenticationDetailsProvider: await createOciAuthProvider(env),
  });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;
  return new OciObjectJsonStore(client, {
    bucketName: requireEnv("OCI_OBJECTSTORAGE_BUCKET", env),
    namespaceName: requireEnv("OCI_OBJECTSTORAGE_NAMESPACE", env),
  });
};

export const requiredOciQueueIdFromEnv = (env: NodeJS.ProcessEnv = process.env) => requireEnv("OCI_QUEUE_ID", env);
