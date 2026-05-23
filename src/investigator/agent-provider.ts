import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { buildAiReasonerRequest } from "../ai/evidence.js";
import { groundAiResult } from "../ai/grounding.js";
import {
  AiInvestigationResultPayloadSchema,
  type AiInvestigationResultPayload,
} from "../ai/schema.js";
import { createInvestigationToolset } from "./tools.js";
import type {
  AiEvidenceItem,
  AiReasonerRequest,
  InvestigationToolName,
  InvestigationToolResult,
  InvestigatorProvider,
} from "../types.js";

const MAX_AGENT_STEPS = 8;
const MAX_TOOL_ERROR_LENGTH = 500;

const ToolNameSchema = z.enum(["findFiles", "readFile", "searchRepo", "findReferences", "gitLog", "gitBlame", "runSafeCommand"]);

const OpenAiAgentTurnSchema = z.object({
  argsJson: z.string(),
  reason: z.string(),
  result: AiInvestigationResultPayloadSchema.nullable(),
  tool: ToolNameSchema.nullable(),
  type: z.enum(["tool", "final"]),
});

const AgentFinalSchema = z.object({
  result: AiInvestigationResultPayloadSchema,
});

export type AgentTurn =
  | {
      args: Record<string, unknown>;
      reason: string;
      tool: InvestigationToolName;
      type: "tool";
    }
  | {
      result: AiInvestigationResultPayload;
      type: "final";
    };

export type AgentObservation = InvestigationToolResult & {
  id: string;
  tool: InvestigationToolName;
};

export type AgentModelInput = {
  maxSteps: number;
  observations: AgentObservation[];
  request: AiReasonerRequest;
  step: number;
};

export type AgentModelClient = {
  final(input: AgentModelInput): Promise<AiInvestigationResultPayload>;
  next(input: AgentModelInput): Promise<AgentTurn>;
};

const systemPrompt = `You are FirstTrace's read-only investigation agent.
Your job is to localize the likely cause of a bug report.

Rules:
- Use only the provided evidence and tool observations.
- Prefer cited file, line, git log, and git blame evidence.
- Use tools when they can materially improve the fault-location lead.
- First identify the user journey/surface before selecting fault files. Distinguish public routes from authenticated app shells, admin screens, tabs, modals, background jobs, and API routes.
- For UI reports with wording like "login", "sign in", "as <role>", "go to <screen>", "tab", "page", "empty", "blank", or "loading", trace: entry route -> shell/navigation -> rendered screen component -> data/loading state. Do not default to a public detail route just because it matches the same noun.
- For app shell or tab reports, include both the parent shell/router and the rendered screen/tab component when both are supported by observations.
- For auth/bootstrap/loading reports, include the state owner file that defines readiness flags when observations identify it.
- For reports where an old, expired, missing, deleted, or disappeared item opens a blank detail screen, inspect the parent route/shell/switch that resolves the item id and fallback state before ranking the leaf detail component. A detail component cannot render if the parent returns null before mounting it.
- For retry, duplicate, idempotency, skipped, failed, or status reports, trace: entrypoint -> claim/idempotency guard -> persisted status or unique constraint -> retry eligibility. The store/repository/database function that decides whether a retry is allowed is usually more important than the route or wrapper that calls it.
- When file-path candidates include both public detail routes and authenticated shell/tab components, prefer the path that matches the reported journey, and cite why adjacent routes are secondary if needed.
- Never suggest code edits as if they were already made.
- Do not ask to inspect the repo if a read-only tool can inspect it.
- Every likely file and implementer hint must cite evidence or tool observation citations.
- Use exact citation labels from the evidence or tool observations when possible; prefer individual line labels over invented line ranges.
- Keep the final handoff short: prioritize fault location, owner/person, and commit/date over detailed fix instructions.
- Return final JSON when you have the strongest supported handoff.`;

