import { randomUUID } from "node:crypto";
import { createOciAuthProvider } from "./auth.js";

type EnvRecord = Record<string, string | undefined>;

export type OciRedeliveryProbeResult = {
  deliveryCount?: number;
  messageId?: number | string;
  queueId?: string;
  queueName?: string;
};

type QueueSummary = {
  displayName?: string;
  id: string;
  lifecycleState?: string;
  messagesEndpoint?: string;
};

type QueueMessage = {
  content: string;
  deliveryCount?: number;
  id?: number | string;
  receipt: string;
};

export type OciRedeliveryProbeAdminClient = {
  createQueue(request: {
    createQueueDetails: {
      compartmentId: string;
      deadLetterQueueDeliveryCount?: number;
      displayName: string;
      retentionInSeconds?: number;
      timeoutInSeconds?: number;
      visibilityInSeconds?: number;
    };
    opcRetryToken?: string;
  }): Promise<unknown>;
  deleteQueue(request: { queueId: string }): Promise<unknown>;
  listQueues(request: {
    compartmentId: string;
    displayName?: string;
    lifecycleState?: string;
    limit?: number;
  }): Promise<{ queueCollection: { items: QueueSummary[] } }>;
};

export type OciRedeliveryProbeQueueClient = {
  deleteMessage(request: { messageReceipt: string; queueId: string }): Promise<unknown>;
  getMessages(request: {
    limit?: number;
    queueId: string;
    timeoutInSeconds?: number;
    visibilityInSeconds?: number;
  }): Promise<{ getMessages: { messages: QueueMessage[] } }>;
  putMessages(request: {
    queueId: string;
    putMessagesDetails: { messages: Array<{ content: string }> };
  }): Promise<unknown>;
};

