import { createOpenAiProvider } from "./openai-provider.js";
import { createOciGenAiProviderFromConfig } from "./oci-genai-provider.js";
import { resolveAiRequestOptions } from "./request-options.js";
import type { AiProvider, AiRequestConfig } from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_OCI_GENAI_MODEL = "openai.gpt-5-codex";

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
      : undefined) ||
    DEFAULT_OCI_GENAI_MODEL;
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
  region?: string;
};

export const ociGenAiConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): OciGenAiEnvConfig => {
  const compartmentId = trimmedEnv(env, "OCI_COMPARTMENT_ID");
  if (!compartmentId) {
    throw new Error("OCI_COMPARTMENT_ID is required when FIRSTTRACE_AI_PROVIDER=oci-genai.");
  }
  return {
    compartmentId,
    dedicatedEndpointId: trimmedEnv(env, "OCI_GENAI_DEDICATED_ENDPOINT_ID"),
    endpoint: trimmedEnv(env, "OCI_GENAI_ENDPOINT"),
    region: trimmedEnv(env, "OCI_GENAI_REGION") || trimmedEnv(env, "OCI_REGION"),
  };
};

export type CreateAiProviderFromEnvOptions = {
  requestConfig?: AiRequestConfig;
};

export const createAiProviderFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  options: CreateAiProviderFromEnvOptions = {},
): AiProvider => {
  const providerName = aiModelProviderFromEnv(env);
  const model = resolveChatModelFromEnv(env, providerName);
  const requestOptions = resolveAiRequestOptions({
    config: options.requestConfig,
    env,
    model,
    provider: providerName,
  });

  if (providerName === "oci-genai") {
    return createOciGenAiProviderFromConfig({
      ...ociGenAiConfigFromEnv(env),
      env,
      model,
      requestOptions,
      resultProviderName: "evidence",
    });
  }

  return createOpenAiProvider({
    apiKey: requireOpenAiApiKey(env),
    env,
    model,
    requestOptions,
    resultProviderName: "evidence",
  });
};