const userPrompt = (input: AgentModelInput, finalOnly = false) =>
  [
    finalOnly
      ? "Return the final FirstTrace investigation JSON. Do not request another tool."
      : "Choose the next read-only investigation step or return the final investigation JSON.",
    "",
    `Step: ${input.step}/${input.maxSteps}`,
    "",
    "Available tools:",
    "- findFiles: find file paths whose names include a query; use this early to map screen/route/component candidates.",
    "- readFile: read a bounded window from a file by repo/path/line/window.",
    "- searchRepo: fixed-string search by repo/query.",
    "- findReferences: fixed-string reference search by repo/symbolOrPath.",
    "- gitLog: recent git history by repo/path.",
    "- gitBlame: blame one file line by repo/path/line.",
    "- runSafeCommand: exact allowlist only: npm test, npm run test, npm run typecheck, npm run lint.",
    "",
    "When choosing a tool, set type=tool, set tool, and put tool arguments in argsJson as valid JSON.",
    "When returning final output, set type=final and put the final handoff in result.",
    "",
    "Investigation request and evidence:",
    JSON.stringify(input.request, null, 2),
    "",
    "Tool observations:",
    JSON.stringify(input.observations, null, 2),
  ].join("\n");

const createOpenAiAgentModelClient = (apiKey: string, model: string): AgentModelClient => {
  const client = new OpenAI({ apiKey });

  return {
    async next(input) {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(input) },
        ],
        model,
        text: {
          format: zodTextFormat(OpenAiAgentTurnSchema, "firsttrace_agent_turn"),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured investigation agent turn.");
      }
      if (response.output_parsed.type === "final") {
        if (!response.output_parsed.result) {
          throw new Error("OpenAI returned a final agent turn without result.");
        }
        return { result: response.output_parsed.result, type: "final" };
      }
      if (!response.output_parsed.tool) {
        throw new Error("OpenAI returned a tool agent turn without tool.");
      }
      let args: Record<string, unknown>;
      try {
        const argsJson = response.output_parsed.argsJson.trim() || "{}";
        const parsedArgs = JSON.parse(argsJson) as unknown;
        args = parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
          ? (parsedArgs as Record<string, unknown>)
          : {};
      } catch {
        throw new Error(`OpenAI returned invalid tool args JSON: ${response.output_parsed.argsJson}`);
      }
      return {
        args,
        reason: response.output_parsed.reason,
        tool: response.output_parsed.tool,
        type: "tool",
      };
    },
    async final(input) {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(input, true) },
        ],
        model,
        text: {
          format: zodTextFormat(AgentFinalSchema, "firsttrace_agent_final"),
        },
      });
      if (!response.output_parsed) {
        throw new Error("OpenAI did not return a structured final investigation result.");
      }
      return response.output_parsed.result;
    },
  };
};

const SYMPTOM_TERMS = new Set([
  "after",
  "blank",
  "bug",
  "empty",
  "error",
  "few",
  "fix",
  "looks",
  "loading",
  "shown",
  "seconds",
  "things",
]);

const AUTH_JOURNEY_TERMS = ["auth", "authenticated", "login", "logout", "session", "sign", "signin", "signup"];

const LOADING_JOURNEY_TERMS = ["blank", "empty", "loading", "seconds", "shown"];

const MISSING_ENTITY_TERMS = ["deleted", "disappeared", "expired", "gone", "missing", "not found", "old", "removed", "stale"];

const SCREEN_HINT_TERMS = new Set([
  "account",
  "admin",
  "artist",
  "artwork",
  "checkout",
  "dashboard",
  "detail",
  "messages",
  "onboarding",
  "orders",
  "profile",
  "reservation",
  "reservations",
  "receipt",
  "sales",
  "settings",
  "signup",
  "venue",
]);

const TAB_HINT_TERMS = new Set(["profile", "reservations", "sales", "settings"]);

const ENTITY_DETAIL_TERMS = new Set(["artist", "artwork", "reservation", "venue"]);

const UI_JOURNEY_TERMS = [
  "admin",
  "artist",
  "artwork",
  "auth",
  "authenticated",
  "blank",
  "dashboard",
  "detail",
  "empty",
  "login",
  "loading",
  "page",
  "profile",
  "reservation",
  "route",
  "screen",
  "settings",
  "shell",
  "sign",
  "tab",
  "venue",
];

