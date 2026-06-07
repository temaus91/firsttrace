import type { ManagerOwnerTriageCandidate, ManagerOwnerTriageResult } from "./manager-triage.js";
import type { OwnerEvidenceResult } from "./owner-evidence.js";

export type Classification = "bug" | "feature_request" | "support_question" | "unknown";

export type EvidenceType = "file" | "commit" | "doc" | "issue";

export type Citation = {
  commit?: string;
  query?: string;
  relevance?: string;
  label: string;
  line?: number;
  path?: string;
  repo: string;
  score?: number;
  searchPass?: string;
  snippet?: string;
  whyRelevant?: string;
};

export type EvidenceItem = {
  citations: Citation[];
  metadata?: Record<string, string | number | boolean | null>;
  owner?: string;
  path?: string;
  repo: string;
  score: number;
  summary: string;
  title: string;
  type: EvidenceType;
};

export type InvestigationResult = {
  ai?: AiInvestigationResult;
  classification: Classification;
  likelyComponent: string;
  likelyOwners: string[];
  ownerEvidence?: OwnerEvidenceResult;
  relatedCommits: EvidenceItem[];
  relatedDocs: EvidenceItem[];
  report: string;
  searchTerms: string[];
  suggestedNextSteps: string[];
  suspiciousFiles: EvidenceItem[];
  warnings: string[];
};

export type AiEvidenceKind =
  | "suspicious_file"
  | "related_commit"
  | "related_doc"
  | "owner_evidence"
  | "agent_observation"
  | "warning";

export type AiEvidenceItem = {
  citations: string[];
  id: string;
  kind: AiEvidenceKind;
  metadata?: Record<string, string | number | boolean | null>;
  missingInfo?: string[];
  owner?: string;
  ownerCandidate?: ManagerOwnerTriageCandidate;
  path?: string;
  repo?: string;
  score?: number;
  summary: string;
  title: string;
  type?: EvidenceType;
};

export type AiReasonerRequest = {
  classification: Classification;
  evidence: AiEvidenceItem[];
  likelyComponent: string;
  likelyOwners: string[];
  report: string;
  searchTerms: string[];
  warnings: string[];
};

export type AiFileFinding = {
  citations: string[];
  confidence: number;
  path: string;
  reason: string;
  repo: string;
};

export type AiImplementerHint = {
  citations: string[];
  commit: string | null;
  email: string | null;
  name: string | null;
  reason: string;
};

export type AiInvestigationQuality = {
  actionability: number;
  citationCoverage: number;
  evidenceWarnings: string[];
  executionStatus: "succeeded" | "failed";
  foundExactFile: boolean;
  foundExactLine: boolean;
  foundCommitEvidence: boolean;
  foundOwner: boolean;
  foundPersonOwner: boolean;
  foundRelatedCommit: boolean;
  triageQuality: "strong" | "medium" | "weak" | "failed";
  usedTeamFallback: boolean;
};

export type AiInvestigationResult = {
  bugLikelihood?: "likely_bug" | "feature_request" | "support_question" | "needs_clarification";
  confidence: number;
  confidenceRationale?: string | null;
  explanation: string;
  firstContact?: string | null;
  implementerHints: AiImplementerHint[];
  likelyComponent: string;
  likelyFiles: AiFileFinding[];
  likelyOwners: string[];
  managerTriage?: ManagerOwnerTriageResult;
  missingInfoQuestions: string[];
  provider: string;
  promptProfile?: string;
  promptVersion?: string;
  quality?: AiInvestigationQuality;
  relatedChange?: string | null;
  userImpact?: string | null;
  warnings: string[];
};

export type AiProvider = {
  model?: string;
  name: string;
  reason(request: AiReasonerRequest, promptConfig?: InvestigationPromptConfig): Promise<AiInvestigationResult>;
};

