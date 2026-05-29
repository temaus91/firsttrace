import { createOpenAiProvider } from "./openai-provider.js";
import { createOciGenAiProviderFromConfig } from "./oci-genai-provider.js";
import type { AiProvider } from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";

export type AiModelProviderName = "openai" | "oci-genai";

const normalizeAiProviderName = (value?: string): AiModelProviderName => {
  const provider = (value ?? "openai").trim().toLowerCase();
  if (provider === "openai") return "openai";
  if (provider === "oci" || provider === "oci-genai" || provider === "oracle-genai") return "oci-genai";
  throw new Error(
    `Unsupported AI provider: ${provider}. Expected FIRSTTRACE_AI_PROVIDER=openai or oci-genai.`,
  );
};

export const aiModelProviderFromEnv = (env: NodeJS.ProcessEnv = process.env): AiModelProviderName =>
  normalizeAiProviderName(env.FIRSTTRACE_AI_PROVIDER);

const trimmedEnv = (env: NodeJS.ProcessEnv, name: string) => env[name]?.trim() || undefined;

export const resolveOpenAiModelFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  trimmedEnv(env, "FIRSTTRACE_MODEL_CHAT") || trimmedEnv(env, "OPENAI_MODEL_CHAT") || DEFAULT_OPENAI_MODEL;

export const resolveOciGenAiModelFromEnv = (env: NodeJS.ProcessEnv = process.env) => {
  const model = trimmedEnv(env, "FIRSTTRACE_MODEL_CHAT") ||
    trimmedEnv(env, "OCI_GENAI_MODEL_ID") ||
    (trimmedEnv(env, "OPENAI_MODEL_CHAT") && trimmedEnv(env, "OPENAI_MODEL_CHAT") !== DEFAULT_OPENAI_MODEL
      ? trimmedEnv(env, "OPENAI_MODEL_CHAT")
      : undefined);
  if (!model) {
    throw new Error(
      "FIRSTTRACE_MODEL_CHAT or OCI_GENAI_MODEL_ID is required when FIRSTTRACE_AI_PROVIDER=oci-genai.",
    );
  }
  return model;
};

export const resolveChatModelFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  provider: AiModelProviderName = aiModelProviderFromEnv(env),
) => provider === "oci-genai" ? resolveOciGenAiModelFromEnv(env) : resolveOpenAiModelFromEnv(env);

export const requireOpenAiApiKey = (env: NodeJS.ProcessEnv = process.env) => {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when --ai is enabled.");
  }
  return apiKey;
};

export type OciGenAiEnvConfig = {
  compartmentId: string;
  dedicatedEndpointId?: string;
  endpoint?: string;
  maxTokens?: number;
  region?: string;
};

export const ociGenAiConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): OciGenAiEnvConfig => {
  const compartmentId = trimmedEnv(env, "OCI_COMPARTMENT_ID");
  if (!compartmentId) {
    throw new Error("OCI_COMPARTMENT_ID is required when FIRSTTRACE_AI_PROVIDER=oci-genai.");
  }
  const maxTokensRaw = trimmedEnv(env, "FIRSTTRACE_AI_MAX_TOKENS");
  let maxTokens: number | undefined;
  if (maxTokensRaw) {
    const parsedMaxTokens = Number.parseInt(maxTokensRaw, 10);
    if (!Number.isFinite(parsedMaxTokens) || parsedMaxTokens <= 0) {
      throw new Error("FIRSTTRACE_AI_MAX_TOKENS must be a positive integer.");
    }
    maxTokens = parsedMaxTokens;
  }
  return {
    compartmentId,
    dedicatedEndpointId: trimmedEnv(env, "OCI_GENAI_DEDICATED_ENDPOINT_ID"),
    endpoint: trimmedEnv(env, "OCI_GENAI_ENDPOINT"),
    maxTokens,
    region: trimmedEnv(env, "OCI_REGION"),
  };
};

export const createAiProviderFromEnv = (env: NodeJS.ProcessEnv = process.env): AiProvider => {
  const providerName = aiModelProviderFromEnv(env);
  const model = resolveChatModelFromEnv(env, providerName);

  if (providerName === "oci-genai") {
    return createOciGenAiProviderFromConfig({
      ...ociGenAiConfigFromEnv(env),
      env,
      model,
      resultProviderName: "evidence",
    });
  }

  return createOpenAiProvider({
    apiKey: requireOpenAiApiKey(env),
    model,
    resultProviderName: "evidence",
  });
};