const BACKEND_FLOW_TERMS = [
  "api",
  "checkout",
  "database",
  "db",
  "email",
  "job",
  "notification",
  "payment",
  "queue",
  "receipt",
  "resend",
  "sale",
  "store",
  "stripe",
  "token",
  "webhook",
  "worker",
];

const STATE_MACHINE_TERMS = [
  "already",
  "claim",
  "claimed",
  "duplicate",
  "idempotency",
  "idempotent",
  "retry",
  "retried",
  "skip",
  "skipped",
  "state",
  "status",
];

const FAILURE_STATE_TERMS = ["failed", "failure"];

const reportLooksLikeUiJourney = (request: AiReasonerRequest) => {
  const text = `${request.report} ${request.searchTerms.join(" ")}`.toLowerCase();
  return UI_JOURNEY_TERMS.some((term) => text.includes(term));
};

const reportLooksLikeBackendFlow = (request: AiReasonerRequest) => {
  const text = `${request.report} ${request.searchTerms.join(" ")}`.toLowerCase();
  return BACKEND_FLOW_TERMS.some((term) => text.includes(term));
};

const reportIncludesAny = (request: AiReasonerRequest, terms: string[]) => {
  const text = `${request.report} ${request.searchTerms.join(" ")}`.toLowerCase();
  return terms.some((term) => text.includes(term));
};

const reportLooksLikeStateMachineFlow = (request: AiReasonerRequest) =>
  reportIncludesAny(request, STATE_MACHINE_TERMS) ||
  (reportIncludesAny(request, FAILURE_STATE_TERMS) && reportLooksLikeBackendFlow(request));

const seedFilePathQueries = (request: AiReasonerRequest) =>
  request.searchTerms
    .filter((term) => term.length >= 4 && !SYMPTOM_TERMS.has(term))
    .slice(0, 4);

const capitalize = (value: string) => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

const seedScreenTerms = (request: AiReasonerRequest) =>
  request.searchTerms
    .filter((term) => SCREEN_HINT_TERMS.has(term))
    .slice(0, 2);

const seedSearchQueries = (request: AiReasonerRequest) => {
  const queries = new Set<string>();
  for (const term of seedScreenTerms(request)) {
    if (TAB_HINT_TERMS.has(term)) {
      queries.add(`${capitalize(term)}Tab`);
      queries.add(`case '${term}'`);
      queries.add(`tab === '${term}'`);
    }
  }

  if (reportIncludesAny(request, AUTH_JOURNEY_TERMS)) {
    queries.add("isAuthBootstrapReady");
    queries.add("activeTab");
  }

  if (reportIncludesAny(request, LOADING_JOURNEY_TERMS)) {
    queries.add("isAppBootstrapReady");
  }

  if (reportIncludesAny(request, MISSING_ENTITY_TERMS)) {
    for (const term of seedScreenTerms(request).filter((item) => ENTITY_DETAIL_TERMS.has(item))) {
      queries.add(`case '${term}-detail'`);
      queries.add(`type: '${term}-detail'`);
      queries.add(`active${capitalize(term)}`);
      queries.add(`screen.${term}Id`);
      queries.add(`${term}s.find`);
    }
  }

  if (reportLooksLikeStateMachineFlow(request)) {
    queries.add("shouldSend");
    queries.add("delivery_status");
    queries.add("23505");
    queries.add("unique");
    queries.add("SENDING");
    queries.add("FAILED");
    queries.add("skipped");
    queries.add("claim");
  }

  return [...queries].slice(0, 8);
};