export type OciRedeliveryProbeOptions = {
  adminClient?: OciRedeliveryProbeAdminClient;
  env?: EnvRecord;
  queueClient?: OciRedeliveryProbeQueueClient;
  queueName?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  visibilityTimeoutSeconds?: number;
  waitAfterClaimMs?: number;
};

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_VISIBILITY_SECONDS = 5;
const DEFAULT_WAIT_AFTER_CLAIM_MS = 6_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const requireEnv = (env: EnvRecord, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for OCI Queue redelivery acceptance.`);
  return value;
};

const createDefaultAdminClient = async (env: EnvRecord): Promise<OciRedeliveryProbeAdminClient> => {
  const ociQueue = await import("oci-queue");
  const client = new ociQueue.QueueAdminClient({ authenticationDetailsProvider: await createOciAuthProvider(env) });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;
  return client as OciRedeliveryProbeAdminClient;
};

const createDefaultQueueClient = async (
  env: EnvRecord,
  messagesEndpoint: string,
): Promise<OciRedeliveryProbeQueueClient> => {
  const ociQueue = await import("oci-queue");
  const client = new ociQueue.QueueClient({ authenticationDetailsProvider: await createOciAuthProvider(env) });
  const region = env.OCI_REGION?.trim();
  if (region) client.regionId = region;
  client.endpoint = messagesEndpoint;
  return client as OciRedeliveryProbeQueueClient;
};

const isActiveQueue = (queue: QueueSummary) => queue.lifecycleState === "ACTIVE" || queue.lifecycleState === undefined;

const waitForQueue = async (
  adminClient: OciRedeliveryProbeAdminClient,
  compartmentId: string,
  queueName: string,
  deadlineMs: number,
  sleepFn: (ms: number) => Promise<void>,
) => {
  while (Date.now() < deadlineMs) {
    const response = await adminClient.listQueues({
      compartmentId,
      displayName: queueName,
      limit: 10,
    });
    const queue = response.queueCollection.items.find(
      (item) => item.displayName === queueName && item.messagesEndpoint && isActiveQueue(item),
    );
    if (queue) return queue;
    await sleepFn(2_000);
  }
  throw new Error(`Timed out waiting for temporary OCI Queue ${queueName} to become active.`);
};

const claimOne = async (
  queueClient: OciRedeliveryProbeQueueClient,
  queueId: string,
  visibilityTimeoutSeconds: number,
) => {
  const response = await queueClient.getMessages({
    limit: 1,
    queueId,
    timeoutInSeconds: 0,
    visibilityInSeconds: visibilityTimeoutSeconds,
  });
  return response.getMessages.messages[0];
};

const cleanupQueue = async (
  adminClient: OciRedeliveryProbeAdminClient,
  compartmentId: string,
  queueName: string,
  queue?: QueueSummary,
) => {
  const queues = queue
    ? [queue]
    : (
        await adminClient.listQueues({
          compartmentId,
          displayName: queueName,
          limit: 10,
        })
      ).queueCollection.items.filter((item) => item.displayName === queueName);

  for (const item of queues) {
    await adminClient.deleteQueue({ queueId: item.id });
  }
};

export const runOciQueueRedeliveryProbe = async ({
  adminClient,
  env = process.env,
  queueClient,
  queueName = `firsttrace-accept-${randomUUID().slice(0, 8)}`,
  sleep: sleepFn = sleep,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  visibilityTimeoutSeconds = DEFAULT_VISIBILITY_SECONDS,
  waitAfterClaimMs = DEFAULT_WAIT_AFTER_CLAIM_MS,
}: OciRedeliveryProbeOptions = {}): Promise<OciRedeliveryProbeResult> => {
  const compartmentId = requireEnv(env, "OCI_COMPARTMENT_ID");
  const effectiveAdminClient = adminClient ?? (await createDefaultAdminClient(env));
  const deadlineMs = Date.now() + timeoutMs;
  let createdQueue = false;
  let primaryError: unknown;
  let queue: QueueSummary | undefined;

  try {
    await effectiveAdminClient.createQueue({
      createQueueDetails: {
        compartmentId,
        deadLetterQueueDeliveryCount: 0,
        displayName: queueName,
        retentionInSeconds: 600,
        timeoutInSeconds: 0,
        visibilityInSeconds: visibilityTimeoutSeconds,
      },
      opcRetryToken: queueName,
    });
    createdQueue = true;
    queue = await waitForQueue(effectiveAdminClient, compartmentId, queueName, deadlineMs, sleepFn);
    const effectiveQueueClient = queueClient ?? (await createDefaultQueueClient(env, queue.messagesEndpoint!));
    const content = JSON.stringify({ probe: "firsttrace-oci-redelivery", queueName });

    await effectiveQueueClient.putMessages({
      queueId: queue.id,
      putMessagesDetails: { messages: [{ content }] },
    });

    const firstClaim = await claimOne(effectiveQueueClient, queue.id, visibilityTimeoutSeconds);
    if (!firstClaim) throw new Error("Temporary OCI Queue did not return the probe message on first claim.");
    if (firstClaim.content !== content) throw new Error("Temporary OCI Queue returned an unexpected first message.");

    await sleepFn(waitAfterClaimMs);

    const secondClaim = await claimOne(effectiveQueueClient, queue.id, visibilityTimeoutSeconds);
    if (!secondClaim) throw new Error("Temporary OCI Queue did not redeliver the abandoned probe message.");
    if (secondClaim.content !== content) throw new Error("Temporary OCI Queue redelivered an unexpected message.");
    if ((secondClaim.deliveryCount ?? 0) <= (firstClaim.deliveryCount ?? 1)) {
      throw new Error("Temporary OCI Queue redelivered without a valid delivery count.");
    }

    await effectiveQueueClient.deleteMessage({ messageReceipt: secondClaim.receipt, queueId: queue.id });
    return {
      deliveryCount: secondClaim.deliveryCount,
      messageId: secondClaim.id,
      queueId: queue.id,
      queueName,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (createdQueue) {
      try {
        await cleanupQueue(effectiveAdminClient, compartmentId, queueName, queue);
      } catch (error) {
        if (!primaryError) throw error;
        console.error(`Failed to clean up temporary OCI Queue ${queueName}: ${(error as Error).message}`);
      }
    }
  }
};
