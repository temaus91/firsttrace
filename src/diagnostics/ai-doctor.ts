import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  aiModelProviderFromEnv,
  ociGenAiConfigFromEnv,
  requireOpenAiApiKey,
  resolveChatModelFromEnv,
} from "../ai/provider-factory.js";
import { createOciGenAiJsonClient } from "../ai/oci-genai-json-client.js";
import {
  applyOpenAiResponsesRequestOptions,
  resolveAiRequestOptions,
  type AiRequestProvider,
  type ResolvedAiRequestOptions,
} from "../ai/request-options.js";
import { normalizeAiInvestigationResultPayload } from "../ai/schema.js";
import { normalizeAgentTurnResponse } from "../investigator/agent-schemas.js";
import type { FirstTraceConfig } from "../types.js";

export type AiDoctorCheckLevel = "FAIL" | "PASS";

export type AiDoctorCheck = {
  level: AiDoctorCheckLevel;
  message: string;
  name: string;
};

export type AiDoctorProbeContext = {
  config: FirstTraceConfig;
  env: NodeJS.ProcessEnv;
  model: string;
  provider: AiRequestProvider;
  requestOptions: ResolvedAiRequestOptions;
};

export type AiDoctorLiveProbe = (context: AiDoctorProbeContext) => Promise<void>;

export type AiDoctorOptions = {
  config: FirstTraceConfig;
  env?: NodeJS.ProcessEnv;
  liveProbe?: AiDoctorLiveProbe;
};

export type AiDoctorResult = {
  checks: AiDoctorCheck[];
  model?: string;
  passed: boolean;
  provider?: AiRequestProvider;
};

const DoctorLiveResponseSchema = z.object({
  message: z.string(),
  ok: z.boolean(),
});

const check = (level: AiDoctorCheckLevel, name: string, message: string): AiDoctorCheck => ({
  level,
  message,
  name,
});

const fixturePayload = () => ({
  confidence: 0.7,
  explanation: "Doctor fixture payload.",
  implementerHints: [],
  likelyComponent: "README.md",
  likelyFiles: [],
  likelyOwners: [],
  missingInfoQuestions: [],
  warnings: [],
});

const parserFixtureCheck = () => {
  normalizeAgentTurnResponse({
    argsJson: { path: "README.md" },
    tool: "readFile",
    type: "tool",
  });
  normalizeAgentTurnResponse({
    args: { query: "README" },
    tool: "searchRepo",
  });
  normalizeAgentTurnResponse({
    arguments: "{\"symbolOrPath\":\"renderCitation\"}",
    tool: "findReferences",
    type: "tool",
  });
  normalizeAgentTurnResponse({
    result: {
      ...fixturePayload(),
      bugLikelihood: "Likely Bug",
    },
    type: "final",
  });
  normalizeAiInvestigationResultPayload({
    ...fixturePayload(),
    bugLikelihood: "Likely Bug",
    managerTriage: {
      issue: "Renderer crashes on citations.",
      likely_owner_candidates: [
        {
          commit_id: "abcdef1234567890abcdef1234567890abcdef12",
          commit_time: "2026-05-20T17:15:30Z",
          commit_title: "Fix renderer citations",
          confidence: "High",
          email: "owner@example.com",
          evidence_source: "exact_line_blame",
          file: "src/render.ts",
          line: 12,
          name: "Repo Owner",
          rank: 1,
          reason: "Exact-line blame points at citation rendering.",
          repo: "app",
          snippet: "return renderCitation(citation)",
          why_relevant: "The blamed code renders citations.",
        },
      ],
      likely_root_cause: "Citation rendering throws.",
      missing_info: [],
      recommended_manager_action: "Route first to Repo Owner.",
      user_impact: "Users cannot read citations.",
    },
  });
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const redactedErrorMessage = (error: unknown, env: NodeJS.ProcessEnv) => {
  let message = error instanceof Error ? error.message : String(error);
  const secretValues = Object.entries(env)
    .filter(([name, value]) => /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE)/i.test(name) && Boolean(value?.trim()))
    .map(([, value]) => value?.trim() ?? "")
    .filter((value) => value.length >= 6);
  for (const secret of secretValues) {
    message = message.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED_SECRET]");
  }
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED_SECRET]");
};

export const defaultAiDoctorLiveProbe: AiDoctorLiveProbe = async ({
  env,
  model,
  provider,
  requestOptions,
}) => {
  const systemPrompt = "You are FirstTrace's AI provider compatibility doctor. Return only JSON.";
  const userPrompt = "Return JSON with ok=true and a short message.";

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: requireOpenAiApiKey(env) });
    const response = await client.responses.parse(applyOpenAiResponsesRequestOptions({
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model,
      text: {
        format: zodTextFormat(DoctorLiveResponseSchema, "firsttrace_ai_doctor"),
      },
    }, requestOptions) as never);
    const parsed = DoctorLiveResponseSchema.parse(response.output_parsed);
    if (!parsed.ok) throw new Error(`OpenAI doctor probe returned ok=false: ${parsed.message}`);
    return;
  }

  const client = createOciGenAiJsonClient({
    ...ociGenAiConfigFromEnv(env),
    env,
    model,
    requestOptions,
  });
  const parsed = DoctorLiveResponseSchema.parse(await client.generateJson({
    responseName: "firsttrace_ai_doctor",
    systemPrompt,
    userPrompt,
  }));
  if (!parsed.ok) throw new Error(`OCI GenAI doctor probe returned ok=false: ${parsed.message}`);
};

export const runAiDoctor = async ({
  config,
  env = process.env,
  liveProbe = defaultAiDoctorLiveProbe,
}: AiDoctorOptions): Promise<AiDoctorResult> => {
  const checks: AiDoctorCheck[] = [];
  let provider: AiRequestProvider | undefined;
  let model: string | undefined;
  let requestOptions: ResolvedAiRequestOptions | undefined;

  try {
    provider = aiModelProviderFromEnv(env);
    model = resolveChatModelFromEnv(env, provider);
    requestOptions = resolveAiRequestOptions({
      config: config.investigation.ai?.request,
      env,
      model,
      provider,
    });
    checks.push(check("PASS", "AI configuration", `${provider} selected with model ${model}.`));
  } catch (error) {
    checks.push(check("FAIL", "AI configuration", redactedErrorMessage(error, env)));
  }

  try {
    parserFixtureCheck();
    checks.push(check("PASS", "Provider output parser", "Accepted FirstTrace tool, final, and manager-owner compatibility fixtures."));
  } catch (error) {
    checks.push(check("FAIL", "Provider output parser", redactedErrorMessage(error, env)));
  }

  if (provider && model && requestOptions) {
    try {
      await liveProbe({ config, env, model, provider, requestOptions });
      checks.push(check("PASS", "Live provider probe", "Configured provider accepted a minimal JSON request with current request controls."));
    } catch (error) {
      checks.push(check("FAIL", "Live provider probe", redactedErrorMessage(error, env)));
    }
  }

  return {
    checks,
    model,
    passed: !checks.some((item) => item.level === "FAIL"),
    provider,
  };
};

export const renderAiDoctor = (result: AiDoctorResult) =>
  [
    `FirstTrace AI doctor: ${result.passed ? "PASS" : "FAIL"}`,
    `Provider: ${result.provider ?? "<unresolved>"}`,
    `Model: ${result.model ?? "<unresolved>"}`,
    "",
    ...result.checks.map((item) => `${item.level} ${item.name}: ${item.message}`),
  ].join("\n");
