import type { AiRequestConfig, AiRequestControl, JsonObject, JsonValue } from "../types.js";

export type AiRequestProvider = "oci-genai" | "openai";

export type ResolvedAiRequestOptions = {
  config: AiRequestConfig;
  model: string;
  provider: AiRequestProvider;
};

const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const cloneJsonObject = (value?: JsonObject): JsonObject | undefined =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as JsonObject);

const withControl = <T>(control: AiRequestControl<T> | undefined, patch: Partial<AiRequestControl<T>>) => ({
  ...(control ?? {}),
  ...patch,
});

export const normalizeAiRequestField = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const field = value.trim();
  if (!field || field.toLowerCase() === "none") return "none";
  if (field.toLowerCase() === "auto") return "auto";
  if (!FIELD_PATH_PATTERN.test(field)) {
    throw new Error(`${label} must be auto, none, or a dot-separated request field path.`);
  }
  return field;
};

const envValue = (env: NodeJS.ProcessEnv, ...names: string[]) => {
  for (const name of names) {
    if (hasOwn(env, name)) return env[name] ?? "";
  }
  return undefined;
};

const parseFiniteNumber = (value: string, label: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
  return parsed;
};

const parsePositiveInteger = (value: string, label: string) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
};

const parseNonNegativeInteger = (value: string, label: string) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
};

const parseTopP = (value: string, label: string) => {
  const parsed = parseFiniteNumber(value, label);
  if (parsed < 0 || parsed > 1) throw new Error(`${label} must be between 0 and 1.`);
  return parsed;
};

const parseBoolean = (value: string, label: string) => {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  throw new Error(`${label} must be true or false.`);
};

const parseStopSequences = (value: string, label: string) => {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error(`${label} must be a JSON array of strings.`);
    }
    return parsed;
  }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
};

const parseExtraJson = (value: string, label: string): JsonObject => {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed as JsonObject;
};

const applyValueEnv = <T>(
  config: AiRequestConfig,
  key: keyof AiRequestConfig,
  env: NodeJS.ProcessEnv,
  parser: (value: string, label: string) => T,
  name: string,
  ...aliases: string[]
) => {
  const raw = envValue(env, name, ...aliases);
  if (raw === undefined || !raw.trim()) return;
  (config as Record<string, unknown>)[key] = withControl(config[key] as AiRequestControl<T> | undefined, {
    value: parser(raw, name),
  });
};

const applyFieldEnv = <T>(
  config: AiRequestConfig,
  key: keyof AiRequestConfig,
  env: NodeJS.ProcessEnv,
  name: string,
) => {
  if (!hasOwn(env, name)) return;
  (config as Record<string, unknown>)[key] = withControl(config[key] as AiRequestControl<T> | undefined, {
    field: normalizeAiRequestField(env[name] ?? "", name),
  });
};

export const aiRequestConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
  base: AiRequestConfig = {},
): AiRequestConfig => {
  const config: AiRequestConfig = {
    ...base,
    extra: cloneJsonObject(base.extra),
    outputTokenLimit: base.outputTokenLimit ? { ...base.outputTokenLimit } : undefined,
    reasoningEffort: base.reasoningEffort ? { ...base.reasoningEffort } : undefined,
    stopSequences: base.stopSequences ? { ...base.stopSequences } : undefined,
    store: base.store ? { ...base.store } : undefined,
    temperature: base.temperature ? { ...base.temperature } : undefined,
    topK: base.topK ? { ...base.topK } : undefined,
    topP: base.topP ? { ...base.topP } : undefined,
    verbosity: base.verbosity ? { ...base.verbosity } : undefined,
  };

  applyValueEnv(config, "outputTokenLimit", env, parsePositiveInteger, "FIRSTTRACE_AI_OUTPUT_TOKEN_LIMIT", "FIRSTTRACE_AI_MAX_TOKENS");
  applyFieldEnv<number>(config, "outputTokenLimit", env, "FIRSTTRACE_AI_OUTPUT_TOKEN_LIMIT_FIELD");
  applyValueEnv(config, "temperature", env, parseFiniteNumber, "FIRSTTRACE_AI_TEMPERATURE");
  applyFieldEnv<number>(config, "temperature", env, "FIRSTTRACE_AI_TEMPERATURE_FIELD");
  applyValueEnv(config, "reasoningEffort", env, (value) => value.trim(), "FIRSTTRACE_AI_REASONING_EFFORT");
  applyFieldEnv<string>(config, "reasoningEffort", env, "FIRSTTRACE_AI_REASONING_EFFORT_FIELD");
  applyValueEnv(config, "verbosity", env, (value) => value.trim(), "FIRSTTRACE_AI_VERBOSITY");
  applyFieldEnv<string>(config, "verbosity", env, "FIRSTTRACE_AI_VERBOSITY_FIELD");
  applyValueEnv(config, "topP", env, parseTopP, "FIRSTTRACE_AI_TOP_P");
  applyFieldEnv<number>(config, "topP", env, "FIRSTTRACE_AI_TOP_P_FIELD");
  applyValueEnv(config, "topK", env, parseNonNegativeInteger, "FIRSTTRACE_AI_TOP_K");
  applyFieldEnv<number>(config, "topK", env, "FIRSTTRACE_AI_TOP_K_FIELD");
  applyValueEnv(config, "stopSequences", env, parseStopSequences, "FIRSTTRACE_AI_STOP_SEQUENCES");
  applyFieldEnv<string[]>(config, "stopSequences", env, "FIRSTTRACE_AI_STOP_SEQUENCES_FIELD");
  applyValueEnv(config, "store", env, parseBoolean, "FIRSTTRACE_AI_STORE");
  applyFieldEnv<boolean>(config, "store", env, "FIRSTTRACE_AI_STORE_FIELD");

  const extraRaw = envValue(env, "FIRSTTRACE_AI_REQUEST_EXTRA_JSON");
  if (extraRaw !== undefined && extraRaw.trim()) {
    config.extra = mergeRecords(config.extra ?? {}, parseExtraJson(extraRaw, "FIRSTTRACE_AI_REQUEST_EXTRA_JSON")) as JsonObject;
  }

  return config;
};

