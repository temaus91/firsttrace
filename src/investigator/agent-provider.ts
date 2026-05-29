import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { buildAiReasonerRequest } from "../ai/evidence.js";
import { groundAiResult } from "../ai/grounding.js";
import type { AiInvestigationResultPayload } from "../ai/schema.js";
import { agentSystemPrompt, agentUserPrompt } from "./agent-prompts.js";
import { AgentFinalResponseSchema, AgentTurnResponseSchema } from "./agent-schemas.js";
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

const createOpenAiAgentModelClient = (apiKey: string, model: string): AgentModelClient => {
  const client = new OpenAI({ apiKey });

  return {
    async next(input) {
      const response = await client.responses.parse({
        input: [
          { role: "system", content: agentSystemPrompt },
          { role: "user", content: agentUserPrompt(input) },
        ],
        model,
        text: {
          format: zodTextFormat(AgentTurnResponseSchema, "firsttrace_agent_turn"),
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
          { role: "system", content: agentSystemPrompt },
          { role: "user", content: agentUserPrompt(input, true) },
        ],
        model,
        text: {
          format: zodTextFormat(AgentFinalResponseSchema, "firsttrace_agent_final"),
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

const pathFromCitation = (citation: string) => {
  const lineMatch = /^(.+):\d+$/.exec(citation);
  return lineMatch?.[1] ?? citation;
};

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

type CandidateCitation = {
  citations: string[];
  path: string;
  score: number;
};

const authenticatedSurfaceCandidateScore = (filePath: string) => {
  const normalized = filePath.toLowerCase();
  if (isPublicDynamicRoutePath(normalized)) return 0;

  let score = 0;
  if (/^app\/page\.(tsx|ts|jsx|js)$/.test(normalized) || /^pages\/index\.(tsx|ts|jsx|js)$/.test(normalized)) {
    score += 6;
  }
  if (normalized.includes("shell")) score += 4;
  if (normalized.includes("active") || normalized.includes("navigation")) score += 2;
  if (normalized.includes("-tab") || normalized.includes("tab.")) score += 2;
  if (normalized.includes("profile")) score += 2;
  if (normalized.includes("app-context") || normalized.includes("auth")) score += 1;
  if (/^(app|pages|src\/app|src\/pages)\//.test(normalized)) score += 1;
  if (/^components\//.test(normalized)) score += 1;
  return score;
};

const authenticatedSurfaceCandidates = (observations: AgentObservation[]) => {
  const candidates = new Map<string, CandidateCitation>();
  for (const observation of observations) {
    for (const citation of observation.citations) {
      const filePath = pathFromCitation(citation);
      const score = authenticatedSurfaceCandidateScore(filePath);
      if (!score) continue;

      const existing = candidates.get(filePath);
      if (existing) {
        existing.citations.push(citation);
        existing.score = Math.max(existing.score, score);
      } else {
        candidates.set(filePath, { citations: [citation], path: filePath, score });
      }
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      citations: [...new Set(candidate.citations)].slice(0, 6),
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
};

const authSurfaceCorrectedExplanation = (filePath: string, explanation: string) =>
  [
    `The report describes an authenticated/login journey, so ${filePath} is the best first check before public dynamic detail routes.`,
    explanation,
  ].join(" ");

const authSurfaceCorrectedWarnings = (warnings: string[]) =>
  warnings.filter((warning) => !/public .*route.*best|best match.*public|public .*best match/i.test(warning));

const preferAuthenticatedSurfaceOwner = (
  payload: AiInvestigationResultPayload,
  request: AiReasonerRequest,
  observations: AgentObservation[],
) => {
  const topFile = payload.likelyFiles[0];
  if (
    !topFile ||
    !reportIncludesAny(request, AUTH_JOURNEY_TERMS) ||
    !hasAuthenticatedSurfaceSignals(observations)
  ) {
    return payload;
  }

  const observedCandidate = authenticatedSurfaceCandidates(observations)[0];
  const hasPublicDynamicCandidate = payload.likelyFiles.some((file) => isPublicDynamicRoutePath(file.path));
  const existingIndex = payload.likelyFiles.findIndex(
    (file, index) => index > 0 && authenticatedSurfaceCandidateScore(file.path) >= 3,
  );
  const existingScore = existingIndex > 0 ? authenticatedSurfaceCandidateScore(payload.likelyFiles[existingIndex]!.path) : 0;
  const observedExistingIndex = observedCandidate
    ? payload.likelyFiles.findIndex((file) => file.path === observedCandidate.path)
    : -1;
  const shouldPromoteObserved =
    Boolean(observedCandidate) &&
    observedCandidate!.score >= 6 &&
    observedCandidate!.path !== topFile.path &&
    (isPublicDynamicRoutePath(topFile.path) || hasPublicDynamicCandidate);

  if (observedExistingIndex > 0 && shouldPromoteObserved) {
    const candidate = payload.likelyFiles[observedExistingIndex];
    return {
      ...payload,
      explanation: authSurfaceCorrectedExplanation(candidate?.path ?? payload.likelyComponent, payload.explanation),
      likelyComponent: candidate?.path ?? payload.likelyComponent,
      likelyFiles: [
        payload.likelyFiles[observedExistingIndex]!,
        ...payload.likelyFiles.slice(0, observedExistingIndex),
        ...payload.likelyFiles.slice(observedExistingIndex + 1),
      ],
      warnings: authSurfaceCorrectedWarnings(payload.warnings),
    };
  }

  if (existingIndex > 0 && !shouldPromoteObserved && isPublicDynamicRoutePath(topFile.path) && (!observedCandidate || existingScore >= observedCandidate.score)) {
    const candidate = payload.likelyFiles[existingIndex];
    return {
      ...payload,
      explanation: authSurfaceCorrectedExplanation(candidate?.path ?? payload.likelyComponent, payload.explanation),
      likelyComponent: candidate?.path ?? payload.likelyComponent,
      likelyFiles: [
        payload.likelyFiles[existingIndex]!,
        ...payload.likelyFiles.slice(0, existingIndex),
        ...payload.likelyFiles.slice(existingIndex + 1),
      ],
      warnings: authSurfaceCorrectedWarnings(payload.warnings),
    };
  }

  const candidate = observedCandidate;
  if (!candidate || !shouldPromoteObserved) return payload;

  return {
    ...payload,
    explanation: authSurfaceCorrectedExplanation(candidate.path, payload.explanation),
    likelyComponent: candidate.path,
    likelyFiles: [
      {
        citations: candidate.citations,
        confidence: Math.max(0.82, Math.min(0.95, topFile.confidence)),
        path: candidate.path,
        reason: "Authenticated/login journey evidence points to this shell or screen owner rather than the public dynamic detail route.",
        repo: topFile.repo,
      },
      ...payload.likelyFiles,
    ],
    warnings: authSurfaceCorrectedWarnings(payload.warnings),
  };
};

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
  const normalizePayload = (result: AiInvestigationResultPayload) =>
    preferRetryStateOwner(preferAuthenticatedSurfaceOwner(result, baseRequest, observations), baseRequest, observations);
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
    return normalizePayload(payload);
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
  return normalizePayload(revised);
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