const seedJourneyObservations = async (
  request: AiReasonerRequest,
  toolset: ReturnType<typeof createInvestigationToolset>,
): Promise<AgentObservation[]> => {
  if (!reportLooksLikeUiJourney(request) && !reportLooksLikeBackendFlow(request)) return [];

  const observations: AgentObservation[] = [];
  const calls: Array<{ args: Record<string, string>; tool: InvestigationToolName }> = [
    ...seedFilePathQueries(request).map((query) => ({ args: { query }, tool: "findFiles" as const })),
    ...seedSearchQueries(request).map((query) => ({ args: { query }, tool: "searchRepo" as const })),
  ];

  for (const call of calls) {
    let toolResult: InvestigationToolResult;
    try {
      toolResult = await toolset.execute(call.tool, call.args);
    } catch (error) {
      toolResult = toolErrorResult(call.tool, error);
    }
    observations.push({
      ...toolResult,
      id: `tool-${observations.length + 1}`,
      tool: call.tool,
    });
  }
  return observations;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown tool error";

const toolErrorResult = (tool: InvestigationToolName, error: unknown): InvestigationToolResult => {
  const message = errorMessage(error);
  return {
    citations: [],
    summary: `Tool call failed: ${message.slice(0, MAX_TOOL_ERROR_LENGTH)}`,
    title: `${tool} failed`,
  };
};

const observationEvidence = (observations: AgentObservation[]): AiEvidenceItem[] =>
  observations.map((observation) => ({
    citations: observation.citations,
    id: observation.id,
    kind: "agent_observation",
    summary: observation.summary,
    title: observation.title,
  }));

const requestWithObservations = (
  request: AiReasonerRequest,
  observations: AgentObservation[],
): AiReasonerRequest => ({
  ...request,
  evidence: [...request.evidence, ...observationEvidence(observations)],
});

const groundedResult = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) =>
  groundAiResult(
    {
      ...payload,
      provider: "agent",
    },
    requestWithObservations(request, observations),
  );

const isPublicDynamicRoutePath = (filePath: string) =>
  /(^|\/)(app|pages)\//.test(filePath) && /\[[^\]]+\]/.test(filePath);

const hasAuthenticatedSurfaceSignals = (observations: AgentObservation[]) =>
  observations.some((observation) => {
    const text = `${observation.title}\n${observation.summary}\n${observation.citations.join("\n")}`.toLowerCase();
    return text.includes("activetab") || /\btabs?\b/.test(text) || text.includes("shell") || text.includes("-tab");
  });

const hasRenderedTabComponentSignals = (observations: AgentObservation[]) =>
  observations.some((observation) => {
    const text = `${observation.title}\n${observation.summary}\n${observation.citations.join("\n")}`.toLowerCase();
    return text.includes("-tab.tsx") || /[a-z]+tab\b/.test(text);
  });

const hasBootstrapStateSignals = (observations: AgentObservation[]) =>
  observations.some((observation) => {
    const text = `${observation.title}\n${observation.summary}\n${observation.citations.join("\n")}`.toLowerCase();
    return text.includes("app-context") || text.includes("isappbootstrapready") || text.includes("isauthbootstrapready");
  });

const hasMissingEntityShellSignals = (observations: AgentObservation[]) => {
  const text = observations
    .map((observation) => `${observation.title}\n${observation.summary}\n${observation.citations.join("\n")}`)
    .join("\n")
    .toLowerCase();
  return (
    (text.includes("return null") || text.includes("not found") || text.includes("missing")) &&
    (text.includes("screen.") || text.includes("case '") || text.includes(".find(")) &&
    text.includes("-detail")
  );
};

const observationText = (observations: AgentObservation[]) =>
  observations
    .map((observation) => `${observation.title}\n${observation.summary}\n${observation.citations.join("\n")}`)
    .join("\n")
    .toLowerCase();

const hasRetryStatePersistenceSignals = (observations: AgentObservation[]) => {
  const text = observationText(observations);
  const hasRetryGuard = (
    text.includes("23505") ||
    text.includes("shouldsend") ||
    text.includes("idempot") ||
    text.includes("unique") ||
    text.includes("claim")
  );
  const hasPersistedStatus = (
    text.includes("delivery_status") ||
    text.includes("failed") ||
    text.includes("sending") ||
    text.includes("skipped") ||
    text.includes("status")
  );
  const hasPersistenceOwner = (
    text.includes(".from(") ||
    text.includes("insert") ||
    text.includes("migration") ||
    text.includes("repository") ||
    text.includes("store") ||
    text.includes("update")
  );
  return hasRetryGuard && hasPersistedStatus && hasPersistenceOwner;
};

const isStatePersistencePath = (filePath: string) =>
  /(^|\/|[-_.])(db|database|model|repository|repo|schema|store|storage)\b/i.test(filePath) ||
  /(^|\/)migrations\//i.test(filePath);

