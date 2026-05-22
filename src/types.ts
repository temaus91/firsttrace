export type Classification = "bug" | "feature_request" | "support_question" | "unknown";

export type EvidenceType = "file" | "commit" | "doc" | "issue";

export type Citation = {
  commit?: string;
  label: string;
  line?: number;
  path?: string;
  repo: string;
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
  relatedCommits: EvidenceItem[];
  relatedDocs: EvidenceItem[];
  report: string;
  searchTerms: string[];
  suggestedNextSteps: string[];
  suspiciousFiles: EvidenceItem[];
  warnings: string[];
};

export type AiEvidenceKind = "suspicious_file" | "related_commit" | "related_doc" | "warning";

export type AiEvidenceItem = {
  citations: string[];
  id: string;
  kind: AiEvidenceKind;
  metadata?: Record<string, string | number | boolean | null>;
  owner?: string;
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

export type AiInvestigationResult = {
  confidence: number;
  explanation: string;
  implementerHints: AiImplementerHint[];
  likelyComponent: string;
  likelyFiles: AiFileFinding[];
  likelyOwners: string[];
  missingInfoQuestions: string[];
  provider: string;
  warnings: string[];
};

export type AiProvider = {
  name: string;
  reason(request: AiReasonerRequest): Promise<AiInvestigationResult>;
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
  status: "idle" | "processed";
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

export type RepoConfig = {
  name: string;
  path: string;
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

export type FirstTraceConfig = {
  configPath: string;
  docs: string[];
  issueExports: string[];
  owners: OwnerRule[];
  repos: RepoConfig[];
  search: SearchConfig;
};