export type InvestigationToolName =
  | "findFiles"
  | "readFile"
  | "searchRepo"
  | "findReferences"
  | "gitLog"
  | "gitBlame"
  | "runSafeCommand";

export type InvestigationToolResult = {
  citations: string[];
  summary: string;
  title: string;
};

export type InvestigationToolset = {
  execute(name: InvestigationToolName, args: unknown): Promise<InvestigationToolResult>;
};

export type InvestigatorRequest = {
  preparedConfig: PreparedFirstTraceConfig;
  result: InvestigationResult;
};

export type InvestigatorProvider = {
  model?: string;
  name: string;
  investigate(request: InvestigatorRequest): Promise<AiInvestigationResult>;
};

export type EvalCase = {
  expectedClassification?: Classification;
  expectedComponent?: string;
  expectedFiles: string[];
  expectedOwners: string[];
  id: string;
  notes?: string;
  report: string;
};

export type EvalScore = {
  citationCoverage: number;
  citationsPassed: boolean;
  classificationMatched?: boolean;
  componentMatched?: boolean;
  expectedFilesFound: string[];
  expectedFilesMissing: string[];
  expectedOwnersFound: string[];
  expectedOwnersMissing: string[];
  passed: boolean;
  unsupportedAiCitationCount: number;
  usefulness: number;
};

export type EvalCaseResult = {
  aiScore?: EvalScore;
  case: EvalCase;
  deterministicResult: InvestigationResult;
  deterministicScore: EvalScore;
};

export type EvalRunResult = {
  aiEnabled: boolean;
  caseResults: EvalCaseResult[];
  passed: boolean;
  summary: {
    failed: number;
    passed: number;
    total: number;
  };
};

export type InvestigationJobStatus = "queued" | "running" | "succeeded" | "failed";

export type Awaitable<T> = T | Promise<T>;

export type InvestigationJobSource = {
  channelId?: string;
  channelName?: string;
  messageId?: string;
  provider: string;
  threadId?: string;
  userId?: string;
};

export type InvestigationJob = {
  aiEnabled: boolean;
  attempts: number;
  configPath: string;
  createdAt: string;
  dedupeKey?: string;
  error?: string;
  finishedAt?: string;
  id: string;
  maxAttempts: number;
  report: string;
  result?: InvestigationResult;
  source?: InvestigationJobSource;
  startedAt?: string;
  status: InvestigationJobStatus;
  updatedAt: string;
};

export type EnqueueInvestigationJobInput = {
  aiEnabled: boolean;
  configPath: string;
  dedupeKey?: string;
  maxAttempts?: number;
  report: string;
  source?: InvestigationJobSource;
};

export type JobQueue = {
  claimNext(): Awaitable<InvestigationJob | undefined>;
  complete(id: string, result: InvestigationResult): Awaitable<InvestigationJob>;
  enqueue(input: EnqueueInvestigationJobInput): Awaitable<InvestigationJob>;
  fail(id: string, error: string): Awaitable<InvestigationJob>;
  get(id: string): Awaitable<InvestigationJob | undefined>;
  list(): Awaitable<InvestigationJob[]>;
};

export type WorkerRunResult = {
  job?: InvestigationJob;
  message: string;
  notifications?: string[];
  status: "idle" | "processed";
};

export type HostedVerifyStatus = "passed" | "failed" | "blocked" | "skipped";

export type HostedVerifyCheck = {
  message: string;
  name: string;
  required: boolean;
  status: HostedVerifyStatus;
};

export type HostedVerifyResult = {
  channelId?: string;
  channelName?: string;
  checks: HostedVerifyCheck[];
  configPath: string;
  job?: InvestigationJob;
  passed: boolean;
  queueProvider: string;
  slackReplyText?: string;
};

export type MessageSubmitInput = {
  aiEnabled: boolean;
  configPath: string;
  report: string;
  source?: InvestigationJobSource;
};

export type MessageSubmitResult = {
  job: InvestigationJob;
};