const isStateCodePath = (filePath: string) =>
  isStatePersistencePath(filePath) && !/(^|\/)migrations\//i.test(filePath);

const preferRetryStateOwner = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  if (!reportLooksLikeStateMachineFlow(request) || !hasRetryStatePersistenceSignals(observations)) {
    return payload;
  }

  const topFile = payload.likelyFiles[0];
  if (!topFile || isStatePersistencePath(topFile.path)) {
    return payload;
  }

  const stateIndex = payload.likelyFiles.findIndex((file) => isStateCodePath(file.path));
  if (stateIndex < 1) return payload;

  const stateFile = payload.likelyFiles[stateIndex];
  if (!stateFile || stateFile.confidence < topFile.confidence - 0.1) {
    return payload;
  }

  return {
    ...payload,
    likelyComponent: isStateCodePath(payload.likelyComponent) ? payload.likelyComponent : stateFile.path,
    likelyFiles: [
      stateFile,
      ...payload.likelyFiles.slice(0, stateIndex),
      ...payload.likelyFiles.slice(stateIndex + 1),
    ],
  };
};

const shouldReconsiderJourneyFinal = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  const topPath = payload.likelyFiles[0]?.path;
  return Boolean(
    topPath &&
      isPublicDynamicRoutePath(topPath) &&
      reportIncludesAny(request, AUTH_JOURNEY_TERMS) &&
      hasAuthenticatedSurfaceSignals(observations),
  );
};

const shouldReconsiderMissingEntityFinal = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  const topPath = payload.likelyFiles[0]?.path;
  return Boolean(
    topPath &&
      /^components\/.*detail\.tsx$/.test(topPath) &&
      reportIncludesAny(request, MISSING_ENTITY_TERMS) &&
      hasMissingEntityShellSignals(observations),
  );
};

const shouldReconsiderMissingRenderedSurfaceFinal = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) =>
  reportIncludesAny(request, AUTH_JOURNEY_TERMS) &&
  hasRenderedTabComponentSignals(observations) &&
  !payload.likelyFiles.some((file) => file.path.toLowerCase().includes("-tab"));

const shouldReconsiderMissingBootstrapStateFinal = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) =>
  reportIncludesAny(request, AUTH_JOURNEY_TERMS) &&
  reportIncludesAny(request, LOADING_JOURNEY_TERMS) &&
  hasBootstrapStateSignals(observations) &&
  !payload.likelyFiles.some((file) => file.path.toLowerCase().includes("app-context"));

const shouldReconsiderRetryStateFinal = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  const topPath = payload.likelyFiles[0]?.path;
  return Boolean(
    topPath &&
      reportLooksLikeStateMachineFlow(request) &&
      hasRetryStatePersistenceSignals(observations) &&
      !isStatePersistencePath(topPath),
  );
};

const journeyCorrectionObservation = (observations: AgentObservation[]): AgentObservation => ({
  citations: [],
  id: `tool-${observations.length + 1}`,
  summary: [
    "The draft final answer selected a public dynamic detail route as the top fault location.",
    "The report describes an authenticated/login journey and the observations include shell/tab/navigation candidates.",
    "Re-evaluate authenticated app shell, tab, and screen component paths before finalizing.",
    "Keep the final answer focused on the best fault location and owner/person.",
  ].join(" "),
  title: "Journey correction: reconsider public route vs authenticated surface",
  tool: "searchRepo",
});

const renderedSurfaceCorrectionObservation = (observations: AgentObservation[]): AgentObservation => ({
  citations: [],
  id: `tool-${observations.length + 1}`,
  summary: [
    "The draft final answer selected shell/bootstrap files for an authenticated tab or screen report but omitted the rendered tab/screen component.",
    "The observations include rendered tab component candidates.",
    "Keep the parent shell/router as primary if it is best supported, but include the leaf tab/screen component as a secondary fault-location lead when supported.",
  ].join(" "),
  title: "Rendered surface correction: include shell and leaf tab component",
  tool: "searchRepo",
});