export const resolveAiRequestOptions = ({
  config,
  env = process.env,
  model,
  provider,
}: {
  config?: AiRequestConfig;
  env?: NodeJS.ProcessEnv;
  model: string;
  provider: AiRequestProvider;
}): ResolvedAiRequestOptions => ({
  config: aiRequestConfigFromEnv(env, config ?? {}),
  model,
  provider,
});

const resolvedField = (field: string | undefined, defaultField: string | undefined, label: string) => {
  const normalized = field === undefined ? "auto" : normalizeAiRequestField(field, label);
  if (normalized === "none") return undefined;
  if (normalized === "auto") return defaultField;
  return normalized;
};

const setPath = (target: Record<string, unknown>, path: string, value: unknown) => {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!isRecord(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const finalKey = parts[parts.length - 1];
  if (!finalKey) return;
  if (value === null) {
    delete current[finalKey];
  } else {
    current[finalKey] = value;
  }
};

const applyControl = <T extends JsonValue>(
  patch: Record<string, unknown>,
  control: AiRequestControl<T> | undefined,
  defaultField: string | undefined,
  label: string,
) => {
  if (!control || control.value === undefined) return;
  const field = resolvedField(control.field, defaultField, label);
  if (!field) return;
  setPath(patch, field, control.value);
};

const mergeRecords = (
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = mergeRecords(merged[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
};

const hasConfiguredValues = (config: AiRequestConfig) =>
  Boolean(
    config.extra ||
      config.outputTokenLimit ||
      config.reasoningEffort ||
      config.stopSequences ||
      config.store ||
      config.temperature ||
      config.topK ||
      config.topP ||
      config.verbosity,
  );

const openAiFamilyModel = (model: string) => /(^openai[./_-]|gpt|codex|^o\d)/i.test(model);

export const applyOpenAiResponsesRequestOptions = <T extends Record<string, unknown>>(
  request: T,
  options?: ResolvedAiRequestOptions,
): T => {
  const config = options?.config ?? {};
  if (!hasConfiguredValues(config)) return request;
  const patch: Record<string, unknown> = {};
  applyControl(patch, config.outputTokenLimit, "max_output_tokens", "output_token_limit.field");
  applyControl(patch, config.temperature, "temperature", "temperature.field");
  applyControl(patch, config.reasoningEffort, "reasoning.effort", "reasoning_effort.field");
  applyControl(patch, config.verbosity, "text.verbosity", "verbosity.field");
  applyControl(patch, config.topP, "top_p", "top_p.field");
  applyControl(patch, config.topK, undefined, "top_k.field");
  applyControl(patch, config.stopSequences, undefined, "stop_sequences.field");
  applyControl(patch, config.store, "store", "store.field");
  return mergeRecords(mergeRecords(request, patch), config.extra ?? {}) as T;
};

export const applyOciGenAiGenericChatRequestOptions = <T extends Record<string, unknown>>(
  request: T,
  options?: ResolvedAiRequestOptions,
): T => {
  const config = options?.config ?? {};
  if (!hasConfiguredValues(config)) return request;
  const patch: Record<string, unknown> = {};
  const outputTokenField = options?.model && openAiFamilyModel(options.model) ? "maxCompletionTokens" : "maxTokens";
  applyControl(patch, config.outputTokenLimit, outputTokenField, "output_token_limit.field");
  applyControl(patch, config.temperature, "temperature", "temperature.field");
  applyControl(patch, config.reasoningEffort, "reasoningEffort", "reasoning_effort.field");
  applyControl(patch, config.verbosity, "verbosity", "verbosity.field");
  applyControl(patch, config.topP, "topP", "top_p.field");
  applyControl(patch, config.topK, "topK", "top_k.field");
  applyControl(patch, config.stopSequences, "stop", "stop_sequences.field");
  applyControl(patch, config.store, undefined, "store.field");
  return mergeRecords(mergeRecords(request, patch), config.extra ?? {}) as T;
};