export type MessageDeliveryAdapter = {
  submit(input: MessageSubmitInput): MessageSubmitResult | Promise<MessageSubmitResult>;
};

export type JobResultNotifier = {
  notify(job: InvestigationJob): Promise<void>;
};

export type JobProgressNotifier = {
  notifyStarted(job: InvestigationJob): Promise<void>;
};

export type LocalRepoConfig = {
  name: string;
  path: string;
  provider?: "local";
};

export type GitHubRepoConfig = {
  defaultBranch: string;
  name: string;
  owner: string;
  provider: "github";
  repo: string;
};

export type GitRepoCredentialConfig =
  | {
      tokenEnv: string;
      type: "token";
      usernameEnv?: string;
    }
  | {
      commandEnv?: string;
      keyFile?: string;
      keyFileEnv?: string;
      type: "ssh";
    };

export type GitRepoMaterializationConfig = {
  includeGitHistory: boolean;
  refresh: "startup" | "manual";
  scrubRemoteCredentials: boolean;
};

export type GitRepoConfig = {
  cloneDepth: "full" | number;
  credential?: GitRepoCredentialConfig;
  materialization: GitRepoMaterializationConfig;
  name: string;
  path: string;
  provider: "git";
  ref?: string;
  url: string;
};

export type ArchiveRepoConfig = {
  archiveCommand: string;
  commandCwd: string;
  name: string;
  path: string;
  provider: "archive";
  ref?: string;
};

export type RepoConfig = LocalRepoConfig | GitHubRepoConfig | GitRepoConfig | ArchiveRepoConfig;

export type SearchableRepoConfig = {
  cloneDepth?: "full" | number;
  defaultBranch?: string;
  lastRefreshStatus?: "failed" | "not_run" | "succeeded";
  name: string;
  owner?: string;
  path: string;
  provider: "local";
  ref?: string;
  remoteRepo?: string;
  sourceProvider: "archive" | "local" | "github" | "git";
};

export type OwnerRule = {
  owner: string;
  path: string;
};

export type SearchConfig = {
  maxCommits: number;
  maxEvidencePerFile: number;
  maxFiles: number;
};

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type InvestigationPromptConfig = {
  overlayFiles: string[];
  profile: string;
};

export type AiRequestControl<T> = {
  field?: string;
  value?: T;
};

export type AiRequestConfig = {
  extra?: JsonObject;
  outputTokenLimit?: AiRequestControl<number>;
  reasoningEffort?: AiRequestControl<string>;
  stopSequences?: AiRequestControl<string[]>;
  store?: AiRequestControl<boolean>;
  temperature?: AiRequestControl<number>;
  topK?: AiRequestControl<number>;
  topP?: AiRequestControl<number>;
  verbosity?: AiRequestControl<string>;
};

export type InvestigationAiConfig = {
  request?: AiRequestConfig;
};

export type InvestigationConfig = {
  ai?: InvestigationAiConfig;
  prompt: InvestigationPromptConfig;
};

export type ChatTrigger = "app_mention" | "message" | "reaction";
export type SlackDataClassification = "confidential" | "internal" | "restricted";

export type SlackChannelConfig = {
  aiEnabled: boolean;
  dataClassification: SlackDataClassification;
  id: string;
  includeThreadContext: boolean;
  name?: string;
  repositories: string[];
  response: "thread" | "channel";
  triggers: ChatTrigger[];
};

export type ChatConfig = {
  provider: "slack";
  channels: SlackChannelConfig[];
};

export type FirstTraceConfig = {
  chat?: ChatConfig;
  configPath: string;
  docs: string[];
  issueExports: string[];
  investigation: InvestigationConfig;
  owners: OwnerRule[];
  repos: RepoConfig[];
  search: SearchConfig;
};

export type PreparedFirstTraceConfig = Omit<FirstTraceConfig, "repos"> & {
  repos: SearchableRepoConfig[];
};