const bootstrapStateCorrectionObservation = (observations: AgentObservation[]): AgentObservation => ({
  citations: [],
  id: `tool-${observations.length + 1}`,
  summary: [
    "The draft final answer describes auth/bootstrap/loading behavior but omitted the file that owns readiness state.",
    "The observations include app-context or readiness-flag evidence.",
    "Keep the best shell/component ranking, but include the bootstrap state owner file as a supported secondary lead.",
  ].join(" "),
  title: "Bootstrap state correction: include readiness state owner",
  tool: "searchRepo",
});

const missingEntityCorrectionObservation = (observations: AgentObservation[]): AgentObservation => ({
  citations: [],
  id: `tool-${observations.length + 1}`,
  summary: [
    "The draft final answer selected a leaf detail component for a missing/expired/disappeared item blank-screen report.",
    "The observations include parent shell, route, or switch code that resolves an item id and can return null before the detail component mounts.",
    "Re-evaluate the parent lookup/fallback code as the primary fault location, then keep the leaf detail component only as secondary if needed.",
  ].join(" "),
  title: "Missing entity correction: reconsider leaf detail component vs parent fallback",
  tool: "searchRepo",
});

const retryStateCorrectionObservation = (observations: AgentObservation[]): AgentObservation => ({
  citations: [],
  id: `tool-${observations.length + 1}`,
  summary: [
    "The draft final answer selected an entry route, wrapper, or sender for a retry/skipped/failed/idempotency report.",
    "The observations include persisted claim/status/unique-constraint evidence.",
    "Re-evaluate the store, repository, database, or migration code that decides whether a retry is allowed as the primary fault location.",
    "Keep the caller as secondary only when it owns the state transition.",
  ].join(" "),
  title: "Retry state correction: reconsider caller vs persisted state owner",
  tool: "searchRepo",
});

const needsOwnerEnrichment = (payload: AiInvestigationResultPayload) =>
  payload.likelyFiles.length > 0 &&
  !(
    payload.implementerHints[0]?.commit &&
    payload.implementerHints[0].citations.some((citation) => citation.startsWith("commit "))
  );

type CommitSignal = {
  author: string;
  citation: string;
  date: string;
  hash: string;
  path: string;
  repo: string;
  subject: string;
};

const commitSignalFromGitLog = (
  file: AiInvestigationResultPayload["likelyFiles"][number],
  toolResult: InvestigationToolResult,
): CommitSignal | undefined => {
  const citation = toolResult.citations.find((item) => item.startsWith("commit "));
  if (!citation) return undefined;

  const row = toolResult.summary.split("\n").find(Boolean);
  const match = row ? /^([a-f0-9]+)\s+(\d{4}-\d{2}-\d{2})\s+(.+?):\s+(.*)$/.exec(row) : undefined;
  const hash = citation.replace("commit ", "");
  return {
    author: match?.[3]?.trim().replace(/\s+/g, " ") || "unknown",
    citation,
    date: match?.[2] || "unknown date",
    hash,
    path: file.path,
    repo: file.repo,
    subject: match?.[4]?.trim() || "Recent file history",
  };
};

const finalPayload = async (
  modelClient: AgentModelClient,
  payload: AiInvestigationResultPayload,
  baseRequest: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  const needsJourneyCorrection = shouldReconsiderJourneyFinal(payload, baseRequest, observations);
  const needsMissingEntityCorrection = shouldReconsiderMissingEntityFinal(payload, baseRequest, observations);
  const needsRenderedSurfaceCorrection = shouldReconsiderMissingRenderedSurfaceFinal(payload, baseRequest, observations);
  const needsBootstrapStateCorrection = shouldReconsiderMissingBootstrapStateFinal(payload, baseRequest, observations);
  const needsRetryStateCorrection = shouldReconsiderRetryStateFinal(payload, baseRequest, observations);
  if (
    !needsJourneyCorrection &&
    !needsMissingEntityCorrection &&
    !needsRenderedSurfaceCorrection &&
    !needsBootstrapStateCorrection &&
    !needsRetryStateCorrection
  ) {
    return preferRetryStateOwner(payload, baseRequest, observations);
  }

  if (needsJourneyCorrection) observations.push(journeyCorrectionObservation(observations));
  if (needsRenderedSurfaceCorrection) observations.push(renderedSurfaceCorrectionObservation(observations));
  if (needsBootstrapStateCorrection) observations.push(bootstrapStateCorrectionObservation(observations));
  if (needsMissingEntityCorrection) observations.push(missingEntityCorrectionObservation(observations));
  if (needsRetryStateCorrection) observations.push(retryStateCorrectionObservation(observations));
  const revised = await modelClient.final({
    maxSteps: MAX_AGENT_STEPS,
    observations,
    request: requestWithObservations(baseRequest, observations),
    step: MAX_AGENT_STEPS,
  });
  return preferRetryStateOwner(revised, baseRequest, observations);
};

