import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_VERSION = "v0";
const MAX_TIMESTAMP_AGE_SECONDS = 60 * 5;

export type SlackSignatureVerificationInput = {
  body: string;
  nowSeconds?: number;
  signature?: string | null;
  signingSecret: string;
  timestamp?: string | null;
};

const safeCompare = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

export const createSlackSignature = (signingSecret: string, timestamp: string, body: string) => {
  const baseString = `${SIGNATURE_VERSION}:${timestamp}:${body}`;
  const digest = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return `${SIGNATURE_VERSION}=${digest}`;
};

export const verifySlackRequestSignature = ({
  body,
  nowSeconds = Math.floor(Date.now() / 1000),
  signature,
  signingSecret,
  timestamp,
}: SlackSignatureVerificationInput) => {
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_AGE_SECONDS) return false;

  return safeCompare(createSlackSignature(signingSecret, timestamp, body), signature);
};