const enrichOwnerSignals = async (
  payload: AiInvestigationResultPayload,
  observations: AgentObservation[],
  toolset: ReturnType<typeof createInvestigationToolset>,
) => {
  if (!needsOwnerEnrichment(payload)) {
    return payload;
  }

  const seen = new Set<string>();
  const commitSignals: CommitSignal[] = [];
  const files = payload.likelyFiles
    .filter((file) => {
      const key = `${file.repo}:${file.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);

  for (const file of files) {
    let toolResult: InvestigationToolResult;
    try {
      toolResult = await toolset.execute("gitLog", { path: file.path, repo: file.repo });
    } catch (error) {
      toolResult = toolErrorResult("gitLog", error);
    }
    observations.push({
      ...toolResult,
      id: `tool-${observations.length + 1}`,
      tool: "gitLog",
    });
    const signal = commitSignalFromGitLog(file, toolResult);
    if (signal && signal.author !== "unknown") {
      commitSignals.push(signal);
    }
  }

  if (!commitSignals.length) return payload;

  const implementerHints = commitSignals.slice(0, 3).map((signal) => ({
    citations: [signal.citation],
    commit: signal.hash,
    email: null,
    name: signal.author,
    reason: `Recent history for ${signal.path} points to this person: commit ${signal.hash} on ${signal.date}, "${signal.subject}".`,
  }));
  const likelyOwners = [...new Set(implementerHints.map((hint) => hint.name).filter(Boolean))].slice(0, 8) as string[];

  return {
    ...payload,
    implementerHints,
    likelyOwners,
  };
};

export type AgentInvestigatorOptions =
  | {
      apiKey: string;
      model: string;
      modelClient?: never;
    }
  | {
      model: string;
      modelClient: AgentModelClient;
      apiKey?: never;
    };

export const createAgentInvestigator = (options: AgentInvestigatorOptions): InvestigatorProvider => {
  const modelClient = options.modelClient ?? createOpenAiAgentModelClient(options.apiKey, options.model);

  return {
    model: options.model,
    name: "agent",
    async investigate({ preparedConfig, result }) {
      const baseRequest = buildAiReasonerRequest(result);
      const toolset = createInvestigationToolset(preparedConfig);
      const observations: AgentObservation[] = await seedJourneyObservations(baseRequest, toolset);

      for (let step = 1; step <= MAX_AGENT_STEPS; step += 1) {
        const request = requestWithObservations(baseRequest, observations);
        const turn = await modelClient.next({ maxSteps: MAX_AGENT_STEPS, observations, request, step });
        if (turn.type === "final") {
          const correctedPayload = await finalPayload(modelClient, turn.result, baseRequest, observations);
          const payload = await enrichOwnerSignals(correctedPayload, observations, toolset);
          return groundedResult(payload, baseRequest, observations);
        }

        let toolResult: InvestigationToolResult;
        try {
          toolResult = await toolset.execute(turn.tool, turn.args);
        } catch (error) {
          toolResult = toolErrorResult(turn.tool, error);
        }
        observations.push({
          ...toolResult,
          id: `tool-${observations.length + 1}`,
          tool: turn.tool,
        });
      }

      const request = requestWithObservations(baseRequest, observations);
      const resultPayload = await modelClient.final({
        maxSteps: MAX_AGENT_STEPS,
        observations,
        request,
        step: MAX_AGENT_STEPS,
      });
      const correctedPayload = await finalPayload(modelClient, resultPayload, baseRequest, observations);
      const payload = await enrichOwnerSignals(correctedPayload, observations, toolset);
      return groundedResult(payload, baseRequest, observations);
    },
  };
};
